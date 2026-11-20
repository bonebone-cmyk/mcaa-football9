import { describe, expect, it } from 'vitest';
import { allValid, checkRoster, simulateGame, SimError } from '../engine/index';
import { runPercentageChecks } from '../engine/percentages';
import { buildLineup } from '../engine/roster';
import { DEFAULT_CONFIG, type GameResult, type Play, type RosterPlayer, type TeamInput } from '../engine/types';
import { makeTeam } from './fixtures';

const game = (seed: string, a = makeTeam('AAA'), h = makeTeam('HHH'), config = {}) => simulateGame({ seed, teams: [a, h], config });
const ids = (t: TeamInput) => new Set(t.roster.map((p) => p.id));

describe('simulation core', () => {
  it('reproduces an identical game from the same seed and a different game from another seed', () => {
    const a = game('same-seed'), b = game('same-seed'), c = game('other-seed');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.plays)).not.toBe(JSON.stringify(c.plays));
  });
  it('derives the score from scoring plays, and every validation check passes, across many games', () => {
    for (let i = 0; i < 150; i++) {
      const r = game(`valid-${i}`);
      const pts = [0, 0];
      for (const p of r.plays) if (p.points) pts[p.points.side] += p.points.pts;
      expect(pts).toEqual(r.final);
      expect(r.scoring.reduce((a, s) => a + (s.side === 0 ? s.pts : 0), 0)).toBe(r.final[0]);
      expect(r.final[0]).not.toBe(r.final[1]);
      const bad = r.validation.filter((v) => !v.ok);
      expect(bad, `seed valid-${i}: ${JSON.stringify(bad)}`).toHaveLength(0);
    }
  });
  it('keeps downs, distance, field position and the clock legal on every snap', () => {
    for (let i = 0; i < 40; i++) {
      const r = game(`legal-${i}`);
      let lastQ = 1, lastClock = 900;
      for (const p of r.plays) {
        if (p.down != null) { expect(p.down).toBeGreaterThanOrEqual(1); expect(p.down).toBeLessThanOrEqual(4); expect(p.distance).toBeGreaterThanOrEqual(1); }
        expect(p.ballOn).toBeGreaterThanOrEqual(1); expect(p.ballOn).toBeLessThanOrEqual(99);
        if (p.quarter <= 4) { expect(p.clock).toBeGreaterThanOrEqual(0); expect(p.clock).toBeLessThanOrEqual(900); }
        if (p.quarter === lastQ && p.quarter <= 4) expect(p.clock).toBeLessThanOrEqual(lastClock);
        expect(p.quarter).toBeGreaterThanOrEqual(lastQ);
        lastQ = p.quarter; lastClock = p.clock;
      }
      // Four 15-minute quarters: possession time adds up to exactly 60 minutes.
      expect(r.teamStats[0].top + r.teamStats[1].top).toBe(3600);
      expect(r.drives.length).toBeGreaterThan(12);
    }
  });
  it('plays overtime under college rules when regulation ends tied', () => {
    let found = 0;
    for (let i = 0; i < 400 && found < 8; i++) {
      const r = game(`ot-${i}`);
      if (!r.overtimePeriods) continue;
      found++;
      const reg = [0, 1].map((s) => r.quarters[s].slice(0, 4).reduce((a, b) => a + b, 0));
      expect(reg[0]).toBe(reg[1]);
      expect(r.final[0]).not.toBe(r.final[1]);
      for (let pd = 1; pd <= r.overtimePeriods; pd++) {
        const plays = r.plays.filter((p) => p.quarter === 4 + pd);
        const last = pd === r.overtimePeriods;
        const pts = [r.quarters[0][3 + pd], r.quarters[1][3 + pd]];
        if (!last) expect(pts[0]).toBe(pts[1]); // a period that does not decide the game is tied
        expect(plays.some((p) => p.type === 'punt' || p.type === 'kickoff')).toBe(false); // no punts or kickoffs in overtime
        if (pd <= 2) for (const d of r.drives.filter((d) => d.quarter === 4 + pd)) expect(d.startBallOn).toBe(75); // each possession starts at the 25
        if (pd === 2) expect(plays.some((p) => p.type === 'extra_point')).toBe(false); // must go for two from the second overtime
        if (pd >= 3) expect(plays.every((p) => p.type === 'two_point')).toBe(true); // alternating two-point tries
      }
    }
    expect(found).toBeGreaterThan(2);
  });
  it('lets stronger teams win more often without guaranteeing it, and does not hand games to the home team', () => {
    let strongWins = 0, homeWins = 0;
    const N = 300;
    for (let i = 0; i < N; i++) {
      if (game(`str-${i}`, makeTeam('WEAK', { rating: 68 }), makeTeam('STRG', { rating: 82 })).final[1] > game(`str-${i}`, makeTeam('WEAK', { rating: 68 }), makeTeam('STRG', { rating: 82 })).final[0]) strongWins++;
      const even = game(`home-${i}`);
      if (even.final[1] > even.final[0]) homeWins++;
    }
    expect(strongWins / N).toBeGreaterThan(0.75);
    expect(strongWins).toBeLessThan(N); // upsets happen
    expect(homeWins / N).toBeGreaterThan(0.45);
    expect(homeWins / N).toBeLessThan(0.7);
  });
  it('uses offensive scheme and custom run/pass ratio in play selection', () => {
    const share = (t: Partial<TeamInput>) => {
      let pass = 0, run = 0;
      for (let i = 0; i < 25; i++) { const r = game(`scheme-${i}`, makeTeam('AAA', t)); pass += r.teamStats[0].passAtt; run += r.teamStats[0].rushAtt; }
      return run / (run + pass);
    };
    const airRaid = share({ offScheme: 'Air Raid' }), option = share({ offScheme: 'Option' }), custom = share({ offScheme: 'Air Raid', runPct: 75 });
    expect(option).toBeGreaterThan(airRaid + 0.2);
    expect(custom).toBeGreaterThan(airRaid + 0.2);
  });
});

describe('roster-only statistics', () => {
  const everyId = (p: Play) => [p.passer, p.rusher, p.target, p.kicker, p.punter, p.returner, p.interceptor, p.pd, p.fumbler, p.forcedBy, p.recoveredBy, p.blockedBy, p.sackAllowedBy, p.penalty?.player, ...(p.tacklers ?? []), ...(p.sackers ?? [])].filter(Boolean) as string[];
  it('never credits a player who is not on the correct active roster', () => {
    const a = makeTeam('AAA'), h = makeTeam('HHH');
    const A = ids(a), H = ids(h);
    for (let i = 0; i < 40; i++) {
      const r = game(`roster-${i}`, a, h);
      for (const l of r.playerStats) expect((l.side === 0 ? A : H).has(l.playerId)).toBe(true);
      for (const p of r.plays) for (const id of everyId(p)) expect(A.has(id) || H.has(id)).toBe(true);
      // Offensive credits belong to the offense, defensive credits to the defense.
      for (const p of r.plays) {
        const off = p.offense === 0 ? A : H, def = p.offense === 0 ? H : A;
        for (const id of [p.passer, p.rusher, p.target, p.kicker, p.punter].filter(Boolean) as string[]) expect(off.has(id)).toBe(true);
        for (const id of [...(p.tacklers ?? []), ...(p.sackers ?? []), p.interceptor, p.returner].filter(Boolean) as string[]) expect(def.has(id)).toBe(true);
      }
    }
  });
  it('gives inactive players no statistics unless explicitly permitted', () => {
    const a = makeTeam('AAA');
    const benched = a.roster.find((p) => p.id === 'AAA-RB1')!;
    benched.active = false;
    const seen = (cfg = {}) => { let n = 0; for (let i = 0; i < 15; i++) n += game(`inact-${i}`, a, makeTeam('HHH'), cfg).playerStats.filter((l) => l.playerId === benched.id).length; return n; };
    expect(seen()).toBe(0);
    expect(seen({ allowInactive: true })).toBeGreaterThan(0);
  });
  it('credits a two-way player (QB and FS) on both sides of the ball', () => {
    const a = makeTeam('AAA');
    a.roster = a.roster.filter((p) => p.position !== 'FS' && p.id !== 'AAA-QB2');
    a.roster.find((p) => p.id === 'AAA-QB1')!.secondary = ['FS'];
    let pass = 0, tackles = 0;
    for (let i = 0; i < 30; i++) {
      const l = game(`twoway-${i}`, a).playerStats.find((x) => x.playerId === 'AAA-QB1')!;
      pass += l.passAtt; tackles += l.tklSolo + l.tklAst + l.pd + l.defInt;
    }
    expect(pass).toBeGreaterThan(0);
    expect(tackles).toBeGreaterThan(0);
  });
  it('stops instead of inventing a player when a required position is missing', () => {
    const noQb = makeTeam('AAA'); noQb.roster = noQb.roster.filter((p) => p.position !== 'QB');
    expect(() => game('x', noQb)).toThrow(SimError);
    expect(checkRoster(noQb).errors.join(' ')).toMatch(/no rostered QB/);
    const noRec = makeTeam('AAA'); noRec.roster = noRec.roster.filter((p) => !['WR', 'TE', 'RB', 'FB'].includes(p.position));
    expect(() => game('x', noRec)).toThrow(/no rostered receiver/);
    const empty = makeTeam('AAA'); empty.roster = [];
    expect(() => game('x', empty)).toThrow(SimError);
  });
  it('falls back to authorized secondary positions, then to team-level attribution, never to made-up names', () => {
    // WR listed with QB as a secondary position becomes the passer when no QB is rostered.
    const sec = makeTeam('AAA'); sec.roster = sec.roster.filter((p) => p.position !== 'QB');
    sec.roster.find((p) => p.id === 'AAA-WR4')!.secondary = ['QB'];
    expect(game('sec', sec).playerStats.find((l) => l.playerId === 'AAA-WR4')!.passAtt).toBeGreaterThan(10);
    // No kicker: no field goals or extra points are attempted; the team goes for two.
    const noK = makeTeam('AAA'); noK.roster = noK.roster.filter((p) => p.position !== 'K' && p.position !== 'P');
    let kicks = 0, twos = 0, teamPunts = 0;
    for (let i = 0; i < 12; i++) {
      const r = game(`nok-${i}`, noK);
      expect(allValid(r)).toBe(true);
      kicks += r.plays.filter((p) => p.offense === 0 && (p.type === 'field_goal' || p.type === 'extra_point')).length;
      twos += r.plays.filter((p) => p.offense === 0 && p.type === 'two_point').length;
      teamPunts += r.teamStats[0].teamPunts;
      expect(r.warnings.join(' ')).toMatch(/no K/);
    }
    expect(kicks).toBe(0); expect(twos).toBeGreaterThan(0); expect(teamPunts).toBeGreaterThan(0);
    // A tiny roster (offense only) still produces a valid game with team-credited defense.
    const tiny = makeTeam('AAA'); tiny.roster = tiny.roster.filter((p) => ['QB', 'RB', 'WR'].includes(p.position) && p.depth === 1);
    const r = game('tiny', tiny);
    expect(allValid(r)).toBe(true);
    expect(new Set(r.playerStats.filter((l) => l.side === 0).map((l) => l.playerId)).size).toBeLessThanOrEqual(3);
    expect(r.teamStats[0].teamSacks + r.teamStats[0].teamInt + r.teamStats[0].teamFr).toBeGreaterThanOrEqual(0);
  });
  it('gives starters more work than reserves, with week-to-week variation', () => {
    let rb1 = 0, rb2 = 0, wr1 = 0, wr4 = 0;
    const rb1Games = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const r = game(`usage-${i}`);
      const g = (id: string) => r.playerStats.find((l) => l.playerId === id);
      rb1 += g('AAA-RB1')?.rushAtt ?? 0; rb2 += g('AAA-RB2')?.rushAtt ?? 0; wr1 += g('AAA-WR1')?.targets ?? 0; wr4 += g('AAA-WR4')?.targets ?? 0;
      rb1Games.add(g('AAA-RB1')?.rushYds ?? 0);
    }
    expect(rb1).toBeGreaterThan(rb2 * 1.5);
    expect(wr1).toBeGreaterThan(wr4 * 1.5);
    expect(rb1Games.size).toBeGreaterThan(20); // not the same stat line every week
  });
});

describe('statistical consistency', () => {
  const sum = (r: GameResult, side: number, f: (l: GameResult['playerStats'][number]) => number) => r.playerStats.filter((l) => l.side === side).reduce((a, l) => a + f(l), 0);
  it('reconciles player totals, team totals, touchdowns, points and turnovers', () => {
    for (let i = 0; i < 60; i++) {
      const r = game(`recon-${i}`);
      for (const s of [0, 1]) {
        const t = r.teamStats[s], o = r.teamStats[1 - s];
        expect(sum(r, s, (l) => l.passYds)).toBe(t.passYds);
        expect(sum(r, s, (l) => l.recYds)).toBe(t.passYds);
        expect(sum(r, s, (l) => l.passCmp)).toBe(sum(r, s, (l) => l.rec));
        expect(sum(r, s, (l) => l.passTd)).toBe(sum(r, s, (l) => l.recTd));
        expect(sum(r, s, (l) => l.rushYds) + t.teamRushYds).toBe(t.rushYds);
        expect(t.totalYds).toBe(t.passYds + t.rushYds);
        // Defensive takeaways equal the opponent's giveaways.
        expect(sum(r, s, (l) => l.defInt) + t.teamInt).toBe(o.intThrown);
        expect(sum(r, s, (l) => l.fr) + t.teamFr).toBe(o.fumblesLost);
        expect(o.turnovers).toBe(o.intThrown + o.fumblesLost);
        // Sacks: defenders' sacks equal the times the opposing passers went down, and count as QB rushes (NCAA).
        expect(Math.round(sum(r, s, (l) => l.sacks) + t.teamSacks)).toBe(sum(r, 1 - s, (l) => l.sacked));
        // Points are composed of touchdowns, kicks and safeties.
        const td = r.plays.filter((p) => p.td === s).length;
        const fg = sum(r, s, (l) => l.fgm), xp = sum(r, s, (l) => l.xpm);
        const two = r.plays.filter((p) => p.type === 'two_point' && p.good && p.offense === s).length;
        const saf = r.plays.filter((p) => p.points?.kind === 'SAFETY' && p.points.side === s).length;
        expect(6 * td + 3 * fg + xp + 2 * two + 2 * saf).toBe(r.final[s]);
        expect(sum(r, s, (l) => l.rushTd + l.recTd + l.defTd + l.krTd + l.prTd)).toBe(td);
      }
    }
  });
  it('applies the configured sack convention', () => {
    const ncaa = game('sacks-1'), nfl = game('sacks-1', makeTeam('AAA'), makeTeam('HHH'), { sackConvention: 'nfl' });
    expect(ncaa.final).toEqual(nfl.final);
    for (const s of [0, 1]) {
      const lost = ncaa.teamStats[1 - s].sackYds;
      expect(nfl.teamStats[s].rushYds).toBe(ncaa.teamStats[s].rushYds + lost);
      expect(nfl.teamStats[s].passYds).toBe(ncaa.teamStats[s].passYds - lost);
      expect(nfl.teamStats[s].totalYds).toBe(ncaa.teamStats[s].totalYds);
    }
    expect(allValid(nfl)).toBe(true);
  });
  it('references a real stored play from every highlight and selects a sensible number', () => {
    for (let i = 0; i < 30; i++) {
      const r = game(`hl-${i}`);
      const seqs = new Map(r.plays.map((p) => [p.seq, p]));
      expect(r.highlights.length).toBeGreaterThanOrEqual(5);
      expect(r.highlights.length).toBeLessThanOrEqual(16);
      let last = 0;
      for (const h of r.highlights) {
        const p = seqs.get(h.playSeq)!;
        expect(p).toBeTruthy();
        expect(h.text.startsWith(p.desc)).toBe(true);
        expect(h.playSeq).toBeGreaterThan(last); // chronological
        last = h.playSeq;
      }
      expect(r.recap.text).toContain(`${Math.max(...r.final)}-${Math.min(...r.final)}`);
    }
  });
});

describe('independent percentages', () => {
  const cfg = DEFAULT_CONFIG;
  const run = (a: TeamInput, h: TeamInput, seed = 'pct') => runPercentageChecks(seed, [a, h], [buildLineup(a), buildLineup(h)], cfg);
  it('rolls Activity, Upset and Star as separate checks against their own percentage only', () => {
    const base = run(makeTeam('AAA', { pct: { activity: 85, upset: 35, star: 70 } }), makeTeam('HHH', { pct: { activity: 45, upset: 65, star: 20 } }));
    const cats = new Set(base.checks.map((c) => c.category));
    expect(cats).toEqual(new Set(['activity', 'upset', 'star']));
    for (const c of base.checks) {
      const want = { activity: c.side === 0 ? 85 : 45, upset: c.side === 0 ? 35 : 65, star: c.side === 0 ? 70 : 20 }[c.category];
      expect(c.percentage).toBe(want);
      expect(c.passed).toBe(c.roll < c.percentage);
    }
    // Changing one category changes only that category's outcomes: the others keep the same rolls and results.
    const moreStar = run(makeTeam('AAA', { pct: { activity: 85, upset: 35, star: 5 } }), makeTeam('HHH', { pct: { activity: 45, upset: 65, star: 20 } }));
    const pick = (r: typeof base, cat: string) => r.checks.filter((c) => c.category === cat).map((c) => [c.side, c.scope, c.roll, c.passed]);
    expect(pick(moreStar, 'activity')).toEqual(pick(base, 'activity'));
    expect(pick(moreStar, 'upset')).toEqual(pick(base, 'upset'));
    expect(pick(moreStar, 'star').map((c) => c[2])).toEqual(pick(base, 'star').map((c) => c[2])); // same rolls
    expect(pick(moreStar, 'star')).not.toEqual(pick(base, 'star')); // different outcomes
  });
  it('never merges the three: 100/0/0, 0/100/0 and 0/0/100 produce three different sets of effects', () => {
    const only = (pct: TeamInput['pct']) => run(makeTeam('AAA', { pct, rating: 65 }), makeTeam('HHH', { rating: 80 })).state[0];
    const act = only({ activity: 100, upset: 0, star: 0 }), ups = only({ activity: 0, upset: 100, star: 0 }), star = only({ activity: 0, upset: 0, star: 100 });
    expect(act.activity.every(Boolean)).toBe(true); expect(act.upset).toEqual([false, false]); expect(act.stars.size).toBe(0);
    expect(ups.activity.some(Boolean)).toBe(false); expect(ups.upset).toEqual([true, true]); expect(ups.stars.size).toBe(0);
    expect(star.activity.some(Boolean)).toBe(false); expect(star.upset).toEqual([false, false]); expect(star.stars.size).toBeGreaterThanOrEqual(3);
  });
  it('gives each category a distinct, measurable effect on the game', () => {
    const N = 160;
    const avg = (aPct: TeamInput['pct'], rating = 75, f: (r: GameResult) => number) => { let t = 0; for (let i = 0; i < N; i++) t += f(game(`eff-${i}`, makeTeam('AAA', { pct: aPct, rating }), makeTeam('HHH', { pct: { activity: 50, upset: 0, star: 0 } }))); return t / N; };
    const none = { activity: 0, upset: 0, star: 0 };
    // Activity: preparedness shows up as fewer penalties.
    expect(avg({ ...none, activity: 100 }, 75, (r) => r.teamStats[0].penalties)).toBeLessThan(avg(none, 75, (r) => r.teamStats[0].penalties) - 0.4);
    // Star: the featured receiver's production rises.
    const wr = (r: GameResult) => r.playerStats.find((l) => l.playerId === 'AAA-WR1')?.recYds ?? 0;
    expect(avg({ ...none, star: 100 }, 75, wr)).toBeGreaterThan(avg(none, 75, wr) + 8);
    // Upset: an underdog wins more often; a favorite gets nothing from it.
    const win = (r: GameResult) => (r.final[0] > r.final[1] ? 1 : 0);
    expect(avg({ ...none, upset: 100 }, 66, win)).toBeGreaterThan(avg(none, 66, win) + 0.05);
    const fav = run(makeTeam('AAA', { pct: { ...none, upset: 100 }, rating: 90 }), makeTeam('HHH', { rating: 70 }));
    expect(fav.state[0].upsetBonus).toBe(0);
    expect(fav.checks.find((c) => c.category === 'upset' && c.side === 0)!.effect).toMatch(/no effect/);
  });
  it('refuses to simulate with missing or out-of-range percentages', () => {
    expect(() => game('x', makeTeam('AAA', { pct: { activity: NaN, upset: 10, star: 10 } }))).toThrow(/never invented/);
    expect(() => game('x', makeTeam('AAA', { pct: { activity: 50, upset: 140, star: 10 } }))).toThrow(SimError);
    expect(() => game('x', makeTeam('AAA', { pct: undefined as unknown as TeamInput['pct'] }))).toThrow(SimError);
  });
  it('records every check, with its roll and effect, on the result', () => {
    const r = game('transparent');
    expect(r.percentageChecks.filter((c) => c.category === 'activity')).toHaveLength(10); // 5 periods x 2 teams
    expect(r.percentageChecks.filter((c) => c.category === 'upset')).toHaveLength(4);
    expect(r.percentageChecks.filter((c) => c.category === 'star').length).toBeGreaterThanOrEqual(6);
    for (const c of r.percentageChecks) { expect(typeof c.roll).toBe('number'); expect(c.effect.length).toBeGreaterThan(5); }
  });
});
