import { getPlatformProxy } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../worker/db';

// A league created before percentages moved into D1 must keep its values after upgrading.
describe('migration 2: team percentages stored in D1', () => {
  let db: D1Database, dispose: () => Promise<void>;
  beforeAll(async () => {
    const p = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
    db = p.env.DB; dispose = p.dispose;
    // Build the database exactly as the first release left it.
    await db.prepare('CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
    await db.batch([...MIGRATIONS[0].map((sql) => db.prepare(sql)), db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (1, 1)')]);
    await db.batch([
      db.prepare("INSERT INTO seasons (id, year, name, created_at) VALUES ('s1', 2026, 'S', 1)"),
      db.prepare("INSERT INTO teams (id, name, short_name, abbr, created_at) VALUES ('t1', 'One', 'One', 'ONE', 1), ('t2', 'Two', 'Two', 'TWO', 1)"),
      db.prepare("INSERT INTO percentage_snapshots (id, season_id, source, fetched_at, checksum, team_count) VALUES ('old', 's1', 'csv', 100, 'x', 2), ('new', 's1', 'api', 200, 'y', 1)"),
      db.prepare(`INSERT INTO percentage_snapshot_entries (snapshot_id, team_id, activity, upset, star, extra) VALUES
        ('old', 't1', 10, 20, 30, '{}'), ('old', 't2', 40, 50, 60, '{}'), ('new', 't1', 70, 80, 90, '{"morale":5}')`),
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('percentage_api_url', 'https://example.invalid', 1)"),
    ]);
  });
  afterAll(async () => dispose());

  it('copies the latest snapshot of each season into team_percentages and drops the API setting', async () => {
    await migrate(db);
    const rows = (await db.prepare('SELECT team_id, activity, upset, star, extra FROM team_percentages ORDER BY team_id').all()).results;
    expect(rows).toEqual([{ team_id: 't1', activity: 70, upset: 80, star: 90, extra: '{"morale":5}' }]);
    expect(await db.prepare("SELECT 1 FROM settings WHERE key = 'percentage_api_url'").first()).toBeNull();
    expect((await db.prepare('SELECT MAX(id) AS v FROM _migrations').first<{ v: number }>())!.v).toBe(MIGRATIONS.length);
    await migrate(db); // idempotent
  });
});
