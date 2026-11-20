import { selectHighlights } from './highlights';
import { runPercentageChecks } from './percentages';
import { writeRecap } from './recap';
import { assertRoster, buildLineup } from './roster';
import { Rng } from './rng';
import { GameSim } from './sim';
import { computeStats } from './stats';
import { DEFAULT_CONFIG, ENGINE_VERSION, SimError, type Drive, type GameResult, type PercentageCheck, type Play, type PrimetimeInput, type SimConfig, type TeamInput } from './types';
import { validateGame } from './validate';

export * from './types';
export { checkRoster, buildLineup } from './roster';
export { validateGame, lockMismatches } from './validate';
export { computeStats, passerRating } from './stats';
export { fmtClock, periodLabel, downLabel, playResult, spot } from './describe';
export { reconstructPrimetime, checkPrimetimeInput } from './primetime';
export { rebuildDrives } from './drives';
export { describePlay } from './describe';
export { OFF_PROFILE, DEF_PROFILE } from './schemes';

export interface SimInput {
  seed: string;
  teams: [TeamInput, TeamInput];
  config?: Partial<SimConfig>;
}

export function validatePercentages(t: TeamInput) {
  for (const k of ['activity', 'upset', 'star'] as const) {
    const v = t.pct?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new SimError('PERCENTAGES', `${t.name} is missing a valid ${k} percentage (0-100). Percentages are never invented; import them from the MCAA source.`);
  }
}

/** Derive every downstream artifact (stats, scoring summary, highlights, recap, validation) from a play ledger. */
export function finalize(mode: 'sim' | 'primetime', seed: string, teams: [TeamInput, TeamInput], config: SimConfig, plays: Play[], drives: Drive[], percentageChecks: PercentageCheck[], warnings: string[], primetime?: PrimetimeInput): GameResult {
  const calc = computeStats(plays, teams, config);
  const teamName: [string, string] = [teams[0].name, teams[1].name];
  const highlights = selectHighlights(plays, teamName, calc.final, config.quarterSeconds);
  const partial = {
    mode, engineVersion: ENGINE_VERSION, seed,
    teams: [{ id: teams[0].id, name: teams[0].name, abbr: teams[0].abbr }, { id: teams[1].id, name: teams[1].name, abbr: teams[1].abbr }] as GameResult['teams'],
    final: calc.final, quarters: calc.quarters, overtimePeriods: Math.max(0, calc.quarters[0].length - 4),
    plays, drives, scoring: calc.scoring, playerStats: calc.playerStats, teamStats: calc.teamStats, highlights,
    percentageChecks, warnings, config, primetime,
  };
  const recap = writeRecap(partial, teams);
  const validation = validateGame(partial, teams);
  return { ...partial, recap, validation };
}

/** MODE A: full play-by-play simulation. Deterministic for a given seed and inputs. */
export function simulateGame(input: SimInput): GameResult {
  const config: SimConfig = { ...DEFAULT_CONFIG, ...input.config };
  const teams = input.teams;
  if (teams[0].id === teams[1].id) throw new SimError('MATCHUP', 'A team cannot play itself.');
  const warnings: string[] = [];
  for (const t of teams) {
    validatePercentages(t);
    warnings.push(...assertRoster(t, config.allowInactive));
  }
  const lineups = [buildLineup(teams[0], config.allowInactive), buildLineup(teams[1], config.allowInactive)] as [ReturnType<typeof buildLineup>, ReturnType<typeof buildLineup>];
  const pct = runPercentageChecks(input.seed, teams, lineups, config);
  const sim = new GameSim(teams, pct.state, config, new Rng(`${input.seed}/game`));
  sim.run();
  return finalize('sim', input.seed, teams, config, sim.plays, sim.drives, pct.checks, warnings);
}

export function allValid(r: GameResult): boolean {
  return r.validation.every((v) => v.ok);
}
