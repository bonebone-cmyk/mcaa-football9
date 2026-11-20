import type { DefScheme, Position, RosterPlayer, TeamInput } from './types';
import { SimError } from './types';

/** A rostered player slotted into a role, with a usage weight. Never contains anyone who is not on the roster. */
export interface Slot {
  p: RosterPlayer;
  w: number;
}

export interface Lineup {
  qbs: Slot[];
  rushers: Slot[];
  receivers: Slot[];
  kicker: RosterPlayer | null;
  punter: RosterPlayer | null;
  kr: Slot[];
  pr: Slot[];
  defenders: RosterPlayer[];
  ol: RosterPlayer[];
  all: Map<string, RosterPlayer>;
}

const rf = (p: RosterPlayer, pow = 2) => Math.pow((p.rating ?? 70) / 70, pow);

/** Players eligible at any of `positions`: primary-position players first, then authorized secondary positions. */
export function eligible(roster: RosterPlayer[], positions: Position[], allowInactive = false): { p: RosterPlayer; primary: boolean; pos: Position }[] {
  const out: { p: RosterPlayer; primary: boolean; pos: Position }[] = [];
  for (const p of roster) {
    if (!p.active && !allowInactive) continue;
    if (positions.includes(p.position)) out.push({ p, primary: true, pos: p.position });
    else {
      const sec = p.secondary.find((s) => positions.includes(s));
      if (sec) out.push({ p, primary: false, pos: sec });
    }
  }
  out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.p.depth - b.p.depth || (b.p.rating ?? 70) - (a.p.rating ?? 70) || a.p.id.localeCompare(b.p.id));
  return out;
}

const DEPTH_W = [1, 0.4, 0.16, 0.07, 0.04];
const WR_W = [1, 0.82, 0.62, 0.34, 0.18, 0.1];
const TE_W = [0.55, 0.2, 0.08];
const RB_REC_W = [0.36, 0.15, 0.06];

function slots(list: { p: RosterPlayer; primary: boolean }[], weights: number[], base = 1): Slot[] {
  return list.map((e, i) => ({ p: e.p, w: base * (weights[Math.min(i, weights.length - 1)] ?? 0.03) * (e.primary ? 1 : 0.6) * rf(e.p) }));
}

export function buildLineup(team: TeamInput, allowInactive = false): Lineup {
  const r = team.roster;
  const all = new Map<string, RosterPlayer>();
  for (const p of r) if (p.active || allowInactive) all.set(p.id, p);

  const qbs = slots(eligible(r, ['QB'], allowInactive), [1, 0.02, 0.01]);
  const rushers = [...slots(eligible(r, ['RB'], allowInactive), DEPTH_W), ...slots(eligible(r, ['FB'], allowInactive), [0.2, 0.06])];
  const receivers: Slot[] = [];
  const seen = new Set<string>();
  const add = (list: Slot[]) => {
    for (const s of list) if (!seen.has(s.p.id)) (seen.add(s.p.id), receivers.push(s));
  };
  add(slots(eligible(r, ['WR'], allowInactive), WR_W));
  add(slots(eligible(r, ['TE'], allowInactive), TE_W));
  add(slots(eligible(r, ['RB'], allowInactive), RB_REC_W));
  add(slots(eligible(r, ['FB'], allowInactive), [0.08, 0.03]));

  const kicker = eligible(r, ['K'], allowInactive)[0]?.p ?? null;
  const punter = eligible(r, ['P'], allowInactive)[0]?.p ?? eligible(r, ['K'], allowInactive)[0]?.p ?? null;
  const krList = eligible(r, ['KR'], allowInactive);
  const prList = eligible(r, ['PR'], allowInactive);
  const fallbackRet = eligible(r, ['WR', 'RB', 'CB'], allowInactive).slice(0, 2);
  const kr = slots(krList.length ? krList : fallbackRet, [1, 0.5, 0.2]);
  const pr = slots(prList.length ? prList : fallbackRet, [1, 0.3, 0.1]);

  const defenders = eligible(r, ['DE', 'DT', 'EDGE', 'LB', 'CB', 'FS', 'SS'], allowInactive).map((e) => e.p);
  const ol: RosterPlayer[] = [];
  for (const pos of ['LT', 'LG', 'C', 'RG', 'RT'] as Position[]) {
    const s = eligible(r, [pos], allowInactive).find((e) => !ol.includes(e.p));
    if (s) ol.push(s.p);
  }
  return { qbs, rushers, receivers, kicker, punter, kr, pr, defenders, ol, all };
}

export interface RosterCheck {
  errors: string[];
  warnings: string[];
}

/** Roster preflight. Errors block the simulation; warnings describe team-level attribution that will be used. */
export function checkRoster(team: TeamInput, allowInactive = false): RosterCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const l = buildLineup(team, allowInactive);
  if (l.all.size === 0) errors.push(`${team.name} has no active rostered players.`);
  else {
    if (l.qbs.length === 0) errors.push(`${team.name} has no rostered QB (primary or secondary). Add a quarterback before simulating.`);
    const nonQbReceivers = l.receivers.filter((s) => l.qbs.length !== 1 || s.p.id !== l.qbs[0].p.id);
    if (nonQbReceivers.length === 0) errors.push(`${team.name} has no rostered receiver (WR, TE, RB or FB) other than the quarterback.`);
    if (l.rushers.length === 0 && l.qbs.length) warnings.push(`${team.name} has no RB/FB: every designed run is a quarterback keeper.`);
    if (!l.kicker) warnings.push(`${team.name} has no K: the team goes for two after touchdowns and never attempts field goals.`);
    if (!l.punter) warnings.push(`${team.name} has no P or K: punts are credited to the team, not an individual.`);
    if (l.defenders.length === 0) warnings.push(`${team.name} has no defensive players: tackles, sacks and takeaways are credited to the team.`);
    if (l.ol.length === 0) warnings.push(`${team.name} has no offensive linemen: line snaps and sacks allowed are not tracked individually.`);
    if (l.kr.length === 0) warnings.push(`${team.name} has no eligible returner: kickoffs and punts are not returned.`);
  }
  return { errors, warnings };
}

export function assertRoster(team: TeamInput, allowInactive = false): string[] {
  const c = checkRoster(team, allowInactive);
  if (c.errors.length) throw new SimError('ROSTER', c.errors[0], c.errors);
  return c.warnings;
}

type DefRole = 'runTackle' | 'passTackle' | 'sack' | 'int' | 'pd' | 'block';
const DEF_W: Record<DefRole, Partial<Record<Position, number>>> = {
  runTackle: { LB: 1, DT: 0.55, DE: 0.6, EDGE: 0.6, SS: 0.7, FS: 0.5, CB: 0.35 },
  passTackle: { CB: 0.9, FS: 0.7, SS: 0.75, LB: 0.8, DE: 0.1, DT: 0.08, EDGE: 0.15 },
  sack: { DE: 1, EDGE: 1.1, DT: 0.6, LB: 0.5, SS: 0.12, CB: 0.08, FS: 0.08 },
  int: { CB: 1, FS: 0.9, SS: 0.7, LB: 0.4, DE: 0.03, DT: 0.02, EDGE: 0.04 },
  pd: { CB: 1, FS: 0.6, SS: 0.55, LB: 0.35, DE: 0.1, DT: 0.08, EDGE: 0.1 },
  block: { DE: 1, DT: 1, EDGE: 0.8, LB: 0.4, CB: 0.3, FS: 0.2, SS: 0.2 },
};
const DEFENSE = ['DE', 'DT', 'EDGE', 'LB', 'CB', 'FS', 'SS'];

export function defPos(p: RosterPlayer): Position {
  if (DEFENSE.includes(p.position)) return p.position;
  return p.secondary.find((s) => DEFENSE.includes(s)) ?? p.position;
}

export function defWeight(p: RosterPlayer, role: DefRole, scheme: DefScheme, stars: Set<string>): number {
  const pos = defPos(p);
  let w = DEF_W[role][pos] ?? 0;
  if (!DEFENSE.includes(p.position)) w *= 0.6;
  w *= DEPTH_W[Math.min(Math.max(p.depth, 1) - 1, DEPTH_W.length - 1)] ** 0.6;
  w *= rf(p, 2.5);
  if (role === 'sack' && scheme === 'Blitz Heavy' && ['LB', 'SS', 'CB', 'FS'].includes(pos)) w *= 1.8;
  if (role === 'sack' && scheme === '3-4' && (pos === 'LB' || pos === 'EDGE')) w *= 1.4;
  if ((role === 'int' || role === 'pd') && (scheme === '4-2-5' || scheme === '3-3-5' || scheme === 'Nickel') && ['CB', 'FS', 'SS'].includes(pos)) w *= 1.2;
  if (stars.has(p.id)) w *= 1.9;
  return w;
}
