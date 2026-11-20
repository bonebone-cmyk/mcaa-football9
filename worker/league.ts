// League data access shared by public and admin routes. Records and season statistics are always
// aggregated from officially published games; nothing is incremented by hand, so nothing can be double-counted.
import { DEFAULT_CONFIG, POSITIONS, type Position, type RosterPlayer, type SimConfig, type TeamInput } from '../engine/types';
import { HttpError } from './auth';
import { all, first, j, type DB } from './db';

export interface SeasonRow { id: string; year: number; name: string; is_current: number; weeks: number }
export interface GameRow {
  id: string; season_id: string; week: number; away_team_id: string; home_team_id: string; kickoff_at: number | null; network: string | null; stadium: string | null;
  neutral_site: number; status: string; mode: 'sim' | 'primetime'; designations: string; away_score: number | null; home_score: number | null; final_at: number | null;
  published_run_id: string | null; presentation_started_at: number | null; presentation_ms_per_play: number | null;
  live_away: number | null; live_home: number | null; live_period: string | null; live_clock: string | null; created_at: number; updated_at: number;
}
export interface TeamRow {
  id: string; name: string; short_name: string; abbr: string; mascot: string | null; primary_color: string; secondary_color: string; has_logo: number; stadium: string | null;
  conference_id: string | null; conference_name: string | null; conference_abbr: string | null;
  off_rating: number | null; def_rating: number | null; st_rating: number | null; off_scheme: string | null; def_scheme: string | null; run_pct: number | null; tempo: string | null; in_season: number;
}

export async function getSeason(db: DB, idOrYear?: string | null): Promise<SeasonRow> {
  let s: SeasonRow | null = null;
  if (idOrYear) s = await first<SeasonRow>(db, 'SELECT * FROM seasons WHERE id = ?1 OR CAST(year AS TEXT) = ?1', idOrYear);
  else s = await first<SeasonRow>(db, 'SELECT * FROM seasons ORDER BY is_current DESC, year DESC LIMIT 1');
  if (!s) throw new HttpError(404, idOrYear ? 'Season not found.' : 'No season has been created yet.', { code: 'NO_SEASON' });
  return s;
}

export async function teamsForSeason(db: DB, seasonId: string, onlyInSeason = false): Promise<TeamRow[]> {
  return all<TeamRow>(db, `SELECT t.id, t.name, t.short_name, t.abbr, t.mascot, t.primary_color, t.secondary_color, (t.logo IS NOT NULL) AS has_logo, t.stadium,
      ts.conference_id, c.name AS conference_name, c.abbr AS conference_abbr, ts.off_rating, ts.def_rating, ts.st_rating, ts.off_scheme, ts.def_scheme, ts.run_pct, ts.tempo, (ts.id IS NOT NULL) AS in_season
    FROM teams t LEFT JOIN team_seasons ts ON ts.team_id = t.id AND ts.season_id = ?1 LEFT JOIN conferences c ON c.id = ts.conference_id
    ${onlyInSeason ? 'WHERE ts.id IS NOT NULL' : ''} ORDER BY t.name`, seasonId);
}

export interface TeamRecord { w: number; l: number; cw: number; cl: number; pf: number; pa: number; streak: string; games: { opp: string; won: boolean; conf: boolean; pf: number; pa: number }[] }
const emptyRecord = (): TeamRecord => ({ w: 0, l: 0, cw: 0, cl: 0, pf: 0, pa: 0, streak: '', games: [] });

/** Only games that are final AND public (any replay has finished) count. */
export const OFFICIAL = `g.status = 'final' AND g.published_run_id IS NOT NULL AND g.final_at <= ?`;

export async function records(db: DB, seasonId: string, at: number, teams?: TeamRow[]): Promise<Map<string, TeamRecord>> {
  const ts = teams ?? (await teamsForSeason(db, seasonId));
  const conf = new Map(ts.map((t) => [t.id, t.conference_id]));
  const games = await all<GameRow>(db, `SELECT g.* FROM games g WHERE g.season_id = ?1 AND g.status = 'final' AND g.published_run_id IS NOT NULL AND g.final_at <= ?2 ORDER BY g.week, g.kickoff_at`, seasonId, at);
  const rec = new Map<string, TeamRecord>();
  const get = (id: string) => rec.get(id) ?? rec.set(id, emptyRecord()).get(id)!;
  for (const g of games) {
    const a = get(g.away_team_id), h = get(g.home_team_id);
    const as = g.away_score ?? 0, hs = g.home_score ?? 0;
    const sameConf = !!conf.get(g.away_team_id) && conf.get(g.away_team_id) === conf.get(g.home_team_id) && !j<string[]>(g.designations, []).some((d) => d === 'playoff' || d === 'bowl');
    const apply = (r: TeamRecord, pf: number, pa: number, opp: string) => {
      const won = pf > pa;
      r.pf += pf; r.pa += pa;
      if (won) r.w++; else r.l++;
      if (sameConf) won ? r.cw++ : r.cl++;
      r.games.push({ opp, won, conf: sameConf, pf, pa });
      const ch = won ? 'W' : 'L';
      r.streak = r.streak.startsWith(ch) ? `${ch}${Number(r.streak.slice(1)) + 1}` : `${ch}1`;
    };
    apply(a, as, hs, g.home_team_id);
    apply(h, hs, as, g.away_team_id);
  }
  return rec;
}

export async function ranks(db: DB, seasonId: string, week?: number | null): Promise<{ week: number | null; map: Map<string, number> }> {
  const w = await first<{ week: number }>(db, `SELECT MAX(week) AS week FROM rankings WHERE season_id = ?1 AND poll = 'AP' ${week != null ? 'AND week <= ?2' : ''}`, ...(week != null ? [seasonId, week] : [seasonId]));
  if (w?.week == null) return { week: null, map: new Map() };
  const rows = await all<{ team_id: string; rank: number }>(db, "SELECT team_id, rank FROM rankings WHERE season_id = ?1 AND poll = 'AP' AND week = ?2", seasonId, w.week);
  return { week: w.week, map: new Map(rows.map((r) => [r.team_id, r.rank])) };
}

export async function simConfig(db: DB, seasonId: string): Promise<SimConfig> {
  const row = await first<{ config: string }>(db, 'SELECT config FROM simulation_configurations WHERE season_id = ?1', seasonId);
  return { ...DEFAULT_CONFIG, ...j<Partial<SimConfig>>(row?.config, {}) };
}

export interface RosterRow { id: string; player_id: string; name: string; team_id: string; season_id: string; jersey: number | null; position: string; secondary_positions: string; depth_rank: number; rating: number | null; active: number; awards: string }

export async function roster(db: DB, seasonId: string, teamId: string): Promise<RosterRow[]> {
  return all<RosterRow>(db, 'SELECT rm.*, p.name FROM roster_memberships rm JOIN players p ON p.id = rm.player_id WHERE rm.season_id = ?1 AND rm.team_id = ?2 ORDER BY rm.position, rm.depth_rank, p.name', seasonId, teamId);
}

export function toRosterPlayers(rows: RosterRow[]): RosterPlayer[] {
  return rows.map((r) => ({
    id: r.player_id, name: r.name, jersey: r.jersey, position: r.position as Position,
    secondary: j<string[]>(r.secondary_positions, []).filter((p) => (POSITIONS as readonly string[]).includes(p)) as Position[],
    depth: r.depth_rank, rating: r.rating, active: !!r.active,
  }));
}

export async function teamInput(db: DB, seasonId: string, teamId: string, pct: { activity: number; upset: number; star: number } | null, rec?: TeamRecord): Promise<TeamInput> {
  const t = await first<TeamRow>(db, `SELECT t.id, t.name, t.short_name, t.abbr, ts.off_rating, ts.def_rating, ts.st_rating, ts.off_scheme, ts.def_scheme, ts.run_pct, ts.tempo, (ts.id IS NOT NULL) AS in_season
    FROM teams t LEFT JOIN team_seasons ts ON ts.team_id = t.id AND ts.season_id = ?1 WHERE t.id = ?2`, seasonId, teamId);
  if (!t) throw new HttpError(404, 'Team not found.');
  if (!t.in_season) throw new HttpError(422, `${t.name} is not entered in this season. Add the team to the season in Team Manager.`);
  return {
    id: t.id, name: t.name, abbr: t.abbr, offRating: t.off_rating ?? 70, defRating: t.def_rating ?? 70, stRating: t.st_rating ?? 70,
    offScheme: (t.off_scheme ?? 'Balanced') as TeamInput['offScheme'], defScheme: (t.def_scheme ?? '4-3') as TeamInput['defScheme'],
    runPct: t.run_pct, tempo: (t.tempo ?? 'normal') as TeamInput['tempo'],
    roster: toRosterPlayers(await roster(db, seasonId, teamId)),
    // Percentages are never defaulted: a missing value stays invalid and the engine refuses to simulate.
    pct: pct ?? { activity: NaN, upset: NaN, star: NaN },
    record: rec ? { w: rec.w, l: rec.l } : undefined,
  };
}

export const recordText = (r?: TeamRecord) => (r ? `${r.w}-${r.l}` : '0-0');

export interface PublicTeamRef { id: string; name: string; short: string; abbr: string; color: string; color2: string; logo: string | null; rank: number | null; record: string; confRecord: string; score: number | null }
export interface PublicGame {
  id: string; seasonId: string; week: number; status: string; mode: string; kickoffAt: number | null; network: string | null; stadium: string | null; neutralSite: boolean;
  designations: string[]; away: PublicTeamRef; home: PublicTeamRef; period: string | null; clock: string | null; replay: boolean; manualLive: boolean; hasResult: boolean;
}

export const logoUrl = (t: { id: string; has_logo?: number }) => (t.has_logo ? `/api/teams/${t.id}/logo` : null);

/** Shape a schedule row for public display. A published game whose replay is still running is shown as in progress, never as final. */
export async function publicGames(db: DB, games: GameRow[], teams: TeamRow[], rec: Map<string, TeamRecord>, rk: Map<string, number>, at: number): Promise<PublicGame[]> {
  const tm = new Map(teams.map((t) => [t.id, t]));
  const out: PublicGame[] = [];
  for (const g of games) {
    const ref = (id: string, score: number | null): PublicTeamRef => {
      const t = tm.get(id);
      const r = rec.get(id);
      return { id, name: t?.name ?? 'Unknown', short: t?.short_name ?? '?', abbr: t?.abbr ?? '?', color: t?.primary_color ?? '#334155', color2: t?.secondary_color ?? '#fff', logo: t ? logoUrl(t) : null, rank: rk.get(id) ?? null, record: recordText(r), confRecord: r ? `${r.cw}-${r.cl}` : '0-0', score };
    };
    let status = g.status;
    let as = g.away_score, hs = g.home_score, period: string | null = null, clock: string | null = null, replay = false, manualLive = false;
    if (g.status === 'final' && g.final_at != null && g.final_at > at) {
      // Replay of a completed simulation: reveal only what has been "shown" so far.
      replay = true;
      status = 'in_progress';
      const idx = Math.max(1, Math.floor((at - (g.presentation_started_at ?? at)) / (g.presentation_ms_per_play || 1000)) + 1);
      const p = await first<{ quarter: number; clock: number; away_score: number; home_score: number }>(db, 'SELECT quarter, clock, away_score, home_score FROM play_events WHERE game_id = ?1 AND seq <= ?2 ORDER BY seq DESC LIMIT 1', g.id, idx);
      as = p?.away_score ?? 0; hs = p?.home_score ?? 0;
      period = p ? (p.quarter <= 4 ? `Q${p.quarter}` : p.quarter === 5 ? 'OT' : `${p.quarter - 4}OT`) : 'Q1';
      clock = p && p.quarter <= 4 ? `${Math.floor(p.clock / 60)}:${String(p.clock % 60).padStart(2, '0')}` : null;
    } else if (g.status === 'in_progress') {
      manualLive = true;
      as = g.live_away; hs = g.live_home; period = g.live_period; clock = g.live_clock;
    } else if (g.status !== 'final') (as = null), (hs = null);
    out.push({
      id: g.id, seasonId: g.season_id, week: g.week, status, mode: g.mode, kickoffAt: g.kickoff_at, network: g.network, stadium: g.stadium ?? tm.get(g.home_team_id)?.stadium ?? null, neutralSite: !!g.neutral_site,
      designations: j<string[]>(g.designations, []), away: ref(g.away_team_id, as), home: ref(g.home_team_id, hs), period, clock, replay, manualLive, hasResult: g.status === 'final' && !replay,
    });
  }
  return out;
}
