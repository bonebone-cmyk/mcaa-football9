import type { DefScheme, OffScheme, Tempo } from './types';

export interface OffProfile {
  /** Base share of plays that are passes. */
  pass: number;
  /** Share of designed runs kept by the quarterback. */
  qbRun: number;
  /** Short / medium / deep target mix. */
  depth: [number, number, number];
  runYds: number;
  comp: number;
  fumble: number;
  tempo: number;
}

export const OFF_PROFILE: Record<OffScheme, OffProfile> = {
  Spread: { pass: 0.52, qbRun: 0.14, depth: [0.6, 0.28, 0.12], runYds: 0.15, comp: 0.01, fumble: 1, tempo: -3 },
  'Physical Spread': { pass: 0.44, qbRun: 0.18, depth: [0.56, 0.3, 0.14], runYds: 0.3, comp: 0, fumble: 1, tempo: -1 },
  'Pro Style': { pass: 0.47, qbRun: 0.05, depth: [0.54, 0.31, 0.15], runYds: 0.1, comp: 0.005, fumble: 0.95, tempo: 2 },
  'Air Raid': { pass: 0.63, qbRun: 0.05, depth: [0.64, 0.25, 0.11], runYds: -0.1, comp: 0.025, fumble: 1, tempo: -5 },
  Option: { pass: 0.28, qbRun: 0.34, depth: [0.45, 0.3, 0.25], runYds: 0.45, comp: -0.03, fumble: 1.35, tempo: 3 },
  'Run Heavy': { pass: 0.34, qbRun: 0.08, depth: [0.5, 0.31, 0.19], runYds: 0.3, comp: -0.01, fumble: 1.05, tempo: 3 },
  'Pass Heavy': { pass: 0.59, qbRun: 0.06, depth: [0.52, 0.31, 0.17], runYds: -0.1, comp: 0.01, fumble: 1, tempo: -2 },
  Balanced: { pass: 0.47, qbRun: 0.08, depth: [0.57, 0.3, 0.13], runYds: 0.1, comp: 0, fumble: 1, tempo: 0 },
};

export interface DefProfile {
  /** Yards per carry taken away. */
  runDef: number;
  /** Completion probability taken away. */
  comp: number;
  sack: number;
  int: number;
  /** Added explosive-play chance allowed. */
  bigPlay: number;
}

export const DEF_PROFILE: Record<DefScheme, DefProfile> = {
  '4-3': { runDef: 0.25, comp: 0, sack: 0.004, int: 0, bigPlay: 0 },
  '3-4': { runDef: 0.1, comp: 0.005, sack: 0.008, int: 0.001, bigPlay: 0.003 },
  '4-2-5': { runDef: -0.15, comp: 0.02, sack: 0, int: 0.003, bigPlay: -0.004 },
  '3-3-5': { runDef: -0.35, comp: 0.03, sack: -0.004, int: 0.005, bigPlay: -0.008 },
  Nickel: { runDef: -0.2, comp: 0.022, sack: 0, int: 0.003, bigPlay: -0.004 },
  Multiple: { runDef: 0.05, comp: 0.008, sack: 0.002, int: 0.001, bigPlay: 0 },
  'Man Heavy': { runDef: 0, comp: 0.03, sack: 0.006, int: -0.002, bigPlay: 0.012 },
  'Zone Heavy': { runDef: 0, comp: -0.015, sack: -0.004, int: 0.006, bigPlay: -0.01 },
  'Blitz Heavy': { runDef: 0.15, comp: 0.01, sack: 0.022, int: 0.002, bigPlay: 0.02 },
};

export const TEMPO_RUNOFF: Record<Tempo, number> = { slow: 4, normal: 0, fast: -6 };
