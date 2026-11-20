// Publishing: the only code path that makes a result official. Everything happens in one D1 transaction
// (db.batch), guarded so that concurrent or repeated publishes cannot duplicate or double-count a game.
import { playResult } from '../engine/describe';
import type { GameResult } from '../engine/types';
import { HttpError, auditStmt, type AdminUser } from './auth';
import { PLAYER_STAT_COLS, TEAM_STAT_COLS, assertStmt, clearAssert, first, insertRows, j, now, stmt, uid, type DB } from './db';
import type { GameRow } from './league';

interface RunRow { id: string; game_id: string; mode: 'sim' | 'primetime'; status: string; valid: number; away_score: number; home_score: number; result: string }

const MATERIALIZED = ['highlights', 'scoring_events', 'player_game_stats', 'team_game_stats', 'drives', 'play_events'];

function materialize(db: DB, game: GameRow, runId: string, r: GameResult): D1PreparedStatement[] {
  const tid = [game.away_team_id, game.home_team_id];
  const base = { game_id: game.id, run_id: runId };
  const locked = r.primetime?.locks?.players ?? {};
  const out: D1PreparedStatement[] = [];
  out.push(insertRows(db, 'play_events', ['game_id', 'run_id', 'seq', 'drive', 'quarter', 'clock', 'offense_team_id', 'down', 'distance', 'ball_on', 'type', 'yards', 'result', 'description', 'away_score', 'home_score', 'data'],
    r.plays.map((p) => ({ ...base, seq: p.seq, drive: p.drive, quarter: p.quarter, clock: p.clock, offense_team_id: tid[p.offense], down: p.down, distance: p.distance, ball_on: p.ballOn, type: p.type, yards: p.yards, result: playResult(p), description: p.desc, away_score: p.scoreAfter[0], home_score: p.scoreAfter[1], data: p }))));
  out.push(insertRows(db, 'drives', ['game_id', 'run_id', 'num', 'team_id', 'quarter', 'start_clock', 'start_ball_on', 'plays', 'yards', 'seconds', 'result', 'points'],
    r.drives.map((d) => ({ ...base, num: d.num, team_id: tid[d.side], quarter: d.quarter, start_clock: d.startClock, start_ball_on: d.startBallOn, plays: d.plays, yards: d.yards, seconds: d.seconds, result: d.result, points: d.points }))));
  out.push(insertRows(db, 'scoring_events', ['game_id', 'run_id', 'play_seq', 'quarter', 'clock', 'team_id', 'kind', 'pts', 'player_id', 'description', 'away_score', 'home_score'],
    r.scoring.map((s) => ({ ...base, play_seq: s.playSeq, quarter: s.quarter, clock: s.clock, team_id: tid[s.side], kind: s.kind, pts: s.pts, player_id: s.playerId, description: s.desc, away_score: s.score[0], home_score: s.score[1] }))));
  out.push(insertRows(db, 'player_game_stats', ['game_id', 'run_id', 'season_id', 'team_id', 'player_id', 'locked_fields', ...PLAYER_STAT_COLS],
    r.playerStats.map((l) => ({ ...base, season_id: game.season_id, team_id: tid[l.side], player_id: l.playerId, locked_fields: Object.keys(locked[l.playerId] ?? {}), ...Object.fromEntries(PLAYER_STAT_COLS.map((c) => [c, (l as unknown as Record<string, number>)[c] ?? 0])) }))));
  out.push(insertRows(db, 'team_game_stats', ['game_id', 'run_id', 'season_id', 'team_id', 'opponent_id', 'is_home', ...TEAM_STAT_COLS],
    r.teamStats.map((t) => ({ ...base, season_id: game.season_id, team_id: tid[t.side], opponent_id: tid[1 - t.side], is_home: t.side, ...Object.fromEntries(TEAM_STAT_COLS.map((c) => [c, (t as unknown as Record<string, number>)[c] ?? 0])) }))));
  out.push(insertRows(db, 'highlights', ['game_id', 'run_id', 'play_seq', 'quarter', 'clock', 'team_id', 'title', 'text', 'rank', 'tags'],
    r.highlights.map((h) => ({ ...base, play_seq: h.playSeq, quarter: h.quarter, clock: h.clock, team_id: tid[h.side], title: h.title, text: h.text, rank: h.rank, tags: h.tags }))));
  return out;
}

export interface PublishOptions {
  /** Milliseconds per play for a replay-style presentation. Omit for an instant result. */
  presentationMsPerPlay?: number | null;
  /** Required to replace a result that is already official. */
  confirm?: boolean;
  reason?: string | null;
}

export async function publishRun(db: DB, admin: AdminUser, runId: string, opts: PublishOptions = {}): Promise<{ version: number; finalAt: number; correction: boolean }> {
  const run = await first<RunRow>(db, 'SELECT id, game_id, mode, status, valid, away_score, home_score, result FROM simulation_runs WHERE id = ?1', runId);
  if (!run) throw new HttpError(404, 'Result not found.');
  if (run.status === 'published') throw new HttpError(409, 'This result is already published.');
  if (run.status !== 'approved') throw new HttpError(409, `Only an approved result can be published (this one is "${run.status}"). Approve it in Results Review first.`);
  if (!run.valid) throw new HttpError(422, 'This result failed validation and cannot be published.');
  const game = (await first<GameRow>(db, 'SELECT * FROM games WHERE id = ?1', run.game_id))!;
  if (game.status === 'canceled') throw new HttpError(409, 'A canceled game cannot receive a result.');
  const current = await first<{ id: string; run_id: string; version: number; away_score: number; home_score: number }>(db, 'SELECT * FROM published_results WHERE game_id = ?1 AND is_current = 1', game.id);
  const correction = !!current;
  if (correction) {
    if (!opts.confirm) throw new HttpError(409, `This game already has an official result (${current!.away_score}-${current!.home_score}). Publishing will replace it. Confirm the correction and give a reason.`, { code: 'CONFIRM_REQUIRED', current: { away: current!.away_score, home: current!.home_score, version: current!.version } });
    if (!opts.reason?.trim()) throw new HttpError(422, 'A reason is required when correcting an official result.');
  }
  const result = j<GameResult | null>(run.result, null);
  if (!result) throw new HttpError(500, 'Stored result is unreadable.');
  const t = now();
  const ms = run.mode === 'sim' && opts.presentationMsPerPlay ? Math.max(250, Math.min(60_000, Math.round(opts.presentationMsPerPlay))) : null;
  const finalAt = ms ? t + ms * result.plays.length : t;
  const version = (current?.version ?? ((await first<{ v: number }>(db, 'SELECT COALESCE(MAX(version), 0) AS v FROM published_results WHERE game_id = ?1', game.id))?.v ?? 0)) + 1;
  const designations = j<string[]>(game.designations, []);
  if (run.mode === 'primetime' && !designations.includes('primetime')) designations.push('primetime');

  await db.batch([
    // Guards: abort the whole transaction if another request already published this run or changed the official result.
    assertStmt(db, "(SELECT status FROM simulation_runs WHERE id = ?1) = 'approved'", run.id),
    assertStmt(db, 'COALESCE((SELECT run_id FROM published_results WHERE game_id = ?1 AND is_current = 1), \'\') = ?2', game.id, current?.run_id ?? ''),
    clearAssert(db),
    ...MATERIALIZED.map((tbl) => stmt(db, `DELETE FROM ${tbl} WHERE game_id = ?1`, game.id)),
    stmt(db, 'UPDATE published_results SET is_current = 0, superseded_at = ?1 WHERE game_id = ?2 AND is_current = 1', t, game.id),
    stmt(db, "UPDATE simulation_runs SET status = 'superseded' WHERE game_id = ?1 AND status = 'published'", game.id),
    stmt(db, "UPDATE simulation_runs SET status = 'published' WHERE id = ?1", run.id),
    stmt(db, 'INSERT INTO published_results (id, game_id, run_id, version, away_score, home_score, published_by, published_at, is_current, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)', uid(), game.id, run.id, version, run.away_score, run.home_score, admin.id, t, opts.reason ?? null),
    ...materialize(db, game, run.id, result),
    stmt(db, `UPDATE games SET status = 'final', mode = ?1, away_score = ?2, home_score = ?3, final_at = ?4, published_run_id = ?5, presentation_started_at = ?6, presentation_ms_per_play = ?7,
      designations = ?8, live_away = NULL, live_home = NULL, live_period = NULL, live_clock = NULL, updated_at = ?9 WHERE id = ?10`,
      run.mode, run.away_score, run.home_score, finalAt, run.id, ms ? t : null, ms, JSON.stringify(designations), t, game.id),
    auditStmt(db, admin, {
      action: correction ? 'result_corrected' : 'result_published', entity: 'game', entityId: game.id, gameId: game.id,
      previous: correction ? { away: current!.away_score, home: current!.home_score, runId: current!.run_id, version: current!.version } : null,
      next: { away: run.away_score, home: run.home_score, runId: run.id, version, mode: run.mode, presentation: !!ms }, reason: opts.reason ?? null,
    }),
  ]);
  return { version, finalAt, correction };
}

/** Withdraw an official result. The historical version and its immutable run are kept; team records and statistics simply stop counting it. */
export async function unpublishGame(db: DB, admin: AdminUser, gameId: string, reason: string): Promise<void> {
  const current = await first<{ run_id: string; version: number; away_score: number; home_score: number }>(db, 'SELECT * FROM published_results WHERE game_id = ?1 AND is_current = 1', gameId);
  if (!current) throw new HttpError(409, 'This game has no official result to withdraw.');
  if (!reason.trim()) throw new HttpError(422, 'A reason is required to withdraw an official result.');
  const t = now();
  await db.batch([
    assertStmt(db, '(SELECT run_id FROM published_results WHERE game_id = ?1 AND is_current = 1) = ?2', gameId, current.run_id),
    clearAssert(db),
    ...MATERIALIZED.map((tbl) => stmt(db, `DELETE FROM ${tbl} WHERE game_id = ?1`, gameId)),
    stmt(db, 'UPDATE published_results SET is_current = 0, superseded_at = ?1 WHERE game_id = ?2 AND is_current = 1', t, gameId),
    stmt(db, "UPDATE simulation_runs SET status = 'superseded' WHERE id = ?1", current.run_id),
    stmt(db, "UPDATE games SET status = 'scheduled', away_score = NULL, home_score = NULL, final_at = NULL, published_run_id = NULL, presentation_started_at = NULL, presentation_ms_per_play = NULL, updated_at = ?1 WHERE id = ?2", t, gameId),
    auditStmt(db, admin, { action: 'result_withdrawn', entity: 'game', entityId: gameId, gameId, previous: { away: current.away_score, home: current.home_score, runId: current.run_id, version: current.version }, next: null, reason }),
  ]);
}
