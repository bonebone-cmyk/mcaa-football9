// MCAA percentages. Activity, Upset and Star are evaluated EQUALLY BUT SEPARATELY:
//   * each category draws from its own random stream,
//   * each category is rolled against its own percentage only,
//   * each category drives a different mechanism in the game,
//   * the three are never added, averaged or folded into one probability.
// See docs/PERCENTAGES.md for the full specification.
import type { Lineup } from './roster';
import { Rng } from './rng';
import type { PercentageCheck, Side, SimConfig, TeamInput } from './types';

export interface PctState {
  /** Activity result per period: index 0-3 = quarters, 4 = overtime. */
  activity: boolean[];
  /** Upset result per half. Overtime uses the second-half result. */
  upset: [boolean, boolean];
  /** Rating points granted while an Upset surge is active (0 for a favorite). */
  upsetBonus: number;
  /** Player ids whose Star check passed. */
  stars: Set<string>;
}

export function overall(t: TeamInput): number {
  return (t.offRating + t.defRating) / 2;
}

export function runPercentageChecks(seed: string, teams: [TeamInput, TeamInput], lineups: [Lineup, Lineup], cfg: SimConfig): { state: [PctState, PctState]; checks: PercentageCheck[] } {
  const base = new Rng(seed);
  const checks: PercentageCheck[] = [];
  const state: PctState[] = [];
  const hfa = cfg.neutralSite ? 0 : cfg.homeFieldAdvantage;

  for (const side of [0, 1] as Side[]) {
    const t = teams[side];
    const opp = teams[side === 0 ? 1 : 0];

    // --- ACTIVITY: preparedness. One check per quarter (+1 for overtime). Drives execution quality. ---
    const actRng = base.fork(`pct/activity/${side}`);
    const activity: boolean[] = [];
    for (let q = 0; q < 5; q++) {
      const roll = actRng.next() * 100;
      const passed = roll < t.pct.activity;
      activity.push(passed);
      checks.push({
        category: 'activity', side, teamId: t.id, scope: q < 4 ? `Q${q + 1}` : 'OT', scopeLabel: q < 4 ? `Quarter ${q + 1}` : 'Overtime (used only if played)',
        percentage: t.pct.activity, roll: Math.round(roll * 100) / 100, passed,
        effect: passed
          ? `Sharp: +${cfg.activityEffect} execution rating, fewer penalties and fumbles this period`
          : `Flat: -${cfg.activityEffect} execution rating, more penalties and fumbles this period`,
      });
    }

    // --- UPSET: underdog potential. One check per half. Closes part of the rating gap; never helps a favorite. ---
    const upsRng = base.fork(`pct/upset/${side}`);
    // Positive gap = this team is the underdog once home field is counted.
    const adjGap = overall(opp) + (side === 0 ? hfa : -hfa) - overall(t);
    const role = adjGap >= 1 ? 'underdog' : adjGap <= -1 ? 'favorite' : 'even';
    const upsetBonus = role === 'underdog' ? Math.round(adjGap * cfg.upsetGapClosure * 100) / 100 : role === 'even' ? 1 : 0;
    const upset: boolean[] = [];
    for (let h = 0; h < 2; h++) {
      const roll = upsRng.next() * 100;
      const passed = roll < t.pct.upset;
      upset.push(passed);
      checks.push({
        category: 'upset', side, teamId: t.id, scope: `H${h + 1}`, scopeLabel: h === 0 ? 'First half' : 'Second half and overtime',
        percentage: t.pct.upset, roll: Math.round(roll * 100) / 100, passed,
        effect: !passed
          ? 'No surge this half'
          : role === 'favorite'
            ? 'Passed, no effect: the team is favored in this matchup, and Upset potential only helps an underdog'
            : `Upset surge: +${upsetBonus} rating (${role === 'even' ? 'even matchup' : `${Math.round(cfg.upsetGapClosure * 100)}% of the ${adjGap.toFixed(1)}-point gap closed`}) and a higher takeaway chance this half`,
      });
    }

    // --- STAR: individual brilliance. One check per featured player. Raises that player's usage and efficiency only. ---
    const starRng = base.fork(`pct/star/${side}`);
    const stars = new Set<string>();
    const l = lineups[side];
    const cands: { id: string; name: string; role: string }[] = [];
    if (l.qbs[0]) cands.push({ id: l.qbs[0].p.id, name: l.qbs[0].p.name, role: 'QB1' });
    if (l.rushers[0]) cands.push({ id: l.rushers[0].p.id, name: l.rushers[0].p.name, role: 'lead rusher' });
    const wr = l.receivers.find((s) => !cands.some((c) => c.id === s.p.id));
    if (wr) cands.push({ id: wr.p.id, name: wr.p.name, role: 'top receiver' });
    const topDef = [...l.defenders].sort((a, b) => (b.rating ?? 70) - (a.rating ?? 70) || a.depth - b.depth || a.id.localeCompare(b.id)).find((d) => !cands.some((c) => c.id === d.id));
    if (topDef) cands.push({ id: topDef.id, name: topDef.name, role: 'top defender' });
    for (const c of cands) {
      const roll = starRng.next() * 100;
      const passed = roll < t.pct.star;
      if (passed) stars.add(c.id);
      checks.push({
        category: 'star', side, teamId: t.id, scope: c.id, scopeLabel: `${c.name} (${c.role})`,
        percentage: t.pct.star, roll: Math.round(roll * 100) / 100, passed,
        effect: passed ? `Star game: +${cfg.starBoost} individual rating, larger share of touches and more explosive plays for this player only` : 'Normal game for this player',
      });
    }
    state.push({ activity, upset: [upset[0], upset[1]], upsetBonus, stars });
  }
  return { state: [state[0], state[1]], checks };
}

/** Placeholder state for score-constrained reconstructions, where percentages are not applied at all. */
export function neutralPctState(): PctState {
  return { activity: [false, false, false, false, false], upset: [false, false], upsetBonus: 0, stars: new Set() };
}
