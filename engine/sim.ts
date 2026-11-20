// Play-by-play college football simulation. Scores are never rolled directly: every point comes from a
// sequence of legal snaps, and every individual credit goes to a player who is on the active roster.
import { describePlay } from './describe';
import type { PctState } from './percentages';
import { buildLineup, defWeight, type Lineup, type Slot } from './roster';
import { Rng, clamp } from './rng';
import { DEF_PROFILE, OFF_PROFILE, TEMPO_RUNOFF } from './schemes';
import { other, type Drive, type DriveResult, type Play, type RosterPlayer, type Side, type SimConfig, type TeamInput } from './types';

interface SideState {
  team: TeamInput;
  lineup: Lineup;
  pct: PctState;
  timeouts: number;
  defSnaps: number;
}

/** Steering used only by the score-constrained (primetime) reconstruction. */
export interface Force {
  pat?: 'XP_GOOD' | 'XP_MISS' | '2PT_GOOD' | '2PT_FAIL' | 'NONE';
  fg?: 'GOOD' | 'MISS';
  /** Disallow return touchdowns, defensive touchdowns and blocked kicks. */
  plain?: boolean;
  /** Always kick on fourth down when in range. */
  kickInRange?: boolean;
  /** Fourth down ends with the snap going out of the end zone (reconstructing a known safety). */
  safety?: boolean;
}

type Next = { kind: 'kickoff'; kicking: Side; free: boolean } | { kind: 'ball'; side: Side; ballOn: number } | null;

interface CurDrive {
  num: number;
  side: Side;
  quarter: number;
  startClock: number;
  startBallOn: number;
  plays: number;
  yards: number;
  seconds: number;
  startScore: number;
}

export class GameSim {
  plays: Play[] = [];
  drives: Drive[] = [];
  score: [number, number] = [0, 0];
  quarter = 1;
  clock: number;
  poss: Side = 0;
  ballOn = 25;
  down = 1;
  dist = 10;
  sides: [SideState, SideState];
  next: Next = null;
  cur: CurDrive | null = null;
  pendingRunoff = 0;
  periodOver = false;
  /** No game clock: overtime and reconstruction drives. */
  untimed = false;
  /** Overtime period currently being played (0 in regulation). */
  ot = 0;
  /** Percentages are not applied (primetime reconstruction). */
  neutral = false;
  force: Force = {};
  /** Extra offensive edge per side, used by the reconstruction to make rare outcomes reachable. */
  boost: [number, number] = [0, 0];
  lastDefTd = false;
  /** Game-day form: ordinary random variation in how well each team plays, in rating points. */
  form: [number, number] = [0, 0];
  firstHalfReceiver: Side = 0;
  names: Map<string, string> = new Map();
  abbr: [string, string];
  teamName: [string, string];

  constructor(public teams: [TeamInput, TeamInput], pct: [PctState, PctState], public cfg: SimConfig, public rng: Rng) {
    const l0 = buildLineup(teams[0], cfg.allowInactive);
    const l1 = buildLineup(teams[1], cfg.allowInactive);
    this.sides = [
      { team: teams[0], lineup: l0, pct: pct[0], timeouts: 3, defSnaps: 0 },
      { team: teams[1], lineup: l1, pct: pct[1], timeouts: 3, defSnaps: 0 },
    ];
    for (const l of [l0, l1]) for (const p of l.all.values()) this.names.set(p.id, p.name);
    this.abbr = [teams[0].abbr, teams[1].abbr];
    this.teamName = [teams[0].name, teams[1].name];
    this.clock = cfg.quarterSeconds;
  }

  // ------------------------------------------------------------------ helpers
  name = (id?: string) => (id ? this.names.get(id) ?? 'Unknown' : '');

  private isStar(side: Side, p: RosterPlayer | null | undefined): boolean {
    return !!p && !this.neutral && this.sides[side].pct.stars.has(p.id);
  }
  private pr(side: Side, p: RosterPlayer | null | undefined): number {
    if (!p) return 70;
    return (p.rating ?? 70) + (this.isStar(side, p) ? this.cfg.starBoost : 0);
  }
  private stars(side: Side): Set<string> {
    return this.neutral ? EMPTY : this.sides[side].pct.stars;
  }
  private pctIdx(): number {
    return Math.min(this.quarter, 5) - 1;
  }
  private sharp(side: Side): number {
    if (this.neutral) return 0;
    return this.sides[side].pct.activity[this.pctIdx()] ? 1 : -1;
  }
  private surging(side: Side): boolean {
    if (this.neutral) return false;
    const s = this.sides[side].pct;
    return s.upset[this.quarter <= 2 ? 0 : 1] && s.upsetBonus > 0;
  }
  private rate(side: Side, unit: 'off' | 'def'): number {
    const s = this.sides[side];
    let r = unit === 'off' ? s.team.offRating : s.team.defRating;
    if (!this.cfg.neutralSite) r += (side === 1 ? 0.5 : -0.5) * this.cfg.homeFieldAdvantage;
    r += this.form[side] + this.sharp(side) * this.cfg.activityEffect;
    if (this.surging(side)) r += s.pct.upsetBonus;
    return r;
  }
  /** Offensive advantage, in tens of rating points. 0 = evenly matched. */
  private edge(off: Side): number {
    const def = other(off);
    const fatigue = clamp((this.sides[def].defSnaps - 38) / 110, 0, 0.35);
    return (this.rate(off, 'off') - this.rate(def, 'def')) / 12 + fatigue + this.boost[off];
  }
  private pickSlot(slots: Slot[], side: Side, exclude?: string, bias?: (s: Slot) => number): RosterPlayer {
    const pool = exclude ? slots.filter((s) => s.p.id !== exclude) : slots;
    const st = this.stars(side);
    return this.rng.weighted(pool, (s) => s.w * (st.has(s.p.id) ? 1.5 : 1) * (bias ? bias(s) : 1)).p;
  }
  private qb(side: Side): RosterPlayer {
    return this.sides[side].lineup.qbs[0].p;
  }
  private defender(def: Side, role: Parameters<typeof defWeight>[1], exclude?: string): string | undefined {
    const D = this.sides[def];
    const pool = exclude ? D.lineup.defenders.filter((d) => d.id !== exclude) : D.lineup.defenders;
    if (!pool.length) return undefined;
    const st = this.stars(def);
    return this.rng.weighted(pool, (d) => defWeight(d, role, D.team.defScheme, st)).id;
  }
  private tacklers(def: Side, role: 'runTackle' | 'passTackle'): string[] {
    const a = this.defender(def, role);
    if (!a) return [];
    if (this.rng.chance(0.27)) {
      const b = this.defender(def, role, a);
      if (b) return [a, b];
    }
    return [a];
  }

  private spend(seconds: number) {
    if (this.cur) this.cur.seconds += this.untimed ? seconds : Math.min(seconds, this.clock);
    if (this.untimed) return;
    this.clock -= Math.min(seconds, this.clock);
    if (this.clock <= 0) this.periodOver = true;
  }

  emit(p: Partial<Play> & { type: Play['type']; offense: Side }): Play {
    if (p.points) this.score[p.points.side] += p.points.pts;
    const play: Play = {
      seq: this.plays.length + 1,
      drive: this.cur?.num ?? 0,
      quarter: this.quarter,
      clock: this.untimed ? 0 : this.clock,
      poss: p.offense,
      down: null,
      distance: null,
      ballOn: this.ballOn,
      yards: 0,
      desc: '',
      ...p,
      scoreAfter: [this.score[0], this.score[1]],
    };
    play.desc = describePlay(play, this.name, this.abbr, this.teamName);
    this.plays.push(play);
    return play;
  }

  beginDrive(side: Side, ballOn: number) {
    this.poss = side;
    this.ballOn = clamp(Math.round(ballOn), 1, 99);
    this.down = 1;
    this.dist = Math.min(10, 100 - this.ballOn);
    this.lastDefTd = false;
    this.cur = { num: this.drives.length + 1, side, quarter: this.quarter, startClock: this.untimed ? 0 : this.clock, startBallOn: this.ballOn, plays: 0, yards: 0, seconds: 0, startScore: this.score[side] };
  }

  endDrive(result: DriveResult) {
    const c = this.cur;
    if (!c) return;
    this.drives.push({ num: c.num, side: c.side, quarter: c.quarter, startClock: c.startClock, startBallOn: c.startBallOn, plays: c.plays, yards: c.yards, seconds: c.seconds, result, points: this.score[c.side] - c.startScore });
    this.cur = null;
  }

  snapshot() {
    return {
      plays: this.plays.length, drives: this.drives.length, score: [this.score[0], this.score[1]] as [number, number], quarter: this.quarter, clock: this.clock,
      poss: this.poss, ballOn: this.ballOn, down: this.down, dist: this.dist, next: this.next, cur: this.cur ? { ...this.cur } : null,
      pendingRunoff: this.pendingRunoff, periodOver: this.periodOver, to: [this.sides[0].timeouts, this.sides[1].timeouts], snaps: [this.sides[0].defSnaps, this.sides[1].defSnaps], lastDefTd: this.lastDefTd,
    };
  }
  restore(s: ReturnType<GameSim['snapshot']>) {
    this.plays.length = s.plays;
    this.drives.length = s.drives;
    this.score = [s.score[0], s.score[1]];
    this.quarter = s.quarter; this.clock = s.clock; this.poss = s.poss; this.ballOn = s.ballOn; this.down = s.down; this.dist = s.dist;
    this.next = s.next; this.cur = s.cur ? { ...s.cur } : null; this.pendingRunoff = s.pendingRunoff; this.periodOver = s.periodOver;
    this.sides[0].timeouts = s.to[0]; this.sides[1].timeouts = s.to[1]; this.sides[0].defSnaps = s.snaps[0]; this.sides[1].defSnaps = s.snaps[1];
    this.lastDefTd = s.lastDefTd;
  }

  // ------------------------------------------------------------------ full game
  run() {
    const r: Side = this.rng.chance(0.5) ? 0 : 1;
    this.form = [this.rng.normal(0, 2.6), this.rng.normal(0, 2.6)];
    this.firstHalfReceiver = r;
    this.next = { kind: 'kickoff', kicking: other(r), free: false };
    for (let guard = 0; guard < 5000; guard++) {
      if (this.periodOver) {
        this.periodOver = false;
        this.pendingRunoff = 0;
        if (this.quarter === 1 || this.quarter === 3) {
          this.quarter++;
          this.clock = this.cfg.quarterSeconds;
          continue;
        }
        if (this.quarter === 2) {
          this.endDrive('END_HALF');
          this.quarter = 3;
          this.clock = this.cfg.quarterSeconds;
          for (const s of this.sides) (s.timeouts = 3), (s.defSnaps = 0);
          this.next = { kind: 'kickoff', kicking: this.firstHalfReceiver, free: false };
          continue;
        }
        this.endDrive('END_GAME');
        this.next = null;
        if (this.score[0] === this.score[1]) this.overtime();
        return;
      }
      this.step();
    }
    throw new Error('simulation did not terminate');
  }

  /** Run plays until the current (or next) drive is over. Used by overtime and by the reconstruction. */
  runDrive(): Drive {
    const n = this.drives.length;
    for (let guard = 0; guard < 400 && this.drives.length === n; guard++) this.step();
    if (this.drives.length === n) throw new Error('drive did not terminate');
    return this.drives[n];
  }

  overtime() {
    this.untimed = true;
    let first: Side = this.rng.chance(0.5) ? 0 : 1;
    for (let period = 1; this.score[0] === this.score[1] && period < 40; period++) {
      this.ot = period;
      this.quarter = 4 + period;
      this.clock = 0;
      for (const s of this.sides) s.timeouts = 1;
      const order: Side[] = [first, other(first)];
      for (let i = 0; i < 2; i++) {
        const s = order[i];
        if (period <= 2) {
          this.next = null;
          this.beginDrive(s, 75);
          this.otSecond = i === 1;
          this.runDrive();
          this.next = null;
          if (this.lastDefTd) break;
        } else {
          this.next = null;
          this.beginDrive(s, 97);
          this.twoPoint(s, true);
          this.endDrive(this.score[s] > this.cur!.startScore ? 'TD' : 'DOWNS');
        }
      }
      first = other(first);
    }
  }
  otSecond = false;

  // ------------------------------------------------------------------ one snap
  step() {
    if (this.next) {
      const n = this.next;
      this.next = null;
      if (n.kind === 'kickoff') return this.kickoff(n.kicking, n.free);
      this.beginDrive(n.side, n.ballOn);
    }
    const off = this.poss;
    const def = other(off);
    const S = this.sides[off];
    const lead = this.score[off] - this.score[def];
    const q = this.quarter;
    const timed = !this.untimed;
    const hurry = timed && ((q === 4 && lead < 0 && this.clock <= 300) || (q === 4 && lead === 0 && this.clock <= 120) || (q === 2 && this.clock <= 110));
    const milk = timed && q === 4 && lead > 0 && this.clock <= 360;

    if (timed && this.pendingRunoff > 0) {
      let runoff = this.pendingRunoff;
      this.pendingRunoff = 0;
      if (this.clock <= 150 && (q === 2 || q === 4)) {
        const defWants = q === 4 && lead > 0 && this.sides[def].timeouts > 0;
        const offWants = S.timeouts > 0 && this.clock <= 70 && ((q === 4 && lead <= 0 && lead >= -8) || (q === 2 && this.ballOn >= 40));
        if (defWants || offWants) {
          const by = defWants ? def : off;
          this.sides[by].timeouts--;
          this.emit({ type: 'timeout', offense: off, timeoutBy: by, down: this.down, distance: this.dist });
          runoff = 0;
        }
      }
      this.spend(runoff);
      if (this.periodOver) return;
    }

    const toGoal = 100 - this.ballOn;
    const fgDist = toGoal + 17;
    const kicker = S.lineup.kicker;
    const range = kicker ? 50 + Math.round(((kicker.rating ?? 70) - 70) / 5) : 0;

    if (timed) {
      // Victory formation.
      if (q === 4 && lead > 0 && this.down <= 3) {
        const kneels = 4 - this.down;
        const burn = kneels * 2 + Math.max(0, kneels - this.sides[def].timeouts) * 38;
        if (this.clock <= burn) return this.kneel(off);
      }
      if (q === 2 && this.clock <= 22 && this.ballOn < 35 && this.down <= 3) return this.kneel(off);
      // Last-second field goal.
      if (kicker && this.clock <= 9 && fgDist <= range + 4 && (q === 2 || (q === 4 && lead <= 0 && lead >= -3))) return this.fieldGoal(off);
    }

    // Pre-snap / no-play penalties.
    if (this.rng.chance(0.078)) {
      const wOff = 0.52 * (1 - 0.25 * this.sharp(off));
      const wDef = 0.48 * (1 - 0.25 * this.sharp(def));
      if (this.penalty(this.rng.chance(wOff / (wOff + wDef)) ? off : def)) return;
    }

    if (this.down === 4 && this.force.safety) {
      if (this.cur) this.cur.plays++;
      return this.settle({ type: 'run', offense: off }, -this.ballOn, 'run', false, false);
    }
    if (this.down === 4) {
      const d = this.dist;
      const inRange = !!kicker && fgDist <= range;
      let choice: 'go' | 'fg' | 'punt';
      if (this.ot) {
        const need = this.otSecond ? -lead : 0; // points needed to stay alive
        choice = inRange && need <= 3 ? 'fg' : 'go';
      } else if (this.force.kickInRange && inRange) choice = 'fg';
      else {
        const desperate = timed && q === 4 && lead < 0 && (this.clock <= 150 || (this.clock <= 420 && lead <= -9));
        if (desperate) choice = inRange && lead >= -3 ? 'fg' : inRange && lead <= -9 && lead >= -11 && this.clock > 60 ? 'fg' : 'go';
        else if (inRange) choice = (d <= 1 && toGoal <= 4 && this.rng.chance(0.5)) || (d <= 2 && toGoal <= 35 && this.rng.chance(0.28)) ? 'go' : 'fg';
        else if (this.ballOn >= 55) choice = d <= 3 ? (this.rng.chance(0.62) ? 'go' : 'punt') : d <= 6 && this.ballOn >= 62 && this.rng.chance(0.3) ? 'go' : 'punt';
        else if (this.ballOn >= 40 && d <= 1) choice = this.rng.chance(0.35) ? 'go' : 'punt';
        else choice = 'punt';
        if (timed && q === 2 && this.clock <= 12 && choice === 'punt' && this.ballOn >= 45) choice = 'go';
      }
      if (choice === 'fg') return this.fieldGoal(off);
      if (choice === 'punt') return this.punt(off);
    }

    // Play call.
    const prof = OFF_PROFILE[S.team.offScheme];
    let pp = S.team.runPct != null ? 1 - S.team.runPct / 100 : prof.pass;
    if (this.down >= 3) {
      if (this.dist >= 7) pp = Math.max(pp, 0.86);
      else if (this.dist >= 4) pp = Math.max(pp, 0.68);
      else if (this.dist <= 2) pp = Math.min(pp, 0.38);
    } else if (this.down === 2 && this.dist >= 8) pp += 0.1;
    if (toGoal <= 3) pp -= 0.15;
    if (hurry) pp = Math.max(pp, 0.82);
    else if (milk) pp = Math.min(pp, 0.22);
    else if (timed && q >= 3 && lead <= -14) pp += 0.12;
    else if (timed && q === 4 && lead >= 10) pp -= 0.15;
    pp = clamp(pp, 0.05, 0.95);

    this.sides[def].defSnaps++;
    if (this.cur) this.cur.plays++;
    if (this.rng.chance(pp)) this.passPlay(off, hurry, milk);
    else this.runPlay(off, hurry, milk);
  }

  // ------------------------------------------------------------------ scrimmage plays
  private runoff(off: Side, hurry: boolean, milk: boolean): number {
    if (hurry) return this.rng.int(9, 15);
    if (milk) return this.rng.int(36, 40);
    const t = this.sides[off].team;
    return clamp(this.rng.int(25, 33) + TEMPO_RUNOFF[t.tempo] + OFF_PROFILE[t.offScheme].tempo, 12, 40);
  }

  /** Apply a completed scrimmage play: emit it, then update down, distance and possession. */
  private settle(p: Partial<Play> & { type: Play['type']; offense: Side }, yards: number, kind: 'run' | 'complete' | 'incomplete' | 'sack', hurry: boolean, milk: boolean) {
    const off = p.offense;
    const def = other(off);
    const fourth = this.down === 4;
    const toGoal = 100 - this.ballOn;
    yards = clamp(yards, -this.ballOn, toGoal);
    const base = { ...p, yards, down: this.down, distance: this.dist, fourthDownTry: fourth || undefined };
    if (this.cur) this.cur.yards += yards;
    const playTime = kind === 'incomplete' ? this.rng.int(4, 7) : this.rng.int(5, 8);

    if (yards >= toGoal) {
      this.emit({ ...base, td: off, firstDown: true, tacklers: undefined, points: { side: off, pts: 6, kind: 'TD' } });
      this.spend(playTime);
      this.afterTouchdown(off);
      this.endDrive('TD');
      this.next = { kind: 'kickoff', kicking: off, free: false };
      return;
    }
    if (this.ballOn + yards <= 0) {
      this.emit({ ...base, points: { side: def, pts: 2, kind: 'SAFETY' } });
      this.spend(playTime);
      this.endDrive('SAFETY');
      this.next = { kind: 'kickoff', kicking: off, free: true };
      return;
    }
    const first = yards >= this.dist;
    if (!first && fourth) {
      this.emit({ ...base, turnover: 'downs' });
      this.spend(playTime);
      this.endDrive('DOWNS');
      this.next = { kind: 'ball', side: def, ballOn: 100 - (this.ballOn + yards) };
      return;
    }
    this.emit({ ...base, firstDown: first || undefined });
    this.spend(playTime);
    this.ballOn += yards;
    if (first) {
      this.down = 1;
      this.dist = Math.min(10, 100 - this.ballOn);
    } else {
      this.down++;
      this.dist -= yards;
    }
    if (this.untimed || this.periodOver) return;
    const lateHalf = (this.quarter === 2 || this.quarter === 4) && this.clock <= 120;
    const stops = kind === 'incomplete' || (lateHalf && kind !== 'sack' && this.rng.chance(hurry ? 0.3 : 0.1));
    if (!stops) this.pendingRunoff = first && lateHalf ? this.rng.int(5, 8) : this.runoff(off, hurry, milk);
  }

  /** A fumble lost to the defense. Returns true when the play ended the drive. */
  private fumbleLost(p: Partial<Play> & { type: Play['type']; offense: Side }, yards: number, fumbler: RosterPlayer): boolean {
    const off = p.offense;
    const def = other(off);
    const spotOff = this.ballOn + yards;
    if (spotOff >= 99 || spotOff <= 1) return false;
    const forcedBy = this.rng.chance(0.75) ? this.defender(def, 'runTackle') : undefined;
    const recoveredBy = this.defender(def, 'runTackle');
    const defSpot = 100 - spotOff;
    const scoop = !this.force.plain && this.rng.chance(0.05);
    const ret = scoop ? 100 - defSpot : this.rng.chance(0.3) ? Math.min(this.rng.int(1, 12), 99 - defSpot) : 0;
    const base = { ...p, yards, down: this.down, distance: this.dist, fourthDownTry: this.down === 4 || undefined, fumbler: fumbler.id, fumbleLost: true, forcedBy, recoveredBy, turnover: 'fumble' as const, returnYards: ret, tacklers: undefined };
    if (this.cur) this.cur.yards += yards;
    if (scoop) {
      this.emit({ ...base, td: def, points: { side: def, pts: 6, kind: 'TD' } });
      this.spend(this.rng.int(8, 13));
      this.endDrive('FUMBLE');
      this.lastDefTd = true;
      this.afterTouchdown(def);
      this.next = { kind: 'kickoff', kicking: def, free: false };
    } else {
      this.emit(base);
      this.spend(this.rng.int(6, 9));
      this.endDrive('FUMBLE');
      this.next = { kind: 'ball', side: def, ballOn: defSpot + ret };
    }
    return true;
  }

  private runPlay(off: Side, hurry: boolean, milk: boolean) {
    const def = other(off);
    const S = this.sides[off];
    const prof = OFF_PROFILE[S.team.offScheme];
    const dprof = DEF_PROFILE[this.sides[def].team.defScheme];
    const e = this.edge(off);
    const qb = this.qb(off);
    const rusher = !S.lineup.rushers.length || this.rng.chance(prof.qbRun + (this.dist <= 1 ? 0.1 : 0)) ? qb : this.pickSlot(S.lineup.rushers, off);
    const star = this.isStar(off, rusher);
    const toGoal = 100 - this.ballOn;
    let mean = 3.6 + 1.0 * e + prof.runYds - dprof.runDef + (this.pr(off, rusher) - 70) * 0.03;
    if (toGoal <= 10) mean *= 0.8;
    if (this.down >= 3) mean -= 0.35;
    let y = this.rng.normal(mean, 3.1);
    if (this.rng.chance(clamp(0.075 + 0.02 * e + dprof.bigPlay + (star ? 0.045 : 0), 0.02, 0.22))) y += 7 + this.rng.exp(11);
    const yards = clamp(Math.round(y), Math.max(-7, -this.ballOn), toGoal);
    const p = { type: 'run' as const, offense: off, rusher: rusher.id, tacklers: this.tacklers(def, 'runTackle') };
    const pFum = 0.021 * prof.fumble * (1 - 0.15 * this.sharp(off)) * (star ? 0.7 : 1);
    if (this.rng.chance(pFum)) {
      if (this.rng.chance(this.surging(def) ? 0.6 : 0.48)) {
        if (this.fumbleLost(p, yards, rusher)) return;
      } else {
        return this.settle({ ...p, fumbler: rusher.id, fumbleLost: false }, yards, 'run', hurry, milk);
      }
    }
    this.settle(p, yards, 'run', hurry, milk);
  }

  private kneel(off: Side) {
    if (this.cur) this.cur.plays++;
    const yards = -Math.min(this.rng.int(1, 2), this.ballOn - 1);
    this.emit({ type: 'kneel', offense: off, yards, down: this.down, distance: this.dist });
    if (this.cur) this.cur.yards += yards;
    this.spend(2);
    this.ballOn += yards;
    this.down++;
    this.dist -= yards;
    if (!this.periodOver) this.pendingRunoff = 38;
  }

  private passPlay(off: Side, hurry: boolean, milk: boolean) {
    const def = other(off);
    const S = this.sides[off];
    const D = this.sides[def];
    const prof = OFF_PROFILE[S.team.offScheme];
    const dprof = DEF_PROFILE[D.team.defScheme];
    const e = this.edge(off);
    const qb = this.qb(off);
    const qr = this.pr(off, qb);
    const toGoal = 100 - this.ballOn;
    const long = this.down >= 3 && this.dist >= 7;

    // Pass rush.
    const pSack = clamp(0.058 - 0.014 * e + dprof.sack + (long ? 0.02 : 0) - (qr - 70) * 0.0004, 0.012, 0.15);
    if (this.rng.chance(pSack)) {
      const a = this.defender(def, 'sack');
      const sackers = a ? (this.rng.chance(0.16) ? [a, this.defender(def, 'sack', a)].filter(Boolean) as string[] : [a]) : [];
      const yards = -clamp(Math.round(2 + this.rng.exp(4.5)), 1, 14);
      const ol = S.lineup.ol.length ? this.rng.pick(S.lineup.ol).id : undefined;
      const p = { type: 'sack' as const, offense: off, passer: qb.id, sackers, sackAllowedBy: ol };
      if (this.rng.chance(0.07) && this.rng.chance(0.5) && this.fumbleLost({ ...p }, Math.max(yards, -this.ballOn + 2), qb)) return;
      return this.settle(p, yards, 'sack', hurry, milk);
    }
    // Scramble.
    if (this.rng.chance(0.035 + prof.qbRun * 0.15)) {
      const yards = clamp(Math.round(this.rng.normal(5.5 + e, 5)), Math.max(-4, -this.ballOn), toGoal);
      return this.settle({ type: 'run', offense: off, rusher: qb.id, tacklers: this.tacklers(def, 'passTackle') }, yards, 'run', hurry, milk);
    }

    // Target and depth.
    let mix = prof.depth;
    if (long) mix = [mix[0] - 0.14, mix[1] + 0.1, mix[2] + 0.04];
    if (toGoal <= 12) mix = [0.8, 0.2, 0];
    else if (toGoal <= 22) mix = [mix[0] + mix[2], mix[1], 0];
    const r = this.rng.next();
    const depth = r < mix[0] ? 'short' : r < mix[0] + mix[1] ? 'medium' : 'deep';
    const bias = (s: Slot) => {
      const pos = s.p.position;
      if (depth === 'deep') return pos === 'WR' ? 1.3 : pos === 'TE' ? 0.5 : 0.15;
      if (depth === 'short') return pos === 'WR' ? 0.9 : 1.35;
      return 1;
    };
    const target = this.pickSlot(S.lineup.receivers, off, qb.id, bias);
    const star = this.isStar(off, target) || this.isStar(off, qb);
    const tr = this.pr(off, target);

    const compBase = depth === 'short' ? 0.7 : depth === 'medium' ? 0.545 : 0.34;
    const comp = clamp(compBase + 0.045 * e + prof.comp - dprof.comp + (qr - 70) * 0.003 + (tr - 70) * 0.0015 + 0.01 * this.sharp(off) - (this.down >= 3 ? 0.04 : 0), 0.15, 0.92);
    let pInt = 0.025 - 0.007 * e + dprof.int + (depth === 'deep' ? 0.02 : depth === 'short' ? -0.008 : 0) - (qr - 70) * 0.0004;
    if (this.surging(def)) pInt *= 1.25;
    pInt = clamp(pInt, 0.005, 0.09);
    const air = depth === 'short' ? clamp(Math.round(this.rng.normal(4.5, 2.5)), -3, 9) : depth === 'medium' ? clamp(Math.round(this.rng.normal(13, 3)), 8, 19) : clamp(Math.round(this.rng.normal(29, 8)), 20, 55);
    const p = { type: 'pass' as const, offense: off, passer: qb.id, target: target.id, depth };
    const roll = this.rng.next();

    if (roll < pInt) {
      const interceptor = this.defender(def, 'int');
      const spotOff = this.ballOn + Math.max(air, 1);
      const base = { ...p, complete: false, interceptor, turnover: 'interception' as const, down: this.down, distance: this.dist, fourthDownTry: this.down === 4 || undefined };
      if (spotOff >= 100) {
        this.emit({ ...base, touchback: true });
        this.spend(this.rng.int(5, 8));
        this.endDrive('INT');
        this.next = { kind: 'ball', side: def, ballOn: 20 };
        return;
      }
      const defSpot = 100 - spotOff;
      const six = !this.force.plain && this.rng.chance(0.045);
      const ret = six ? 100 - defSpot : this.rng.chance(0.3) ? 0 : Math.min(Math.round(this.rng.exp(9)), 99 - defSpot);
      if (six) {
        this.emit({ ...base, returnYards: ret, td: def, points: { side: def, pts: 6, kind: 'TD' } });
        this.spend(this.rng.int(9, 14));
        this.endDrive('INT');
        this.lastDefTd = true;
        this.afterTouchdown(def);
        this.next = { kind: 'kickoff', kicking: def, free: false };
      } else {
        this.emit({ ...base, returnYards: ret });
        this.spend(this.rng.int(6, 10));
        this.endDrive('INT');
        this.next = { kind: 'ball', side: def, ballOn: defSpot + ret };
      }
      return;
    }
    if (roll >= pInt + comp * (1 - pInt)) {
      const pd = this.rng.chance(0.3) ? this.defender(def, 'pd') : undefined;
      return this.settle({ ...p, complete: false, pd }, 0, 'incomplete', hurry, milk);
    }
    let yac = depth === 'short' ? this.rng.exp(2.9) : depth === 'medium' ? this.rng.exp(2.1) : this.rng.exp(2.6);
    yac += (tr - 70) * 0.04 + 0.5 * e;
    if (this.rng.chance(clamp(0.04 + 0.012 * e + dprof.bigPlay + (star ? 0.04 : 0), 0.01, 0.18))) yac += 6 + this.rng.exp(14);
    const yards = clamp(Math.round(air + Math.max(0, yac)), Math.max(-5, -this.ballOn), toGoal);
    const full = { ...p, complete: true, tacklers: this.tacklers(def, 'passTackle') };
    if (this.rng.chance(0.006) && this.rng.chance(0.5) && this.fumbleLost(full, yards, target)) return;
    this.settle(full, yards, 'complete', hurry, milk);
  }

  /** Returns false when no eligible penalty applied. */
  private penalty(side: Side): boolean {
    const off = this.poss;
    const def = other(off);
    const S = this.sides[off];
    const D = this.sides[def];
    const r = this.rng.next();
    let name: string, yards: number, autoFirst = false, player: string | undefined;
    if (side === off) {
      if (r < 0.5) (name = 'False Start'), (yards = 5);
      else if (r < 0.9) (name = 'Holding'), (yards = 10);
      else (name = 'Delay of Game'), (yards = 5);
      if (name !== 'Delay of Game' && S.lineup.ol.length) player = this.rng.pick(S.lineup.ol).id;
      const actual = Math.min(yards, Math.floor(this.ballOn / 2));
      if (actual <= 0) return false;
      this.emit({ type: 'penalty', offense: off, down: this.down, distance: this.dist, penalty: { side, name, yards: actual, player } });
      this.ballOn -= actual;
      this.dist += actual;
    } else {
      if (r < 0.42) (name = 'Offside'), (yards = 5);
      else if (r < 0.7) (name = 'Pass Interference'), (yards = 15), (autoFirst = true);
      else if (r < 0.85) (name = 'Holding'), (yards = 10), (autoFirst = true);
      else (name = 'Personal Foul'), (yards = 15), (autoFirst = true);
      player = name === 'Offside' || name === 'Personal Foul' ? this.defender(def, 'sack') : this.defender(def, 'pd');
      const actual = Math.min(yards, Math.floor((100 - this.ballOn) / 2));
      if (actual <= 0) return false;
      const first = autoFirst || actual >= this.dist;
      this.emit({ type: 'penalty', offense: off, down: this.down, distance: this.dist, firstDown: first || undefined, penalty: { side, name, yards: actual, player, autoFirst: autoFirst || undefined } });
      this.ballOn += actual;
      if (first) {
        this.down = 1;
        this.dist = Math.min(10, 100 - this.ballOn);
      } else this.dist -= actual;
      void D;
    }
    return true;
  }

  // ------------------------------------------------------------------ kicking game
  private fieldGoal(off: Side) {
    const def = other(off);
    const S = this.sides[off];
    const k = S.lineup.kicker;
    const d = 100 - this.ballOn + 17;
    let p = d <= 27 ? 0.97 : d <= 37 ? 0.86 : d <= 44 ? 0.73 : d <= 49 ? 0.61 : d <= 54 ? 0.47 : 0.26;
    p = clamp(p + ((k?.rating ?? 70) - 70) * 0.004 + (S.team.stRating - 70) * 0.002, 0.03, 0.995);
    let good = this.rng.chance(p);
    let blockedBy: string | undefined;
    if (this.force.fg) good = this.force.fg === 'GOOD';
    else if (!good && !this.force.plain && this.rng.chance(0.12)) blockedBy = this.defender(def, 'block');
    if (this.cur) this.cur.plays++;
    this.emit({ type: 'field_goal', offense: off, down: this.down, distance: this.dist, kicker: k?.id, fgDistance: d, good, blockedBy, points: good ? { side: off, pts: 3, kind: 'FG' } : undefined });
    this.spend(5);
    if (good) {
      this.endDrive('FG');
      this.next = { kind: 'kickoff', kicking: off, free: false };
    } else {
      this.endDrive('MISSED_FG');
      this.next = { kind: 'ball', side: def, ballOn: Math.max(20, 100 - this.ballOn) };
    }
  }

  private punt(off: Side) {
    const def = other(off);
    const S = this.sides[off];
    const R = this.sides[def];
    const punter = S.lineup.punter;
    let gross = clamp(Math.round(this.rng.normal(42 + ((punter?.rating ?? 70) - 70) * 0.12 + (S.team.stRating - 70) * 0.05, 6)), 18, 68);
    const base = { type: 'punt' as const, offense: off, down: this.down, distance: this.dist, punter: punter?.id };
    if (this.cur) this.cur.plays++;
    const land = this.ballOn + gross;
    if (land >= 100) {
      gross = 100 - this.ballOn;
      this.emit({ ...base, kickYards: gross, touchback: true });
      this.spend(this.rng.int(6, 9));
      this.endDrive('PUNT');
      this.next = { kind: 'ball', side: def, ballOn: 20 };
      return;
    }
    const catchSpot = 100 - land;
    const returner = R.lineup.pr.length ? this.pickSlot(R.lineup.pr, def) : null;
    const r = this.rng.next();
    if (!returner || r < 0.58) {
      const fair = !!returner && r < 0.42;
      this.emit({ ...base, kickYards: gross, fairCatch: fair || undefined, returner: fair ? returner!.id : undefined, inside20: catchSpot < 20 || undefined });
      this.spend(this.rng.int(6, 9));
      this.endDrive('PUNT');
      this.next = { kind: 'ball', side: def, ballOn: catchSpot };
      return;
    }
    const house = !this.force.plain && this.rng.chance(0.012 + (R.team.stRating - 70) * 0.0003);
    const ret = house ? 100 - catchSpot : clamp(Math.round(this.rng.exp(8.5) - 1), -3, 99 - catchSpot);
    if (house) {
      this.emit({ ...base, kickYards: gross, returner: returner.id, returnYards: ret, td: def, points: { side: def, pts: 6, kind: 'TD' } });
      this.spend(this.rng.int(11, 15));
      this.endDrive('PUNT');
      this.afterTouchdown(def);
      this.next = { kind: 'kickoff', kicking: def, free: false };
      return;
    }
    this.emit({ ...base, kickYards: gross, returner: returner.id, returnYards: ret, inside20: catchSpot + ret < 20 || undefined });
    this.spend(this.rng.int(8, 12));
    this.endDrive('PUNT');
    this.next = { kind: 'ball', side: def, ballOn: catchSpot + ret };
  }

  kickoff(kicking: Side, free: boolean) {
    const rec = other(kicking);
    const K = this.sides[kicking];
    const R = this.sides[rec];
    const k = K.lineup.kicker ?? K.lineup.punter;
    const from = free ? 20 : 35;
    const saved = this.ballOn;
    this.ballOn = from;
    const base = { type: 'kickoff' as const, offense: kicking, poss: rec, kicker: k?.id, freeKick: free || undefined };
    const returner = R.lineup.kr.length ? this.pickSlot(R.lineup.kr, rec) : null;
    const pTouch = free ? 0 : clamp(0.5 + ((k?.rating ?? 70) - 70) * 0.006, 0.15, 0.85);
    if (!free && (this.rng.chance(pTouch) || !returner)) {
      this.emit({ ...base, kickYards: 65, touchback: true });
      this.ballOn = saved;
      this.next = { kind: 'ball', side: rec, ballOn: 25 };
      return;
    }
    const landing = free ? clamp(Math.round(this.rng.normal(22, 6)), 8, 40) : this.rng.int(0, 9);
    const kickYards = 100 - from - landing;
    if (!returner) {
      this.emit({ ...base, kickYards });
      this.ballOn = saved;
      this.next = { kind: 'ball', side: rec, ballOn: Math.max(landing, 1) };
      return;
    }
    const house = !this.force.plain && this.rng.chance(0.006 + (R.team.stRating - 70) * 0.0002);
    const ret = house ? 100 - landing : clamp(Math.round(this.rng.normal(free ? 12 : 21.5, 7)), 3, 99 - landing);
    if (house) {
      this.emit({ ...base, kickYards, returner: returner.id, returnYards: ret, td: rec, points: { side: rec, pts: 6, kind: 'TD' } });
      this.spend(this.rng.int(11, 15));
      this.ballOn = saved;
      this.afterTouchdown(rec);
      this.next = { kind: 'kickoff', kicking: rec, free: false };
      return;
    }
    this.emit({ ...base, kickYards, returner: returner.id, returnYards: ret });
    this.spend(this.rng.int(5, 8));
    this.ballOn = saved;
    this.next = { kind: 'ball', side: rec, ballOn: landing + ret };
  }

  // ------------------------------------------------------------------ tries
  private afterTouchdown(side: Side) {
    const opp = other(side);
    const S = this.sides[side];
    const lead = this.score[side] - this.score[opp];
    const forced = this.force.pat;
    if (forced === 'NONE') return;
    // In overtime the try is skipped when the touchdown already decides the game.
    if (this.ot && !forced && ((this.otSecond && lead > 0) || this.lastDefTd)) return;
    let two = !S.lineup.kicker;
    if (this.ot >= 2) two = true;
    else if (S.lineup.kicker && !this.untimed && this.quarter === 4 && [-2, -5, -10, 1, 5, 12].includes(lead)) two = true;
    if (forced) two = forced.startsWith('2PT');
    if (two) return void this.twoPoint(side, false);
    const k = S.lineup.kicker;
    let good = this.rng.chance(clamp(0.965 + ((k?.rating ?? 70) - 70) * 0.002, 0.8, 0.995));
    if (forced) good = forced === 'XP_GOOD';
    const savedBall = this.ballOn;
    this.ballOn = 97;
    this.emit({ type: 'extra_point', offense: side, kicker: k?.id, good, points: good ? { side, pts: 1, kind: 'XP' } : undefined });
    this.ballOn = savedBall;
  }

  twoPoint(side: Side, otTry: boolean) {
    const S = this.sides[side];
    const e = this.edge(side);
    let good = this.rng.chance(clamp(0.43 + 0.05 * e, 0.2, 0.7));
    if (this.force.pat) good = this.force.pat === '2PT_GOOD';
    const qb = this.qb(side);
    const savedBall = this.ballOn;
    this.ballOn = 97;
    const pass = this.rng.chance(0.62) || !S.lineup.rushers.length;
    const hasTarget = S.lineup.receivers.some((s) => s.p.id !== qb.id);
    if (pass && hasTarget) {
      const target = this.pickSlot(S.lineup.receivers, side, qb.id);
      this.emit({ type: 'two_point', offense: side, passer: qb.id, target: target.id, good, points: good ? { side, pts: 2, kind: '2PT' } : undefined });
    } else {
      const rusher = S.lineup.rushers.length ? this.pickSlot(S.lineup.rushers, side) : qb;
      this.emit({ type: 'two_point', offense: side, rusher: rusher.id, good, points: good ? { side, pts: 2, kind: '2PT' } : undefined });
    }
    this.ballOn = savedBall;
    void otTry;
  }
}

const EMPTY: Set<string> = new Set();
