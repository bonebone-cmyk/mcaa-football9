// Administrator API. Every route here is mounted behind requireAdmin (session + role + CSRF) and writes an audit entry.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { allValid, checkPrimetimeInput, checkRoster, describePlay, finalize, rebuildDrives, reconstructPrimetime, simulateGame } from '../engine/index';
import { DEF_SCHEMES, LOCKABLE_PLAYER_STATS, OFF_SCHEMES, POSITIONS, SimError, TEMPOS, type GameResult, type Play, type PrimetimeInput, type SimConfig, type TeamInput } from '../engine/types';
import { aiRecap, extractScreenshots } from './ai';
import { HttpError, auditStmt, type AdminUser, type AppEnv } from './auth';
import { all, assertStmt, clearAssert, first, j, now, stmt, uid, type DB } from './db';
import { getSeason, ranks, records, roster, simConfig, teamInput, teamsForSeason, toRosterPlayers, type GameRow, type SeasonRow } from './league';
import { currentPercentages, parseCsv, parsePercentages, resolveSnapshot, snapshotCurrent, snapshotEntries, upsertPercentagesStmt, type Snapshot } from './percent';
import { publishRun, unpublishGame } from './publish';

export const adminRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;
const body = async <T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> => schema.parse(await c.req.json().catch(() => ({})));
const log = (c: C, e: Parameters<typeof auditStmt>[2]) => auditStmt(c.env.DB, c.get('admin'), e);
const DESIGNATIONS = ['gotw', 'rivalry', 'primetime', 'conference_championship', 'playoff', 'bowl'] as const;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colors must be hex values like #1e3a5f.');
const position = z.enum(POSITIONS);

// ---------------------------------------------------------------------------------- seasons & conferences
adminRoutes.get('/seasons', async (c) => c.json({ seasons: await all(c.env.DB, 'SELECT * FROM seasons ORDER BY year DESC') }));
const seasonSchema = z.object({ year: z.number().int().min(1900).max(3000), name: z.string().trim().min(1).max(60), weeks: z.number().int().min(1).max(30).default(14), isCurrent: z.boolean().default(false) });
adminRoutes.post('/seasons', async (c) => {
  const b = await body(c, seasonSchema);
  const db = c.env.DB;
  if (await first(db, 'SELECT 1 FROM seasons WHERE year = ?1', b.year)) throw new HttpError(409, `A ${b.year} season already exists.`);
  const id = uid();
  const isFirst = !(await first(db, 'SELECT 1 FROM seasons LIMIT 1'));
  const cur = b.isCurrent || isFirst;
  await db.batch([
    ...(cur ? [stmt(db, 'UPDATE seasons SET is_current = 0')] : []),
    stmt(db, 'INSERT INTO seasons (id, year, name, is_current, weeks, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)', id, b.year, b.name, cur ? 1 : 0, b.weeks, now()),
    log(c, { action: 'season_created', entity: 'season', entityId: id, next: b }),
  ]);
  return c.json({ id }, 201);
});
adminRoutes.patch('/seasons/:id', async (c) => {
  const b = await body(c, z.object({ name: z.string().trim().min(1).max(60).optional(), weeks: z.number().int().min(1).max(30).optional(), isCurrent: z.boolean().optional() }));
  const db = c.env.DB;
  const s = await first<SeasonRow>(db, 'SELECT * FROM seasons WHERE id = ?1', c.req.param('id'));
  if (!s) throw new HttpError(404, 'Season not found.');
  await db.batch([
    ...(b.isCurrent ? [stmt(db, 'UPDATE seasons SET is_current = 0')] : []),
    stmt(db, 'UPDATE seasons SET name = ?1, weeks = ?2, is_current = ?3 WHERE id = ?4', b.name ?? s.name, b.weeks ?? s.weeks, b.isCurrent ?? !!s.is_current ? 1 : 0, s.id),
    log(c, { action: 'season_updated', entity: 'season', entityId: s.id, previous: { name: s.name, weeks: s.weeks, isCurrent: !!s.is_current }, next: b }),
  ]);
  return c.json({ ok: true });
});

const confSchema = z.object({ name: z.string().trim().min(1).max(60), abbr: z.string().trim().min(1).max(10) });
adminRoutes.get('/conferences', async (c) => c.json({ conferences: await all(c.env.DB, 'SELECT * FROM conferences ORDER BY name') }));
adminRoutes.post('/conferences', async (c) => {
  const b = await body(c, confSchema);
  if (await first(c.env.DB, 'SELECT 1 FROM conferences WHERE name = ?1', b.name)) throw new HttpError(409, 'A conference with that name already exists.');
  const id = uid();
  await c.env.DB.batch([stmt(c.env.DB, 'INSERT INTO conferences (id, name, abbr) VALUES (?1, ?2, ?3)', id, b.name, b.abbr), log(c, { action: 'conference_created', entity: 'conference', entityId: id, next: b })]);
  return c.json({ id }, 201);
});
adminRoutes.patch('/conferences/:id', async (c) => {
  const b = await body(c, confSchema);
  const prev = await first(c.env.DB, 'SELECT * FROM conferences WHERE id = ?1', c.req.param('id'));
  if (!prev) throw new HttpError(404, 'Conference not found.');
  await c.env.DB.batch([stmt(c.env.DB, 'UPDATE conferences SET name = ?1, abbr = ?2 WHERE id = ?3', b.name, b.abbr, c.req.param('id')), log(c, { action: 'conference_updated', entity: 'conference', entityId: c.req.param('id'), previous: prev, next: b })]);
  return c.json({ ok: true });
});
adminRoutes.delete('/conferences/:id', async (c) => {
  const id = c.req.param('id');
  if (await first(c.env.DB, 'SELECT 1 FROM team_seasons WHERE conference_id = ?1 LIMIT 1', id)) throw new HttpError(409, 'Teams are assigned to this conference. Move them first.');
  await c.env.DB.batch([stmt(c.env.DB, 'DELETE FROM conferences WHERE id = ?1', id), log(c, { action: 'conference_deleted', entity: 'conference', entityId: id })]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------- teams
const logo = z.string().max(420_000).refine((v) => /^https:\/\/\S+$/.test(v) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v), 'Logo must be an https:// URL or a PNG, JPEG, WebP or GIF image under 300 KB.');
const teamSchema = z.object({
  name: z.string().trim().min(2).max(80), shortName: z.string().trim().min(1).max(40), abbr: z.string().trim().min(2).max(6).transform((s) => s.toUpperCase()), mascot: z.string().trim().max(60).nullish(),
  primaryColor: color.default('#1e3a5f'), secondaryColor: color.default('#ffffff'), stadium: z.string().trim().max(80).nullish(), logo: logo.nullish(),
});
adminRoutes.get('/teams', async (c) => {
  const db = c.env.DB;
  const season = await getSeason(db, c.req.query('season'));
  const teams = await teamsForSeason(db, season.id);
  const counts = new Map((await all<{ team_id: string; n: number; a: number }>(db, 'SELECT team_id, COUNT(*) AS n, SUM(active) AS a FROM roster_memberships WHERE season_id = ?1 GROUP BY team_id', season.id)).map((r) => [r.team_id, r]));
  return c.json({ season: season.id, teams: teams.map((t) => ({ ...t, rosterCount: counts.get(t.id)?.n ?? 0, activeCount: counts.get(t.id)?.a ?? 0, logo: t.has_logo ? `/api/teams/${t.id}/logo?v=${now()}` : null })) });
});
adminRoutes.post('/teams', async (c) => {
  const b = await body(c, teamSchema);
  const db = c.env.DB;
  if (await first(db, 'SELECT 1 FROM teams WHERE name = ?1 OR abbr = ?2', b.name, b.abbr)) throw new HttpError(409, 'A team with that name or abbreviation already exists.');
  const id = uid();
  await db.batch([
    stmt(db, 'INSERT INTO teams (id, name, short_name, abbr, mascot, primary_color, secondary_color, logo, stadium, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)', id, b.name, b.shortName, b.abbr, b.mascot ?? null, b.primaryColor, b.secondaryColor, b.logo ?? null, b.stadium ?? null, now()),
    log(c, { action: 'team_created', entity: 'team', entityId: id, next: { ...b, logo: b.logo ? '(image)' : null } }),
  ]);
  return c.json({ id }, 201);
});
adminRoutes.patch('/teams/:id', async (c) => {
  const b = await body(c, teamSchema.partial().extend({ removeLogo: z.boolean().optional() }));
  const db = c.env.DB;
  const t = await first<Record<string, string | null>>(db, 'SELECT * FROM teams WHERE id = ?1', c.req.param('id'));
  if (!t) throw new HttpError(404, 'Team not found.');
  if ((b.name || b.abbr) && (await first(db, 'SELECT 1 FROM teams WHERE (name = ?1 OR abbr = ?2) AND id <> ?3', b.name ?? '', b.abbr ?? '', t.id))) throw new HttpError(409, 'Another team already uses that name or abbreviation.');
  const nextLogo = b.removeLogo ? null : b.logo ?? t.logo;
  await db.batch([
    stmt(db, 'UPDATE teams SET name = ?1, short_name = ?2, abbr = ?3, mascot = ?4, primary_color = ?5, secondary_color = ?6, logo = ?7, stadium = ?8 WHERE id = ?9',
      b.name ?? t.name, b.shortName ?? t.short_name, b.abbr ?? t.abbr, b.mascot === undefined ? t.mascot : b.mascot, b.primaryColor ?? t.primary_color, b.secondaryColor ?? t.secondary_color, nextLogo, b.stadium === undefined ? t.stadium : b.stadium, t.id),
    log(c, { action: 'team_updated', entity: 'team', entityId: t.id as string, previous: { ...t, logo: t.logo ? '(image)' : null }, next: { ...b, logo: b.logo ? '(image)' : undefined } }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.delete('/teams/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  if (await first(db, 'SELECT 1 FROM games WHERE away_team_id = ?1 OR home_team_id = ?1 LIMIT 1', id)) throw new HttpError(409, 'This team has scheduled or played games and cannot be deleted. Remove it from future seasons instead.');
  if (await first(db, 'SELECT 1 FROM roster_memberships WHERE team_id = ?1 LIMIT 1', id)) throw new HttpError(409, 'Remove the team’s roster before deleting it.');
  await db.batch([stmt(db, 'DELETE FROM team_seasons WHERE team_id = ?1', id), stmt(db, 'DELETE FROM teams WHERE id = ?1', id), log(c, { action: 'team_deleted', entity: 'team', entityId: id })]);
  return c.json({ ok: true });
});
const teamSeasonSchema = z.object({
  seasonId: z.string(), conferenceId: z.string().nullable().default(null),
  offRating: z.number().min(40).max(99).default(70), defRating: z.number().min(40).max(99).default(70), stRating: z.number().min(40).max(99).default(70),
  offScheme: z.enum(OFF_SCHEMES).default('Balanced'), defScheme: z.enum(DEF_SCHEMES).default('4-3'), runPct: z.number().min(5).max(95).nullable().default(null), tempo: z.enum(TEMPOS).default('normal'),
});
adminRoutes.put('/teams/:id/season', async (c) => {
  const b = await body(c, teamSeasonSchema);
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!(await first(db, 'SELECT 1 FROM teams WHERE id = ?1', id))) throw new HttpError(404, 'Team not found.');
  const prev = await first(db, 'SELECT * FROM team_seasons WHERE team_id = ?1 AND season_id = ?2', id, b.seasonId);
  await db.batch([
    stmt(db, `INSERT INTO team_seasons (id, team_id, season_id, conference_id, off_rating, def_rating, st_rating, off_scheme, def_scheme, run_pct, tempo) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT (team_id, season_id) DO UPDATE SET conference_id = excluded.conference_id, off_rating = excluded.off_rating, def_rating = excluded.def_rating, st_rating = excluded.st_rating, off_scheme = excluded.off_scheme, def_scheme = excluded.def_scheme, run_pct = excluded.run_pct, tempo = excluded.tempo`,
      uid(), id, b.seasonId, b.conferenceId, b.offRating, b.defRating, b.stRating, b.offScheme, b.defScheme, b.runPct, b.tempo),
    log(c, { action: prev ? 'team_season_updated' : 'team_season_added', entity: 'team', entityId: id, previous: prev, next: b }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.delete('/teams/:id/season', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const seasonId = c.req.query('season') ?? '';
  if (await first(db, 'SELECT 1 FROM games WHERE season_id = ?1 AND (away_team_id = ?2 OR home_team_id = ?2) LIMIT 1', seasonId, id)) throw new HttpError(409, 'This team has games in that season. Cancel or delete them first.');
  await db.batch([stmt(db, 'DELETE FROM team_seasons WHERE team_id = ?1 AND season_id = ?2', id, seasonId), log(c, { action: 'team_season_removed', entity: 'team', entityId: id, previous: { seasonId } })]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------- rosters
const rosterSchema = z.object({
  name: z.string().trim().min(1).max(60), jersey: z.number().int().min(0).max(99).nullable().default(null), position,
  secondary: z.array(position).max(6).default([]), depth: z.number().int().min(1).max(9).default(1), rating: z.number().min(40).max(99).nullable().default(null), active: z.boolean().default(true),
});
adminRoutes.get('/roster', async (c) => {
  const season = await getSeason(c.env.DB, c.req.query('season'));
  const teamId = c.req.query('team') ?? '';
  const rows = await roster(c.env.DB, season.id, teamId);
  const t = await teamInput(c.env.DB, season.id, teamId, { activity: 0, upset: 0, star: 0 }).catch(() => null);
  return c.json({ season: season.id, players: rows.map((r) => ({ ...r, secondary_positions: j(r.secondary_positions, []), awards: j(r.awards, []), active: !!r.active })), check: t ? checkRoster(t) : null });
});
adminRoutes.post('/roster', async (c) => {
  const b = await body(c, rosterSchema.extend({ seasonId: z.string(), teamId: z.string(), playerId: z.string().optional() }));
  const db = c.env.DB;
  if (!(await first(db, 'SELECT 1 FROM team_seasons WHERE team_id = ?1 AND season_id = ?2', b.teamId, b.seasonId))) throw new HttpError(422, 'Add the team to this season before building its roster.');
  if (b.playerId && (await first(db, 'SELECT 1 FROM roster_memberships WHERE player_id = ?1 AND season_id = ?2', b.playerId, b.seasonId))) throw new HttpError(409, 'That player is already rostered this season.');
  if (!b.playerId && (await first(db, 'SELECT 1 FROM roster_memberships rm JOIN players p ON p.id = rm.player_id WHERE rm.season_id = ?1 AND rm.team_id = ?2 AND LOWER(p.name) = LOWER(?3)', b.seasonId, b.teamId, b.name))) throw new HttpError(409, `${b.name} is already on this roster.`);
  const pid = b.playerId ?? uid();
  const mid = uid();
  await db.batch([
    ...(b.playerId ? [] : [stmt(db, 'INSERT INTO players (id, name, created_at) VALUES (?1, ?2, ?3)', pid, b.name, now())]),
    stmt(db, 'INSERT INTO roster_memberships (id, player_id, team_id, season_id, jersey, position, secondary_positions, depth_rank, rating, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)', mid, pid, b.teamId, b.seasonId, b.jersey, b.position, JSON.stringify(b.secondary.filter((p) => p !== b.position)), b.depth, b.rating, b.active ? 1 : 0),
    log(c, { action: 'player_added', entity: 'player', entityId: pid, next: b }),
  ]);
  return c.json({ id: mid, playerId: pid }, 201);
});
adminRoutes.patch('/roster/:id', async (c) => {
  const b = await body(c, rosterSchema.partial().extend({ awards: z.array(z.string().trim().min(1).max(80)).max(20).optional() }));
  const db = c.env.DB;
  const m = await first<Record<string, unknown>>(db, 'SELECT rm.*, p.name FROM roster_memberships rm JOIN players p ON p.id = rm.player_id WHERE rm.id = ?1', c.req.param('id'));
  if (!m) throw new HttpError(404, 'Roster entry not found.');
  const pos = b.position ?? (m.position as string);
  await db.batch([
    ...(b.name ? [stmt(db, 'UPDATE players SET name = ?1 WHERE id = ?2', b.name, m.player_id)] : []),
    stmt(db, 'UPDATE roster_memberships SET jersey = ?1, position = ?2, secondary_positions = ?3, depth_rank = ?4, rating = ?5, active = ?6, awards = ?7 WHERE id = ?8',
      b.jersey === undefined ? m.jersey : b.jersey, pos, JSON.stringify((b.secondary ?? j<string[]>(m.secondary_positions as string, [])).filter((p) => p !== pos)), b.depth ?? m.depth_rank, b.rating === undefined ? m.rating : b.rating, b.active === undefined ? m.active : b.active ? 1 : 0, b.awards ? JSON.stringify(b.awards) : m.awards, m.id),
    log(c, { action: 'player_updated', entity: 'player', entityId: m.player_id as string, previous: m, next: b }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.delete('/roster/:id', async (c) => {
  const db = c.env.DB;
  const m = await first<{ id: string; player_id: string; season_id: string }>(db, 'SELECT * FROM roster_memberships WHERE id = ?1', c.req.param('id'));
  if (!m) throw new HttpError(404, 'Roster entry not found.');
  if (await first(db, 'SELECT 1 FROM player_game_stats WHERE player_id = ?1 AND season_id = ?2 LIMIT 1', m.player_id, m.season_id)) throw new HttpError(409, 'This player has official statistics this season and cannot be removed. Mark the player inactive instead.');
  if (await first(db, "SELECT 1 FROM simulation_runs r JOIN games g ON g.id = r.game_id WHERE g.season_id = ?1 AND r.status IN ('candidate','approved') AND instr(r.result, ?2) > 0 LIMIT 1", m.season_id, m.player_id)) throw new HttpError(409, 'This player appears in a result awaiting review. Reject or publish that result first, or mark the player inactive.');
  const others = await first(db, 'SELECT 1 FROM roster_memberships WHERE player_id = ?1 AND id <> ?2 LIMIT 1', m.player_id, m.id);
  const hasStats = await first(db, 'SELECT 1 FROM player_game_stats WHERE player_id = ?1 LIMIT 1', m.player_id);
  await db.batch([
    stmt(db, 'DELETE FROM roster_memberships WHERE id = ?1', m.id),
    ...(!others && !hasStats ? [stmt(db, 'DELETE FROM players WHERE id = ?1', m.player_id)] : []),
    log(c, { action: 'player_removed', entity: 'player', entityId: m.player_id, previous: m }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.post('/roster/import', async (c) => {
  const b = await body(c, z.object({ seasonId: z.string(), teamId: z.string(), csv: z.string().min(1).max(200_000) }));
  const db = c.env.DB;
  if (!(await first(db, 'SELECT 1 FROM team_seasons WHERE team_id = ?1 AND season_id = ?2', b.teamId, b.seasonId))) throw new HttpError(422, 'Add the team to this season before importing its roster.');
  const rows = parseCsv(b.csv);
  const errors: string[] = [];
  const existing = new Set((await roster(db, b.seasonId, b.teamId)).map((r) => r.name.toLowerCase()));
  const parsed: z.infer<typeof rosterSchema>[] = [];
  rows.forEach((r, i) => {
    const num = (v?: string) => (v == null || v === '' ? null : Number(v));
    const res = rosterSchema.safeParse({
      name: r.name ?? r.player, jersey: num(r.jersey ?? r.number ?? r.no), position: (r.position ?? r.pos ?? '').toUpperCase(),
      secondary: (r.secondary ?? r.secondarypositions ?? '').split(/[\/|\s]+/).map((s) => s.toUpperCase()).filter(Boolean), depth: num(r.depth ?? r.depthrank) ?? 1, rating: num(r.rating ?? r.ovr ?? r.overall),
      active: !['0', 'no', 'false', 'inactive'].includes((r.active ?? '').toLowerCase()),
    });
    if (!res.success) return void errors.push(`Row ${i + 1}: ${res.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
    if (existing.has(res.data.name.toLowerCase())) return void errors.push(`Row ${i + 1}: ${res.data.name} is already on this roster (or appears twice in the file).`);
    existing.add(res.data.name.toLowerCase());
    parsed.push(res.data);
  });
  if (!rows.length) errors.push('No rows found. Expected a header row: name, jersey, position, secondary, depth, rating.');
  if (errors.length) throw new HttpError(422, 'The roster file has problems. Nothing was imported.', { details: errors });
  const stmts: D1PreparedStatement[] = [];
  for (const p of parsed) {
    const pid = uid();
    stmts.push(stmt(db, 'INSERT INTO players (id, name, created_at) VALUES (?1, ?2, ?3)', pid, p.name, now()));
    stmts.push(stmt(db, 'INSERT INTO roster_memberships (id, player_id, team_id, season_id, jersey, position, secondary_positions, depth_rank, rating, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)', uid(), pid, b.teamId, b.seasonId, p.jersey, p.position, JSON.stringify(p.secondary.filter((s) => s !== p.position)), p.depth, p.rating, p.active ? 1 : 0));
  }
  stmts.push(log(c, { action: 'roster_imported', entity: 'team', entityId: b.teamId, next: { seasonId: b.seasonId, players: parsed.length } }));
  await db.batch(stmts);
  return c.json({ imported: parsed.length }, 201);
});
adminRoutes.post('/roster/copy', async (c) => {
  const b = await body(c, z.object({ fromSeasonId: z.string(), toSeasonId: z.string(), teamId: z.string() }));
  const db = c.env.DB;
  if (!(await first(db, 'SELECT 1 FROM team_seasons WHERE team_id = ?1 AND season_id = ?2', b.teamId, b.toSeasonId))) throw new HttpError(422, 'Add the team to the destination season first.');
  const src = await roster(db, b.fromSeasonId, b.teamId);
  const taken = new Set((await all<{ player_id: string }>(db, 'SELECT player_id FROM roster_memberships WHERE season_id = ?1', b.toSeasonId)).map((r) => r.player_id));
  const add = src.filter((r) => !taken.has(r.player_id));
  if (!add.length) throw new HttpError(409, 'There are no players to carry over.');
  await db.batch([
    ...add.map((r) => stmt(db, 'INSERT INTO roster_memberships (id, player_id, team_id, season_id, jersey, position, secondary_positions, depth_rank, rating, active) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)', uid(), r.player_id, b.teamId, b.toSeasonId, r.jersey, r.position, r.secondary_positions, r.depth_rank, r.rating, r.active)),
    log(c, { action: 'roster_carried_over', entity: 'team', entityId: b.teamId, next: { ...b, players: add.length } }),
  ]);
  return c.json({ copied: add.length });
});

// ---------------------------------------------------------------------------------- schedule
const gameSchema = z.object({
  seasonId: z.string(), week: z.number().int().min(0).max(40), awayTeamId: z.string(), homeTeamId: z.string(),
  kickoffAt: z.number().int().nullable().default(null), network: z.string().trim().max(40).nullable().default(null), stadium: z.string().trim().max(80).nullable().default(null),
  neutralSite: z.boolean().default(false), mode: z.enum(['sim', 'primetime']).default('sim'), designations: z.array(z.enum(DESIGNATIONS)).default([]), allowDuplicate: z.boolean().default(false),
});
async function assertNoDuplicate(db: DB, seasonId: string, week: number, a: string, h: string, exceptId: string | null, allow: boolean) {
  if (allow) return;
  const dup = await first<{ id: string }>(db, `SELECT id FROM games WHERE season_id = ?1 AND week = ?2 AND status <> 'canceled' AND id <> ?5 AND ((away_team_id = ?3 AND home_team_id = ?4) OR (away_team_id = ?4 AND home_team_id = ?3))`, seasonId, week, a, h, exceptId ?? '');
  if (dup) throw new HttpError(409, 'These teams already play each other that week. Tick “allow duplicate” if this is intentional.', { code: 'DUPLICATE_GAME', gameId: dup.id });
  const busy = await first<{ id: string }>(db, `SELECT id FROM games WHERE season_id = ?1 AND week = ?2 AND status <> 'canceled' AND id <> ?5 AND (away_team_id IN (?3, ?4) OR home_team_id IN (?3, ?4))`, seasonId, week, a, h, exceptId ?? '');
  if (busy) throw new HttpError(409, 'One of these teams already has a game that week. Tick “allow duplicate” to schedule a second game.', { code: 'DUPLICATE_GAME', gameId: busy.id });
}
adminRoutes.get('/games', async (c) => {
  const db = c.env.DB;
  const season = await getSeason(db, c.req.query('season'));
  const week = c.req.query('week');
  const games = await all<GameRow>(db, `SELECT * FROM games WHERE season_id = ?1 ${week ? 'AND week = ?2' : ''} ORDER BY week, COALESCE(kickoff_at, 9e15), created_at`, ...(week ? [season.id, Number(week)] : [season.id]));
  const runs = await all<{ id: string; game_id: string; status: string; mode: string; valid: number; away_score: number; home_score: number; created_at: number; seed: string }>(db,
    `SELECT r.id, r.game_id, r.status, r.mode, r.valid, r.away_score, r.home_score, r.created_at, r.seed FROM simulation_runs r JOIN games g ON g.id = r.game_id WHERE g.season_id = ?1 AND r.status IN ('candidate','approved','published') ORDER BY r.created_at`, season.id);
  const pct = await currentPercentages(db, season.id);
  const rec = await records(db, season.id, now());
  // Show the result awaiting review/publication if there is one, otherwise the published one.
  const byGame = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const cur = byGame.get(r.game_id);
    if (!cur || r.status !== 'published' || cur.status === 'published') byGame.set(r.game_id, r);
  }
  return c.json({
    season: season.id,
    games: games.map((g) => ({
      ...g, designations: j(g.designations, []), run: byGame.get(g.id) ?? null,
      awayPct: pct.get(g.away_team_id) ?? null, homePct: pct.get(g.home_team_id) ?? null,
      awayRecord: `${rec.get(g.away_team_id)?.w ?? 0}-${rec.get(g.away_team_id)?.l ?? 0}`, homeRecord: `${rec.get(g.home_team_id)?.w ?? 0}-${rec.get(g.home_team_id)?.l ?? 0}`,
    })),
  });
});
adminRoutes.post('/games', async (c) => {
  const b = await body(c, gameSchema);
  const db = c.env.DB;
  if (b.awayTeamId === b.homeTeamId) throw new HttpError(422, 'A team cannot play itself.');
  for (const t of [b.awayTeamId, b.homeTeamId]) if (!(await first(db, 'SELECT 1 FROM team_seasons WHERE team_id = ?1 AND season_id = ?2', t, b.seasonId))) throw new HttpError(422, 'Both teams must be entered in the season before scheduling a game.');
  await assertNoDuplicate(db, b.seasonId, b.week, b.awayTeamId, b.homeTeamId, null, b.allowDuplicate);
  const id = uid();
  const des = [...new Set(b.mode === 'primetime' ? [...b.designations, 'primetime' as const] : b.designations)];
  await db.batch([
    stmt(db, 'INSERT INTO games (id, season_id, week, away_team_id, home_team_id, kickoff_at, network, stadium, neutral_site, mode, designations, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)', id, b.seasonId, b.week, b.awayTeamId, b.homeTeamId, b.kickoffAt, b.network, b.stadium, b.neutralSite ? 1 : 0, b.mode, JSON.stringify(des), now()),
    log(c, { action: 'game_created', entity: 'game', entityId: id, gameId: id, next: b }),
  ]);
  return c.json({ id }, 201);
});
adminRoutes.patch('/games/:id', async (c) => {
  const b = await body(c, gameSchema.partial().omit({ seasonId: true }).extend({
    status: z.enum(['scheduled', 'in_progress', 'postponed', 'canceled']).optional(),
    liveAway: z.number().int().min(0).max(200).nullable().optional(), liveHome: z.number().int().min(0).max(200).nullable().optional(), livePeriod: z.string().max(10).nullable().optional(), liveClock: z.string().max(10).nullable().optional(),
    reason: z.string().max(300).optional(),
  }));
  const db = c.env.DB;
  const g = await first<GameRow>(db, 'SELECT * FROM games WHERE id = ?1', c.req.param('id'));
  if (!g) throw new HttpError(404, 'Game not found.');
  const published = g.status === 'final';
  const away = b.awayTeamId ?? g.away_team_id, home = b.homeTeamId ?? g.home_team_id;
  if (away === home) throw new HttpError(422, 'A team cannot play itself.');
  const teamsChanged = away !== g.away_team_id || home !== g.home_team_id;
  if (published && (teamsChanged || b.status)) throw new HttpError(409, 'This game has an official result. Withdraw the result (with a reason) before changing the matchup or status.', { code: 'PUBLISHED' });
  if (teamsChanged && (await first(db, "SELECT 1 FROM simulation_runs WHERE game_id = ?1 AND status IN ('candidate','approved') LIMIT 1", g.id))) throw new HttpError(409, 'A result is awaiting review for this game. Reject it before changing the matchup.');
  const week = b.week ?? g.week;
  if (teamsChanged || week !== g.week) await assertNoDuplicate(db, g.season_id, week, away, home, g.id, b.allowDuplicate ?? false);
  if (b.status === 'in_progress' && b.liveAway == null && g.live_away == null) throw new HttpError(422, 'Enter the current score to mark a game in progress. Live scores are only ever entered by hand.');
  const status = b.status ?? g.status;
  const live = status === 'in_progress';
  const mode = b.mode ?? g.mode;
  let des = b.designations ?? j<string[]>(g.designations, []);
  if (mode === 'primetime' && !des.includes('primetime')) des = [...des, 'primetime'];
  await db.batch([
    stmt(db, `UPDATE games SET week = ?1, away_team_id = ?2, home_team_id = ?3, kickoff_at = ?4, network = ?5, stadium = ?6, neutral_site = ?7, mode = ?8, designations = ?9, status = ?10,
      live_away = ?11, live_home = ?12, live_period = ?13, live_clock = ?14, updated_at = ?15 WHERE id = ?16`,
      week, away, home, b.kickoffAt === undefined ? g.kickoff_at : b.kickoffAt, b.network === undefined ? g.network : b.network, b.stadium === undefined ? g.stadium : b.stadium, (b.neutralSite ?? !!g.neutral_site) ? 1 : 0, published ? g.mode : mode, JSON.stringify(des), status,
      live ? (b.liveAway === undefined ? g.live_away : b.liveAway) : null, live ? (b.liveHome === undefined ? g.live_home : b.liveHome) : null, live ? (b.livePeriod === undefined ? g.live_period : b.livePeriod) : null, live ? (b.liveClock === undefined ? g.live_clock : b.liveClock) : null, now(), g.id),
    log(c, { action: b.status === 'canceled' ? 'game_canceled' : live && (b.liveAway !== undefined || b.liveHome !== undefined) ? 'live_score_entered' : 'game_updated', entity: 'game', entityId: g.id, gameId: g.id, previous: { ...g, designations: j(g.designations, []) }, next: b, reason: b.reason ?? null }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.delete('/games/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  if (await first(db, 'SELECT 1 FROM simulation_runs WHERE game_id = ?1 LIMIT 1', id)) throw new HttpError(409, 'This game has simulation history and cannot be deleted. Cancel it instead.');
  const g = await first(db, 'SELECT * FROM games WHERE id = ?1', id);
  if (!g) throw new HttpError(404, 'Game not found.');
  await db.batch([stmt(db, 'DELETE FROM games WHERE id = ?1', id), log(c, { action: 'game_deleted', entity: 'game', entityId: id, gameId: id, previous: g })]);
  return c.json({ ok: true });
});
adminRoutes.post('/games/:id/unpublish', async (c) => {
  const b = await body(c, z.object({ reason: z.string().trim().min(3, 'Give a reason for withdrawing the result.').max(300), confirm: z.literal(true, { message: 'Confirmation is required to withdraw an official result.' }) }));
  await unpublishGame(c.env.DB, c.get('admin'), c.req.param('id'), b.reason);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------- percentages
// Team percentages are stored in D1 (`team_percentages`) and managed here. There is no external source.
const pctValue = z.number({ message: 'Percentages must be numbers.' }).finite().min(0, 'Percentages cannot be below 0.').max(100, 'Percentages cannot be above 100.');

/** Teams missing percentages after a change, so the UI can warn before anyone tries to simulate. */
async function pctCoverage(db: DB, seasonId: string) {
  const teams = await teamsForSeason(db, seasonId, true);
  const cur = await currentPercentages(db, seasonId);
  return { total: teams.length, set: teams.filter((t) => cur.has(t.id)).length, missing: teams.filter((t) => !cur.has(t.id)).map((t) => t.name) };
}

adminRoutes.get('/percentages', async (c) => {
  const db = c.env.DB;
  const season = await getSeason(db, c.req.query('season'));
  const teams = await teamsForSeason(db, season.id, true);
  const cur = await currentPercentages(db, season.id);
  const snapshots = await all<Snapshot>(db, 'SELECT * FROM percentage_snapshots WHERE season_id = ?1 ORDER BY fetched_at DESC, id DESC LIMIT 50', season.id);
  const view = c.req.query('snapshot') || null;
  const entries = view ? [...(await snapshotEntries(db, view)).entries()].map(([teamId, v]) => ({ teamId, ...v })) : [];
  return c.json({
    season: season.id,
    teams: teams.map((t) => { const r = cur.get(t.id); return { teamId: t.id, activity: r?.activity ?? null, upset: r?.upset ?? null, star: r?.star ?? null, extra: r?.extra ?? {}, updatedAt: r?.updatedAt ?? null, updatedBy: r?.updatedBy ?? null }; }),
    snapshots, viewing: view, entries, serverTime: now(),
  });
});

adminRoutes.put('/percentages', async (c) => {
  const b = await body(c, z.object({
    seasonId: z.string(),
    set: z.array(z.object({ teamId: z.string(), activity: pctValue, upset: pctValue, star: pctValue })).max(500).default([]),
    clear: z.array(z.string()).max(500).default([]),
  }));
  const db = c.env.DB;
  if (!b.set.length && !b.clear.length) throw new HttpError(422, 'There are no changes to save.');
  const inSeason = new Set((await teamsForSeason(db, b.seasonId, true)).map((t) => t.id));
  const ids = [...b.set.map((x) => x.teamId), ...b.clear];
  if (new Set(ids).size !== ids.length) throw new HttpError(422, 'A team appears more than once in this change.');
  const bad = ids.filter((id) => !inSeason.has(id));
  if (bad.length) throw new HttpError(422, 'Percentages can only be set for teams entered in this season.', { details: bad });
  const before = await currentPercentages(db, b.seasonId);
  const pick = (id: string) => { const r = before.get(id); return r ? { activity: r.activity, upset: r.upset, star: r.star } : null; };
  await db.batch([
    ...(b.set.length ? [upsertPercentagesStmt(db, b.seasonId, b.set.map((x) => ({ ...x, extra: {} })), c.get('admin'))] : []),
    ...b.clear.map((id) => stmt(db, 'DELETE FROM team_percentages WHERE season_id = ?1 AND team_id = ?2', b.seasonId, id)),
    log(c, {
      action: 'percentages_updated', entity: 'team_percentages', entityId: b.seasonId,
      previous: Object.fromEntries(ids.map((id) => [id, pick(id)])),
      next: Object.fromEntries([...b.set.map((x) => [x.teamId, { activity: x.activity, upset: x.upset, star: x.star }]), ...b.clear.map((id) => [id, null])]),
    }),
  ]);
  return c.json({ ok: true, coverage: await pctCoverage(db, b.seasonId) });
});

adminRoutes.post('/percentages/import', async (c) => {
  const b = await body(c, z.object({ seasonId: z.string(), format: z.enum(['csv', 'json']), content: z.string().min(1).max(500_000), dryRun: z.boolean().default(false) }));
  const db = c.env.DB;
  const teams = await teamsForSeason(db, b.seasonId);
  const parsed = parsePercentages(b.format, b.content, teams);
  if (parsed.errors.length) throw new HttpError(422, 'The percentage file failed validation. Nothing was saved.', { details: parsed.errors });
  if (b.dryRun) return c.json({ ok: true, entries: parsed.entries, warnings: parsed.warnings });
  const before = await currentPercentages(db, b.seasonId);
  // Teams in the file are updated; teams not in the file keep their stored values.
  await db.batch([
    upsertPercentagesStmt(db, b.seasonId, parsed.entries, c.get('admin')),
    log(c, {
      action: 'percentages_imported', entity: 'team_percentages', entityId: b.seasonId,
      previous: Object.fromEntries(parsed.entries.map((e) => { const r = before.get(e.teamId); return [e.teamId, r ? { activity: r.activity, upset: r.upset, star: r.star } : null]; })),
      next: { format: b.format, teams: Object.fromEntries(parsed.entries.map((e) => [e.teamId, { activity: e.activity, upset: e.upset, star: e.star }])) },
    }),
  ]);
  const coverage = await pctCoverage(db, b.seasonId);
  const warnings = [...parsed.warnings, ...(coverage.missing.length ? [`Still no percentages for: ${coverage.missing.join(', ')}. Their games cannot be simulated until they are entered.`] : [])];
  return c.json({ imported: parsed.entries.length, coverage, warnings }, 201);
});

/** Freeze the current values now (used by Simulate Week so every game in the batch shares one snapshot). */
adminRoutes.post('/percentages/snapshot', async (c) => {
  const b = await body(c, z.object({ seasonId: z.string() }));
  return c.json({ snapshot: await snapshotCurrent(c.env.DB, b.seasonId, c.get('admin')) }, 201);
});

// ---------------------------------------------------------------------------------- simulation
interface Prepared { game: GameRow; season: SeasonRow; teams: [TeamInput, TeamInput]; config: SimConfig; snapshot: Snapshot | null }

async function prepare(c: C, gameId: string, opts: { needPct: boolean; snapshotId?: string | null }): Promise<Prepared> {
  const db = c.env.DB;
  const game = await first<GameRow>(db, 'SELECT * FROM games WHERE id = ?1', gameId);
  if (!game) throw new HttpError(404, 'Game not found.');
  if (game.status === 'canceled') throw new HttpError(409, 'This game is canceled.');
  const season = await getSeason(db, game.season_id);
  const rec = await records(db, season.id, now());
  let snapshot: Snapshot | null = null;
  let entries = new Map<string, { activity: number; upset: number; star: number }>();
  if (opts.needPct) {
    snapshot = await resolveSnapshot(db, season.id, c.get('admin'), opts.snapshotId);
    entries = await snapshotEntries(db, snapshot.id);
  }
  const mk = async (id: string) => {
    const t = await teamInput(db, season.id, id, entries.get(id) ?? null, rec.get(id));
    if (opts.needPct && !entries.has(id)) throw new HttpError(422, `${t.name} has no stored percentages${opts.snapshotId ? ` in the selected snapshot (taken ${new Date(snapshot!.fetched_at).toISOString()})` : ''}. Enter its Activity, Upset and Star values in Team Percentages; they are never estimated.`, { code: 'MISSING_PERCENTAGES', teamId: id });
    return t;
  };
  const teams: [TeamInput, TeamInput] = [await mk(game.away_team_id), await mk(game.home_team_id)];
  const config = { ...(await simConfig(db, season.id)), neutralSite: !!game.neutral_site };
  return { game, season, teams, config, snapshot };
}

async function storeRun(c: C, p: Prepared, mode: 'sim' | 'primetime', result: GameResult, regenerate: boolean): Promise<string> {
  const db = c.env.DB;
  const active = await first<{ id: string; status: string }>(db, "SELECT id, status FROM simulation_runs WHERE game_id = ?1 AND status IN ('candidate','approved') LIMIT 1", p.game.id);
  if (active && !regenerate) throw new HttpError(409, `This game already has a result awaiting ${active.status === 'approved' ? 'publication' : 'review'}. Use Regenerate to replace it.`, { code: 'RUN_EXISTS', runId: active.id });
  const id = uid();
  const valid = allValid(result) ? 1 : 0;
  await db.batch([
    // Duplicate-processing guard: two simultaneous requests cannot both create a pending result.
    ...(regenerate ? [] : [assertStmt(db, "(SELECT COUNT(*) FROM simulation_runs WHERE game_id = ?1 AND status IN ('candidate','approved')) = 0", p.game.id), clearAssert(db)]),
    stmt(db, "UPDATE simulation_runs SET status = 'superseded' WHERE game_id = ?1 AND status IN ('candidate','approved')", p.game.id),
    stmt(db, 'INSERT INTO simulation_runs (id, game_id, mode, seed, status, snapshot_id, away_score, home_score, valid, result, created_by, created_at) VALUES (?1, ?2, ?3, ?4, \'candidate\', ?5, ?6, ?7, ?8, ?9, ?10, ?11)',
      id, p.game.id, mode, result.seed, p.snapshot?.id ?? null, result.final[0], result.final[1], valid, JSON.stringify(result), c.get('admin').id, now()),
    ...(mode === 'primetime' && p.game.status !== 'final' && p.game.mode !== 'primetime' ? [stmt(db, "UPDATE games SET mode = 'primetime', updated_at = ?1 WHERE id = ?2", now(), p.game.id)] : []),
    log(c, { action: mode === 'sim' ? (regenerate && active ? 'simulation_regenerated' : 'simulation_run') : 'primetime_imported', entity: 'simulation_run', entityId: id, gameId: p.game.id, next: { seed: result.seed, final: result.final, valid: !!valid, snapshotId: p.snapshot?.id ?? null, imported: result.primetime ? { final: result.primetime.final, quarters: result.primetime.quarters ?? null, lockedPlayers: Object.keys(result.primetime.locks?.players ?? {}).length } : undefined } }),
  ]);
  return id;
}

const runSummary = (id: string, r: GameResult) => ({ runId: id, final: r.final, quarters: r.quarters, valid: allValid(r), validation: r.validation, warnings: r.warnings, overtimePeriods: r.overtimePeriods });
const simErr = (e: unknown): never => {
  if (e instanceof SimError) throw new HttpError(422, e.message, { code: e.code, details: e.details });
  throw e;
};

adminRoutes.get('/games/:id/preflight', async (c) => {
  const db = c.env.DB;
  const game = await first<GameRow>(db, 'SELECT * FROM games WHERE id = ?1', c.req.param('id'));
  if (!game) throw new HttpError(404, 'Game not found.');
  const out = [];
  for (const id of [game.away_team_id, game.home_team_id]) {
    const t = await teamInput(db, game.season_id, id, { activity: 0, upset: 0, star: 0 }).catch((e: Error) => e);
    out.push(t instanceof Error ? { teamId: id, errors: [t.message], warnings: [] } : { teamId: id, name: t.name, ...checkRoster(t) });
  }
  return c.json({ teams: out });
});

adminRoutes.post('/games/:id/simulate', async (c) => {
  const b = await body(c, z.object({ seed: z.string().trim().min(1).max(80).optional(), snapshotId: z.string().nullable().optional(), regenerate: z.boolean().default(false), aiRecap: z.boolean().default(false) }));
  const p = await prepare(c, c.req.param('id'), { needPct: true, snapshotId: b.snapshotId });
  const seed = b.seed ?? `${p.game.id.slice(0, 8)}-${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  let result: GameResult;
  try {
    result = simulateGame({ seed, teams: p.teams, config: p.config });
  } catch (e) {
    return simErr(e);
  }
  if (b.aiRecap && allValid(result)) {
    const ai = c.env.ANTHROPIC_API_KEY ? await aiRecap(c.env, result, p.teams) : { error: 'AI recaps are not configured (no ANTHROPIC_API_KEY); the standard recap was used.' };
    if ('error' in ai) result.warnings.push(ai.error);
    else result.recap = ai;
  }
  const id = await storeRun(c, p, 'sim', result, b.regenerate);
  return c.json({ ...runSummary(id, result), snapshot: p.snapshot }, 201);
});

adminRoutes.get('/games/:id/sim-input', async (c) => {
  const p = await prepare(c, c.req.param('id'), { needPct: false });
  const zero = { activity: 0, upset: 0, star: 0 };
  return c.json({ teams: p.teams.map((t) => ({ ...t, pct: zero })), config: p.config, game: { id: p.game.id, mode: p.game.mode, status: p.game.status } });
});

const lockSchema = z.record(z.string(), z.partialRecord(z.enum(LOCKABLE_PLAYER_STATS), z.number().finite()));
const primetimeSchema = z.object({
  final: z.tuple([z.number().int().min(0).max(200), z.number().int().min(0).max(200)]),
  quarters: z.tuple([z.array(z.number().int().min(0).max(120)).min(4).max(12), z.array(z.number().int().min(0).max(120)).min(4).max(12)]).nullable().optional(),
  overtimePeriods: z.number().int().min(0).max(8).optional(),
  locks: z.object({ players: lockSchema.default({}), teams: z.tuple([z.object({ passYds: z.number().int().optional(), rushYds: z.number().int().optional(), turnovers: z.number().int().min(0).optional() }), z.object({ passYds: z.number().int().optional(), rushYds: z.number().int().optional(), turnovers: z.number().int().min(0).optional() })]).optional() }).nullable().optional(),
});
const idOpt = z.string().max(64).optional();
const side = z.union([z.literal(0), z.literal(1)]);
const playSchema = z.object({
  seq: z.number().int(), drive: z.number().int().min(0), quarter: z.number().int().min(1).max(20), clock: z.number().int().min(0).max(3600), offense: side, poss: side,
  down: z.number().int().min(1).max(4).nullable(), distance: z.number().int().min(1).max(99).nullable(), ballOn: z.number().int().min(1).max(99),
  type: z.enum(['kickoff', 'run', 'pass', 'sack', 'punt', 'field_goal', 'extra_point', 'two_point', 'kneel', 'penalty', 'timeout']), yards: z.number().int().min(-99).max(99),
  passer: idOpt, rusher: idOpt, target: idOpt, complete: z.boolean().optional(), depth: z.string().max(10).optional(), tacklers: z.array(z.string().max(64)).max(2).optional(), sackers: z.array(z.string().max(64)).max(2).optional(),
  sackAllowedBy: idOpt, interceptor: idOpt, pd: idOpt, fumbler: idOpt, forcedBy: idOpt, recoveredBy: idOpt, fumbleLost: z.boolean().optional(), kicker: idOpt, punter: idOpt, returner: idOpt,
  kickYards: z.number().int().min(0).max(100).optional(), returnYards: z.number().int().min(-20).max(110).optional(), touchback: z.boolean().optional(), fairCatch: z.boolean().optional(), inside20: z.boolean().optional(),
  fgDistance: z.number().int().min(17).max(80).optional(), good: z.boolean().optional(), blockedBy: idOpt, freeKick: z.boolean().optional(),
  penalty: z.object({ side, name: z.string().max(40), yards: z.number().int().min(1).max(15), player: idOpt, autoFirst: z.boolean().optional() }).optional(), timeoutBy: side.optional(),
  firstDown: z.boolean().optional(), turnover: z.enum(['interception', 'fumble', 'downs']).optional(), td: side.optional(),
  points: z.object({ side, pts: z.number().int().min(1).max(6), kind: z.enum(['TD', 'FG', 'XP', '2PT', 'SAFETY']) }).optional(), fourthDownTry: z.boolean().optional(),
  scoreAfter: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
});

adminRoutes.post('/games/:id/primetime', async (c) => {
  const b = await body(c, z.object({ input: primetimeSchema, seed: z.string().trim().min(1).max(80).optional(), plays: z.array(playSchema).min(20).max(900).optional(), regenerate: z.boolean().default(false), aiRecap: z.boolean().default(false) }));
  const p = await prepare(c, c.req.param('id'), { needPct: false });
  const input = b.input as PrimetimeInput;
  const seed = b.seed ?? `pt-${p.game.id.slice(0, 8)}-${Date.now().toString(36)}`;
  let result: GameResult;
  try {
    if (b.plays) {
      // The administrator's browser solved the reconstruction; the server does not trust it. Text is regenerated here and
      // every statistic is re-derived from the submitted ledger, then the full validation suite decides whether it is acceptable.
      const pre = checkPrimetimeInput(input, p.teams);
      if (pre.length) throw new SimError('CONFLICT', pre[0], pre);
      const names = new Map(p.teams.flatMap((t) => t.roster.map((r) => [r.id, r.name] as const)));
      const plays = b.plays.map((x, i) => ({ ...x, seq: i + 1, desc: '' })) as Play[];
      for (const pl of plays) pl.desc = describePlay(pl, (id) => (id ? names.get(id) ?? 'Unknown' : ''), [p.teams[0].abbr, p.teams[1].abbr], [p.teams[0].name, p.teams[1].name]);
      const warnings = p.teams.flatMap((t) => { const ck = checkRoster(t); if (ck.errors.length) throw new SimError('ROSTER', ck.errors[0], ck.errors); return ck.warnings; });
      const otPeriods = Math.max(0, Math.max(...plays.map((x) => x.quarter)) - 4);
      result = finalize('primetime', seed, p.teams, p.config, plays, rebuildDrives(plays), [], warnings, { final: input.final, quarters: input.quarters ?? null, overtimePeriods: otPeriods, locks: input.locks ?? null });
      const failed = result.validation.filter((v) => !v.ok);
      if (failed.length) throw new SimError('VERIFY', 'The submitted reconstruction failed server verification and was not saved.', failed.map((f) => `${f.check}: ${f.detail ?? ''}`));
    } else result = reconstructPrimetime({ seed, teams: p.teams, config: p.config, input });
  } catch (e) {
    return simErr(e);
  }
  if (b.aiRecap) {
    const ai = c.env.ANTHROPIC_API_KEY ? await aiRecap(c.env, result, p.teams) : { error: 'AI recaps are not configured (no ANTHROPIC_API_KEY); the standard recap was used.' };
    if ('error' in ai) result.warnings.push(ai.error);
    else result.recap = ai;
  }
  const id = await storeRun(c, p, 'primetime', result, b.regenerate);
  return c.json(runSummary(id, result), 201);
});

adminRoutes.post('/screenshots/extract', async (c) => {
  const b = await body(c, z.object({ gameId: z.string(), images: z.array(z.object({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(100).max(7_000_000) })).min(1).max(4) }));
  const p = await prepare(c, b.gameId, { needPct: false });
  const ex = await extractScreenshots(c.env, b.images, { away: p.teams[0].name, home: p.teams[1].name, rosterNames: p.teams.flatMap((t) => t.roster.filter((r) => r.active).map((r) => r.name)) });
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const index = p.teams.flatMap((t, s) => t.roster.map((r) => ({ key: norm(r.name), id: r.id, name: r.name, side: s, active: r.active })));
  const players = ex.players.map((pl) => {
    const matches = index.filter((x) => x.key === norm(pl.name));
    const m = matches.length === 1 ? matches[0] : null;
    return { ...pl, playerId: m?.id ?? null, side: m?.side ?? null, matched: !!m, note: !matches.length ? 'Not on either roster — map this line to a rostered player or discard it.' : matches.length > 1 ? 'Name matches more than one rostered player — choose which one.' : !m!.active ? 'Matched an inactive player.' : null };
  });
  await log(c, { action: 'screenshot_read', entity: 'game', entityId: p.game.id, gameId: p.game.id, next: { images: b.images.length, playersFound: players.length } }).run();
  // Nothing is stored: the administrator must review, correct and confirm these values in the import form.
  return c.json({ extraction: { ...ex, players }, requiresConfirmation: true });
});

// ---------------------------------------------------------------------------------- review & publishing
adminRoutes.get('/games/:id/runs', async (c) => c.json({ runs: await all(c.env.DB, 'SELECT r.id, r.mode, r.seed, r.status, r.valid, r.away_score, r.home_score, r.created_at, r.reviewed_at, r.review_note, u.name AS created_by_name FROM simulation_runs r LEFT JOIN users u ON u.id = r.created_by WHERE r.game_id = ?1 ORDER BY r.created_at DESC', c.req.param('id')), published: await all(c.env.DB, 'SELECT * FROM published_results WHERE game_id = ?1 ORDER BY version DESC', c.req.param('id')) }));

adminRoutes.get('/review', async (c) => {
  const season = await getSeason(c.env.DB, c.req.query('season'));
  const rows = await all(c.env.DB, `SELECT r.id, r.game_id, r.mode, r.seed, r.status, r.valid, r.away_score, r.home_score, r.created_at, g.week, g.away_team_id, g.home_team_id, g.status AS game_status, g.away_score AS official_away, g.home_score AS official_home
    FROM simulation_runs r JOIN games g ON g.id = r.game_id WHERE g.season_id = ?1 AND r.status IN ('candidate','approved') ORDER BY g.week, r.created_at`, season.id);
  return c.json({ season: season.id, runs: rows });
});

adminRoutes.get('/runs/:id', async (c) => {
  const db = c.env.DB;
  const r = await first<Record<string, unknown>>(db, 'SELECT r.*, u.name AS created_by_name, v.name AS reviewed_by_name FROM simulation_runs r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users v ON v.id = r.reviewed_by WHERE r.id = ?1', c.req.param('id'));
  if (!r) throw new HttpError(404, 'Result not found.');
  const game = await first<GameRow>(db, 'SELECT * FROM games WHERE id = ?1', r.game_id);
  const snapshot = r.snapshot_id ? await first<Snapshot>(db, 'SELECT * FROM percentage_snapshots WHERE id = ?1', r.snapshot_id) : null;
  const entries = snapshot ? await snapshotEntries(db, snapshot.id) : new Map();
  const result = j<GameResult | null>(r.result as string, null);
  const names = Object.fromEntries((await all<{ id: string; name: string; position: string; jersey: number | null }>(db, 'SELECT p.id, p.name, rm.position, rm.jersey FROM roster_memberships rm JOIN players p ON p.id = rm.player_id WHERE rm.season_id = ?1 AND rm.team_id IN (?2, ?3)', game!.season_id, game!.away_team_id, game!.home_team_id)).map((p) => [p.id, p]));
  return c.json({
    run: { ...r, result: undefined }, game: { ...game, designations: j(game!.designations, []) }, result, players: names,
    snapshot: snapshot ? { ...snapshot, away: entries.get(game!.away_team_id) ?? null, home: entries.get(game!.home_team_id) ?? null, ageMs: (r.created_at as number) - snapshot.fetched_at } : null,
  });
});

adminRoutes.post('/runs/:id/approve', async (c) => {
  const db = c.env.DB;
  const r = await first<{ id: string; status: string; valid: number; game_id: string }>(db, 'SELECT id, status, valid, game_id FROM simulation_runs WHERE id = ?1', c.req.param('id'));
  if (!r) throw new HttpError(404, 'Result not found.');
  if (r.status !== 'candidate') throw new HttpError(409, `Only a result awaiting review can be approved (this one is "${r.status}").`);
  if (!r.valid) throw new HttpError(422, 'This result failed validation and cannot be approved. Regenerate it or correct the inputs.');
  await db.batch([
    stmt(db, "UPDATE simulation_runs SET status = 'approved', reviewed_by = ?1, reviewed_at = ?2 WHERE id = ?3 AND status = 'candidate'", c.get('admin').id, now(), r.id),
    log(c, { action: 'result_approved', entity: 'simulation_run', entityId: r.id, gameId: r.game_id }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.post('/runs/:id/reject', async (c) => {
  const b = await body(c, z.object({ note: z.string().max(300).optional() }));
  const db = c.env.DB;
  const r = await first<{ id: string; status: string; game_id: string }>(db, 'SELECT id, status, game_id FROM simulation_runs WHERE id = ?1', c.req.param('id'));
  if (!r) throw new HttpError(404, 'Result not found.');
  if (r.status !== 'candidate' && r.status !== 'approved') throw new HttpError(409, `This result is "${r.status}" and can no longer be rejected.`);
  await db.batch([
    stmt(db, "UPDATE simulation_runs SET status = 'rejected', reviewed_by = ?1, reviewed_at = ?2, review_note = ?3 WHERE id = ?4", c.get('admin').id, now(), b.note ?? null, r.id),
    log(c, { action: 'result_rejected', entity: 'simulation_run', entityId: r.id, gameId: r.game_id, reason: b.note ?? null }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.post('/runs/:id/publish', async (c) => {
  const b = await body(c, z.object({ presentationMsPerPlay: z.number().int().min(250).max(60_000).nullable().optional(), confirm: z.boolean().optional(), reason: z.string().trim().max(300).nullable().optional() }));
  return c.json(await publishRun(c.env.DB, c.get('admin'), c.req.param('id'), b));
});

// ---------------------------------------------------------------------------------- rankings
adminRoutes.get('/rankings', async (c) => {
  const db = c.env.DB;
  const season = await getSeason(db, c.req.query('season'));
  const week = Number(c.req.query('week') ?? 1);
  const exact = await all<{ team_id: string; rank: number }>(db, "SELECT team_id, rank FROM rankings WHERE season_id = ?1 AND week = ?2 AND poll = 'AP' ORDER BY rank", season.id, week);
  const prior = exact.length ? null : await ranks(db, season.id, week);
  return c.json({ season: season.id, week, published: exact.length > 0, teamIds: exact.map((r) => r.team_id), carriedFromWeek: prior?.week ?? null, carried: prior ? [...prior.map.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]) : [] });
});
adminRoutes.put('/rankings', async (c) => {
  const b = await body(c, z.object({ seasonId: z.string(), week: z.number().int().min(0).max(40), teamIds: z.array(z.string()).max(25) }));
  const db = c.env.DB;
  if (new Set(b.teamIds).size !== b.teamIds.length) throw new HttpError(422, 'A team appears twice in the rankings.');
  const valid = new Set((await teamsForSeason(db, b.seasonId, true)).map((t) => t.id));
  if (b.teamIds.some((t) => !valid.has(t))) throw new HttpError(422, 'Rankings may only include teams entered in this season.');
  const prev = await all<{ team_id: string }>(db, "SELECT team_id FROM rankings WHERE season_id = ?1 AND week = ?2 AND poll = 'AP' ORDER BY rank", b.seasonId, b.week);
  await db.batch([
    stmt(db, "DELETE FROM rankings WHERE season_id = ?1 AND week = ?2 AND poll = 'AP'", b.seasonId, b.week),
    ...b.teamIds.map((t, i) => stmt(db, "INSERT INTO rankings (id, season_id, week, poll, rank, team_id, created_by, created_at) VALUES (?1, ?2, ?3, 'AP', ?4, ?5, ?6, ?7)", uid(), b.seasonId, b.week, i + 1, t, c.get('admin').id, now())),
    log(c, { action: 'rankings_published', entity: 'rankings', entityId: `${b.seasonId}:${b.week}`, previous: prev.map((p) => p.team_id), next: b.teamIds }),
  ]);
  return c.json({ ok: true });
});
/** A computed suggestion only. It is returned to the administrator and is never written to the official rankings. */
adminRoutes.get('/rankings/recommendation', async (c) => {
  const db = c.env.DB;
  const season = await getSeason(db, c.req.query('season'));
  const rec = await records(db, season.id, now());
  const pct = (id: string) => { const r = rec.get(id); return r && r.w + r.l ? r.w / (r.w + r.l) : 0; };
  const rows = [...rec.entries()].filter(([, r]) => r.w + r.l > 0).map(([teamId, r]) => {
    const gp = r.w + r.l;
    const sos = r.games.reduce((a, g) => a + pct(g.opp), 0) / gp;
    return { teamId, record: `${r.w}-${r.l}`, score: Math.round((100 * (r.w / gp) + 0.8 * ((r.pf - r.pa) / gp) + 30 * sos + 2 * r.w) * 10) / 10, strengthOfSchedule: Math.round(sos * 1000) / 1000 };
  });
  rows.sort((a, b) => b.score - a.score);
  return c.json({ season: season.id, method: 'Formula: 100 × win% + 0.8 × average margin + 30 × opponents’ win% + 2 × wins. A suggestion only — nothing is saved until an administrator publishes rankings.', recommendation: rows.slice(0, 25) });
});

// ---------------------------------------------------------------------------------- settings, audit, summary
const configSchema = z.object({
  homeFieldAdvantage: z.number().min(0).max(10), sackConvention: z.enum(['ncaa', 'nfl']), activityEffect: z.number().min(0).max(6), upsetGapClosure: z.number().min(0).max(1), starBoost: z.number().min(0).max(25), allowInactive: z.boolean(),
});
adminRoutes.get('/settings', async (c) => {
  const season = await getSeason(c.env.DB, c.req.query('season'));
  return c.json({ season: season.id, config: await simConfig(c.env.DB, season.id), aiConfigured: !!c.env.ANTHROPIC_API_KEY });
});
adminRoutes.put('/settings', async (c) => {
  const b = await body(c, z.object({ seasonId: z.string(), config: configSchema }));
  const prev = await simConfig(c.env.DB, b.seasonId);
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO simulation_configurations (season_id, config, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (season_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by', b.seasonId, JSON.stringify(b.config), now(), c.get('admin').id),
    log(c, { action: 'simulation_settings_changed', entity: 'settings', entityId: b.seasonId, previous: prev, next: b.config }),
  ]);
  return c.json({ ok: true });
});
adminRoutes.get('/audit', async (c) => {
  const limit = Math.min(200, Number(c.req.query('limit') ?? 100));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));
  const gameId = c.req.query('game');
  const rows = await all(c.env.DB, `SELECT * FROM audit_logs ${gameId ? 'WHERE game_id = ?3' : ''} ORDER BY id DESC LIMIT ?1 OFFSET ?2`, ...(gameId ? [limit, offset, gameId] : [limit, offset]));
  return c.json({ entries: rows.map((r) => ({ ...r, previous_value: j(r.previous_value as string, null), new_value: j(r.new_value as string, null) })) });
});
adminRoutes.get('/summary', async (c) => {
  const db = c.env.DB;
  const admin = c.get('admin') as AdminUser;
  const seasons = await all<SeasonRow>(db, 'SELECT * FROM seasons ORDER BY year DESC');
  if (!seasons.length) return c.json({ admin, season: null, counts: null });
  const season = await getSeason(db, c.req.query('season'));
  const one = async (sql: string, ...p: unknown[]) => (await first<{ n: number }>(db, sql, ...p))?.n ?? 0;
  const coverage = await pctCoverage(db, season.id);
  return c.json({
    admin, season,
    counts: {
      teams: await one('SELECT COUNT(*) AS n FROM team_seasons WHERE season_id = ?1', season.id),
      players: await one('SELECT COUNT(*) AS n FROM roster_memberships WHERE season_id = ?1 AND active = 1', season.id),
      games: await one('SELECT COUNT(*) AS n FROM games WHERE season_id = ?1', season.id),
      final: await one("SELECT COUNT(*) AS n FROM games WHERE season_id = ?1 AND status = 'final'", season.id),
      scheduled: await one("SELECT COUNT(*) AS n FROM games WHERE season_id = ?1 AND status = 'scheduled'", season.id),
      awaitingReview: await one("SELECT COUNT(*) AS n FROM simulation_runs r JOIN games g ON g.id = r.game_id WHERE g.season_id = ?1 AND r.status = 'candidate'", season.id),
      awaitingPublish: await one("SELECT COUNT(*) AS n FROM simulation_runs r JOIN games g ON g.id = r.game_id WHERE g.season_id = ?1 AND r.status = 'approved'", season.id),
    },
    percentages: coverage, aiConfigured: !!c.env.ANTHROPIC_API_KEY, serverTime: now(),
  });
});
void toRosterPlayers;
