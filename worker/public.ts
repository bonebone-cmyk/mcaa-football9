// Public, read-only API. Everything here is derived from officially published records.
import { Hono } from 'hono';
import { passerRating } from '../engine/stats';
import { HttpError, type AppEnv } from './auth';
import { PLAYER_STAT_COLS, TEAM_STAT_COLS, all, first, j, now, type DB } from './db';
import { getSeason, logoUrl, publicGames, ranks, records, recordText, teamsForSeason, type GameRow, type SeasonRow, type TeamRow } from './league';

export const publicRoutes = new Hono<AppEnv>();

const AGG = PLAYER_STAT_COLS.map((c) => `${c.endsWith('Long') ? 'MAX' : 'SUM'}(s.${c}) AS ${c}`).join(', ');
const TEAM_AGG = TEAM_STAT_COLS.map((c) => `SUM(s.${c}) AS ${c}`).join(', ');
const OFFICIAL_JOIN = `JOIN games g ON g.id = s.game_id AND g.status = 'final' AND g.published_run_id IS NOT NULL AND g.final_at <= `;

function derive(r: Record<string, number>) {
  const d = (a: number, b: number, digits = 1) => (b ? Math.round((a / b) * 10 ** digits) / 10 ** digits : 0);
  return {
    ...r,
    tackles: (r.tklSolo ?? 0) + (r.tklAst ?? 0),
    cmpPct: d(100 * r.passCmp, r.passAtt), ypa: d(r.passYds, r.passAtt), passRating: passerRating(r.passCmp, r.passAtt, r.passYds, r.passTd, r.passInt),
    ypc: d(r.rushYds, r.rushAtt), ypr: d(r.recYds, r.rec), fgPct: d(100 * r.fgm, r.fga), puntAvg: d(r.puntYds, r.punts),
    krAvg: d(r.krYds, r.kr), prAvg: d(r.prYds, r.pr),
  };
}

async function weekState(db: DB, season: SeasonRow, at: number) {
  const weeks = await all<{ week: number; n: number; open: number }>(db, `SELECT week, COUNT(*) AS n, SUM(CASE WHEN status IN ('scheduled','in_progress','postponed') OR (status = 'final' AND final_at > ?2) THEN 1 ELSE 0 END) AS open FROM games WHERE season_id = ?1 GROUP BY week ORDER BY week`, season.id, at);
  const current = weeks.find((w) => w.open > 0)?.week ?? weeks[weeks.length - 1]?.week ?? 1;
  return { weeks: weeks.map((w) => w.week), current };
}

async function ctx(db: DB, seasonParam?: string | null) {
  const at = now();
  const season = await getSeason(db, seasonParam);
  const teams = await teamsForSeason(db, season.id);
  const rec = await records(db, season.id, at, teams);
  return { at, season, teams, rec };
}

publicRoutes.get('/meta', async (c) => {
  const db = c.env.DB;
  const seasons = await all<SeasonRow>(db, 'SELECT * FROM seasons ORDER BY year DESC');
  if (!seasons.length) return c.json({ seasons: [], season: null, weeks: [], currentWeek: 1, conferences: [], teams: [], aiEnabled: !!c.env.ANTHROPIC_API_KEY });
  const season = await getSeason(db, c.req.query('season'));
  const at = now();
  const [teams, ws, conferences] = await Promise.all([teamsForSeason(db, season.id), weekState(db, season, at), all(db, 'SELECT * FROM conferences ORDER BY name')]);
  return c.json({
    seasons: seasons.map((s) => ({ id: s.id, year: s.year, name: s.name, current: !!s.is_current, weeks: s.weeks })),
    season: { id: season.id, year: season.year, name: season.name, weeks: season.weeks },
    weeks: ws.weeks, currentWeek: ws.current, conferences,
    teams: teams.filter((t) => t.in_season).map((t) => ({ id: t.id, name: t.name, short: t.short_name, abbr: t.abbr, color: t.primary_color, color2: t.secondary_color, logo: logoUrl(t), conferenceId: t.conference_id, conference: t.conference_abbr })),
  });
});

publicRoutes.get('/schedule', async (c) => {
  const db = c.env.DB;
  const { at, season, teams, rec } = await ctx(db, c.req.query('season'));
  const q = c.req.query();
  const where = ['season_id = ?1'];
  const params: unknown[] = [season.id];
  if (q.week) (params.push(Number(q.week)), where.push(`week = ?${params.length}`));
  if (q.team) (params.push(q.team), where.push(`(away_team_id = ?${params.length} OR home_team_id = ?${params.length})`));
  const games = await all<GameRow>(db, `SELECT * FROM games WHERE ${where.join(' AND ')} ORDER BY week, COALESCE(kickoff_at, 9e15), created_at`, ...params);
  const rk = await ranks(db, season.id, q.week ? Number(q.week) : null);
  let list = await publicGames(db, games, teams, rec, rk.map, at);
  if (q.conference) {
    const inConf = new Set(teams.filter((t) => t.conference_id === q.conference).map((t) => t.id));
    list = list.filter((g) => inConf.has(g.away.id) || inConf.has(g.home.id));
  }
  if (q.status) list = list.filter((g) => g.status === q.status);
  return c.json({ season: season.id, rankWeek: rk.week, games: list });
});

async function gameQuarters(db: DB, g: GameRow, upToSeq?: number): Promise<[number[], number[]]> {
  const rows = await all<{ quarter: number; team_id: string; pts: number }>(db, `SELECT quarter, team_id, SUM(pts) AS pts FROM scoring_events WHERE game_id = ?1 ${upToSeq != null ? 'AND play_seq <= ?2' : ''} GROUP BY quarter, team_id`, ...(upToSeq != null ? [g.id, upToSeq] : [g.id]));
  const maxQ = Math.max(4, ...rows.map((r) => r.quarter));
  const q: [number[], number[]] = [Array(maxQ).fill(0), Array(maxQ).fill(0)];
  for (const r of rows) q[r.team_id === g.home_team_id ? 1 : 0][r.quarter - 1] = r.pts;
  return q;
}

publicRoutes.get('/games/:id', async (c) => {
  const db = c.env.DB;
  const g = await first<GameRow>(db, 'SELECT * FROM games WHERE id = ?1', c.req.param('id'));
  if (!g) throw new HttpError(404, 'Game not found.');
  const { at, season, teams, rec } = await ctx(db, g.season_id);
  const rk = await ranks(db, season.id, g.week);
  const [game] = await publicGames(db, [g], teams, rec, rk.map, at);
  const base = { game, season: { id: season.id, year: season.year, name: season.name } };
  if (g.status !== 'final' || !g.published_run_id) return c.json({ ...base, result: null });

  const total = (await first<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM play_events WHERE game_id = ?1', g.id))!.n;
  const playCols = 'seq, drive, quarter, clock, offense_team_id AS teamId, down, distance, ball_on AS ballOn, type, yards, result, description, away_score AS away, home_score AS home';
  const labels = {
    mode: g.mode,
    // Honest provenance: what is real, what is generated.
    score: g.mode === 'primetime' ? 'Verified CFB 27 result' : 'Simulated result',
    playByPlay: g.mode === 'primetime' ? 'AI-generated reconstruction — these plays were not observed' : 'Simulated play-by-play',
    highlights: g.mode === 'primetime' ? 'AI-generated highlight reconstruction — not observed gameplay' : 'Simulated highlights',
    stats: g.mode === 'primetime' ? 'Statistics marked ✓ are verified CFB 27 values; all others are generated to be consistent with the real score' : 'Simulated statistics',
  };
  if (game.replay) {
    const ms = g.presentation_ms_per_play || 1000;
    const visible = Math.min(total, Math.max(1, Math.floor((at - (g.presentation_started_at ?? at)) / ms) + 1));
    const [plays, drives, scoring, highlights, quarters] = await Promise.all([
      all(db, `SELECT ${playCols} FROM play_events WHERE game_id = ?1 AND seq <= ?2 ORDER BY seq`, g.id, visible),
      all(db, 'SELECT d.num, d.team_id AS teamId, d.quarter, d.start_clock AS startClock, d.start_ball_on AS startBallOn FROM drives d WHERE d.game_id = ?1 AND d.num <= (SELECT MAX(drive) FROM play_events WHERE game_id = ?1 AND seq <= ?2) ORDER BY d.num', g.id, visible),
      all(db, 'SELECT play_seq AS playSeq, quarter, clock, team_id AS teamId, kind, pts, description, away_score AS away, home_score AS home FROM scoring_events WHERE game_id = ?1 AND play_seq <= ?2 ORDER BY play_seq', g.id, visible),
      all(db, 'SELECT play_seq AS playSeq, quarter, clock, team_id AS teamId, title, text, tags FROM highlights WHERE game_id = ?1 AND play_seq <= ?2 ORDER BY play_seq', g.id, visible),
      gameQuarters(db, g, visible),
    ]);
    return c.json({
      ...base, labels,
      replay: { active: true, msPerPlay: ms, startedAt: g.presentation_started_at, endsAt: g.final_at, total, visible, note: 'Replay of a completed simulation. This game is not being played live.' },
      result: { quarters, plays, drives, scoring, highlights: highlights.map((h) => ({ ...h, tags: j(h.tags as string, []) })), teamStats: null, playerStats: null, recap: null },
    });
  }
  const [plays, drives, scoring, highlights, teamStats, playerStats, run, quarters] = await Promise.all([
    all(db, `SELECT ${playCols} FROM play_events WHERE game_id = ?1 ORDER BY seq`, g.id),
    all(db, 'SELECT num, team_id AS teamId, quarter, start_clock AS startClock, start_ball_on AS startBallOn, plays, yards, seconds, result, points FROM drives WHERE game_id = ?1 ORDER BY num', g.id),
    all(db, `SELECT se.play_seq AS playSeq, se.quarter, se.clock, se.team_id AS teamId, se.kind, se.pts, se.player_id AS playerId, p.name AS playerName, se.description, se.away_score AS away, se.home_score AS home
      FROM scoring_events se LEFT JOIN players p ON p.id = se.player_id WHERE se.game_id = ?1 ORDER BY se.play_seq`, g.id),
    all(db, 'SELECT play_seq AS playSeq, quarter, clock, team_id AS teamId, title, text, rank, tags FROM highlights WHERE game_id = ?1 ORDER BY play_seq', g.id),
    all(db, `SELECT team_id AS teamId, is_home AS isHome, ${TEAM_STAT_COLS.join(', ')} FROM team_game_stats WHERE game_id = ?1 ORDER BY is_home`, g.id),
    all<Record<string, number> & { locked_fields: string }>(db, `SELECT s.player_id AS playerId, p.name, s.team_id AS teamId, rm.position, rm.jersey, s.locked_fields, ${PLAYER_STAT_COLS.map((x) => `s.${x}`).join(', ')}
      FROM player_game_stats s JOIN players p ON p.id = s.player_id LEFT JOIN roster_memberships rm ON rm.player_id = s.player_id AND rm.season_id = s.season_id WHERE s.game_id = ?1`, g.id),
    first<{ recap: string | null; ot: number; published_at: number; version: number }>(db, `SELECT json_extract(r.result, '$.recap') AS recap, json_extract(r.result, '$.overtimePeriods') AS ot, pr.published_at, pr.version
      FROM simulation_runs r JOIN published_results pr ON pr.run_id = r.id WHERE r.id = ?1`, g.published_run_id),
    gameQuarters(db, g),
  ]);
  return c.json({
    ...base, labels, replay: null,
    result: {
      quarters, overtimePeriods: run?.ot ?? 0, plays, drives, scoring, teamStats,
      highlights: highlights.map((h) => ({ ...h, tags: j(h.tags as string, []) })),
      playerStats: playerStats.map((p) => ({ ...derive(p), lockedFields: j(p.locked_fields, []), locked_fields: undefined })),
      recap: j(run?.recap, null), publishedAt: run?.published_at ?? null, version: run?.version ?? 1,
    },
  });
});

publicRoutes.get('/rankings', async (c) => {
  const db = c.env.DB;
  const { season, teams, rec } = await ctx(db, c.req.query('season'));
  const weeks = (await all<{ week: number }>(db, "SELECT DISTINCT week FROM rankings WHERE season_id = ?1 AND poll = 'AP' ORDER BY week", season.id)).map((w) => w.week);
  const week = c.req.query('week') ? Number(c.req.query('week')) : weeks[weeks.length - 1] ?? null;
  const cur = week != null ? await ranks(db, season.id, week) : { week: null, map: new Map<string, number>() };
  const prevWeek = cur.week != null ? weeks.filter((w) => w < cur.week!).pop() : undefined;
  const prev = prevWeek != null ? await ranks(db, season.id, prevWeek) : { map: new Map<string, number>() };
  const tm = new Map(teams.map((t) => [t.id, t]));
  const rows = [...cur.map.entries()].sort((a, b) => a[1] - b[1]).map(([teamId, rank]) => {
    const t = tm.get(teamId);
    return { rank, previous: prev.map.get(teamId) ?? null, team: t ? { id: t.id, name: t.name, short: t.short_name, abbr: t.abbr, color: t.primary_color, color2: t.secondary_color, logo: logoUrl(t), conference: t.conference_abbr } : null, record: recordText(rec.get(teamId)) };
  });
  return c.json({ season: season.id, weeks, week: cur.week, rankings: rows });
});

publicRoutes.get('/leaders', async (c) => {
  const db = c.env.DB;
  const at = now();
  const season = await getSeason(db, c.req.query('season'));
  const where = ['s.season_id = ?2'];
  const params: unknown[] = [at, season.id];
  if (c.req.query('team')) (params.push(c.req.query('team')), where.push(`s.team_id = ?${params.length}`));
  if (c.req.query('conference')) (params.push(c.req.query('conference')), where.push(`ts.conference_id = ?${params.length}`));
  const rows = await all<Record<string, number>>(db, `SELECT s.player_id AS playerId, p.name, s.team_id AS teamId, t.abbr AS teamAbbr, t.name AS teamName, t.primary_color AS color, rm.position, COUNT(*) AS gp, ${AGG}
    FROM player_game_stats s ${OFFICIAL_JOIN} ?1 JOIN players p ON p.id = s.player_id JOIN teams t ON t.id = s.team_id
    LEFT JOIN team_seasons ts ON ts.team_id = s.team_id AND ts.season_id = s.season_id LEFT JOIN roster_memberships rm ON rm.player_id = s.player_id AND rm.season_id = s.season_id
    WHERE ${where.join(' AND ')} GROUP BY s.player_id, s.team_id`, ...params);
  const teamGames = new Map((await all<{ team_id: string; n: number }>(db, `SELECT s.team_id, COUNT(*) AS n FROM team_game_stats s ${OFFICIAL_JOIN} ?1 WHERE s.season_id = ?2 GROUP BY s.team_id`, at, season.id)).map((r) => [r.team_id, r.n]));
  // Minimums for rate statistics, scaled by team games played (NCAA-style qualification).
  const minimums = { cmpPct: { stat: 'passAtt', perGame: 14 }, passRating: { stat: 'passAtt', perGame: 14 }, ypa: { stat: 'passAtt', perGame: 14 }, ypc: { stat: 'rushAtt', perGame: 8 }, ypr: { stat: 'rec', perGame: 2 }, fgPct: { stat: 'fga', perGame: 0.75 }, puntAvg: { stat: 'punts', perGame: 2 } };
  const players = rows.map((r) => {
    const d = derive(r) as Record<string, number>;
    const tg = teamGames.get(r.teamId as unknown as string) ?? 1;
    const qualified = Object.fromEntries(Object.entries(minimums).map(([k, m]) => [k, (d[m.stat] ?? 0) >= Math.max(1, Math.ceil(m.perGame * tg))]));
    return { ...d, qualified };
  });
  return c.json({ season: season.id, minimums, players });
});

publicRoutes.get('/teams', async (c) => {
  const { season, teams, rec } = await ctx(c.env.DB, c.req.query('season'));
  const rk = await ranks(c.env.DB, season.id, null);
  return c.json({
    season: season.id,
    teams: teams.filter((t) => t.in_season).map((t) => ({ id: t.id, name: t.name, short: t.short_name, abbr: t.abbr, mascot: t.mascot, color: t.primary_color, color2: t.secondary_color, logo: logoUrl(t), conference: t.conference_name, conferenceId: t.conference_id, record: recordText(rec.get(t.id)), confRecord: `${rec.get(t.id)?.cw ?? 0}-${rec.get(t.id)?.cl ?? 0}`, rank: rk.map.get(t.id) ?? null })),
  });
});

publicRoutes.get('/teams/:id/logo', async (c) => {
  const row = await first<{ logo: string | null }>(c.env.DB, 'SELECT logo FROM teams WHERE id = ?1', c.req.param('id'));
  if (!row?.logo) return c.notFound();
  if (/^https:\/\//.test(row.logo)) return c.redirect(row.logo, 302);
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(row.logo);
  if (!m) return c.notFound();
  const bytes = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
});

publicRoutes.get('/teams/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const { at, season, teams, rec } = await ctx(db, c.req.query('season'));
  const t = teams.find((x) => x.id === id || x.abbr.toLowerCase() === id.toLowerCase());
  if (!t) throw new HttpError(404, 'Team not found.');
  const rk = await ranks(db, season.id, null);
  const [rosterRows, games, agg, totals, opp, seasonsIn] = await Promise.all([
    all(db, `SELECT rm.player_id AS playerId, p.name, rm.jersey, rm.position, rm.secondary_positions AS secondary, rm.depth_rank AS depth, rm.active FROM roster_memberships rm JOIN players p ON p.id = rm.player_id WHERE rm.season_id = ?1 AND rm.team_id = ?2 ORDER BY rm.active DESC, rm.position, rm.depth_rank`, season.id, t.id),
    all<GameRow>(db, 'SELECT * FROM games WHERE season_id = ?1 AND (away_team_id = ?2 OR home_team_id = ?2) ORDER BY week, COALESCE(kickoff_at, 9e15)', season.id, t.id),
    all<Record<string, number>>(db, `SELECT s.player_id AS playerId, p.name, rm.position, COUNT(*) AS gp, ${AGG} FROM player_game_stats s ${OFFICIAL_JOIN} ?1 JOIN players p ON p.id = s.player_id
      LEFT JOIN roster_memberships rm ON rm.player_id = s.player_id AND rm.season_id = s.season_id WHERE s.season_id = ?2 AND s.team_id = ?3 GROUP BY s.player_id`, at, season.id, t.id),
    first<Record<string, number>>(db, `SELECT COUNT(*) AS gp, ${TEAM_AGG} FROM team_game_stats s ${OFFICIAL_JOIN} ?1 WHERE s.season_id = ?2 AND s.team_id = ?3`, at, season.id, t.id),
    first<Record<string, number>>(db, `SELECT COUNT(*) AS gp, ${TEAM_AGG} FROM team_game_stats s ${OFFICIAL_JOIN} ?1 WHERE s.season_id = ?2 AND s.opponent_id = ?3`, at, season.id, t.id),
    all<SeasonRow & { conference: string | null }>(db, 'SELECT se.*, c.name AS conference FROM team_seasons ts JOIN seasons se ON se.id = ts.season_id LEFT JOIN conferences c ON c.id = ts.conference_id WHERE ts.team_id = ?1 ORDER BY se.year DESC', t.id),
  ]);
  const history = [];
  for (const s of seasonsIn) {
    const r = s.id === season.id ? rec : await records(db, s.id, at);
    const x = r.get(t.id);
    const fin = await first<{ rank: number }>(db, "SELECT rank FROM rankings WHERE season_id = ?1 AND team_id = ?2 AND poll = 'AP' ORDER BY week DESC LIMIT 1", s.id, t.id);
    history.push({ seasonId: s.id, year: s.year, name: s.name, conference: s.conference, record: recordText(x), confRecord: `${x?.cw ?? 0}-${x?.cl ?? 0}`, pf: x?.pf ?? 0, pa: x?.pa ?? 0, lastRank: fin?.rank ?? null });
  }
  const r = rec.get(t.id);
  return c.json({
    season: { id: season.id, year: season.year, name: season.name },
    team: { id: t.id, name: t.name, short: t.short_name, abbr: t.abbr, mascot: t.mascot, color: t.primary_color, color2: t.secondary_color, logo: logoUrl(t), stadium: t.stadium, conference: t.conference_name, conferenceId: t.conference_id, offScheme: t.off_scheme, defScheme: t.def_scheme, rank: rk.map.get(t.id) ?? null, record: recordText(r), confRecord: `${r?.cw ?? 0}-${r?.cl ?? 0}`, pf: r?.pf ?? 0, pa: r?.pa ?? 0, streak: r?.streak ?? '' },
    roster: rosterRows.map((p) => ({ ...p, secondary: j(p.secondary as string, []), active: !!p.active })),
    schedule: await publicGames(db, games, teams, rec, rk.map, at),
    players: agg.map(derive),
    teamStats: totals?.gp ? totals : null, opponentStats: opp?.gp ? opp : null,
    history,
  });
});

publicRoutes.get('/players/:id', async (c) => {
  const db = c.env.DB;
  const at = now();
  const id = c.req.param('id');
  const player = await first<{ id: string; name: string }>(db, 'SELECT id, name FROM players WHERE id = ?1', id);
  if (!player) throw new HttpError(404, 'Player not found.');
  const [memberships, seasons, log] = await Promise.all([
    all<Record<string, unknown>>(db, `SELECT rm.season_id AS seasonId, se.year, se.name AS seasonName, rm.team_id AS teamId, t.name AS teamName, t.abbr AS teamAbbr, t.primary_color AS color, t.secondary_color AS color2, (t.logo IS NOT NULL) AS has_logo, rm.jersey, rm.position, rm.secondary_positions AS secondary, rm.depth_rank AS depth, rm.active, rm.awards
      FROM roster_memberships rm JOIN seasons se ON se.id = rm.season_id JOIN teams t ON t.id = rm.team_id WHERE rm.player_id = ?1 ORDER BY se.year DESC`, id),
    all<Record<string, number>>(db, `SELECT s.season_id AS seasonId, se.year, s.team_id AS teamId, t.abbr AS teamAbbr, COUNT(*) AS gp, ${AGG} FROM player_game_stats s ${OFFICIAL_JOIN} ?1 JOIN seasons se ON se.id = s.season_id JOIN teams t ON t.id = s.team_id WHERE s.player_id = ?2 GROUP BY s.season_id, s.team_id ORDER BY se.year DESC`, at, id),
    all<Record<string, number>>(db, `SELECT s.game_id AS gameId, g.season_id AS seasonId, g.week, g.mode, s.team_id AS teamId, CASE WHEN g.home_team_id = s.team_id THEN g.away_team_id ELSE g.home_team_id END AS oppId, (g.home_team_id = s.team_id) AS isHome,
      g.away_score AS awayScore, g.home_score AS homeScore, s.locked_fields AS lockedFields, ${PLAYER_STAT_COLS.map((x) => `s.${x}`).join(', ')}
      FROM player_game_stats s ${OFFICIAL_JOIN} ?1 WHERE s.player_id = ?2 ORDER BY g.season_id DESC, g.week`, at, id),
  ]);
  const career = await first<Record<string, number>>(db, `SELECT COUNT(*) AS gp, ${AGG} FROM player_game_stats s ${OFFICIAL_JOIN} ?1 WHERE s.player_id = ?2`, at, id);
  const tm = new Map((await all<{ id: string; abbr: string; name: string }>(db, 'SELECT id, abbr, name FROM teams')).map((t) => [t.id, t]));
  return c.json({
    player,
    memberships: memberships.map((m) => ({ ...m, logo: m.has_logo ? `/api/teams/${m.teamId}/logo` : null, secondary: j(m.secondary as string, []), awards: j(m.awards as string, []), active: !!m.active })),
    seasons: seasons.map(derive),
    career: career?.gp ? derive(career) : null,
    gameLog: log.map((l) => ({ ...derive(l), lockedFields: j(l.lockedFields as unknown as string, []), opp: tm.get(l.oppId as unknown as string) ?? null })),
  });
});

publicRoutes.get('/home', async (c) => {
  const db = c.env.DB;
  const { at, season, teams, rec } = await ctx(db, c.req.query('season'));
  const ws = await weekState(db, season, at);
  const week = c.req.query('week') ? Number(c.req.query('week')) : ws.current;
  const rk = await ranks(db, season.id, week);
  const tm = new Map(teams.map((t) => [t.id, t]));
  const weekGames = await all<GameRow>(db, 'SELECT * FROM games WHERE season_id = ?1 AND week = ?2 ORDER BY COALESCE(kickoff_at, 9e15), created_at', season.id, week);
  const scoreboard = await publicGames(db, weekGames, teams, rec, rk.map, at);
  const rankSum = (g: (typeof scoreboard)[number]) => (g.away.rank ?? 40) + (g.home.rank ?? 40);
  const live = scoreboard.filter((g) => g.status !== 'canceled');
  const featured = live.find((g) => g.designations.includes('gotw')) ?? [...live].sort((a, b) => rankSum(a) - rankSum(b))[0] ?? null;

  const recent = await all<GameRow>(db, `SELECT * FROM games WHERE season_id = ?1 AND status = 'final' AND published_run_id IS NOT NULL AND final_at <= ?2 ORDER BY final_at DESC LIMIT 8`, season.id, at);
  const recentPublic = await publicGames(db, recent, teams, rec, rk.map, at);
  // Upsets: an officially ranked team lost to an unranked or lower-ranked opponent (rankings as of that week).
  const upsets = [];
  const finals = await all<GameRow>(db, `SELECT * FROM games WHERE season_id = ?1 AND status = 'final' AND published_run_id IS NOT NULL AND final_at <= ?2 ORDER BY week DESC LIMIT 60`, season.id, at);
  const rankCache = new Map<number, Map<string, number>>();
  for (const g of finals) {
    if (!rankCache.has(g.week)) rankCache.set(g.week, (await ranks(db, season.id, g.week)).map);
    const m = rankCache.get(g.week)!;
    const homeWon = (g.home_score ?? 0) > (g.away_score ?? 0);
    const w = homeWon ? g.home_team_id : g.away_team_id, l = homeWon ? g.away_team_id : g.home_team_id;
    const lr = m.get(l), wr = m.get(w);
    if (lr != null && (wr == null || wr > lr)) upsets.push({ gameId: g.id, week: g.week, winner: tm.get(w)?.name, loser: tm.get(l)?.name, winnerRank: wr ?? null, loserRank: lr, score: `${Math.max(g.away_score ?? 0, g.home_score ?? 0)}-${Math.min(g.away_score ?? 0, g.home_score ?? 0)}`, severity: (wr ?? 30) - lr });
  }
  upsets.sort((a, b) => b.severity - a.severity);

  const perf = async (col: string, label: string, extra: string) =>
    (await all<Record<string, unknown>>(db, `SELECT s.game_id AS gameId, g.week, s.player_id AS playerId, p.name, t.abbr AS teamAbbr, s.${col} AS value, ${extra} FROM player_game_stats s ${OFFICIAL_JOIN} ?1 JOIN players p ON p.id = s.player_id JOIN teams t ON t.id = s.team_id
      WHERE s.season_id = ?2 AND g.week = (SELECT MAX(g2.week) FROM games g2 WHERE g2.season_id = ?2 AND g2.status = 'final' AND g2.final_at <= ?1) AND s.${col} > 0 ORDER BY s.${col} DESC LIMIT 3`, at, season.id)).map((r) => ({ ...r, label }));
  const topPerformances = [
    ...(await perf('passYds', 'Passing yards', 's.passCmp AS a, s.passAtt AS b, s.passTd AS td')),
    ...(await perf('rushYds', 'Rushing yards', 's.rushAtt AS a, 0 AS b, s.rushTd AS td')),
    ...(await perf('recYds', 'Receiving yards', 's.rec AS a, 0 AS b, s.recTd AS td')),
  ];
  const leader = async (col: string, label: string) => {
    const r = await first<Record<string, unknown>>(db, `SELECT s.player_id AS playerId, p.name, t.abbr AS teamAbbr, SUM(s.${col}) AS value FROM player_game_stats s ${OFFICIAL_JOIN} ?1 JOIN players p ON p.id = s.player_id JOIN teams t ON t.id = s.team_id WHERE s.season_id = ?2 GROUP BY s.player_id, s.team_id HAVING value > 0 ORDER BY value DESC LIMIT 1`, at, season.id);
    return r ? { ...r, label } : null;
  };
  const leaders = (await Promise.all([leader('passYds', 'Passing yards'), leader('rushYds', 'Rushing yards'), leader('recYds', 'Receiving yards'), leader('passTd', 'Passing TDs'), leader('sacks', 'Sacks'), leader('defInt', 'Interceptions')])).filter(Boolean);
  const highlights = await all(db, `SELECT h.game_id AS gameId, h.title, h.text, h.quarter, h.clock, g.mode, g.week FROM highlights h JOIN games g ON g.id = h.game_id AND g.status = 'final' AND g.final_at <= ?1 WHERE g.season_id = ?2 AND h.rank <= 2 ORDER BY g.final_at DESC, h.rank LIMIT 6`, at, season.id);
  const upcoming = await all<GameRow>(db, `SELECT * FROM games WHERE season_id = ?1 AND status = 'scheduled' ORDER BY week, COALESCE(kickoff_at, 9e15) LIMIT 6`, season.id);
  return c.json({
    season: { id: season.id, year: season.year, name: season.name }, week, weeks: ws.weeks, currentWeek: ws.current, rankWeek: rk.week,
    scoreboard, featured, recent: recentPublic, upsets: upsets.slice(0, 4), topPerformances, leaders, highlights,
    upcoming: await publicGames(db, upcoming, teams, rec, rk.map, at),
  });
});
