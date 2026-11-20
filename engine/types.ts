export const ENGINE_VERSION = '1.0.0';

export const OFFENSE_POSITIONS = ['QB', 'RB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT'] as const;
export const DEFENSE_POSITIONS = ['DE', 'DT', 'EDGE', 'LB', 'CB', 'FS', 'SS'] as const;
export const SPECIAL_POSITIONS = ['K', 'P', 'KR', 'PR'] as const;
export const POSITIONS = [...OFFENSE_POSITIONS, ...DEFENSE_POSITIONS, ...SPECIAL_POSITIONS] as const;
export type Position = (typeof POSITIONS)[number];

export const OFF_SCHEMES = ['Spread', 'Physical Spread', 'Pro Style', 'Air Raid', 'Option', 'Run Heavy', 'Pass Heavy', 'Balanced'] as const;
export type OffScheme = (typeof OFF_SCHEMES)[number];
export const DEF_SCHEMES = ['4-3', '3-4', '4-2-5', '3-3-5', 'Nickel', 'Multiple', 'Man Heavy', 'Zone Heavy', 'Blitz Heavy'] as const;
export type DefScheme = (typeof DEF_SCHEMES)[number];
export const TEMPOS = ['slow', 'normal', 'fast'] as const;
export type Tempo = (typeof TEMPOS)[number];

/** 0 = away, 1 = home. */
export type Side = 0 | 1;
export const other = (s: Side): Side => (s === 0 ? 1 : 0);

export interface RosterPlayer {
  id: string;
  name: string;
  jersey: number | null;
  position: Position;
  secondary: Position[];
  depth: number;
  rating: number | null;
  active: boolean;
}

export interface Percentages {
  activity: number;
  upset: number;
  star: number;
}

export interface TeamInput {
  id: string;
  name: string;
  abbr: string;
  offRating: number;
  defRating: number;
  stRating: number;
  offScheme: OffScheme;
  defScheme: DefScheme;
  /** Custom run share 0-100. null = use the scheme default. */
  runPct: number | null;
  tempo: Tempo;
  roster: RosterPlayer[];
  pct: Percentages;
  /** Pre-game record, used only for recap wording. */
  record?: { w: number; l: number };
}

export interface SimConfig {
  /** Total rating-point edge given to the home team (0 on a neutral site). */
  homeFieldAdvantage: number;
  neutralSite: boolean;
  /** 'ncaa': sacks are rushing attempts/yards for the QB. 'nfl': sack yards come off team passing. */
  sackConvention: 'ncaa' | 'nfl';
  quarterSeconds: number;
  /** Rating-point swing applied by a passed/failed Activity check. */
  activityEffect: number;
  /** Share of the rating gap an underdog closes when its Upset check passes. */
  upsetGapClosure: number;
  /** Rating-point boost for a player whose Star check passes. */
  starBoost: number;
  allowInactive: boolean;
}

export const DEFAULT_CONFIG: SimConfig = {
  homeFieldAdvantage: 2.5,
  neutralSite: false,
  sackConvention: 'ncaa',
  quarterSeconds: 900,
  activityEffect: 1.5,
  upsetGapClosure: 0.6,
  starBoost: 12,
  allowInactive: false,
};

export type PlayType = 'kickoff' | 'run' | 'pass' | 'sack' | 'punt' | 'field_goal' | 'extra_point' | 'two_point' | 'kneel' | 'penalty' | 'timeout';

export type ScoreKind = 'TD' | 'FG' | 'XP' | '2PT' | 'SAFETY';

export interface Play {
  seq: number;
  /** Drive number (1-based). 0 for kickoffs. */
  drive: number;
  /** 1-4 regulation, 5+ overtime periods. */
  quarter: number;
  /** Seconds left in the period at the snap. */
  clock: number;
  /** Team snapping/kicking the ball. */
  offense: Side;
  /** Team credited with possession time for this play. */
  poss: Side;
  down: number | null;
  distance: number | null;
  /** Yards from the offense's own goal line at the snap. */
  ballOn: number;
  type: PlayType;
  /** Net yards for the offense on a scrimmage play. */
  yards: number;
  desc: string;

  passer?: string;
  rusher?: string;
  target?: string;
  complete?: boolean;
  /** 'short' | 'medium' | 'deep' */
  depth?: string;
  tacklers?: string[];
  sackers?: string[];
  sackAllowedBy?: string;
  interceptor?: string;
  pd?: string;
  fumbler?: string;
  forcedBy?: string;
  recoveredBy?: string;
  fumbleLost?: boolean;
  kicker?: string;
  punter?: string;
  returner?: string;
  kickYards?: number;
  returnYards?: number;
  touchback?: boolean;
  fairCatch?: boolean;
  inside20?: boolean;
  fgDistance?: number;
  good?: boolean;
  blockedBy?: string;
  freeKick?: boolean;
  penalty?: { side: Side; name: string; yards: number; player?: string; autoFirst?: boolean };
  timeoutBy?: Side;

  firstDown?: boolean;
  turnover?: 'interception' | 'fumble' | 'downs';
  /** Side that scored a touchdown on this play. */
  td?: Side;
  points?: { side: Side; pts: number; kind: ScoreKind };
  /** True when the offense went for it on fourth down. */
  fourthDownTry?: boolean;
  scoreAfter: [number, number];
}

export type DriveResult = 'TD' | 'FG' | 'MISSED_FG' | 'PUNT' | 'INT' | 'FUMBLE' | 'DOWNS' | 'SAFETY' | 'END_HALF' | 'END_GAME';

export interface Drive {
  num: number;
  side: Side;
  quarter: number;
  startClock: number;
  startBallOn: number;
  plays: number;
  yards: number;
  seconds: number;
  result: DriveResult;
  /** Points the possessing team scored on the drive (PAT included). */
  points: number;
}

export interface ScoringEvent {
  playSeq: number;
  quarter: number;
  clock: number;
  side: Side;
  kind: ScoreKind;
  pts: number;
  playerId: string | null;
  desc: string;
  score: [number, number];
}

export interface PlayerLine {
  playerId: string;
  side: Side;
  // passing
  passAtt: number; passCmp: number; passYds: number; passTd: number; passInt: number; passLong: number;
  sacked: number; sackYdsLost: number;
  // rushing
  rushAtt: number; rushYds: number; rushTd: number; rushLong: number; fumbles: number; fumblesLost: number;
  // receiving
  targets: number; rec: number; recYds: number; recTd: number; recLong: number;
  // defense
  tklSolo: number; tklAst: number; tfl: number; sacks: number; defInt: number; intRetYds: number; pd: number; ff: number; fr: number; defTd: number; blocks: number;
  // kicking
  fgm: number; fga: number; fgLong: number; xpm: number; xpa: number; kickoffs: number; koTouchbacks: number;
  // punting
  punts: number; puntYds: number; puntLong: number; puntIn20: number;
  // returns
  kr: number; krYds: number; krTd: number; pr: number; prYds: number; prTd: number;
  // other
  twoPt: number; olSnaps: number; sacksAllowed: number; penalties: number; penaltyYds: number;
}

export interface TeamLine {
  side: Side;
  points: number;
  totalYds: number; passYds: number; rushYds: number; plays: number;
  passAtt: number; passCmp: number; rushAtt: number;
  firstDowns: number; firstDownsRush: number; firstDownsPass: number; firstDownsPen: number;
  thirdAtt: number; thirdConv: number; fourthAtt: number; fourthConv: number;
  turnovers: number; intThrown: number; fumblesLost: number;
  penalties: number; penaltyYds: number;
  top: number;
  sacks: number; sackYds: number;
  rzAtt: number; rzScores: number; rzTd: number;
  punts: number; puntYds: number;
  // team-credited events that have no eligible individual
  teamRushAtt: number; teamRushYds: number; teamTackles: number; teamSacks: number; teamInt: number; teamFr: number; teamPunts: number; teamPuntYds: number;
}

export interface PercentageCheck {
  category: 'activity' | 'upset' | 'star';
  side: Side;
  teamId: string;
  /** e.g. "Q1", "1st half", or a player id for star checks. */
  scope: string;
  scopeLabel: string;
  percentage: number;
  roll: number;
  passed: boolean;
  effect: string;
}

export interface Highlight {
  playSeq: number;
  quarter: number;
  clock: number;
  side: Side;
  title: string;
  text: string;
  rank: number;
  tags: string[];
}

export interface ValidationCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface Recap {
  headline: string;
  text: string;
  source: 'template' | 'ai';
  reconstruction: boolean;
}

export interface LockedStats {
  /** playerId -> stat key -> value. Keys: PlayerLine fields listed in LOCKABLE_PLAYER_STATS. */
  players: Record<string, Partial<Record<LockablePlayerStat, number>>>;
  /** Per side team-level locks. */
  teams?: [TeamLocks, TeamLocks];
}
export interface TeamLocks {
  passYds?: number;
  rushYds?: number;
  turnovers?: number;
}

export const LOCKABLE_PLAYER_STATS = [
  'passAtt', 'passCmp', 'passYds', 'passTd', 'passInt',
  'rushAtt', 'rushYds', 'rushTd',
  'rec', 'recYds', 'recTd',
  'tackles', 'sacks', 'defInt',
  'fgm', 'fga', 'xpm', 'xpa',
] as const;
export type LockablePlayerStat = (typeof LOCKABLE_PLAYER_STATS)[number];

export interface PrimetimeInput {
  final: [number, number];
  /** Optional per-period scores, [away[], home[]]; entries beyond 4 are overtime periods. */
  quarters?: [number[], number[]] | null;
  /** Number of overtime periods played (ignored when quarters are supplied). */
  overtimePeriods?: number;
  locks?: LockedStats | null;
}

export interface GameResult {
  mode: 'sim' | 'primetime';
  engineVersion: string;
  seed: string;
  teams: [{ id: string; name: string; abbr: string }, { id: string; name: string; abbr: string }];
  final: [number, number];
  /** [away[], home[]] points per period. */
  quarters: [number[], number[]];
  overtimePeriods: number;
  plays: Play[];
  drives: Drive[];
  scoring: ScoringEvent[];
  playerStats: PlayerLine[];
  teamStats: [TeamLine, TeamLine];
  highlights: Highlight[];
  recap: Recap;
  percentageChecks: PercentageCheck[];
  warnings: string[];
  validation: ValidationCheck[];
  config: SimConfig;
  /** Primetime only: the authoritative inputs the reconstruction was built around. */
  primetime?: PrimetimeInput;
}

export class SimError extends Error {
  constructor(public code: string, message: string, public details: string[] = []) {
    super(message);
  }
}
