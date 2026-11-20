import type { Play, Side } from './types';

export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const periodLabel = (q: number) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`);

/** Field position label from the offense's yards-from-own-goal. */
export function spot(ballOn: number, off: Side, abbr: [string, string]): string {
  const b = Math.max(1, Math.min(99, Math.round(ballOn)));
  if (b === 50) return '50';
  return b < 50 ? `${abbr[off]} ${b}` : `${abbr[off === 0 ? 1 : 0]} ${100 - b}`;
}

const gain = (y: number) => (y > 0 ? `for ${y} yard${y === 1 ? '' : 's'}` : y === 0 ? 'for no gain' : `for a loss of ${-y} yard${y === -1 ? '' : 's'}`);
const ord = (n: number) => ['', '1st', '2nd', '3rd', '4th'][n] ?? `${n}th`;

export function downLabel(p: Play): string {
  if (p.down == null || p.distance == null) return '';
  const toGoal = 100 - p.ballOn;
  return `${ord(p.down)} & ${p.distance >= toGoal ? 'Goal' : p.distance}`;
}

export function playResult(p: Play): string {
  if (p.points?.kind === 'SAFETY') return 'SAFETY';
  if (p.td != null) return 'TOUCHDOWN';
  if (p.type === 'field_goal') return p.good ? 'FIELD GOAL' : p.blockedBy ? 'BLOCKED' : 'NO GOOD';
  if (p.type === 'extra_point') return p.good ? 'PAT GOOD' : 'PAT NO GOOD';
  if (p.type === 'two_point') return p.good ? '2-PT GOOD' : '2-PT FAILED';
  if (p.turnover === 'interception') return 'INTERCEPTION';
  if (p.turnover === 'fumble') return 'FUMBLE LOST';
  if (p.turnover === 'downs') return 'TURNOVER ON DOWNS';
  if (p.type === 'punt') return 'PUNT';
  if (p.type === 'kickoff') return 'KICKOFF';
  if (p.type === 'penalty') return 'PENALTY';
  if (p.type === 'timeout') return 'TIMEOUT';
  if (p.type === 'sack') return 'SACK';
  if (p.firstDown) return 'FIRST DOWN';
  return '';
}

export function describePlay(p: Play, name: (id?: string) => string, abbr: [string, string], teamName: [string, string]): string {
  const off = p.offense;
  const def: Side = off === 0 ? 1 : 0;
  const after = () => spot(p.ballOn + p.yards, off, abbr);
  const tk = p.tacklers?.length ? ` (${p.tacklers.map((t) => name(t)).join(', ')})` : '';
  const fum = () => {
    if (!p.fumbler) return '';
    const forced = p.forcedBy ? `, forced by ${name(p.forcedBy)}` : '';
    if (!p.fumbleLost) return ` ${name(p.fumbler)} fumbles${forced}, recovered by ${teamName[off]}.`;
    const rec = p.recoveredBy ? name(p.recoveredBy) : teamName[def];
    return ` ${name(p.fumbler)} FUMBLES${forced}, recovered by ${rec}${p.td === def ? ' and returned for a TOUCHDOWN' : p.returnYards ? `, returned ${p.returnYards} yards` : ''}.`;
  };
  switch (p.type) {
    case 'kickoff': {
      const k = p.kicker ? name(p.kicker) : teamName[off];
      const head = `${k} ${p.freeKick ? 'free kick' : 'kickoff'} ${p.kickYards} yards`;
      if (p.touchback) return `${head}, touchback.`;
      if (!p.returner) return `${head}, fair catch at the ${spot(100 - (p.ballOn + (p.kickYards ?? 0)), def, abbr)}.`;
      if (p.td === def) return `${head}. ${name(p.returner)} returns it ${p.returnYards} yards for a TOUCHDOWN.`;
      return `${head}. ${name(p.returner)} returns ${p.returnYards} yards to the ${spot(100 - (p.ballOn + (p.kickYards ?? 0)) + (p.returnYards ?? 0), def, abbr)}.`;
    }
    case 'run': {
      const who = p.rusher ? name(p.rusher) : teamName[off];
      if (p.td === off) return `${who} rushes ${p.yards} yard${p.yards === 1 ? '' : 's'} for a TOUCHDOWN.`;
      if (p.points?.kind === 'SAFETY') return p.rusher ? `${who} is tackled in the end zone${tk} for a SAFETY.` : `The snap sails out of the end zone for a SAFETY (team loss of ${-p.yards} yards).`;
      return `${who} rush ${gain(p.yards)} to the ${after()}${tk}.${p.firstDown ? ' First down.' : ''}${fum()}`;
    }
    case 'kneel':
      return `${teamName[off]} kneels ${gain(p.yards)}.`;
    case 'sack': {
      const by = p.sackers?.length ? p.sackers.map((s) => name(s)).join(' and ') : teamName[def];
      if (p.points?.kind === 'SAFETY') return `${name(p.passer)} sacked in the end zone by ${by} for a SAFETY.`;
      return `${name(p.passer)} sacked by ${by} ${gain(p.yards)} to the ${after()}.${fum()}`;
    }
    case 'pass': {
      const qb = name(p.passer);
      const tgt = p.target ? name(p.target) : '';
      if (p.turnover === 'interception') {
        const by = p.interceptor ? name(p.interceptor) : teamName[def];
        const ret = p.td === def ? ` and returned ${p.returnYards} yards for a TOUCHDOWN` : p.touchback ? ' in the end zone, touchback' : p.returnYards ? `, returned ${p.returnYards} yards` : '';
        return `${qb} pass${tgt ? ` intended for ${tgt}` : ''} INTERCEPTED by ${by}${ret}.`;
      }
      if (!p.complete) return `${qb} pass incomplete${tgt ? ` to ${tgt}` : ''}${p.pd ? `, broken up by ${name(p.pd)}` : ''}.`;
      if (p.td === off) return `${qb} pass complete to ${tgt} for ${p.yards} yard${p.yards === 1 ? '' : 's'} and a TOUCHDOWN.`;
      return `${qb} pass complete to ${tgt} ${gain(p.yards)} to the ${after()}${tk}.${p.firstDown ? ' First down.' : ''}${fum()}`;
    }
    case 'punt': {
      const who = p.punter ? name(p.punter) : teamName[off];
      const head = `${who} punts ${p.kickYards} yards`;
      if (p.touchback) return `${head}, touchback.`;
      const land = spot(100 - (p.ballOn + (p.kickYards ?? 0)), def, abbr);
      if (p.fairCatch) return `${head}, fair catch${p.returner ? ` by ${name(p.returner)}` : ''} at the ${land}.`;
      if (!p.returner) return `${head}, downed at the ${land}.`;
      if (p.td === def) return `${head}. ${name(p.returner)} returns it ${p.returnYards} yards for a TOUCHDOWN.`;
      return `${head}. ${name(p.returner)} returns ${p.returnYards} yards to the ${spot(100 - (p.ballOn + (p.kickYards ?? 0)) + (p.returnYards ?? 0), def, abbr)}.`;
    }
    case 'field_goal': {
      const k = p.kicker ? name(p.kicker) : teamName[off];
      if (p.good) return `${k} ${p.fgDistance}-yard field goal is GOOD.`;
      if (p.blockedBy) return `${k} ${p.fgDistance}-yard field goal BLOCKED by ${name(p.blockedBy)}.`;
      return `${k} ${p.fgDistance}-yard field goal is NO GOOD.`;
    }
    case 'extra_point':
      return `${p.kicker ? name(p.kicker) : teamName[off]} extra point is ${p.good ? 'GOOD' : 'NO GOOD'}.`;
    case 'two_point': {
      const how = p.passer ? `${name(p.passer)} pass${p.target ? ` to ${name(p.target)}` : ''}` : `${p.rusher ? name(p.rusher) : teamName[off]} rush`;
      return `Two-point conversion: ${how} ${p.good ? 'is GOOD' : 'FAILS'}.`;
    }
    case 'penalty': {
      const pen = p.penalty!;
      return `PENALTY on ${teamName[pen.side]}${pen.player ? ` (${name(pen.player)})` : ''}: ${pen.name}, ${pen.yards} yard${pen.yards === 1 ? '' : 's'}${pen.autoFirst || p.firstDown ? ', first down' : ''}.`;
    }
    case 'timeout':
      return `Timeout ${teamName[p.timeoutBy ?? off]}.`;
  }
}
