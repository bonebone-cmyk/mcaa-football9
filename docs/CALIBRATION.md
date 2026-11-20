# Simulation calibration

Reproduce with `npm run calibrate -- 3000` (evenly matched teams, all 8 offensive × 9 defensive identities rotated,
home field on). The same measurements run as assertions in `tests/calibration.test.ts` on every test run.

Reference ranges are approximate recent FBS per-team, per-game figures, widened a little; they are a sanity target,
not a claim of matching any particular season.

| Measure | Engine (3,000 games) | Reference range |
| --- | --- | --- |
| Points per team | 27.1 | 24–31 |
| Passing yards per team | 245 | 215–255 |
| Rushing yards per team (sacks included, NCAA) | 153 | 150–185 |
| Plays per team | 69.3 | 64–74 |
| Completion percentage | 60.7 | 59–64 |
| Yards per pass attempt | 7.25 | 7.0–7.9 |
| Yards per rush | 4.32 | 4.1–4.8 |
| Turnovers per team | 1.15 | 1.1–1.6 |
| Interceptions per team | 0.73 | 0.6–0.9 |
| Fumbles lost per team | 0.42 | 0.4–0.7 |
| Sacks per team | 2.29 | 1.8–2.5 |
| Penalties per team | 6.3 | 5.5–7.0 |
| Punts per team | 4.5 | 3.6–4.8 |
| Field goals made per team | 1.38 | 1.1–1.6 |
| Field-goal percentage | 79.5 | 72–80 |
| Third-down conversion | 42.0% | 37–43% |
| Home win rate (even teams) | 57.7% | 55–62% |
| Decided by 21+ | 21.3% | 15–25% |
| One-score games | 42.1% | 38–50% |
| Overtime | 4.0% | 3–6% |
| Winner trailed by 10+ at some point | 15.3% | 8–16% |
| Combined score 70+ | 13.7% | 8–18% |
| Games failing validation | 0 | 0 |

Outside the range, left as is:

* **First downs per team: 24.1** (reference 19–23). Touchdown plays and penalty first downs are counted as first downs.
* **Combined score of 30 or fewer: 4.0%** (reference 5–12%) and **shutouts: 0.4%** of team-games (reference 1–3%).
  Evenly matched test teams produce fewer one-sided defensive games than a real season with mismatches does.

## Strength matters, without guarantees

Home team stronger by this many rating points (offense and defense), 1,000 games each:

| Rating gap | Stronger team wins |
| --- | --- |
| 0 (home field only) | 58% |
| 5 | 73% |
| 10 | 84% |
| 15 | 91% |
| 20 | 96% |

No result is forced: every game is a sequence of legal snaps from a seeded random stream. The test suite asserts that
600 games produce more than 250 distinct final scores.

## Speed

About 2.5–3.5 ms per full game (simulation, statistics, highlights, recap and validation) on one core.
A CFB 27 reconstruction with no locked statistics takes a few milliseconds; with a fully locked box score for both
teams it typically takes 0.1–1 s and occasionally several seconds, which is why it runs in the administrator's browser.
