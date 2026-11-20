// MODE B: score-constrained reconstruction of a game that was actually played in CFB 27.
//
// The imported final score, any imported period scores and any locked statistics are AUTHORITATIVE.
// Nothing in this file is allowed to change them. The order of work is:
//   1. establish a set of scoring events that adds up to the imported score exactly,
//   2. reconstruct drives and plays around those events (each drive is produced by the same play engine
//      as a full simulation and kept only if it ends the required way),
//   3. adjust play attribution/yardage until locked statistics match exactly, re-walking every drive so
//      downs, distance and field position stay legal,
//   4. derive all statistics from the finished ledger and validate.
// If the inputs cannot all be true at once, a SimError('CONFLICT') explains why; inputs are never altered.
import { describePlay } from './describe';
import { finalize } from './index';
import { neutralPctState } from './percentages';
import { assertRoster, buildLineup, eligible, type Lineup } from './roster';
import { Rng, clamp } from './rng';
import { GameSim, type Force } from './sim';
import { DEFAULT_CONFIG, LOCKABLE_PLAYER_STATS, SimError, other, type Drive, type DriveResult, type GameResult, type LockablePlayerStat, type Play, type PrimetimeInput, type RosterPlayer, type Side, type SimConfig, type TeamInput } from './types';
import { lockMismatches } from './validate';

type EvKind = 'TD7' | 'TD6' | 'TD8' | 'FG' | 'SAF' | 'INT' | 'FUM' | 'MISSFG';
interface Ev { side: Side; kind: EvKind }
interface TdSpec { kind: 'pass' | 'rush' | 'any'; passer?: string; receiver?: string; rusher?: string }
interface Combo { n7: number; n8: number; n6: number; fg: number; saf: number; w: number }

const conflict = (msg: string, details: string[] = []) => new SimError('CONFLICT', msg, details.length ? details : [msg]);
const sumArr = (a: number[]) => a.reduce((x, y) => x + y, 0);

// ---------------------------------------------------------------------------------- input checks
const CAT: Record<LockablePlayerStat, 'pass' | 'rush' | 'rec' | 'def' | 'kick'> = {
  passAtt: 'pass', passCmp: 'pass', passYds: 'pass', passTd: 'pass', passInt: 'pass',
  rushAtt: 'rush', rushYds: 'rush', rushTd: 'rush', rec: 'rec', recYds: 'rec', recTd: 'rec',
  tackles: 'def', sacks: 'def', defInt: 'def', fgm: 'kick', fga: 'kick', xpm: 'kick', xpa: 'kick',
};
const ELIG: Record<string, string[]> = {
  pass: ['QB'], rush: ['QB', 'RB', 'FB', 'WR', 'TE'], rec: ['WR', 'TE', 'RB', 'FB', 'QB'], def: ['DE', 'DT', 'EDGE', 'LB', 'CB', 'FS', 'SS'], kick: ['K', 'P'],
};

interface LockCtx {
  sideOf: Map<string, Side>;
  get: (pid: string, k: LockablePlayerStat) => number | undefined;
  /** Sum of a locked stat over one side. */
  total: (side: Side, k: LockablePlayerStat) => number;
  has: (side: Side, k: LockablePlayerStat) => boolean;
  ids: (side: Side, k: LockablePlayerStat) => string[];
}

function lockCtx(input: PrimetimeInput, lineups: [Lineup, Lineup]): LockCtx {
  const sideOf = new Map<string, Side>();
  for (const s of [0, 1] as Side[]) for (const id of lineups[s].all.keys()) sideOf.set(id, s);
  const players = input.locks?.players ?? {};
  const get = (pid: string, k: LockablePlayerStat) => players[pid]?.[k];
  const ids = (side: Side, k: LockablePlayerStat) => Object.keys(players).filter((id) => sideOf.get(id) === side && players[id][k] != null);
  return { sideOf, get, ids, total: (side, k) => ids(side, k).reduce((a, id) => a + (players[id][k] as number), 0), has: (side, k) => ids(side, k).length > 0 };
}

/** Problems that can be detected before any reconstruction is attempted. Empty array = inputs are coherent so far. */
export function checkPrimetimeInput(input: PrimetimeInput, teams: [TeamInput, TeamInput]): string[] {
  const errs: string[] = [];
  const [a, h] = input.final ?? [];
  const isScore = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 200;
  if (!isScore(a) || !isScore(h)) return ['Both final scores must be whole numbers between 0 and 200.'];
  if (a === h) errs.push('A final score cannot be tied: college football games are played to a winner.');
  if (a === 1 || h === 1) errs.push('A team cannot finish with exactly 1 point.');
  const q = input.quarters;
  if (q) {
    if (q[0].length !== q[1].length || q[0].length < 4) errs.push('Period scores need four quarters for both teams (plus matching overtime periods, if any).');
    else {
      for (const s of [0, 1] as Side[]) {
        if (q[s].some((v) => !isScore(v))) errs.push(`${teams[s].name}: period scores must be whole numbers.`);
        if (sumArr(q[s]) !== input.final[s]) errs.push(`${teams[s].name}: period scores add up to ${sumArr(q[s])}, but the final score is ${input.final[s]}.`);
        q[s].slice(0, 4).forEach((v, i) => v === 1 && errs.push(`${teams[s].name}: 1 point in quarter ${i + 1} is impossible.`));
      }
      const reg = [sumArr(q[0].slice(0, 4)), sumArr(q[1].slice(0, 4))];
      if (q[0].length > 4 && reg[0] !== reg[1]) errs.push(`Overtime periods were entered, but regulation is not tied (${reg[0]}-${reg[1]}).`);
      if (q[0].length === 4 && input.overtimePeriods) errs.push('Overtime was indicated, but only four period scores were entered.');
    }
  }
  const lineups: [Lineup, Lineup] = [buildLineup(teams[0]), buildLineup(teams[1])];
  const everyone = new Map<string, { p: RosterPlayer; side: Side }>();
  teams.forEach((t, s) => t.roster.forEach((p) => everyone.set(p.id, { p, side: s as Side })));
  for (const [pid, stats] of Object.entries(input.locks?.players ?? {})) {
    const e = everyone.get(pid);
    if (!e) {
      errs.push(`Locked statistics reference player "${pid}", who is not on either roster. Map the player to a rostered player or remove the entry.`);
      continue;
    }
    const nm = `${e.p.name} (${teams[e.side].abbr})`;
    if (!e.p.active) errs.push(`${nm} is inactive and cannot receive statistics. Activate the player or remove the locked stats.`);
    for (const [k, v] of Object.entries(stats)) {
      if (!(LOCKABLE_PLAYER_STATS as readonly string[]).includes(k)) {
        errs.push(`${nm}: "${k}" is not a lockable statistic.`);
        continue;
      }
      const isYds = k.endsWith('Yds');
      const okNum = typeof v === 'number' && (k === 'sacks' ? Number.isInteger(v * 2) && v >= 0 : isYds ? Number.isInteger(v) : Number.isInteger(v) && v >= 0);
      if (!okNum) errs.push(`${nm}: ${k} must be a ${k === 'sacks' ? 'multiple of 0.5' : 'whole number'}${k.endsWith('Yds') ? '' : ' of at least 0'}.`);
      const cat = CAT[k as LockablePlayerStat];
      const pos = [e.p.position, ...e.p.secondary];
      if ((v as number) !== 0 && !pos.some((x) => ELIG[cat].includes(x))) errs.push(`${nm} is rostered at ${pos.join('/')} and cannot be credited with ${k}. Add an eligible secondary position or remove the stat.`);
    }
    const g = (k: LockablePlayerStat) => stats[k];
    if (g('passCmp') != null && g('passAtt') != null && g('passCmp')! > g('passAtt')!) errs.push(`${nm}: completions exceed attempts.`);
    if (g('passAtt') != null && (g('passCmp') ?? 0) + (g('passInt') ?? 0) > g('passAtt')!) errs.push(`${nm}: completions plus interceptions exceed attempts.`);
    if (g('passTd') != null && g('passCmp') != null && g('passTd')! > g('passCmp')!) errs.push(`${nm}: passing touchdowns exceed completions.`);
    if (g('recTd') != null && g('rec') != null && g('recTd')! > g('rec')!) errs.push(`${nm}: receiving touchdowns exceed receptions.`);
    if (g('rushTd') != null && g('rushAtt') != null && g('rushTd')! > g('rushAtt')!) errs.push(`${nm}: rushing touchdowns exceed carries.`);
    if (g('fgm') != null && g('fga') != null && g('fgm')! > g('fga')!) errs.push(`${nm}: field goals made exceed attempts.`);
    if (g('xpm') != null && g('xpa') != null && g('xpm')! > g('xpa')!) errs.push(`${nm}: extra points made exceed attempts.`);
    if (g('passCmp') === 0 && (g('passYds') ?? 0) !== 0) errs.push(`${nm}: passing yards without a completion.`);
    if (g('rec') === 0 && (g('recYds') ?? 0) !== 0) errs.push(`${nm}: receiving yards without a reception.`);
    if (g('rushAtt') === 0 && (g('rushYds') ?? 0) !== 0) errs.push(`${nm}: rushing yards without a carry.`);
    const kick = ['fgm', 'fga', 'xpm', 'xpa'].some((k) => (stats as Record<string, number>)[k]);
    if (kick && lineups[e.side].kicker?.id !== pid) errs.push(`${nm}: kicking statistics can only be locked for the team's active kicker (${lineups[e.side].kicker?.name ?? 'none rostered'}).`);
  }
  const L = lockCtx(input, lineups);
  for (const s of [0, 1] as Side[]) {
    const d = other(s);
    const T = teams[s].name;
    if (L.has(s, 'passYds') && L.total(s, 'recYds') > L.total(s, 'passYds') && L.ids(s, 'passYds').length >= lineups[s].qbs.length) errs.push(`${T}: locked receiving yards (${L.total(s, 'recYds')}) exceed locked passing yards (${L.total(s, 'passYds')}).`);
    if (L.has(s, 'passCmp') && L.total(s, 'rec') > L.total(s, 'passCmp') && L.ids(s, 'passCmp').length >= lineups[s].qbs.length) errs.push(`${T}: locked receptions (${L.total(s, 'rec')}) exceed locked completions (${L.total(s, 'passCmp')}).`);
    const qb1 = lineups[s].qbs[0]?.p.id;
    if (qb1 && L.get(qb1, 'passInt') != null && L.total(d, 'defInt') > L.total(s, 'passInt')) errs.push(`${teams[d].name} defenders are locked with ${L.total(d, 'defInt')} interceptions, but ${T} passers are locked with only ${L.total(s, 'passInt')} thrown.`);
    const tl = input.locks?.teams?.[s];
    if (tl?.turnovers != null && tl.turnovers < Math.max(L.total(s, 'passInt'), L.total(d, 'defInt'))) errs.push(`${T}: locked team turnovers (${tl.turnovers}) are fewer than the locked interceptions.`);
    if (tl?.passYds != null && L.has(s, 'passYds') && L.total(s, 'passYds') > tl.passYds) errs.push(`${T}: locked player passing yards exceed the locked team passing yards.`);
  }
  return errs;
}

// ---------------------------------------------------------------------------------- scoring decomposition
function combos(P: number, c: { noKick: boolean; fg?: number; fgMin?: number; n7?: number }): Combo[] {
  const out: Combo[] = [];
  for (let saf = 0; saf <= 2; saf++)
    for (let n8 = 0; n8 <= 3; n8++)
      for (let n6 = 0; n6 <= 3; n6++)
        for (let n7 = 0; n7 * 7 <= P; n7++) {
          const rest = P - 7 * n7 - 8 * n8 - 6 * n6 - 2 * saf;
          if (rest < 0 || rest % 3) continue;
          const fg = rest / 3;
          if (c.noKick && (n7 || fg)) continue;
          if (c.fg != null && fg !== c.fg) continue;
          if (c.fgMin != null && fg < c.fgMin) continue;
          if (c.n7 != null && n7 !== c.n7) continue;
          const td = n7 + n8 + n6;
          const w = Math.pow(0.07, n6) * Math.pow(0.08, n8) * Math.pow(0.015, saf) * Math.exp(-0.55 * Math.abs(fg - 0.4 * td - 0.3)) * (fg > 5 ? Math.pow(0.2, fg - 5) : 1);
          out.push({ n7, n8, n6, fg, saf, w: c.noKick ? Math.pow(0.5, n6 + saf * 4) : w });
        }
  return out;
}

interface OtPlan { periods: [number, number][] }

function otOptions(period: number, last: boolean): [number, number][] {
  const vals = period === 1 ? [0, 3, 6, 7, 8] : period === 2 ? [0, 3, 6, 8] : [0, 2];
  const out: [number, number][] = [];
  for (const x of vals) for (const y of vals) if (last ? x !== y : x === y) out.push([x, y]);
  return out;
}

// ---------------------------------------------------------------------------------- reconstruction
export interface PrimetimeArgs {
  seed: string;
  teams: [TeamInput, TeamInput];
  config?: Partial<SimConfig>;
  input: PrimetimeInput;
}

export function reconstructPrimetime(args: PrimetimeArgs): GameResult {
  const config: SimConfig = { ...DEFAULT_CONFIG, ...args.config };
  const { teams, input } = args;
  const warnings: string[] = [];
  for (const t of teams) warnings.push(...assertRoster(t, config.allowInactive));
  const pre = checkPrimetimeInput(input, teams);
  if (pre.length) throw conflict(pre[0], pre);
  let lastErr: SimError | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const built = build(args, config, new Rng(`${args.seed}/primetime/${attempt}`));
      const clean: PrimetimeInput = { final: [input.final[0], input.final[1]], quarters: input.quarters ?? null, overtimePeriods: built.otPeriods, locks: input.locks ?? null };
      const result = finalize('primetime', args.seed, teams, config, built.plays, built.drives, [], warnings, clean);
      const bad = result.validation.filter((v) => !v.ok);
      if (!bad.length) return result;
      lastErr = conflict('The reconstruction could not satisfy every constraint.', bad.map((b) => `${b.check}: ${b.detail ?? ''}`));
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      lastErr = e;
      if (e.code === 'CONFLICT_HARD') throw conflict(e.message, e.details);
    }
  }
  throw lastErr ?? conflict('The reconstruction failed.');
}

const hard = (msg: string) => new SimError('CONFLICT_HARD', msg, [msg]);

function build(args: PrimetimeArgs, config: SimConfig, rng: Rng): { plays: Play[]; drives: Drive[]; otPeriods: number } {
  const { teams, input } = args;
  const sim = new GameSim(teams, [neutralPctState(), neutralPctState()], config, rng.fork('plays'));
  sim.untimed = true;
  sim.neutral = true;
  const lineups: [Lineup, Lineup] = [sim.sides[0].lineup, sim.sides[1].lineup];
  const L = lockCtx(input, lineups);
  const kickerOf = (s: Side) => lineups[s].kicker;
  const qb1 = (s: Side) => lineups[s].qbs[0].p.id;

  // ---- 1a. Period plan: regulation and overtime points per side.
  let reg: [number[] | null, number[] | null] = [null, null];
  let regTotal: [number, number];
  let ot: OtPlan = { periods: [] };
  if (input.quarters) {
    reg = [input.quarters[0].slice(0, 4), input.quarters[1].slice(0, 4)];
    regTotal = [sumArr(reg[0]!), sumArr(reg[1]!)];
    for (let i = 4; i < input.quarters[0].length; i++) ot.periods.push([input.quarters[0][i], input.quarters[1][i]]);
    ot.periods.forEach((p, i) => {
      const lastP = i === ot.periods.length - 1;
      if (!otOptions(i + 1, lastP).some((o) => o[0] === p[0] && o[1] === p[1]))
        throw hard(`Overtime period ${i + 1} cannot end ${p[0]}-${p[1]} under college overtime rules${lastP ? '' : ' (a period that does not end the game must be tied)'}.`);
    });
  } else if (input.overtimePeriods) {
    const n = input.overtimePeriods;
    const found: { periods: [number, number][]; w: number }[] = [];
    const dfs = (i: number, acc: [number, number][], w: number) => {
      const used: [number, number] = [sumArr(acc.map((p) => p[0])), sumArr(acc.map((p) => p[1]))];
      if (used[0] > input.final[0] || used[1] > input.final[1]) return;
      if (i > n) {
        const t0 = input.final[0] - used[0];
        if (t0 === input.final[1] - used[1] && t0 !== 1) found.push({ periods: acc, w });
        return;
      }
      for (const o of otOptions(i, i === n)) dfs(i + 1, [...acc, o], w * [o[0], o[1]].reduce((a, v) => a * ({ 0: 0.5, 2: 0.6, 3: 0.8, 6: 0.25, 7: 1, 8: 0.2 } as Record<number, number>)[v], 1));
    };
    dfs(1, [], 1);
    if (!found.length) throw hard(`A ${input.final[0]}-${input.final[1]} final cannot be reached in ${n} overtime period${n === 1 ? '' : 's'} from a regulation tie.`);
    ot = { periods: rng.weighted(found, (f) => f.w).periods };
    regTotal = [input.final[0] - sumArr(ot.periods.map((p) => p[0])), input.final[1] - sumArr(ot.periods.map((p) => p[1]))];
  } else regTotal = [input.final[0], input.final[1]];

  // Kicks and touchdowns that happen in overtime count against the same locks.
  const otKicks = ([0, 1] as Side[]).map((s) => ({
    fg: ot.periods.filter((p) => p[s] === 3).length,
    xp: ot.periods.filter((p, i) => i === 0 && p[s] === 7).length,
    td: ot.periods.filter((p, i) => i < 2 && p[s] >= 6).length,
  }));

  // ---- 1b. Touchdown attribution plan (which touchdowns must belong to which locked players).
  const tdNeeds = ([0, 1] as Side[]).map((s) => {
    const Lp = L.total(s, 'passTd'), Lr = L.total(s, 'recTd'), Lu = L.total(s, 'rushTd');
    const passerFree = lineups[s].qbs.some((q) => L.get(q.p.id, 'passTd') == null);
    const qbFree = L.get(qb1(s), 'passTd') == null;
    const recFree = lineups[s].receivers.some((r) => L.get(r.p.id, 'recTd') == null);
    const rushFree = [...lineups[s].rushers.map((r) => r.p.id), qb1(s)].some((id) => L.get(id, 'rushTd') == null);
    /** Returns the number of passing touchdowns to use for a given touchdown total, or null when impossible. */
    const passCount = (nTD: number): number | null => {
      const lo = Math.max(Lp, Lr), hi = nTD - Lu;
      if (lo > hi) return null;
      const forced: number[] = [];
      if (!qbFree) forced.push(Lp);
      if (!recFree) forced.push(Lr);
      if (!rushFree) forced.push(nTD - Lu);
      if (forced.some((f) => f !== forced[0])) return null;
      if (forced.length) return forced[0] >= lo && forced[0] <= hi && (forced[0] === Lp || passerFree) ? forced[0] : null;
      return -1; // free: let the plays fall naturally
    };
    return { Lp, Lr, Lu, passCount };
  });

  // ---- 1c. Scoring events for regulation.
  const events: Ev[][] = [[], [], [], []];
  const missedXp: [number, number] = [0, 0];
  for (const s of [0, 1] as Side[]) {
    const k = kickerOf(s);
    const cons: Parameters<typeof combos>[1] = { noKick: !k };
    if (k && L.get(k.id, 'fgm') != null) cons.fg = L.get(k.id, 'fgm')! - otKicks[s].fg;
    if (k && L.get(k.id, 'xpm') != null) cons.n7 = L.get(k.id, 'xpm')! - otKicks[s].xp;
    if ((cons.fg ?? 0) < 0 || (cons.n7 ?? 0) < 0) throw hard(`${teams[s].name}: locked kicking totals are smaller than the kicks implied by the overtime scores.`);
    const tdOk = (c: Combo) => tdNeeds[s].passCount(c.n7 + c.n8 + c.n6 + otKicks[s].td) != null;
    const xpaOk = (c: Combo) => {
      if (!k || L.get(k.id, 'xpa') == null) return true;
      const miss = L.get(k.id, 'xpa')! - (L.get(k.id, 'xpm') ?? c.n7 + otKicks[s].xp);
      return miss >= 0 && miss <= c.n6 + ot.periods.filter((p, i) => i === 0 && p[s] === 6).length;
    };
    let perQ: Combo[];
    if (reg[s]) {
      const opts = reg[s]!.map((p, qi) => {
        const o = combos(p, { noKick: !k });
        if (!o.length) throw hard(`${teams[s].name} cannot score exactly ${p} point${p === 1 ? '' : 's'} in quarter ${qi + 1}${k ? '' : ' without a rostered kicker'}.`);
        return o;
      });
      const full: { qs: Combo[]; w: number }[] = [];
      const dfs = (i: number, acc: Combo[], w: number) => {
        if (i === 4) {
          const t = acc.reduce((a, c) => ({ n7: a.n7 + c.n7, n8: a.n8 + c.n8, n6: a.n6 + c.n6, fg: a.fg + c.fg, saf: a.saf + c.saf, w: 1 }), { n7: 0, n8: 0, n6: 0, fg: 0, saf: 0, w: 1 });
          if (cons.fg != null && t.fg !== cons.fg) return;
          if (cons.n7 != null && t.n7 !== cons.n7) return;
          if (!tdOk(t) || !xpaOk(t)) return;
          full.push({ qs: acc, w });
          return;
        }
        for (const o of opts[i]) dfs(i + 1, [...acc, o], w * o.w);
      };
      dfs(0, [], 1);
      if (!full.length) throw hard(`${teams[s].name}: the period scores ${reg[s]!.join('/')} cannot be composed in a way that also satisfies the locked touchdown and kicking statistics.`);
      perQ = rng.weighted(full, (f) => f.w).qs;
    } else {
      const o = combos(regTotal[s], cons).filter((c) => tdOk(c) && xpaOk(c));
      if (!o.length) throw hard(`${teams[s].name}: ${regTotal[s]} points cannot be composed in a way that satisfies the locked touchdown and kicking statistics${k ? '' : ' (no kicker is rostered, so extra points and field goals are unavailable)'}.`);
      const c = rng.weighted(o, (x) => x.w);
      perQ = [0, 1, 2, 3].map(() => ({ n7: 0, n8: 0, n6: 0, fg: 0, saf: 0, w: 1 }));
      const place = (key: 'n7' | 'n8' | 'n6' | 'fg' | 'saf', n: number) => {
        for (let i = 0; i < n; i++) perQ[rng.weighted([0, 1, 2, 3], (q) => [0.22, 0.3, 0.22, 0.26][q])][key]++;
      };
      place('n7', c.n7); place('n8', c.n8); place('n6', c.n6); place('fg', c.fg); place('saf', c.saf);
    }
    perQ.forEach((c, qi) => {
      for (let i = 0; i < c.n7; i++) events[qi].push({ side: s, kind: 'TD7' });
      for (let i = 0; i < c.n8; i++) events[qi].push({ side: s, kind: 'TD8' });
      for (let i = 0; i < c.n6; i++) events[qi].push({ side: s, kind: 'TD6' });
      for (let i = 0; i < c.fg; i++) events[qi].push({ side: s, kind: 'FG' });
      for (let i = 0; i < c.saf; i++) events[qi].push({ side: s, kind: 'SAF' });
    });
    const tot = perQ.reduce((a, c) => a + c.n7, 0) + otKicks[s].xp;
    if (k && L.get(k.id, 'xpa') != null) missedXp[s] = L.get(k.id, 'xpa')! - (L.get(k.id, 'xpm') ?? tot);
  }

  // ---- 1d. Scheduled non-scoring events required by locks (interceptions, fumbles, missed field goals).
  const scheduledInt: [boolean, boolean] = [false, false];
  const scheduledFum: [boolean, boolean] = [false, false];
  const scheduledMiss: [boolean, boolean] = [false, false];
  const intPasser: [string[], string[]] = [[], []];
  const intDefender: [string[], string[]] = [[], []]; // indexed by OFFENSE side: who on the other team gets the pick
  for (const s of [0, 1] as Side[]) {
    const d = other(s);
    const tl = input.locks?.teams?.[s];
    const Lint = L.total(s, 'passInt'), Ldef = L.total(d, 'defInt');
    const qbLocked = L.get(qb1(s), 'passInt') != null;
    let nInt = -1;
    if (qbLocked) nInt = Lint;
    else if (L.has(d, 'defInt') || L.has(s, 'passInt') || tl?.turnovers != null) nInt = Math.max(Lint, Ldef);
    if (tl?.turnovers != null) {
      if (!qbLocked && nInt < tl.turnovers) nInt = clamp(Math.max(nInt, Math.round(tl.turnovers * 0.6)), 0, tl.turnovers);
      const nFum = tl.turnovers - nInt;
      if (nFum < 0) throw hard(`${teams[s].name}: locked team turnovers are fewer than the locked interceptions.`);
      scheduledFum[s] = true;
      for (let i = 0; i < nFum; i++) events[rng.int(0, 3)].push({ side: s, kind: 'FUM' });
    }
    if (nInt >= 0) {
      scheduledInt[s] = true;
      for (const id of L.ids(s, 'passInt')) for (let i = 0; i < L.get(id, 'passInt')!; i++) intPasser[s].push(id);
      for (const id of L.ids(d, 'defInt')) for (let i = 0; i < L.get(id, 'defInt')!; i++) intDefender[s].push(id);
      rng.shuffle(intPasser[s]);
      rng.shuffle(intDefender[s]);
      for (let i = 0; i < nInt; i++) events[rng.int(0, 3)].push({ side: s, kind: 'INT' });
    }
    const k = kickerOf(s);
    if (k && L.get(k.id, 'fga') != null) {
      scheduledMiss[s] = true;
      const fgm = L.get(k.id, 'fgm') ?? events.flat().filter((e) => e.side === s && e.kind === 'FG').length + otKicks[s].fg;
      const miss = L.get(k.id, 'fga')! - fgm;
      if (miss < 0) throw hard(`${teams[s].name}: locked field-goal attempts are fewer than the field goals needed for the score.`);
      for (let i = 0; i < miss; i++) events[rng.int(0, 3)].push({ side: s, kind: 'MISSFG' });
    }
  }

  // ---- 1e. Touchdown specs per side.
  const tdSpecs: [TdSpec[], TdSpec[]] = [[], []];
  for (const s of [0, 1] as Side[]) {
    const nTD = events.flat().filter((e) => e.side === s && e.kind.startsWith('TD')).length + otKicks[s].td;
    const n = tdNeeds[s];
    const k = n.passCount(nTD);
    if (k == null) throw hard(`${teams[s].name} scored ${nTD} touchdown${nTD === 1 ? '' : 's'} according to the score, which cannot match the locked touchdown statistics (passing ${n.Lp}, receiving ${n.Lr}, rushing ${n.Lu}).`);
    const expand = (key: LockablePlayerStat) => L.ids(s, key).flatMap((id) => Array(L.get(id, key)!).fill(id) as string[]);
    const passers = rng.shuffle(expand('passTd')), receivers = rng.shuffle(expand('recTd')), rushers = expand('rushTd');
    const nPass = k === -1 ? Math.max(n.Lp, n.Lr) : k;
    for (let i = 0; i < nPass; i++) tdSpecs[s].push({ kind: 'pass', passer: passers[i], receiver: receivers[i] });
    const nRush = k === -1 ? n.Lu : nTD - k;
    for (let i = 0; i < nRush; i++) tdSpecs[s].push({ kind: 'rush', rusher: rushers[i] });
    while (tdSpecs[s].length < nTD) tdSpecs[s].push({ kind: 'any' });
    rng.shuffle(tdSpecs[s]);
  }

  // ---- 2. Drives.
  const playWeight = (p: Play) => (p.type === 'run' || p.type === 'sack' || (p.type === 'pass' && p.complete) ? 33 : p.type === 'kneel' ? 40 : p.type === 'pass' ? 7 : p.type === 'punt' ? 10 : p.type === 'field_goal' ? 5 : p.type === 'kickoff' ? (p.touchback ? 1 : 6) : 0);
  const free = (pool: { p: RosterPlayer; w: number }[], key: LockablePlayerStat, exclude?: string) => {
    const c = pool.filter((x) => L.get(x.p.id, key) == null && x.p.id !== exclude);
    return c.length ? rng.weighted(c, (x) => x.w).p.id : undefined;
  };
  const rushPool = (s: Side) => [...lineups[s].rushers, { p: lineups[s].qbs[0].p, w: 0.15 }];

  const applyTdSpec = (s: Side, p: Play): boolean => {
    const list = tdSpecs[s];
    const natural = p.type === 'pass' ? 'pass' : 'rush';
    let idx = list.findIndex((x) => x.kind === natural);
    if (idx < 0) idx = list.findIndex((x) => x.kind === 'any');
    if (idx < 0) return false;
    const spec = list[idx];
    if (natural === 'pass') {
      let passer = spec.passer ?? p.passer!;
      if (!spec.passer && L.get(passer, 'passTd') != null) {
        const alt = free(lineups[s].qbs, 'passTd');
        if (!alt) return false;
        passer = alt;
      }
      let target = spec.receiver ?? p.target!;
      if ((!spec.receiver && L.get(target, 'recTd') != null) || target === passer) {
        const alt = free(lineups[s].receivers, 'recTd', passer);
        if (!alt) return false;
        target = alt;
      }
      if (target === passer) return false;
      p.passer = passer;
      p.target = target;
    } else {
      let rusher = spec.rusher ?? p.rusher!;
      if (!spec.rusher && L.get(rusher, 'rushTd') != null) {
        const alt = free(rushPool(s), 'rushTd');
        if (!alt) return false;
        rusher = alt;
      }
      p.rusher = rusher;
    }
    list.splice(idx, 1);
    return true;
  };

  type Want = EvKind | 'NONE' | 'OT0';
  const genDrive = (side: Side, want: Want, start?: () => void): Drive => {
    const baseForce: Force = { plain: true };
    for (let attempt = 0; attempt < 600; attempt++) {
      const snap = sim.snapshot();
      const specSnap: [TdSpec[], TdSpec[]] = [[...tdSpecs[0]], [...tdSpecs[1]]];
      const f: Force = { ...baseForce };
      const want6 = want === 'TD6';
      if (want === 'TD7') f.pat = 'XP_GOOD';
      else if (want === 'TD8') f.pat = '2PT_GOOD';
      else if (want6) f.pat = kickerOf(side) && (missedXp[side] > 0 || (L.get(kickerOf(side)!.id, 'xpa') == null && rng.chance(0.7))) && sim.ot !== 2 ? 'XP_MISS' : '2PT_FAIL';
      else if (want === 'FG') (f.fg = 'GOOD'), (f.kickInRange = true);
      else if (want === 'MISSFG') (f.fg = 'MISS'), (f.kickInRange = true);
      else if (want === 'SAF') f.safety = true;
      sim.force = f;
      const up = want.startsWith('TD') || want === 'FG' || want === 'MISSFG';
      sim.boost[side] = attempt < 12 ? 0 : (up ? 1 : -1) * Math.min(2.5, 0.25 * Math.floor(attempt / 12));
      if (want === 'SAF') sim.boost[side] = -2.5;
      if (start) start();
      const d = sim.runDrive();
      sim.boost[side] = 0;
      let ok = d.side === side;
      const dp = sim.plays.slice(snap.plays);
      const scoredBy = (s: Side) => dp.some((p) => p.points?.side === s);
      if (ok)
        switch (want) {
          case 'TD7': case 'TD8': case 'TD6': {
            ok = d.result === 'TD' && !scoredBy(other(side));
            if (ok) ok = applyTdSpec(side, dp.find((p) => p.td === side)!);
            if (ok && want6 && f.pat === 'XP_MISS') missedXp[side]--;
            break;
          }
          case 'FG': ok = d.result === 'FG'; break;
          case 'MISSFG': ok = d.result === 'MISSED_FG'; break;
          case 'SAF': ok = d.result === 'SAFETY'; break;
          case 'INT': ok = d.result === 'INT' && !scoredBy(other(side)); break;
          case 'FUM': ok = d.result === 'FUMBLE' && !scoredBy(other(side)); break;
          case 'OT0': case 'NONE': {
            const r: DriveResult = d.result;
            ok = d.points === 0 && !scoredBy(other(side)) && (r === 'PUNT' || r === 'DOWNS' || (r === 'MISSED_FG' && !scheduledMiss[side]) || (r === 'INT' && !scheduledInt[side]) || (r === 'FUMBLE' && !scheduledFum[side]));
            break;
          }
        }
      // Natural events on unlocked categories must not land on locked players.
      if (ok) for (const p of dp) {
        if (p.turnover === 'interception') {
          if (want === 'INT') {
            p.passer = intPasser[side].pop() ?? (L.get(p.passer!, 'passInt') == null ? p.passer : free(lineups[side].qbs, 'passInt'));
            const dl = intDefender[side].pop();
            p.interceptor = dl ?? (p.interceptor && L.get(p.interceptor, 'defInt') == null ? p.interceptor : free(lineups[other(side)].defenders.map((x) => ({ p: x, w: 1 })), 'defInt'));
            if (!p.passer) ok = false;
            if (p.target === p.passer) p.target = undefined;
          } else if (L.get(p.passer!, 'passInt') != null || (p.interceptor && L.get(p.interceptor, 'defInt') != null)) ok = false;
        }
        if (p.type === 'field_goal' && want !== 'FG' && want !== 'MISSFG' && kickerOf(side) && (L.get(kickerOf(side)!.id, 'fga') != null || (p.good && L.get(kickerOf(side)!.id, 'fgm') != null))) ok = false;
      }
      if (ok) {
        sim.force = {};
        return d;
      }
      sim.restore(snap);
      tdSpecs[0] = specSnap[0];
      tdSpecs[1] = specSnap[1];
    }
    throw conflict(`Could not reconstruct a ${want} drive for ${teams[side].name}; retrying with a different arrangement.`);
  };

  const receiver: Side = rng.chance(0.5) ? 0 : 1;
  for (let q = 1; q <= 4; q++) {
    sim.quarter = q;
    if (q === 1) sim.next = { kind: 'kickoff', kicking: other(receiver), free: false };
    if (q === 3) sim.next = { kind: 'kickoff', kicking: receiver, free: false };
    const queue = rng.shuffle([...events[q - 1]]);
    const driveSide = (e: Ev) => (e.kind === 'SAF' ? other(e.side) : e.side);
    let used = 0;
    const qStart = sim.plays.length;
    for (let guard = 0; guard < 40; guard++) {
      const poss: Side = sim.next!.kind === 'kickoff' ? other(sim.next!.kicking) : (sim.next as { side: Side }).side;
      const idx = queue.findIndex((e) => driveSide(e) === poss);
      const remaining = 900 - used;
      const pressed = queue.length * 150 > remaining;
      let want: Want = 'NONE';
      if (idx >= 0 && (pressed || rng.chance(0.6))) want = queue.splice(idx, 1)[0].kind;
      else if (!queue.length && remaining < 60) break;
      const before = sim.plays.length;
      genDrive(poss, want);
      // End of a half with time for only part of a drive: keep the opening plays and let the clock expire.
      if (!queue.length && want === 'NONE' && (q === 2 || q === 4)) {
        const dp = sim.plays.slice(before);
        const w = dp.reduce((a, p) => a + playWeight(p), 0);
        const d = sim.drives[sim.drives.length - 1];
        if (used + w > 900 && d.result === 'PUNT') {
          let keep = before;
          let acc = used;
          for (let i = before; i < sim.plays.length - 1; i++) {
            acc += playWeight(sim.plays[i]);
            keep = i + 1;
            if (acc >= 880) break;
          }
          if (sim.plays[keep - 1].type === 'kickoff') keep = Math.min(keep + 1, sim.plays.length - 1);
          sim.plays.length = keep;
          d.result = q === 2 ? 'END_HALF' : 'END_GAME';
          sim.next = null;
          used = 900;
          break;
        }
      }
      used = sim.plays.slice(qStart).reduce((a, p) => a + playWeight(p), 0);
    }
    if (queue.length) throw conflict('Could not place every scoring event in its quarter; retrying.');
  }
  sim.next = null;
  if (sim.score[0] !== regTotal[0] || sim.score[1] !== regTotal[1]) throw conflict('Regulation scoring did not reconcile; retrying.');

  // ---- 2b. Overtime.
  if (ot.periods.length) {
    const n = ot.periods.length;
    const lastP = ot.periods[n - 1];
    const w: Side = lastP[0] > lastP[1] ? 0 : 1;
    // A touchdown that wins the game on the second possession ends it with no try (period score of 6).
    const walkOff = n <= 2 && lastP[w] === 6 && lastP[other(w)] <= 3;
    // The eventual winner takes the second possession of the deciding period.
    let first: Side = n % 2 === 1 ? other(w) : w;
    for (let period = 1; period <= n; period++) {
      sim.ot = period;
      sim.quarter = 4 + period;
      const order: Side[] = [first, other(first)];
      for (let i = 0; i < 2; i++) {
        const s = order[i];
        const pts = ot.periods[period - 1][s];
        sim.otSecond = i === 1;
        const begin = () => {
          sim.next = null;
          sim.beginDrive(s, period <= 2 ? 75 : 97);
        };
        if (period >= 3) {
          begin();
          sim.force = { pat: pts === 2 ? '2PT_GOOD' : '2PT_FAIL' };
          sim.twoPoint(s, true);
          sim.force = {};
          sim.endDrive(pts === 2 ? 'TD' : 'DOWNS');
        } else if (pts === 0) genDrive(s, 'OT0', begin);
        else if (pts === 3) genDrive(s, 'FG', begin);
        else if (pts === 6 && walkOff && period === n && i === 1) {
          const keep = sim.force;
          genDriveNoPat(s, begin);
          sim.force = keep;
        } else genDrive(s, pts === 7 ? 'TD7' : pts === 8 ? 'TD8' : 'TD6', begin);
        sim.next = null;
      }
      first = other(first);
    }
  }
  function genDriveNoPat(s: Side, begin: () => void) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const snap = sim.snapshot();
      const specSnap: [TdSpec[], TdSpec[]] = [[...tdSpecs[0]], [...tdSpecs[1]]];
      sim.force = { plain: true, pat: 'NONE' };
      sim.boost[s] = Math.min(2.5, 0.25 * Math.floor(attempt / 12));
      begin();
      const d = sim.runDrive();
      sim.boost[s] = 0;
      if (d.result === 'TD' && applyTdSpec(s, sim.plays.slice(snap.plays).find((p) => p.td === s)!)) return;
      sim.restore(snap);
      tdSpecs[0] = specSnap[0];
      tdSpecs[1] = specSnap[1];
    }
    throw conflict('Could not reconstruct the game-ending overtime touchdown; retrying.');
  }
  if (sim.score[0] !== input.final[0] || sim.score[1] !== input.final[1]) throw conflict('Scoring did not reconcile with the imported final; retrying.');

  // ---- 3. Locked volume statistics.
  repair(sim, input, L, lineups, config, rng.fork('repair'));

  // ---- 4. Clock, numbering, descriptions and drive records.
  const plays = sim.plays;
  for (let q = 1; q <= 4; q++) {
    const qp = plays.filter((p) => p.quarter === q);
    const total = qp.reduce((a, p) => a + playWeight(p), 0) || 1;
    let acc = 0;
    for (const p of qp) {
      p.clock = Math.max(0, Math.round(config.quarterSeconds * (1 - acc / total)));
      acc += playWeight(p);
    }
    if (qp.length) qp[0].clock = config.quarterSeconds;
  }
  const names = (id?: string) => sim.name(id);
  plays.forEach((p, i) => {
    p.seq = i + 1;
    if (p.quarter > 4) p.clock = 0;
    p.desc = describePlay(p, names, sim.abbr, sim.teamName);
  });
  const drives: Drive[] = sim.drives.map((d) => {
    const dp = plays.filter((p) => p.drive === d.num);
    const scr = dp.filter((p) => p.type === 'run' || p.type === 'pass' || p.type === 'sack' || p.type === 'kneel');
    const firstP = dp[0];
    const lastP = dp[dp.length - 1];
    const nxt = plays[plays.indexOf(lastP) + 1];
    const endClock = nxt && nxt.quarter === lastP.quarter ? nxt.clock : 0;
    return {
      ...d, quarter: firstP?.quarter ?? d.quarter, startClock: firstP?.clock ?? 0, startBallOn: firstP?.ballOn ?? d.startBallOn,
      plays: scr.length + dp.filter((p) => p.type === 'punt' || p.type === 'field_goal').length, yards: scr.reduce((a, p) => a + p.yards, 0),
      seconds: firstP && firstP.quarter <= 4 ? Math.max(0, firstP.clock - endClock) : 0,
      points: dp.reduce((a, p) => a + (p.points?.side === d.side ? p.points.pts : 0), 0),
    };
  });
  return { plays, drives, otPeriods: ot.periods.length };
}

// ---------------------------------------------------------------------------------- lock repair
/** Diagnostics for calibration scripts. */
export const repairStats = { iterations: 0, runs: 0 };
interface DriveMeta { start: number; open: boolean; puntLanding?: number; endSpot?: number; touchback?: boolean }

function repair(sim: GameSim, input: PrimetimeInput, L: LockCtx, lineups: [Lineup, Lineup], config: SimConfig, rng: Rng) {
  const ncaa = config.sackConvention === 'ncaa';
  const locks: { key: string; want: number; w: number; pid?: string; stat: string; side: Side }[] = [];
  const W: Record<string, number> = { passYds: 1, rushYds: 1, recYds: 1, passAtt: 30, passCmp: 30, rushAtt: 30, rec: 30, tackles: 30, sacks: 60, passTd: 300, rushTd: 300, recTd: 300, passInt: 300, defInt: 300 };
  for (const [pid, stats] of Object.entries(input.locks?.players ?? {}))
    for (const [stat, want] of Object.entries(stats)) if (W[stat]) locks.push({ key: `${pid}|${stat}`, want: want as number, w: W[stat], pid, stat, side: L.sideOf.get(pid)! });
  input.locks?.teams?.forEach((t, s) => {
    if (t?.passYds != null) locks.push({ key: `T${s}|passYds`, want: t.passYds, w: 1, stat: 'teamPassYds', side: s as Side });
    if (t?.rushYds != null) locks.push({ key: `T${s}|rushYds`, want: t.rushYds, w: 1, stat: 'teamRushYds', side: s as Side });
  });
  if (!locks.length) return;

  // Drives as mutable play lists.
  const isDrivePlay = (p: Play) => p.drive > 0 && p.type !== 'extra_point' && p.type !== 'two_point' && p.type !== 'timeout';
  const D = new Map<number, Play[]>();
  for (const p of sim.plays) if (isDrivePlay(p)) (D.get(p.drive) ?? D.set(p.drive, []).get(p.drive)!).push(p);
  const meta = new Map<number, DriveMeta>();
  for (const [num, dp] of D) {
    const lastP = dp[dp.length - 1];
    const m: DriveMeta = { start: dp[0].ballOn, open: false };
    if (lastP.type === 'punt') (m.puntLanding = lastP.ballOn + (lastP.kickYards ?? 0)), (m.touchback = !!lastP.touchback);
    else if (lastP.type === 'field_goal') { if (!lastP.good) m.endSpot = lastP.ballOn; }
    else if (lastP.turnover === 'fumble' || lastP.turnover === 'downs') m.endSpot = lastP.ballOn + lastP.yards;
    else if (lastP.td === lastP.offense || lastP.turnover === 'interception' || lastP.points?.kind === 'SAFETY') { /* absorbing */ }
    else m.open = true;
    meta.set(num, m);
  }
  const nums = [...D.keys()];
  const bySide: [number[], number[]] = [[], []];
  for (const n of nums) bySide[D.get(n)![0].offense].push(n);

  const tally = new Map<string, number>();
  const add = (p: Play, sign: number) => {
    const inc = (k: string, v: number) => tally.set(k, (tally.get(k) ?? 0) + sign * v);
    const o = p.offense;
    if (p.type === 'run') {
      if (p.rusher) (inc(`${p.rusher}|rushAtt`, 1), inc(`${p.rusher}|rushYds`, p.yards), p.td === o && inc(`${p.rusher}|rushTd`, 1));
      inc(`T${o}|rushYds`, p.yards);
    } else if (p.type === 'kneel') inc(`T${o}|rushYds`, p.yards);
    else if (p.type === 'sack') {
      if (ncaa) (p.passer && (inc(`${p.passer}|rushAtt`, 1), inc(`${p.passer}|rushYds`, p.yards)), inc(`T${o}|rushYds`, p.yards));
      else inc(`T${o}|passYds`, p.yards);
      for (const id of p.sackers ?? []) (inc(`${id}|sacks`, 1 / p.sackers!.length), inc(`${id}|tackles`, 1));
    } else if (p.type === 'pass') {
      inc(`${p.passer}|passAtt`, 1);
      if (p.complete) {
        inc(`${p.passer}|passCmp`, 1); inc(`${p.passer}|passYds`, p.yards); inc(`T${o}|passYds`, p.yards);
        if (p.td === o) (inc(`${p.passer}|passTd`, 1), inc(`${p.target}|recTd`, 1));
        inc(`${p.target}|rec`, 1); inc(`${p.target}|recYds`, p.yards);
      } else if (p.turnover === 'interception') (inc(`${p.passer}|passInt`, 1), p.interceptor && inc(`${p.interceptor}|defInt`, 1));
    }
    if (p.type === 'run' || p.type === 'pass') for (const id of p.tacklers ?? []) inc(`${id}|tackles`, 1);
  };
  for (const dp of D.values()) for (const p of dp) add(p, 1);
  const cost = () => {
    let c = 0;
    for (const l of locks) c += l.w * Math.abs((tally.get(l.key) ?? 0) - l.want);
    return c;
  };
  const diffOf = (key: string, want: number) => Math.round(((tally.get(key) ?? 0) - want) * 2) / 2;

  /** Recompute down, distance and field position for a drive. Returns false if the sequence is not legal football. */
  const rewalk = (dp: Play[], m: DriveMeta): boolean => {
    let ballOn = m.start, down = 1, dist = Math.min(10, 100 - ballOn);
    for (let i = 0; i < dp.length; i++) {
      const p = dp[i];
      const lastP = i === dp.length - 1;
      p.ballOn = ballOn; p.down = down; p.distance = dist;
      if (p.type === 'penalty') {
        const pen = p.penalty!;
        if (pen.side === p.offense) {
          if (pen.yards > Math.floor(ballOn / 2)) return false;
          ballOn -= pen.yards; dist += pen.yards;
        } else {
          if (pen.yards > Math.floor((100 - ballOn) / 2)) return false;
          ballOn += pen.yards;
          const first = !!pen.autoFirst || pen.yards >= dist;
          p.firstDown = first || undefined;
          if (first) (down = 1), (dist = Math.min(10, 100 - ballOn)); else dist -= pen.yards;
        }
        continue;
      }
      if (p.type === 'punt') {
        if (!lastP || down !== 4) return false;
        const kick = m.touchback ? 100 - ballOn : m.puntLanding! - ballOn;
        if (kick < 18 || kick > 72) return false;
        p.kickYards = kick;
        continue;
      }
      if (p.type === 'field_goal') {
        if (!lastP || down !== 4) return false;
        if (!p.good && ballOn !== m.endSpot) return false;
        p.fgDistance = 100 - ballOn + 17;
        if (p.good && p.fgDistance > 57) return false;
        continue;
      }
      const mid4 = down === 4;
      if (mid4 && !p.fourthDownTry) return false;
      if (!mid4 && p.fourthDownTry) p.fourthDownTry = undefined;
      if (p.td === p.offense) {
        if (!lastP) return false;
        p.yards = 100 - ballOn;
        if (p.yards < 1 || p.yards > 99) return false;
        p.firstDown = true;
        continue;
      }
      if (p.turnover === 'interception') { if (!lastP) return false; continue; }
      if (p.points?.kind === 'SAFETY') { if (!lastP) return false; p.yards = -ballOn; continue; }
      if (p.turnover === 'fumble') {
        if (!lastP) return false;
        p.yards = m.endSpot! - ballOn;
        if (p.yards < -12 || p.yards > 80) return false;
        continue;
      }
      if (p.type === 'pass' && !p.complete && p.yards !== 0) return false;
      if (p.type === 'sack' && p.yards >= 0) return false;
      const nb = ballOn + p.yards;
      if (nb < 1 || nb > 99) return false;
      const first = p.yards >= dist;
      if (p.turnover === 'downs') {
        if (!lastP || down !== 4 || first || nb !== m.endSpot) return false;
        continue;
      }
      if (down === 4 && !first) return false;
      p.firstDown = first || undefined;
      if (first) (down = 1), (dist = Math.min(10, 100 - nb)); else (down++, (dist -= p.yards));
      ballOn = nb;
    }
    const lastP = dp[dp.length - 1];
    const terminal = lastP.type === 'punt' || lastP.type === 'field_goal' || lastP.td === lastP.offense || !!lastP.turnover || lastP.points?.kind === 'SAFETY';
    return m.open ? !terminal && down <= 4 : terminal;
  };

  let cur = cost();
  const clone = (dp: Play[]) => dp.map((p) => ({ ...p, tacklers: p.tacklers && [...p.tacklers], sackers: p.sackers && [...p.sackers] }));
  /** Apply a mutation to one or two drives; keep it only if the drives stay legal and the lock error shrinks. */
  const attempt = (ns: number[], fn: (dps: Play[][]) => boolean | void): boolean => {
    const before = ns.map((n) => clone(D.get(n)!));
    const dps = ns.map((n) => D.get(n)!);
    for (const dp of dps) for (const p of dp) add(p, -1);
    let ok = fn(dps) !== false;
    if (ok) for (let i = 0; i < ns.length; i++) if (!rewalk(dps[i], meta.get(ns[i])!)) { ok = false; break; }
    if (ok) {
      for (const dp of dps) for (const p of dp) add(p, 1);
      const c = cost();
      if (c < cur || (c === cur && rng.chance(0.15))) { cur = c; return true; }
      for (const dp of dps) for (const p of dp) add(p, -1);
    }
    ns.forEach((n, i) => { D.set(n, before[i]); for (const p of before[i]) add(p, 1); });
    return false;
  };

  const plain = (p: Play) => p.td == null && !p.turnover && !p.points && !p.fumbler;
  const runs = (s: Side, f: (p: Play) => boolean = () => true) => pick(s, (p) => p.type === 'run' && !!p.rusher && f(p));
  const comps = (s: Side, f: (p: Play) => boolean = () => true) => pick(s, (p) => p.type === 'pass' && !!p.complete && f(p));
  function pick(s: Side, f: (p: Play) => boolean): { n: number; i: number; p: Play } | null {
    const ns = bySide[s];
    for (let t = 0; t < 14; t++) {
      const n = ns[rng.int(0, ns.length - 1)];
      const dp = D.get(n)!;
      const idx = dp.map((p, i) => (f(p) ? i : -1)).filter((i) => i >= 0);
      if (idx.length) { const i = rng.pick(idx); return { n, i, p: dp[i] }; }
    }
    return null;
  }
  const qbId = (s: Side) => lineups[s].qbs[0].p.id;
  const pool = (s: Side, kind: 'rush' | 'rec' | 'def' | 'pass', stat: string): string[] => {
    const base = kind === 'rush' ? [...lineups[s].rushers.map((x) => x.p.id), qbId(s)] : kind === 'rec' ? lineups[s].receivers.map((x) => x.p.id) : kind === 'pass' ? lineups[s].qbs.map((x) => x.p.id) : lineups[s].defenders.map((x) => x.id);
    const extra = locks.filter((l) => l.pid && l.side === s && CAT[l.stat as LockablePlayerStat] === kind).map((l) => l.pid!);
    const all = [...new Set([...base, ...extra])];
    // Prefer players who are short on this stat, then unlocked players.
    const need = all.filter((id) => { const l = locks.find((x) => x.key === `${id}|${stat}`); return l && diffOf(l.key, l.want) < 0; });
    const freeP = all.filter((id) => !locks.some((x) => x.key === `${id}|${stat}`));
    return need.length && rng.chance(0.7) ? need : freeP.length ? freeP : all;
  };
  const over = (s: Side, kind: 'rush' | 'rec' | 'def' | 'pass', stat: string): string[] => {
    const lk = locks.filter((l) => l.pid && l.side === s && l.stat === stat && diffOf(l.key, l.want) > 0).map((l) => l.pid!);
    if (lk.length && rng.chance(0.7)) return lk;
    return pool(s, kind, stat).filter((id) => !locks.some((x) => x.key === `${id}|${stat}`));
  };
  const step = (d: number) => Math.sign(-d) * (Math.abs(d) <= 12 && rng.chance(0.8) ? Math.abs(d) : Math.min(Math.abs(d), rng.int(1, 14)));
  const toRun = (p: Play, rusher: string) => Object.assign(p, { type: 'run', rusher, passer: undefined, target: undefined, complete: undefined, depth: undefined, pd: undefined, sackers: undefined, sackAllowedBy: undefined });
  const toIncomplete = (p: Play, passer: string, target?: string) => Object.assign(p, { type: 'pass', passer, target, complete: false, yards: 0, rusher: undefined, tacklers: undefined, depth: 'medium', sackers: undefined, sackAllowedBy: undefined, pd: undefined });

  let iter = 0;
  for (; iter < 20000 && cur > 0; iter++) {
    const bad = locks.filter((l) => Math.abs((tally.get(l.key) ?? 0) - l.want) > 1e-9);
    // Counts first: yardage is only tuned once the play counts it depends on are settled.
    const counts = bad.filter((l) => l.w > 1);
    const l = rng.pick(counts.length && rng.chance(0.85) ? counts : bad);
    const s = l.side;
    const d = diffOf(l.key, l.want);
    const pid = l.pid!;
    const r = rng.next();
    switch (l.stat) {
      case 'passYds': case 'teamPassYds': {
        const c = comps(s, (p) => (l.stat === 'teamPassYds' || p.passer === pid) && p.td == null && !p.turnover);
        if (!c) break;
        const dl = step(d);
        if (r < 0.6) attempt([c.n], () => { c.p.yards += dl; if (c.p.yards < -3 || c.p.yards > 90) return false; });
        else attempt([c.n], (dps) => { const o = dps[0].filter((p) => p.type === 'run' && plain(p) && !!p.rusher); if (!o.length) return false; const q = rng.pick(o); c.p.yards += dl; q.yards -= dl; if (c.p.yards < -3 || q.yards < -8) return false; });
        break;
      }
      case 'rushYds': case 'teamRushYds': {
        if (ncaa && r > 0.85) {
          const k = pick(s, (p) => p.type === 'sack' && (l.stat === 'teamRushYds' || p.passer === pid) && plain(p));
          if (k) { const dl = step(d); attempt([k.n], () => { k.p.yards += dl; if (k.p.yards > -1 || k.p.yards < -15) return false; }); break; }
        }
        const c = runs(s, (p) => (l.stat === 'teamRushYds' || p.rusher === pid) && p.td == null && !p.turnover && !p.points);
        if (!c) {
          if (l.stat === 'rushYds') { const o = runs(s, (p) => p.rusher !== pid && plain(p)); if (o) attempt([o.n], () => { o.p.rusher = pid; }); }
          break;
        }
        const dl = step(d);
        if (r < 0.45) attempt([c.n], () => { c.p.yards += dl; if (c.p.yards < -8 || c.p.yards > 90) return false; });
        else if (r < 0.7) attempt([c.n], (dps) => { const o = dps[0].filter((p) => p.type === 'pass' && p.complete && plain(p)); if (!o.length) return false; const q = rng.pick(o); c.p.yards += dl; q.yards -= dl; if (c.p.yards < -8 || q.yards < -3) return false; });
        else if (l.stat === 'rushYds') {
          // Swap ball carriers between two runs: carries stay fixed, yardage moves.
          const o = runs(s, (p) => p.rusher !== pid && plain(p) && Math.sign(p.yards - c.p.yards) === Math.sign(-d));
          if (o && plain(c.p)) attempt(o.n === c.n ? [c.n] : [c.n, o.n], () => { const t = o.p.rusher; o.p.rusher = c.p.rusher; c.p.rusher = t; });
        }
        break;
      }
      case 'recYds': {
        const c = comps(s, (p) => p.target === pid && plain(p));
        if (!c) break;
        if (r < 0.55) {
          const o = comps(s, (p) => p.target !== pid && p.passer !== pid && plain(p) && Math.sign(p.yards - c.p.yards) === Math.sign(-d) && Math.abs(p.yards - c.p.yards) <= Math.abs(d) + 6);
          if (o && o.p.passer !== c.p.target && c.p.passer !== o.p.target) attempt(o.n === c.n ? [c.n] : [c.n, o.n], () => { const t = o.p.target; o.p.target = c.p.target; c.p.target = t; });
        } else if (r < 0.8) {
          const dl = step(d);
          attempt([c.n], (dps) => { const o = dps[0].filter((p) => p.type === 'pass' && p.complete && plain(p) && p.target !== pid); if (!o.length) return false; const q = rng.pick(o); c.p.yards += dl; q.yards -= dl; if (c.p.yards < -3 || q.yards < -3) return false; });
        } else { const dl = step(d); attempt([c.n], () => { c.p.yards += dl; if (c.p.yards < -3 || c.p.yards > 90) return false; }); }
        break;
      }
      case 'rushAtt': {
        if (d > 0) {
          // Under the NCAA convention a sack is a carry for the passer, so surplus carries may be surplus sacks.
          if (ncaa && r < 0.4) {
            const k = pick(s, (p) => p.type === 'sack' && p.passer === pid && plain(p));
            if (k) { attempt([k.n], (dps) => { if (rng.chance(0.5)) dps[0].splice(k.i, 1); else toIncomplete(k.p, pid, rng.pick(pool(s, 'rec', 'rec').filter((x) => x !== pid))); }); break; }
          }
          const c = runs(s, (p) => p.rusher === pid && plain(p));
          if (!c) break;
          if (r < 0.6) { const to = pool(s, 'rush', 'rushAtt').filter((x) => x !== pid); if (to.length) attempt([c.n], () => { c.p.rusher = rng.pick(to); }); }
          else if (r < 0.8 && c.p.yards >= 0) attempt([c.n], () => { const tg = pool(s, 'rec', 'rec').filter((x) => x !== qbId(s)); if (!tg.length) return false; Object.assign(c.p, { type: 'pass', passer: qbId(s), target: rng.pick(tg), complete: true, rusher: undefined, depth: 'short' }); });
          else attempt([c.n], (dps) => { const o = dps[0].filter((p) => p !== c.p && p.type === 'run' && p.rusher === pid && plain(p)); if (!o.length) return false; rng.pick(o).yards += c.p.yards; dps[0].splice(dps[0].indexOf(c.p), 1); });
        } else {
          if (r < 0.55) { const from = over(s, 'rush', 'rushAtt').filter((x) => x !== pid); const c = runs(s, (p) => from.includes(p.rusher!) && plain(p)); if (c) attempt([c.n], () => { c.p.rusher = pid; }); }
          else if (r < 0.75) { const c = comps(s, (p) => plain(p) && p.yards < 25); if (c) attempt([c.n], () => { Object.assign(c.p, { type: 'run', rusher: pid, passer: undefined, target: undefined, complete: undefined, depth: undefined }); }); }
          else { const c = pick(s, (p) => (p.type === 'run' || p.type === 'pass') && (p.down ?? 4) <= 2 && plain(p)); if (c) attempt([c.n], (dps) => { dps[0].splice(c.i, 0, { ...c.p, type: 'run', rusher: pid, passer: undefined, target: undefined, complete: undefined, depth: undefined, yards: rng.int(0, 2), tacklers: c.p.tacklers?.slice(0, 1), firstDown: undefined, pd: undefined, sackers: undefined }); }); }
        }
        break;
      }
      case 'passCmp': {
        if (d > 0) {
          const c = comps(s, (p) => p.passer === pid && plain(p));
          if (!c) break;
          if (r < 0.5) attempt([c.n], () => { const to = pool(s, 'rush', 'rushAtt'); Object.assign(c.p, { type: 'run', rusher: rng.pick(to), passer: undefined, target: undefined, complete: undefined, depth: undefined }); });
          else attempt([c.n], () => { c.p.complete = false; c.p.yards = 0; c.p.tacklers = undefined; });
        } else {
          if (r < 0.5) { const c = runs(s, (p) => plain(p) && p.yards >= 0 && p.rusher !== pid); if (c) attempt([c.n], () => { const tg = pool(s, 'rec', 'rec').filter((x) => x !== pid); if (!tg.length) return false; Object.assign(c.p, { type: 'pass', passer: pid, target: rng.pick(tg), complete: true, rusher: undefined, depth: 'short' }); }); }
          else { const c = pick(s, (p) => p.type === 'pass' && !p.complete && !p.turnover && p.passer === pid && !!p.target); if (c) attempt([c.n], () => { c.p.complete = true; c.p.yards = rng.int(2, 9); c.p.pd = undefined; }); }
        }
        break;
      }
      case 'passAtt': {
        if (d > 0) {
          const c = pick(s, (p) => p.type === 'pass' && !p.complete && !p.turnover && p.passer === pid);
          if (c && r < 0.5) attempt([c.n], (dps) => { dps[0].splice(c.i, 1); });
          else if (c) attempt([c.n], () => { toRun(c.p, rng.pick(pool(s, 'rush', 'rushAtt'))); c.p.yards = rng.int(0, 3); c.p.tacklers = undefined; });
          else { const k = comps(s, (p) => p.passer === pid && plain(p)); if (k) attempt([k.n], () => { Object.assign(k.p, { type: 'run', rusher: rng.pick(pool(s, 'rush', 'rushAtt')), passer: undefined, target: undefined, complete: undefined, depth: undefined }); }); }
        } else if (r < 0.5) {
          const from = over(s, 'rush', 'rushAtt');
          const c = runs(s, (p) => from.includes(p.rusher!) && plain(p) && p.yards <= 6);
          if (c) attempt([c.n], () => { const tg = pool(s, 'rec', 'rec').filter((x) => x !== pid); toIncomplete(c.p, pid, tg.length ? rng.pick(tg) : undefined); });
        } else {
          const c = pick(s, (p) => (p.type === 'run' || p.type === 'pass') && (p.down ?? 4) <= 2 && plain(p));
          if (c) attempt([c.n], (dps) => { const tg = pool(s, 'rec', 'rec').filter((x) => x !== pid); dps[0].splice(c.i, 0, { ...c.p, type: 'pass', passer: pid, target: tg.length ? rng.pick(tg) : undefined, complete: false, rusher: undefined, yards: 0, tacklers: undefined, firstDown: undefined, depth: 'medium', fumbler: undefined, turnover: undefined, td: undefined, points: undefined, sackers: undefined, pd: undefined }); });
        }
        break;
      }
      case 'rec': {
        if (d > 0) { const c = comps(s, (p) => p.target === pid && plain(p)); const to = pool(s, 'rec', 'rec').filter((x) => x !== pid); if (c && to.length) attempt([c.n], () => { const t = rng.pick(to); if (t === c.p.passer) return false; c.p.target = t; }); }
        else { const from = over(s, 'rec', 'rec').filter((x) => x !== pid); const c = comps(s, (p) => from.includes(p.target!) && plain(p) && p.passer !== pid); if (c) attempt([c.n], () => { c.p.target = pid; }); }
        break;
      }
      case 'tackles': {
        const defS = s; // the lock is on a defender: plays belong to the other side's offense
        const o = other(defS);
        if (d > 0) {
          const c = pick(o, (p) => (p.type === 'run' || p.type === 'pass') && !!p.tacklers?.includes(pid));
          if (c) attempt([c.n], () => { const to = pool(defS, 'def', 'tackles').filter((x) => !c.p.tacklers!.includes(x)); if (c.p.tacklers!.length > 1 && rng.chance(0.5)) c.p.tacklers = c.p.tacklers!.filter((x) => x !== pid); else if (to.length) c.p.tacklers = c.p.tacklers!.map((x) => (x === pid ? rng.pick(to) : x)); else return false; });
        } else {
          const c = pick(o, (p) => (p.type === 'run' || (p.type === 'pass' && !!p.complete)) && p.td == null && !p.tacklers?.includes(pid));
          if (c) attempt([c.n], () => { const t = c.p.tacklers ?? []; if (!t.length) c.p.tacklers = [pid]; else if (t.length === 1 && rng.chance(0.4)) c.p.tacklers = [t[0], pid]; else c.p.tacklers = t.map((x, i) => (i === 0 ? pid : x)); });
        }
        break;
      }
      case 'sacks': {
        const o = other(s);
        if (d > 0) {
          const c = pick(o, (p) => p.type === 'sack' && !!p.sackers?.includes(pid));
          if (c) attempt([c.n], (dps) => {
            const to = pool(s, 'def', 'sacks').filter((x) => !c.p.sackers!.includes(x));
            if (d % 1 !== 0 && c.p.sackers!.length === 1 && to.length) c.p.sackers = [pid, rng.pick(to)];
            else if (r < 0.3 && plain(c.p)) toIncomplete(c.p, c.p.passer!, undefined);
            else if (r < 0.4 && plain(c.p)) dps[0].splice(c.i, 1);
            else if (to.length) c.p.sackers = c.p.sackers!.map((x) => (x === pid ? rng.pick(to) : x));
            else return false;
          });
        } else if (r < 0.45) {
          const c = pick(o, (p) => p.type === 'sack' && !p.sackers?.includes(pid));
          if (c) attempt([c.n], () => { const sk = c.p.sackers ?? []; if (d === -0.5 && sk.length === 1) c.p.sackers = [sk[0], pid]; else c.p.sackers = sk.length ? sk.map((x, i) => (i === 0 ? pid : x)) : [pid]; });
        } else {
          // Not enough sacks in the ledger: turn an incompletion into a sack and let the drive absorb the yardage.
          const c = pick(o, (p) => p.type === 'pass' && !p.complete && !p.turnover);
          if (c) attempt([c.n], () => { Object.assign(c.p, { type: 'sack', yards: -rng.int(3, 9), sackers: [pid], target: undefined, complete: undefined, pd: undefined, depth: undefined, passer: c.p.passer }); });
        }
        break;
      }
      case 'defInt': {
        const o = other(s);
        const c = pick(o, (p) => p.turnover === 'interception' && (d > 0 ? p.interceptor === pid : p.interceptor !== pid));
        if (c) attempt([c.n], () => { if (d > 0) { const to = pool(s, 'def', 'defInt').filter((x) => x !== pid); if (!to.length) return false; c.p.interceptor = rng.pick(to); } else c.p.interceptor = pid; });
        break;
      }
      case 'recTd': {
        const c = pick(s, (p) => p.type === 'pass' && p.td === s && (d > 0 ? p.target === pid : p.target !== pid && p.passer !== pid));
        if (c) attempt([c.n], () => { if (d > 0) { const to = pool(s, 'rec', 'recTd').filter((x) => x !== pid && x !== c.p.passer); if (!to.length) return false; c.p.target = rng.pick(to); } else c.p.target = pid; });
        break;
      }
      case 'rushTd': {
        const c = pick(s, (p) => p.type === 'run' && p.td === s && (d > 0 ? p.rusher === pid : p.rusher !== pid));
        if (c) attempt([c.n], () => { if (d > 0) { const to = pool(s, 'rush', 'rushTd').filter((x) => x !== pid); if (!to.length) return false; c.p.rusher = rng.pick(to); } else c.p.rusher = pid; });
        break;
      }
      case 'passTd': case 'passInt': {
        const c = pick(s, (p) => p.type === 'pass' && (l.stat === 'passTd' ? p.td === s : p.turnover === 'interception') && (d > 0 ? p.passer === pid : p.passer !== pid && p.target !== pid));
        if (c) attempt([c.n], () => { if (d > 0) { const to = pool(s, 'pass', l.stat).filter((x) => x !== pid && x !== c.p.target); if (!to.length) return false; c.p.passer = rng.pick(to); } else c.p.passer = pid; });
        break;
      }
    }
  }
  repairStats.iterations += iter;
  repairStats.runs++;
  if (cur > 0) {
    const left = locks.filter((l) => Math.abs((tally.get(l.key) ?? 0) - l.want) > 1e-9).map((l) => `${l.pid ? sim.name(l.pid) : sim.teamName[l.side]} ${l.stat.replace('team', '')}: locked ${l.want}, best reconstruction ${tally.get(l.key) ?? 0}`);
    throw conflict('The locked statistics could not all be satisfied together with the imported score. Check these values, or unlock one of them:', left);
  }
  // Write the repaired drives back into the ledger, keeping kickoffs and tries in place.
  const out: Play[] = [];
  const done = new Set<number>();
  for (const p of sim.plays) {
    if (isDrivePlay(p) && D.has(p.drive)) {
      if (!done.has(p.drive)) (done.add(p.drive), out.push(...D.get(p.drive)!));
    } else out.push(p);
  }
  sim.plays = out;
  void eligible;
  void lockMismatches;
}
