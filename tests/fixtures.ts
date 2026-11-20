import type { OffScheme, DefScheme, Position, RosterPlayer, TeamInput } from '../engine/types';

const SLOTS: [Position, number, Position[]][] = [
  ['QB', 1, []], ['QB', 2, []], ['RB', 1, []], ['RB', 2, ['KR']], ['RB', 3, []], ['FB', 1, []],
  ['WR', 1, []], ['WR', 2, ['PR']], ['WR', 3, []], ['WR', 4, []], ['TE', 1, []], ['TE', 2, []],
  ['LT', 1, []], ['LG', 1, []], ['C', 1, []], ['RG', 1, []], ['RT', 1, []],
  ['DE', 1, []], ['DE', 2, []], ['DT', 1, []], ['DT', 2, []], ['EDGE', 1, []], ['LB', 1, []], ['LB', 2, []], ['LB', 3, []],
  ['CB', 1, []], ['CB', 2, []], ['CB', 3, []], ['FS', 1, []], ['SS', 1, []], ['K', 1, []], ['P', 1, []],
];

/** A clearly synthetic test roster. Names are generated ("<ABBR> QB1") so tests never look like league data. */
export function makeTeam(abbr: string, opts: Partial<TeamInput> & { rating?: number; playerRating?: number | null } = {}): TeamInput {
  const rating = opts.rating ?? 75;
  const roster: RosterPlayer[] = SLOTS.map(([position, depth, secondary], i) => ({
    id: `${abbr}-${position}${depth}`, name: `${abbr} ${position}${depth}`, jersey: i + 1, position, secondary, depth,
    rating: opts.playerRating === undefined ? 78 - depth * 4 : opts.playerRating, active: true,
  }));
  return {
    id: `team-${abbr}`, name: `${abbr} Testers`, abbr, offRating: rating, defRating: rating, stRating: 70,
    offScheme: 'Balanced' as OffScheme, defScheme: '4-3' as DefScheme, runPct: null, tempo: 'normal', roster,
    pct: { activity: 60, upset: 40, star: 40 }, ...opts,
  };
}
