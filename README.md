# MCAA Football — Simulation & Statistics Engine

A complete site for the Minecraft Collegiate Athletic Association: a public college-football site (scores, schedule,
rankings, teams, players, leaderboards, game pages) and a private league office where exactly four
administrators run simulations, import College Football 27 results, review and publish.

It runs entirely on Cloudflare: one **Worker** (the API), one **D1** database, and the React site served as static assets.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bonebone-cmyk/enginemcaa-)

---

## Put it on Cloudflare

**Option A — import the repository (recommended)**

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick this repo.
2. Leave **Build command** empty and keep **Deploy command** as `npx wrangler deploy`. Deploy.
   Wrangler builds the site and creates the D1 database (`mcaa-football-db`) automatically; there is no ID to paste.
3. Go to `https://<your-worker>/admin` and sign in on the **Access code** tab with the code. That is all you need to
   start running the league.
4. Optional: to give each administrator their own email/password account, add a **secret** named `SETUP_TOKEN`
   (16+ random characters) under the Worker's **Settings → Variables and Secrets**, then visit `/setup`. Start in **Team Manager** (season → conferences → teams), then **Roster Manager**,
   **Schedule Manager** and **Team Percentages** (enter Activity / Upset / Star for every team).

The Worker creates and migrates its own tables on the first request. There is no SQL to run by hand.

**Option B — from your computer**

```bash
npm install
npx wrangler login
npx wrangler deploy            # builds the site, creates the D1 database, deploys
npx wrangler secret put SETUP_TOKEN
```

**Optional secrets and variables**

| Name | Kind | What it does |
| --- | --- | --- |
| `ADMIN_CODE` | secret, optional | Replaces the built-in access code for the "Access code" sign-in. |
| `SETUP_TOKEN` | secret, optional | Allows creating/removing the four named administrator accounts at `/setup`. |
| `ANTHROPIC_API_KEY` | secret, optional | Turns on AI-written recaps and reading CFB 27 screenshots. Without it, recaps are written by the engine and values are typed in. |

Plan note: the app is built to fit the Workers Free plan. A full simulation costs about 3 ms of CPU, and the heavier
job — reconstructing a CFB 27 game around many locked statistics — is solved in the administrator's browser and then
verified by the server. The most CPU-hungry request is administrator sign-in (password hashing). This has been run
locally and through a Wrangler dry-run deploy, not on a live Cloudflare account; if sign-in ever fails with error 1102
on the Free plan, the Workers Paid plan removes that limit.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars      # set SETUP_TOKEN to any 16+ characters
npm run dev                          # API on :8787, site with hot reload on :5173
npm test                             # 69 automated tests (engine, primetime, API, calibration)
npm run calibrate -- 3000            # print league-wide averages for 3,000 simulated games
```

To look around with a clearly fictional sample league (local preview only — never against the real league database):

```bash
SETUP_TOKEN=<same value as .dev.vars> npm run seed:demo -- http://127.0.0.1:8787
```

## How it is put together

| Folder | Responsibility |
| --- | --- |
| `engine/` | Pure TypeScript, no I/O. Play-by-play simulation (`sim.ts`), independent percentage checks (`percentages.ts`), roster eligibility (`roster.ts`), statistics derived from the play ledger (`stats.ts`), validation (`validate.ts`), highlights, recap, and the score-constrained CFB 27 reconstruction (`primetime.ts`). |
| `worker/` | Hono API on Cloudflare Workers: `auth.ts` (sessions, four-admin rule), `db.ts` (schema + self-migration), `league.ts` (team records), `percent.ts` (team percentages stored in D1, imports, snapshots), `publish.ts` (transactional publishing), `ai.ts` (Claude recaps and screenshot reading), `public.ts`, `admin.ts`. |
| `src/` | React + TypeScript + Tailwind site: public pages and the eleven-section admin dashboard. Charts use Recharts. |
| `tests/` | Vitest suites. API tests run against a real local D1 database. |
| `docs/` | [`PERCENTAGES.md`](docs/PERCENTAGES.md) (exact meaning of Activity / Upset / Star), [`CALIBRATION.md`](docs/CALIBRATION.md) (measured output vs. college football ranges), [`DATA_MODEL.md`](docs/DATA_MODEL.md). |

The simulation never asks a language model for a number. Outcomes come from seeded, deterministic code; AI is used only
to phrase recaps from validated data and to transcribe screenshots for an administrator to confirm.

### The rules the code enforces

1. **Roster accuracy** — every individual credit points at an active rostered player on the right team. A missing position
   falls back to an authorized secondary position, then to a team-level credit, otherwise the simulation stops with a
   message. No names are ever invented. Checked again by validation before a result can be approved.
2. **Independent percentages** — Activity, Upset and Star are rolled from separate random streams against their own
   percentage and drive different mechanisms. They are never added or averaged. Every roll is stored and shown.
3. **Primetime score authority** — an imported CFB 27 score, imported period scores and locked statistics are inputs to a
   constraint solver; if they cannot all be true the import is refused with the reason. They are never adjusted.
4. **Statistical consistency** — box scores are computed from the play ledger, never typed or generated separately.
   Twelve validation checks (fifteen for CFB 27 imports) — score = scoring plays, passing = receiving, takeaways =
   giveaways, legal downs and more — must pass before a result can be approved.
5. **No invented source data** — percentages are entered by administrators and stored in D1; a team without them
   cannot be simulated, and nothing is defaulted.
6. **Realistic football** — see the calibration report.
7. **Secure administration** — no registration endpoint; four-account cap enforced by a database trigger as well as code;
   all `/api/admin` routes require a server-side session; state-changing requests require same-origin + a custom header.
8. **Persistent data** — everything is in D1.
9. **Public transparency** — simulated games, verified CFB 27 results, verified statistics (✓) and generated
   reconstructions are labeled on every game page. A replay of a finished simulation is never called live.
10. **Full implementation** — every button calls a working endpoint; see the status below for the two caveats.

## Status

**Built and tested** (automated tests + browser run-through of every page and the main admin workflows)

- Public site: home/scoreboard/featured game/league digest, schedule with filters, game page (summary, box score, team
  stats, play-by-play, highlights, scoring, score chart), team pages, player pages, rankings, sortable leaderboards with minimum-attempt rules, multi-season switching.
- Admin: Simulation Center (single game, Regenerate, Simulate Week with per-game isolation), Primetime Import Center,
  Schedule/Team/Roster managers (CSV roster import, logos), Team Percentages (edit in a table or import CSV/JSON; stored in D1),
  Rankings Manager (manual + computed suggestion), Results Review, Publishing Center (instant or replay presentation,
  corrections, withdrawals, version history), Simulation Settings, Audit History.
- Engine: full play-by-play game with clock, downs, penalties, timeouts, fourth-down decisions, kicking game, overtime
  under college rules; eight offensive and nine defensive identities; custom run/pass ratio.

**Built but not exercised against the live service**

- *AI recaps and screenshot reading* call the Claude API (`claude-opus-5-5`). The code path, the grounding check and the
  "not configured" behavior are tested; a real API call could not be made here because no API key is available in this
  environment. Add `ANTHROPIC_API_KEY` and try one recap and one screenshot before relying on them.

**Blocked on information only the league has**

- *Reference images.* None were attached to the request, so the visual design is original (dark broadcast-style theme).
  Send them and the styling can be matched.

**Known limits**

- Correcting a published game is done by publishing a replacement result (re-simulate or re-import), not by editing
  single numbers, so statistics can never disagree with the play ledger.
- Laterals and blocked punts are not generated. Blocked field goals, safeties, team rushing losses and defensive/return
  touchdowns are.
- The football model is tuned on synthetic rosters; expect to adjust team ratings (40–99) to taste after a few weeks.
