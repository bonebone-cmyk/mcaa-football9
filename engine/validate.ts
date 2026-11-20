// Statistical validation. A result may only be approved and published when every check passes.
import { buildLineup } from './roster';
import { computeStats, scorer } from './stats';
import { other, type GameResult, type LockedStats, type Play, type PlayerLine, type Side, type TeamInput, type TeamLine, type ValidationCheck } from './types';

export function lockValue(l: PlayerLine | undefined, key: string): number {
  if (!l) return 0;
  if (key === 'tackles') return l.tklSolo + l.tklAst;
  return (l as unknown as Record<string, number>)[key] ?? 0;
}

export function lockMismatches(playerStats: PlayerLine[], teamStats: [TeamLine, TeamLine], locks: LockedStats | null | undefined, name: (id: string) => string = (id) => id): string[] {
  const out: string[] = [];
  if (!locks) return out;
  const by = new Map(playerStats.map((l) => [l.playerId, l]));
  for (const [pid, stats] of Object.entries(locks.players ?? {})) {
    for (const [key, want] of Object.entries(stats)) {
      const got = lockValue(by.get(pid), key);
      if (Math.abs(got - (want as number)) > 1e-9) out.push(`${name(pid)} ${key}: locked ${want}, reconstructed ${got}`);
    }
  }
  locks.teams?.forEach((t, s) => {
    if (!t) return;
    const ts = teamStats[s];
    if (t.passYds != null && ts.passYds !== t.passYds) out.push(`team ${s} passYds: locked ${t.passYds}, reconstructed ${ts.passYds}`);
    if (t.rushYds != null && ts.rushYds !== t.rushYds) out.push(`team ${s} rushYds: locked ${t.rushYds}, reconstructed ${ts.rushYds}`);
    if (t.turnovers != null && ts.turnovers !== t.turnovers) out.push(`team ${s} turnovers: locked ${t.turnovers}, reconstructed ${ts.turnovers}`);
  });
  return out;
}

/** Verify down, distance and field position are continuous inside every drive. */
export function checkDrives(plays: Play[]): string[] {
  const errs: string[] = [];
  const byDrive = new Map<number, Play[]>();
  for (const p of plays) if (p.drive > 0 && p.type !== 'extra_point' && p.type !== 'two_point' && p.type !== 'timeout') (byDrive.get(p.drive) ?? byDrive.set(p.drive, []).get(p.drive)!).push(p);
  for (const [num, dp] of byDrive) {
    let st: { ballOn: number; down: number; dist: number } | null = null;
    let over = false;
    for (const p of dp) {
      const tag = `drive ${num} play ${p.seq}`;
      if (over) {
        errs.push(`${tag}: play after the drive ended`);
        break;
      }
      if (p.down == null || p.distance == null) {
        errs.push(`${tag}: missing down/distance`);
        break;
      }
      if (!st) {
        if (p.down !== 1 || p.distance !== Math.min(10, 100 - p.ballOn)) errs.push(`${tag}: drive does not start 1st & ${Math.min(10, 100 - p.ballOn)}`);
        st = { ballOn: p.ballOn, down: p.down, dist: p.distance };
      } else if (p.ballOn !== st.ballOn || p.down !== st.down || p.distance !== st.dist) {
        errs.push(`${tag}: expected ${st.down}&${st.dist} at ${st.ballOn}, recorded ${p.down}&${p.distance} at ${p.ballOn}`);
        st = { ballOn: p.ballOn, down: p.down, dist: p.distance };
      }
      if (st.down < 1 || st.down > 4 || st.dist < 1 || st.ballOn < 1 || st.ballOn > 99) errs.push(`${tag}: illegal situation ${st.down}&${st.dist} at ${st.ballOn}`);
      if (p.type === 'penalty') {
        const pen = p.penalty!;
        if (pen.side === p.offense) {
          st.ballOn -= pen.yards;
          st.dist += pen.yards;
        } else {
          st.ballOn += pen.yards;
          const first = !!pen.autoFirst || pen.yards >= st.dist;
          if (first !== !!p.firstDown) errs.push(`${tag}: penalty first-down flag is wrong`);
          if (first) (st.down = 1), (st.dist = Math.min(10, 100 - st.ballOn));
          else st.dist -= pen.yards;
        }
        continue;
      }
      if (p.type === 'punt' || p.type === 'field_goal') {
        over = true;
        continue;
      }
      // run / pass / sack / kneel
      if (p.type === 'pass' && !p.complete && p.yards !== 0) errs.push(`${tag}: incomplete pass with yardage`);
      if (p.turnover === 'interception' || p.turnover === 'fumble') {
        over = true;
        continue;
      }
      const nb: number = st.ballOn + p.yards;
      if (p.td === p.offense) {
        if (nb !== 100) errs.push(`${tag}: touchdown play does not reach the goal line`);
        over = true;
        continue;
      }
      if (p.points?.kind === 'SAFETY') {
        if (nb > 0) errs.push(`${tag}: safety recorded outside the end zone`);
        over = true;
        continue;
      }
      if (nb <= 0 || nb >= 100) {
        errs.push(`${tag}: ball leaves the field without a score`);
        over = true;
        continue;
      }
      const first = p.yards >= st.dist;
      if (first !== !!p.firstDown) errs.push(`${tag}: first-down flag is wrong`);
      if (first) st = { ballOn: nb, down: 1, dist: Math.min(10, 100 - nb) };
      else if (st.down === 4) {
        if (p.turnover !== 'downs') errs.push(`${tag}: failed fourth down without a turnover on downs`);
        over = true;
      } else st = { ballOn: nb, down: st.down + 1, dist: st.dist - p.yards };
    }
  }
  return errs;
}

export function validateGame(r: Pick<GameResult, 'plays' | 'final' | 'quarters' | 'playerStats' | 'teamStats' | 'highlights' | 'config' | 'mode' | 'primetime' | 'overtimePeriods'>, teams: [TeamInput, TeamInput]): ValidationCheck[] {
  const out: ValidationCheck[] = [];
  const add = (check: string, problems: string[]) => out.push({ check, ok: problems.length === 0, detail: problems.length ? problems.slice(0, 6).join('; ') : undefined });
  const calc = computeStats(r.plays, teams, r.config);
  const lineups = [buildLineup(teams[0], r.config.allowInactive), buildLineup(teams[1], r.config.allowInactive)];
  const name = (id: string) => lineups[0].all.get(id)?.name ?? lineups[1].all.get(id)?.name ?? id;

  // 1. Score reconciles with the scoring events in the ledger.
  {
    const e: string[] = [];
    const run: [number, number] = [0, 0];
    for (const p of r.plays) {
      if (p.points) run[p.points.side] += p.points.pts;
      if (p.scoreAfter[0] !== run[0] || p.scoreAfter[1] !== run[1]) {
        e.push(`play ${p.seq}: running score ${p.scoreAfter.join('-')} does not match the ledger ${run.join('-')}`);
        break;
      }
    }
    if (run[0] !== r.final[0] || run[1] !== r.final[1]) e.push(`final ${r.final.join('-')} but the ledger adds up to ${run.join('-')}`);
    add('Final score equals the sum of scoring plays', e);
  }
  // 2. Quarter scores.
  {
    const e: string[] = [];
    for (const s of [0, 1] as Side[]) {
      const sum = r.quarters[s].reduce((a, b) => a + b, 0);
      if (sum !== r.final[s]) e.push(`${teams[s].abbr} period scores add to ${sum}, final is ${r.final[s]}`);
      if (JSON.stringify(calc.quarters[s]) !== JSON.stringify(r.quarters[s])) e.push(`${teams[s].abbr} period scores do not match the ledger`);
    }
    add('Period scores reconcile with the final score', e);
  }
  // 3. Scoring composition.
  {
    const e: string[] = [];
    for (const s of [0, 1] as Side[]) {
      let pts = 0;
      for (const p of r.plays) if (p.points?.side === s) pts += { TD: 6, FG: 3, XP: 1, '2PT': 2, SAFETY: 2 }[p.points.kind] === p.points.pts ? p.points.pts : NaN;
      if (pts !== r.final[s]) e.push(`${teams[s].abbr} touchdowns/kicks/safeties do not compose ${r.final[s]}`);
    }
    add('Touchdowns, kicks and safeties compose the score', e);
  }
  // 4. Roster-only attribution.
  {
    const e: string[] = [];
    const chk = (id: string | undefined, side: Side, role: string, p: Play) => {
      if (id && !lineups[side].all.has(id)) e.push(`play ${p.seq}: ${role} ${id} is not on the active ${teams[side].abbr} roster`);
    };
    for (const p of r.plays) {
      const o = p.offense;
      const d = other(o);
      chk(p.passer, o, 'passer', p); chk(p.rusher, o, 'rusher', p); chk(p.target, o, 'target', p); chk(p.kicker, o, 'kicker', p);
      chk(p.punter, o, 'punter', p); chk(p.fumbler, o, 'fumbler', p); chk(p.sackAllowedBy, o, 'lineman', p);
      for (const t of p.tacklers ?? []) chk(t, d, 'tackler', p);
      for (const t of p.sackers ?? []) chk(t, d, 'sacker', p);
      chk(p.interceptor, d, 'interceptor', p); chk(p.pd, d, 'defender', p); chk(p.forcedBy, d, 'defender', p); chk(p.recoveredBy, d, 'defender', p);
      chk(p.blockedBy, d, 'defender', p); chk(p.returner, d, 'returner', p);
      if (p.penalty) chk(p.penalty.player, p.penalty.side, 'penalized player', p);
    }
    for (const l of calc.playerStats) if (!lineups[l.side].all.has(l.playerId)) e.push(`statistics exist for unrostered player ${l.playerId}`);
    add('Only active rostered players receive statistics', [...new Set(e)]);
  }
  const sum = (s: Side, f: (l: PlayerLine) => number) => calc.playerStats.filter((l) => l.side === s).reduce((a, l) => a + f(l), 0);
  // 5-10. Cross-category balances.
  {
    const e: string[] = [];
    for (const s of [0, 1] as Side[]) {
      const t = calc.teamStats[s];
      const o = calc.teamStats[other(s)];
      const sackYds = r.config.sackConvention === 'nfl' ? o.sackYds : 0;
      if (sum(s, (l) => l.passYds) !== sum(s, (l) => l.recYds)) e.push(`${teams[s].abbr} passing yards ≠ receiving yards`);
      if (sum(s, (l) => l.passYds) - sackYds !== t.passYds) e.push(`${teams[s].abbr} player passing yards ≠ team passing yards`);
      if (sum(s, (l) => l.passCmp) !== sum(s, (l) => l.rec)) e.push(`${teams[s].abbr} completions ≠ receptions`);
      if (sum(s, (l) => l.passTd) !== sum(s, (l) => l.recTd)) e.push(`${teams[s].abbr} passing TDs ≠ receiving TDs`);
      if (sum(s, (l) => l.rushYds) + t.teamRushYds !== t.rushYds) e.push(`${teams[s].abbr} player rushing yards ≠ team rushing yards`);
      if (sum(s, (l) => l.rushAtt) + t.teamRushAtt !== t.rushAtt) e.push(`${teams[s].abbr} player carries ≠ team carries`);
      if (t.totalYds !== t.passYds + t.rushYds) e.push(`${teams[s].abbr} total yards ≠ passing + rushing`);
    }
    add('Passing, receiving and rushing totals reconcile', e);
  }
  {
    const e: string[] = [];
    for (const s of [0, 1] as Side[]) {
      const t = calc.teamStats[s];
      const d = other(s);
      const dt = calc.teamStats[d];
      if (t.intThrown !== sum(d, (l) => l.defInt) + dt.teamInt) e.push(`${teams[s].abbr} interceptions thrown ≠ ${teams[d].abbr} interceptions made`);
      if (t.intThrown !== sum(s, (l) => l.passInt)) e.push(`${teams[s].abbr} team interceptions ≠ passer interceptions`);
      if (t.fumblesLost !== sum(d, (l) => l.fr) + dt.teamFr) e.push(`${teams[s].abbr} fumbles lost ≠ ${teams[d].abbr} fumble recoveries`);
      if (t.turnovers !== t.intThrown + t.fumblesLost) e.push(`${teams[s].abbr} turnovers ≠ interceptions + fumbles lost`);
      const sacks = sum(d, (l) => l.sacks) + dt.teamSacks;
      if (Math.abs(sacks - dt.sacks) > 0.11 || dt.sacks !== sum(s, (l) => l.sacked)) e.push(`${teams[d].abbr} sacks ≠ times ${teams[s].abbr} passers were sacked`);
    }
    add('Defensive takeaways and sacks match offensive turnovers and sacks taken', e);
  }
  {
    const e: string[] = [];
    for (const s of [0, 1] as Side[]) {
      const tdPlays = r.plays.filter((p) => p.td === s);
      const unattributed = tdPlays.filter((p) => !scorer(p)).length;
      const credited = sum(s, (l) => l.rushTd + l.recTd + l.defTd + l.krTd + l.prTd);
      if (tdPlays.length !== credited + unattributed) e.push(`${teams[s].abbr} has ${tdPlays.length} touchdown plays but ${credited} credited touchdowns`);
    }
    add('Player touchdowns reconcile with touchdown plays', e);
  }
  // 11. Possession time.
  {
    const e: string[] = [];
    const total = calc.teamStats[0].top + calc.teamStats[1].top;
    if (total !== 4 * r.config.quarterSeconds) e.push(`time of possession totals ${total}s, regulation is ${4 * r.config.quarterSeconds}s`);
    let lastQ = 0, lastC = Infinity;
    for (const p of r.plays) {
      if (p.quarter < lastQ || (p.quarter === lastQ && p.quarter <= 4 && p.clock > lastC)) {
        e.push(`play ${p.seq}: game clock runs backwards`);
        break;
      }
      (lastQ = p.quarter), (lastC = p.clock);
    }
    add('Game clock and time of possession are consistent', e);
  }
  add('Downs, distance and field position are continuous on every drive', checkDrives(r.plays));
  // Derived statistics supplied with the result must equal what the ledger produces.
  {
    const e: string[] = [];
    if (JSON.stringify(calc.playerStats) !== JSON.stringify(r.playerStats)) e.push('player statistics differ from the ledger');
    if (JSON.stringify(calc.teamStats) !== JSON.stringify(r.teamStats)) e.push('team statistics differ from the ledger');
    add('Stored statistics are exactly the statistics derived from the play ledger', e);
  }
  {
    const seqs = new Set(r.plays.map((p) => p.seq));
    add('Every highlight references a stored play', r.highlights.filter((h) => !seqs.has(h.playSeq)).map((h) => `highlight references missing play ${h.playSeq}`));
  }
  {
    const e: string[] = [];
    if (r.final[0] === r.final[1]) e.push('game ended in a tie');
    if (r.overtimePeriods > 0) {
      const reg = [0, 1].map((s) => r.quarters[s].slice(0, 4).reduce((a, b) => a + b, 0));
      if (reg[0] !== reg[1]) e.push('overtime was played but regulation was not tied');
    } else if (r.quarters[0].length > 4) e.push('overtime periods present without an overtime flag');
    add('Game has a winner and overtime follows a regulation tie', e);
  }
  if (r.mode === 'primetime' && r.primetime) {
    const pt = r.primetime;
    const e: string[] = [];
    if (pt.final[0] !== r.final[0] || pt.final[1] !== r.final[1]) e.push(`imported score ${pt.final.join('-')} but result is ${r.final.join('-')}`);
    add('Imported CFB 27 final score is unchanged', e);
    if (pt.quarters) {
      const q: string[] = [];
      for (const s of [0, 1] as Side[]) if (JSON.stringify(pt.quarters[s]) !== JSON.stringify(r.quarters[s])) q.push(`${teams[s].abbr} imported period scores ${pt.quarters[s].join('/')} but result has ${r.quarters[s].join('/')}`);
      add('Imported period scores are unchanged', q);
    }
    add('Locked CFB 27 statistics are unchanged', lockMismatches(calc.playerStats, calc.teamStats, pt.locks, name));
  }
  return out;
}
