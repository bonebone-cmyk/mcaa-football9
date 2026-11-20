// Every statistic is derived from the play ledger. Nothing here invents a number: if it is not in a play, it is not in the box score.
import { buildLineup } from './roster';
import { other, type Play, type PlayerLine, type ScoringEvent, type Side, type SimConfig, type TeamInput, type TeamLine } from './types';

export function emptyPlayerLine(playerId: string, side: Side): PlayerLine {
  return {
    playerId, side,
    passAtt: 0, passCmp: 0, passYds: 0, passTd: 0, passInt: 0, passLong: 0, sacked: 0, sackYdsLost: 0,
    rushAtt: 0, rushYds: 0, rushTd: 0, rushLong: 0, fumbles: 0, fumblesLost: 0,
    targets: 0, rec: 0, recYds: 0, recTd: 0, recLong: 0,
    tklSolo: 0, tklAst: 0, tfl: 0, sacks: 0, defInt: 0, intRetYds: 0, pd: 0, ff: 0, fr: 0, defTd: 0, blocks: 0,
    fgm: 0, fga: 0, fgLong: 0, xpm: 0, xpa: 0, kickoffs: 0, koTouchbacks: 0,
    punts: 0, puntYds: 0, puntLong: 0, puntIn20: 0,
    kr: 0, krYds: 0, krTd: 0, pr: 0, prYds: 0, prTd: 0,
    twoPt: 0, olSnaps: 0, sacksAllowed: 0, penalties: 0, penaltyYds: 0,
  };
}

export function emptyTeamLine(side: Side): TeamLine {
  return {
    side, points: 0, totalYds: 0, passYds: 0, rushYds: 0, plays: 0, passAtt: 0, passCmp: 0, rushAtt: 0,
    firstDowns: 0, firstDownsRush: 0, firstDownsPass: 0, firstDownsPen: 0, thirdAtt: 0, thirdConv: 0, fourthAtt: 0, fourthConv: 0,
    turnovers: 0, intThrown: 0, fumblesLost: 0, penalties: 0, penaltyYds: 0, top: 0, sacks: 0, sackYds: 0,
    rzAtt: 0, rzScores: 0, rzTd: 0, punts: 0, puntYds: 0,
    teamRushAtt: 0, teamRushYds: 0, teamTackles: 0, teamSacks: 0, teamInt: 0, teamFr: 0, teamPunts: 0, teamPuntYds: 0,
  };
}

export interface ComputedStats {
  playerStats: PlayerLine[];
  teamStats: [TeamLine, TeamLine];
  quarters: [number[], number[]];
  scoring: ScoringEvent[];
  final: [number, number];
}

export function scorer(p: Play): string | null {
  if (!p.points) return null;
  switch (p.type) {
    case 'run': return p.td === p.offense ? p.rusher ?? null : p.points.kind === 'SAFETY' ? p.tacklers?.[0] ?? null : p.recoveredBy ?? null;
    case 'pass': return p.td === p.offense ? p.target ?? null : p.interceptor ?? p.recoveredBy ?? null;
    case 'sack': return p.points.kind === 'SAFETY' ? p.sackers?.[0] ?? null : p.recoveredBy ?? null;
    case 'kickoff': case 'punt': return p.returner ?? null;
    case 'field_goal': case 'extra_point': return p.kicker ?? null;
    case 'two_point': return p.target ?? p.rusher ?? null;
    default: return null;
  }
}

export function computeStats(plays: Play[], teams: [TeamInput, TeamInput], cfg: Pick<SimConfig, 'sackConvention' | 'quarterSeconds' | 'allowInactive'>): ComputedStats {
  const lines = new Map<string, PlayerLine>();
  const sideOf = new Map<string, Side>();
  const lineups = [buildLineup(teams[0], cfg.allowInactive), buildLineup(teams[1], cfg.allowInactive)] as const;
  for (const s of [0, 1] as Side[]) for (const id of lineups[s].all.keys()) sideOf.set(id, s);
  // Unknown ids are still tallied (under side -1 semantics) so that validation can flag them instead of silently dropping them.
  const L = (id: string | undefined, fallbackSide: Side): PlayerLine | null => {
    if (!id) return null;
    let l = lines.get(id);
    if (!l) lines.set(id, (l = emptyPlayerLine(id, sideOf.get(id) ?? fallbackSide)));
    return l;
  };
  const T: [TeamLine, TeamLine] = [emptyTeamLine(0), emptyTeamLine(1)];
  const quarters: [number[], number[]] = [[0, 0, 0, 0], [0, 0, 0, 0]];
  const scoring: ScoringEvent[] = [];
  const ncaa = cfg.sackConvention === 'ncaa';
  const rz = new Map<number, { side: Side; scored: boolean; td: boolean }>();

  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const off = p.offense;
    const def = other(off);
    const to = T[off];
    const td = T[def];

    // Time of possession: the clock that runs off between this snap and the next one in the same period.
    if (p.quarter <= 4) {
      const nx = plays[i + 1];
      const end = nx && nx.quarter === p.quarter ? nx.clock : 0;
      T[p.poss].top += Math.max(0, p.clock - end);
    }
    if (p.points) {
      const s = p.points.side;
      T[s].points += p.points.pts;
      while (quarters[0].length < p.quarter) (quarters[0].push(0), quarters[1].push(0));
      quarters[s][p.quarter - 1] += p.points.pts;
      scoring.push({ playSeq: p.seq, quarter: p.quarter, clock: p.clock, side: s, kind: p.points.kind, pts: p.points.pts, playerId: scorer(p), desc: p.desc, score: [p.scoreAfter[0], p.scoreAfter[1]] });
    }
    const scrimmage = p.type === 'run' || p.type === 'pass' || p.type === 'sack' || p.type === 'kneel';
    if (scrimmage) {
      to.plays++;
      for (const o of lineups[off].ol) L(o.id, off)!.olSnaps++;
      if (p.down === 3) (to.thirdAtt++, (p.firstDown || p.td === off) && to.thirdConv++);
      if (p.down === 4) (to.fourthAtt++, (p.firstDown || p.td === off) && to.fourthConv++);
      if (p.drive && p.ballOn >= 80 && !rz.has(p.drive)) rz.set(p.drive, { side: off, scored: false, td: false });
    }
    if (p.drive && p.points && p.points.side === off && rz.has(p.drive)) {
      const r = rz.get(p.drive)!;
      if (p.points.kind === 'TD') (r.scored = true), (r.td = true);
      if (p.points.kind === 'FG') r.scored = true;
    }
    const tackles = () => {
      const t = p.tacklers ?? [];
      const loss = p.yards < 0;
      for (const id of t) {
        const l = L(id, def)!;
        if (t.length === 1) l.tklSolo++;
        else l.tklAst++;
        if (loss) l.tfl += 1 / t.length;
      }
    };
    const fumble = () => {
      if (!p.fumbler) return;
      const f = L(p.fumbler, off)!;
      f.fumbles++;
      if (p.forcedBy) L(p.forcedBy, def)!.ff++;
      if (p.fumbleLost) {
        f.fumblesLost++;
        to.fumblesLost++;
        to.turnovers++;
        if (p.recoveredBy) {
          const r = L(p.recoveredBy, def)!;
          r.fr++;
          if (p.td === def) r.defTd++;
        } else td.teamFr++;
      }
    };

    switch (p.type) {
      case 'run': {
        to.rushAtt++;
        to.rushYds += p.yards;
        const r = L(p.rusher, off);
        if (r) {
          r.rushAtt++;
          r.rushYds += p.yards;
          r.rushLong = Math.max(r.rushLong, p.yards);
          if (p.td === off) r.rushTd++;
        } else (to.teamRushAtt++, (to.teamRushYds += p.yards));
        if (p.firstDown) (to.firstDowns++, to.firstDownsRush++);
        tackles();
        fumble();
        break;
      }
      case 'kneel':
        to.rushAtt++;
        to.rushYds += p.yards;
        to.teamRushAtt++;
        to.teamRushYds += p.yards;
        break;
      case 'sack': {
        const qb = L(p.passer, off);
        if (qb) (qb.sacked++, (qb.sackYdsLost += -p.yards));
        td.sacks++;
        td.sackYds += -p.yards;
        if (ncaa) {
          to.rushAtt++;
          to.rushYds += p.yards;
          if (qb) (qb.rushAtt++, (qb.rushYds += p.yards));
          else (to.teamRushAtt++, (to.teamRushYds += p.yards));
        } else to.passYds += p.yards;
        const s = p.sackers ?? [];
        if (!s.length) td.teamSacks++;
        for (const id of s) {
          const l = L(id, def)!;
          l.sacks += 1 / s.length;
          l.tfl += 1 / s.length;
          if (s.length === 1) l.tklSolo++;
          else l.tklAst++;
        }
        if (p.sackAllowedBy) L(p.sackAllowedBy, off)!.sacksAllowed++;
        fumble();
        break;
      }
      case 'pass': {
        to.passAtt++;
        const qb = L(p.passer, off);
        const tg = L(p.target, off);
        if (qb) qb.passAtt++;
        if (tg) tg.targets++;
        if (p.complete) {
          to.passCmp++;
          to.passYds += p.yards;
          if (qb) (qb.passCmp++, (qb.passYds += p.yards), (qb.passLong = Math.max(qb.passLong, p.yards)), p.td === off && qb.passTd++);
          if (tg) (tg.rec++, (tg.recYds += p.yards), (tg.recLong = Math.max(tg.recLong, p.yards)), p.td === off && tg.recTd++);
          if (p.firstDown) (to.firstDowns++, to.firstDownsPass++);
          tackles();
          fumble();
        } else if (p.turnover === 'interception') {
          to.intThrown++;
          to.turnovers++;
          if (qb) qb.passInt++;
          const d = L(p.interceptor, def);
          if (d) (d.defInt++, (d.intRetYds += p.returnYards ?? 0), p.td === def && d.defTd++);
          else td.teamInt++;
        } else if (p.pd) L(p.pd, def)!.pd++;
        break;
      }
      case 'punt': {
        to.punts++;
        to.puntYds += p.kickYards ?? 0;
        const k = L(p.punter, off);
        if (k) (k.punts++, (k.puntYds += p.kickYards ?? 0), (k.puntLong = Math.max(k.puntLong, p.kickYards ?? 0)), p.inside20 && k.puntIn20++);
        else (to.teamPunts++, (to.teamPuntYds += p.kickYards ?? 0));
        const r = L(p.returner, def);
        if (r && !p.fairCatch) (r.pr++, (r.prYds += p.returnYards ?? 0), p.td === def && r.prTd++);
        break;
      }
      case 'kickoff': {
        const k = L(p.kicker, off);
        if (k) (k.kickoffs++, p.touchback && k.koTouchbacks++);
        const r = L(p.returner, def);
        if (r) (r.kr++, (r.krYds += p.returnYards ?? 0), p.td === def && r.krTd++);
        break;
      }
      case 'field_goal': {
        const k = L(p.kicker, off);
        if (k) (k.fga++, p.good && (k.fgm++, (k.fgLong = Math.max(k.fgLong, p.fgDistance ?? 0))));
        if (p.blockedBy) L(p.blockedBy, def)!.blocks++;
        break;
      }
      case 'extra_point': {
        const k = L(p.kicker, off);
        if (k) (k.xpa++, p.good && k.xpm++);
        break;
      }
      case 'two_point':
        if (p.good) {
          const a = L(p.target ?? p.rusher, off);
          if (a) a.twoPt++;
          if (p.passer) L(p.passer, off)!.twoPt++;
        }
        break;
      case 'penalty': {
        const pen = p.penalty!;
        T[pen.side].penalties++;
        T[pen.side].penaltyYds += pen.yards;
        const l = L(pen.player, pen.side);
        if (l) (l.penalties++, (l.penaltyYds += pen.yards));
        if (p.firstDown) (to.firstDowns++, to.firstDownsPen++);
        break;
      }
    }
  }
  for (const r of rz.values()) {
    T[r.side].rzAtt++;
    if (r.scored) T[r.side].rzScores++;
    if (r.td) T[r.side].rzTd++;
  }
  for (const t of T) t.totalYds = t.passYds + t.rushYds;
  const round = (n: number) => Math.round(n * 10) / 10;
  const playerStats = [...lines.values()].map((l) => ({ ...l, sacks: round(l.sacks), tfl: round(l.tfl) }));
  playerStats.sort((a, b) => a.side - b.side || a.playerId.localeCompare(b.playerId));
  return { playerStats, teamStats: T, quarters, scoring, final: [T[0].points, T[1].points] };
}

/** NCAA passing efficiency rating. */
export function passerRating(cmp: number, att: number, yds: number, td: number, int: number): number {
  if (!att) return 0;
  return Math.round(((8.4 * yds + 330 * td + 100 * cmp - 200 * int) / att) * 10) / 10;
}
