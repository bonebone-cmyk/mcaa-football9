// D1 access helpers and self-applying schema migrations.
// The Worker migrates its own database on the first request, so a fresh Cloudflare import needs no manual SQL step.
import { emptyPlayerLine, emptyTeamLine } from '../engine/stats';

export type DB = D1Database;

export const PLAYER_STAT_COLS = Object.keys(emptyPlayerLine('', 0)).filter((k) => k !== 'playerId' && k !== 'side');
export const TEAM_STAT_COLS = Object.keys(emptyTeamLine(0)).filter((k) => k !== 'side');

const num = (cols: string[]) => cols.map((c) => `${c} REAL NOT NULL DEFAULT 0`).join(', ');

/** Each entry is one migration: an ordered list of single SQL statements applied in one transaction. Never edit a shipped migration; append a new one. */
export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)`,
    `INSERT INTO roles (id, name) VALUES ('admin', 'Administrator')`,
    `CREATE TABLE users (
       id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
       role_id TEXT NOT NULL REFERENCES roles(id), password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iter INTEGER NOT NULL,
       created_at INTEGER NOT NULL, last_login_at INTEGER)`,
    // Database-level policy: the league has at most four administrator accounts, whatever the application code does.
    `CREATE TRIGGER users_max_four_admins BEFORE INSERT ON users
       WHEN NEW.role_id = 'admin' AND (SELECT COUNT(*) FROM users WHERE role_id = 'admin') >= 4
       BEGIN SELECT RAISE(ABORT, 'MCAA allows exactly four administrator accounts'); END`,
    `CREATE TRIGGER users_role_is_fixed BEFORE UPDATE OF role_id ON users BEGIN SELECT RAISE(ABORT, 'roles cannot be reassigned'); END`,
    `CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL)`,
    `CREATE INDEX login_attempts_email ON login_attempts(email, at)`,

    `CREATE TABLE seasons (id TEXT PRIMARY KEY, year INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 0, weeks INTEGER NOT NULL DEFAULT 14, created_at INTEGER NOT NULL)`,
    `CREATE TABLE conferences (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, abbr TEXT NOT NULL)`,
    `CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, short_name TEXT NOT NULL, abbr TEXT NOT NULL UNIQUE, mascot TEXT,
       primary_color TEXT NOT NULL DEFAULT '#1e3a5f', secondary_color TEXT NOT NULL DEFAULT '#ffffff', logo TEXT, stadium TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE team_seasons (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), season_id TEXT NOT NULL REFERENCES seasons(id), conference_id TEXT REFERENCES conferences(id),
       off_rating REAL NOT NULL DEFAULT 70, def_rating REAL NOT NULL DEFAULT 70, st_rating REAL NOT NULL DEFAULT 70,
       off_scheme TEXT NOT NULL DEFAULT 'Balanced', def_scheme TEXT NOT NULL DEFAULT '4-3', run_pct REAL, tempo TEXT NOT NULL DEFAULT 'normal',
       UNIQUE (team_id, season_id))`,
    `CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE roster_memberships (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), team_id TEXT NOT NULL REFERENCES teams(id), season_id TEXT NOT NULL REFERENCES seasons(id),
       jersey INTEGER, position TEXT NOT NULL, secondary_positions TEXT NOT NULL DEFAULT '[]', depth_rank INTEGER NOT NULL DEFAULT 1, rating REAL, active INTEGER NOT NULL DEFAULT 1, awards TEXT NOT NULL DEFAULT '[]',
       UNIQUE (player_id, season_id))`,
    `CREATE INDEX roster_team_season ON roster_memberships(team_id, season_id)`,
    `CREATE VIEW depth_charts AS SELECT season_id, team_id, position, depth_rank, player_id, id AS roster_membership_id FROM roster_memberships WHERE active = 1`,

    `CREATE TABLE game_statuses (id TEXT PRIMARY KEY, label TEXT NOT NULL)`,
    `INSERT INTO game_statuses (id, label) VALUES ('scheduled','Scheduled'), ('in_progress','In Progress'), ('final','Final'), ('postponed','Postponed'), ('canceled','Canceled')`,
    `CREATE TABLE games (id TEXT PRIMARY KEY, season_id TEXT NOT NULL REFERENCES seasons(id), week INTEGER NOT NULL,
       away_team_id TEXT NOT NULL REFERENCES teams(id), home_team_id TEXT NOT NULL REFERENCES teams(id),
       kickoff_at INTEGER, network TEXT, stadium TEXT, neutral_site INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'scheduled' REFERENCES game_statuses(id), mode TEXT NOT NULL DEFAULT 'sim' CHECK (mode IN ('sim','primetime')),
       designations TEXT NOT NULL DEFAULT '[]', away_score INTEGER, home_score INTEGER, final_at INTEGER, published_run_id TEXT,
       presentation_started_at INTEGER, presentation_ms_per_play INTEGER,
       live_away INTEGER, live_home INTEGER, live_period TEXT, live_clock TEXT,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK (away_team_id <> home_team_id))`,
    `CREATE INDEX games_season_week ON games(season_id, week)`,

    `CREATE TABLE percentage_snapshots (id TEXT PRIMARY KEY, season_id TEXT NOT NULL REFERENCES seasons(id), source TEXT NOT NULL, source_detail TEXT, fetched_at INTEGER NOT NULL, created_by TEXT, checksum TEXT NOT NULL, team_count INTEGER NOT NULL)`,
    `CREATE TABLE percentage_snapshot_entries (snapshot_id TEXT NOT NULL REFERENCES percentage_snapshots(id), team_id TEXT NOT NULL REFERENCES teams(id),
       activity REAL NOT NULL CHECK (activity BETWEEN 0 AND 100), upset REAL NOT NULL CHECK (upset BETWEEN 0 AND 100), star REAL NOT NULL CHECK (star BETWEEN 0 AND 100),
       extra TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, team_id))`,
    `CREATE TRIGGER pct_entries_no_update BEFORE UPDATE ON percentage_snapshot_entries BEGIN SELECT RAISE(ABORT, 'percentage snapshots are immutable'); END`,
    `CREATE TRIGGER pct_entries_no_delete BEFORE DELETE ON percentage_snapshot_entries BEGIN SELECT RAISE(ABORT, 'percentage snapshots are immutable'); END`,

    `CREATE TABLE simulation_configurations (season_id TEXT PRIMARY KEY REFERENCES seasons(id), config TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`,
    `CREATE TABLE simulation_runs (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), mode TEXT NOT NULL CHECK (mode IN ('sim','primetime')), seed TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','approved','rejected','published','superseded')),
       snapshot_id TEXT REFERENCES percentage_snapshots(id), away_score INTEGER NOT NULL, home_score INTEGER NOT NULL, valid INTEGER NOT NULL, result TEXT NOT NULL,
       created_by TEXT, created_at INTEGER NOT NULL, reviewed_by TEXT, reviewed_at INTEGER, review_note TEXT)`,
    `CREATE INDEX runs_game ON simulation_runs(game_id, created_at)`,
    // Simulation records are immutable: only the review status may change after creation.
    `CREATE TRIGGER runs_immutable BEFORE UPDATE OF result, seed, away_score, home_score, snapshot_id, mode, game_id, valid, created_by, created_at ON simulation_runs BEGIN SELECT RAISE(ABORT, 'simulation runs are immutable'); END`,
    `CREATE TRIGGER runs_no_delete BEFORE DELETE ON simulation_runs BEGIN SELECT RAISE(ABORT, 'simulation runs are kept for history'); END`,
    `CREATE TRIGGER runs_approve_requires_valid BEFORE UPDATE OF status ON simulation_runs WHEN NEW.status IN ('approved','published') AND OLD.valid <> 1 BEGIN SELECT RAISE(ABORT, 'a result that failed validation cannot be approved or published'); END`,

    `CREATE TABLE published_results (id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), run_id TEXT NOT NULL UNIQUE REFERENCES simulation_runs(id), version INTEGER NOT NULL,
       away_score INTEGER NOT NULL, home_score INTEGER NOT NULL, published_by TEXT, published_at INTEGER NOT NULL, is_current INTEGER NOT NULL DEFAULT 1, superseded_at INTEGER, reason TEXT,
       UNIQUE (game_id, version))`,
    // A game has at most one current official result, so concurrent publishing cannot create duplicates.
    `CREATE UNIQUE INDEX published_one_current ON published_results(game_id) WHERE is_current = 1`,

    `CREATE TABLE drives (game_id TEXT NOT NULL REFERENCES games(id), run_id TEXT NOT NULL, num INTEGER NOT NULL, team_id TEXT NOT NULL, quarter INTEGER NOT NULL, start_clock INTEGER NOT NULL, start_ball_on INTEGER NOT NULL,
       plays INTEGER NOT NULL, yards INTEGER NOT NULL, seconds INTEGER NOT NULL, result TEXT NOT NULL, points INTEGER NOT NULL, PRIMARY KEY (game_id, num))`,
    `CREATE TABLE play_events (game_id TEXT NOT NULL REFERENCES games(id), run_id TEXT NOT NULL, seq INTEGER NOT NULL, drive INTEGER NOT NULL, quarter INTEGER NOT NULL, clock INTEGER NOT NULL,
       offense_team_id TEXT NOT NULL, down INTEGER, distance INTEGER, ball_on INTEGER NOT NULL, type TEXT NOT NULL, yards INTEGER NOT NULL, result TEXT NOT NULL, description TEXT NOT NULL,
       away_score INTEGER NOT NULL, home_score INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (game_id, seq))`,
    `CREATE TABLE scoring_events (game_id TEXT NOT NULL REFERENCES games(id), run_id TEXT NOT NULL, play_seq INTEGER NOT NULL, quarter INTEGER NOT NULL, clock INTEGER NOT NULL, team_id TEXT NOT NULL,
       kind TEXT NOT NULL, pts INTEGER NOT NULL, player_id TEXT REFERENCES players(id), description TEXT NOT NULL, away_score INTEGER NOT NULL, home_score INTEGER NOT NULL, PRIMARY KEY (game_id, play_seq))`,
    `CREATE TABLE player_game_stats (game_id TEXT NOT NULL REFERENCES games(id), run_id TEXT NOT NULL, season_id TEXT NOT NULL, team_id TEXT NOT NULL REFERENCES teams(id), player_id TEXT NOT NULL REFERENCES players(id),
       locked_fields TEXT NOT NULL DEFAULT '[]', ${num(PLAYER_STAT_COLS)}, PRIMARY KEY (game_id, player_id))`,
    `CREATE INDEX pgs_player ON player_game_stats(player_id)`,
    `CREATE INDEX pgs_season ON player_game_stats(season_id, team_id)`,
    `CREATE TABLE team_game_stats (game_id TEXT NOT NULL REFERENCES games(id), run_id TEXT NOT NULL, season_id TEXT NOT NULL, team_id TEXT NOT NULL REFERENCES teams(id), opponent_id TEXT NOT NULL, is_home INTEGER NOT NULL,
       ${num(TEAM_STAT_COLS)}, PRIMARY KEY (game_id, team_id))`,
    `CREATE TABLE highlights (game_id TEXT NOT NULL REFERENCES games(id), run_id TEXT NOT NULL, play_seq INTEGER NOT NULL, quarter INTEGER NOT NULL, clock INTEGER NOT NULL, team_id TEXT NOT NULL,
       title TEXT NOT NULL, text TEXT NOT NULL, rank INTEGER NOT NULL, tags TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (game_id, play_seq),
       FOREIGN KEY (game_id, play_seq) REFERENCES play_events(game_id, seq) DEFERRABLE INITIALLY DEFERRED)`,

    `CREATE TABLE rankings (id TEXT PRIMARY KEY, season_id TEXT NOT NULL REFERENCES seasons(id), week INTEGER NOT NULL, poll TEXT NOT NULL DEFAULT 'AP', rank INTEGER NOT NULL, team_id TEXT NOT NULL REFERENCES teams(id),
       created_by TEXT, created_at INTEGER NOT NULL, UNIQUE (season_id, week, poll, rank), UNIQUE (season_id, week, poll, team_id))`,
    `CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id TEXT, admin_name TEXT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, game_id TEXT,
       previous_value TEXT, new_value TEXT, reason TEXT, created_at INTEGER NOT NULL)`,
    `CREATE INDEX audit_created ON audit_logs(created_at)`,
    `CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END`,
    `CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END`,
    `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    // Guard table: inserting NULL aborts the surrounding transaction. Used to make multi-statement publishes conditional.
    `CREATE TABLE _assert (ok INTEGER NOT NULL CHECK (ok = 1))`,
  ],
  // 2: team percentages live in D1 and are edited by administrators; there is no external percentage API.
  [
    `CREATE TABLE team_percentages (season_id TEXT NOT NULL REFERENCES seasons(id), team_id TEXT NOT NULL REFERENCES teams(id),
       activity REAL NOT NULL CHECK (activity BETWEEN 0 AND 100), upset REAL NOT NULL CHECK (upset BETWEEN 0 AND 100), star REAL NOT NULL CHECK (star BETWEEN 0 AND 100),
       extra TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, updated_by TEXT, updated_by_name TEXT, PRIMARY KEY (season_id, team_id))`,
    // Carry over the most recent snapshot of each season so existing leagues keep their values.
    `INSERT INTO team_percentages (season_id, team_id, activity, upset, star, extra, updated_at, updated_by, updated_by_name)
       SELECT s.season_id, e.team_id, e.activity, e.upset, e.star, e.extra, s.fetched_at, s.created_by, 'imported snapshot'
       FROM percentage_snapshots s JOIN percentage_snapshot_entries e ON e.snapshot_id = s.id
       WHERE s.id = (SELECT s2.id FROM percentage_snapshots s2 WHERE s2.season_id = s.season_id ORDER BY s2.fetched_at DESC, s2.id LIMIT 1)`,
    `DELETE FROM settings WHERE key = 'percentage_api_url'`,
  ],
  // 3: shared "Code" login. It signs in to one built-in account with its own role, so it does not take one of the
  // four named administrator slots. The account has no usable password; it can only be reached through /auth/code.
  [
    `INSERT INTO roles (id, name) VALUES ('code_admin', 'Administrator (access code)')`,
    `INSERT INTO users (id, email, name, role_id, password_hash, password_salt, password_iter, created_at)
       VALUES ('code-admin', 'code-access@mcaa.invalid', 'Code login', 'code_admin', '!', '!', 1, ${Date.UTC(2026, 10, 18)})`,
    `ALTER TABLE sessions ADD COLUMN display_name TEXT`,
  ],
];

let ready: Promise<void> | null = null;
let readyFor: DB | null = null;

export function ensureSchema(db: DB): Promise<void> {
  if (ready && readyFor === db) return ready;
  readyFor = db;
  ready = migrate(db).catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

export async function migrate(db: DB): Promise<void> {
  await db.prepare('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
  const row = await db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM _migrations').first<{ v: number }>();
  const have = row?.v ?? 0;
  for (let i = have; i < MIGRATIONS.length; i++) {
    const stmts = MIGRATIONS[i].map((sql) => db.prepare(sql));
    stmts.push(db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?1, ?2)').bind(i + 1, Date.now()));
    try {
      await db.batch(stmts);
    } catch (e) {
      // Another request may have applied the same migration concurrently.
      const again = await db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM _migrations').first<{ v: number }>();
      if ((again?.v ?? 0) < i + 1) throw e;
    }
  }
}

export async function all<T = Record<string, unknown>>(db: DB, sql: string, ...params: unknown[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}
export async function first<T = Record<string, unknown>>(db: DB, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}
export function stmt(db: DB, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}
/** Bulk insert in a single statement: rows travel as one JSON parameter and are expanded with json_each. */
export function insertRows(db: DB, table: string, cols: string[], rows: Record<string, unknown>[]): D1PreparedStatement {
  const sel = cols.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  return db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${sel} FROM json_each(?1)`).bind(JSON.stringify(rows));
}
/** Aborts the enclosing batch unless the scalar sub-query is true. */
export function assertStmt(db: DB, condition: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO _assert (ok) SELECT CASE WHEN (${condition}) THEN 1 END`).bind(...params);
}
export const clearAssert = (db: DB) => db.prepare('DELETE FROM _assert');
export const uid = () => crypto.randomUUID();
export const now = () => Date.now();
export const j = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
