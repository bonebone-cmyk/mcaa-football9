import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../worker/auth';
import { Client, SETUP_TOKEN, addGame, createAdmin, login, makeEnv, playGame, seedLeague } from './helpers';

let env: Env, dispose: () => Promise<void>, admin: Client, pub: Client;
let L: Awaited<ReturnType<typeof seedLeague>>;
/** Overall records as the public site reports them: abbr -> { games, wins, pf, pa }. */
const recordsNow = async () => {
  const out: Record<string, { games: number; wins: number; pf: number; pa: number }> = {};
  for (const t of (await pub.get('/teams')).json.teams) {
    const [w, l] = String(t.record).split('-').map(Number);
    const d = (await pub.get(`/teams/${t.id}`)).json.team;
    out[t.abbr] = { games: w + l, wins: w, pf: d.pf, pa: d.pa };
  }
  return out;
};

beforeAll(async () => {
  ({ env, dispose } = await makeEnv());
  pub = new Client(env);
});
afterAll(async () => dispose());

describe('authentication and the four-administrator rule', () => {
  it('rejects public access to admin endpoints', async () => {
    for (const p of ['/admin/summary', '/admin/games', '/admin/audit', '/admin/teams', '/admin/percentages', '/admin/review']) expect((await pub.get(p)).status).toBe(401);
    expect((await pub.post('/admin/seasons', { year: 2030, name: 'x' })).status).toBe(401);
    expect((await pub.post('/admin/games/abc/simulate', {})).status).toBe(401);
    expect((await pub.post('/admin/runs/abc/publish', {})).status).toBe(401);
  });
  it('has no public registration path and requires the setup token to create administrators', async () => {
    expect((await pub.post('/auth/register', { email: 'x@y.z', password: 'whatever12345' })).status).toBe(404);
    expect((await pub.post('/setup/admins', { email: 'evil@x.test', name: 'Evil', password: 'longenoughpassword' })).status).toBe(401);
    expect((await pub.post('/setup/admins', { email: 'evil@x.test', name: 'Evil', password: 'longenoughpassword' }, { Authorization: 'Bearer wrong-token-000000000' })).status).toBe(401);
    const noToken = new Client({ ...env, SETUP_TOKEN: undefined } as Env);
    expect((await noToken.post('/setup/admins', { email: 'a@b.test', name: 'A', password: 'longenoughpassword' }, { Authorization: 'Bearer anything' })).status).toBe(503);
  });
  it('allows exactly four administrators', async () => {
    for (let n = 1; n <= 4; n++) expect((await createAdmin(env, n)).res.status).toBe(201);
    const fifth = await createAdmin(env, 5);
    expect(fifth.res.status).toBe(409);
    // The database enforces the same cap even if application code is bypassed.
    await expect(env.DB.prepare("INSERT INTO users (id, email, name, role_id, password_hash, password_salt, password_iter, created_at) VALUES ('x', 'direct@db.test', 'Direct', 'admin', 'h', 's', 1, 1)").run()).rejects.toThrow(/four administrator/);
    expect((await pub.get('/setup/status')).json).toMatchObject({ adminCount: 4, maxAdmins: 4 });
  });
  it('signs administrators in, rejects bad passwords and cross-site writes', async () => {
    expect((await pub.post('/auth/login', { email: 'admin1@mcaa.test', password: 'wrong-password' })).status).toBe(401);
    admin = await login(env, 1);
    expect((await admin.get('/auth/me')).json.admin.email).toBe('admin1@mcaa.test');
    expect((await admin.get('/admin/summary')).status).toBe(200);
    // Missing CSRF header or foreign origin.
    expect((await admin.req('POST', '/admin/seasons', { year: 2031, name: 'x' }, { 'X-MCAA-Request': '' })).status).toBe(403);
    expect((await admin.req('POST', '/admin/seasons', { year: 2031, name: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403);
    // All four administrators have the same privileges.
    for (let n = 2; n <= 4; n++) expect((await (await login(env, n)).get('/admin/summary')).status).toBe(200);
  });
  it('invalidates the session on logout', async () => {
    const c = await login(env, 2);
    await c.post('/auth/logout');
    expect((await c.get('/admin/summary')).status).toBe(401);
  });
});

describe('access-code login', () => {
  it('signs in as an administrator with the code DIDYDOLLAR and rejects anything else', async () => {
    const c = new Client(env);
    expect((await c.post('/auth/code', { code: 'didydollar' })).status).toBe(401); // case-sensitive
    expect((await c.post('/auth/code', { code: 'wrong' })).status).toBe(401);
    expect((await c.get('/admin/summary')).status).toBe(401);
    const ok = await c.post('/auth/code', { code: 'DIDYDOLLAR', name: 'Sam' });
    expect(ok.status).toBe(200);
    expect(ok.json.admin.name).toBe('Sam (code)');
    expect((await c.get('/admin/summary')).status).toBe(200);
    expect((await c.post('/admin/conferences', { name: 'Code Conf', abbr: 'CC' })).status).toBe(201);
    const audit = (await c.get('/admin/audit')).json.entries.find((e: any) => e.action === 'conference_created');
    expect(audit.admin_name).toBe('Sam (code)');
    expect((await c.post('/auth/password', { current: 'x', next: 'something-long-enough' })).status).toBe(403);
    await c.post('/auth/logout');
    expect((await c.get('/admin/summary')).status).toBe(401);
  });
  it('does not use one of the four administrator slots and cannot be reached by email', async () => {
    expect((await pub.get('/setup/status')).json.adminCount).toBe(4);
    expect((await pub.post('/auth/login', { email: 'code-access@mcaa.invalid', password: '!' })).status).toBe(401);
  });
  it('locks out an address after repeated wrong codes, without affecting other addresses', async () => {
    const bad = new Client(env);
    for (let i = 0; i < 8; i++) await bad.req('POST', '/auth/code', { code: `guess${i}` }, { 'CF-Connecting-IP': '203.0.113.9' });
    expect((await bad.req('POST', '/auth/code', { code: 'DIDYDOLLAR' }, { 'CF-Connecting-IP': '203.0.113.9' })).status).toBe(429);
    expect((await new Client(env).req('POST', '/auth/code', { code: 'DIDYDOLLAR' }, { 'CF-Connecting-IP': '198.51.100.7' })).status).toBe(200);
  });
  it('accepts a replacement code from the ADMIN_CODE secret', async () => {
    const custom = new Client({ ...env, ADMIN_CODE: 'NEW-CODE-123' } as Env);
    expect((await custom.post('/auth/code', { code: 'DIDYDOLLAR' })).status).toBe(401);
    expect((await custom.post('/auth/code', { code: 'NEW-CODE-123' })).status).toBe(200);
  });
});

describe('league data, percentages and scheduling', () => {
  it('builds a league through the admin API', async () => {
    L = await seedLeague(admin);
    const teams = (await pub.get('/teams')).json.teams;
    expect(teams).toHaveLength(4);
    expect((await pub.get('/meta')).json.season.year).toBe(2026);
  });
  const pctOf = async (abbr: string) => (await admin.get(`/admin/percentages?season=${L.season}`)).json.teams.find((t: any) => t.teamId === L.teams[abbr]);
  it('stores team percentages in D1, validates imports and never saves partial or invented data', async () => {
    const before = (await admin.get(`/admin/percentages?season=${L.season}`)).json.teams;
    expect(before.every((t: any) => t.activity != null)).toBe(true);
    const bad = await admin.post('/admin/percentages/import', { seasonId: L.season, format: 'csv', content: 'team,activity,upset,star\nAAA,120,30,40\nBBB,50,,40\nZZZ,50,50,50\nAAA,1,2,3' });
    expect(bad.status).toBe(422);
    expect(bad.json.details.join(' ')).toMatch(/outside 0-100/);
    expect(bad.json.details.join(' ')).toMatch(/missing or not a number/);
    expect(bad.json.details.join(' ')).toMatch(/does not match any MCAA team/);
    expect((await admin.get(`/admin/percentages?season=${L.season}`)).json.teams).toEqual(before); // nothing partial was written
    // An import updates the listed teams and leaves the others alone.
    const json = await admin.post('/admin/percentages/import', { seasonId: L.season, format: 'json', content: JSON.stringify([{ team: 'AAA', activity: '85%', upset: 35, star: 70, morale: 55 }, { team: 'BBB', activity: 45, upset: 65, star: 20 }]) });
    expect(json.status).toBe(201);
    expect(json.json).toMatchObject({ imported: 2, coverage: { total: 4, set: 4, missing: [] } });
    expect(await pctOf('AAA')).toMatchObject({ activity: 85, upset: 35, star: 70, extra: { morale: 55 }, updatedBy: 'Admin 1' });
    expect(await pctOf('CCC')).toMatchObject({ activity: before.find((t: any) => t.teamId === L.teams.CCC).activity });
    // Direct edits from the admin dashboard.
    expect((await admin.put('/admin/percentages', { seasonId: L.season, set: [{ teamId: L.teams.CCC, activity: 50, upset: 40, star: 30 }] })).status).toBe(200);
    expect(await pctOf('CCC')).toMatchObject({ activity: 50, upset: 40, star: 30 });
    expect(await pctOf('AAA')).toMatchObject({ extra: { morale: 55 } }); // untouched teams keep extra categories
    const audit = (await admin.get('/admin/audit')).json.entries.find((e: any) => e.action === 'percentages_updated');
    expect(audit.new_value[L.teams.CCC]).toEqual({ activity: 50, upset: 40, star: 30 });
    expect(audit.previous_value[L.teams.CCC]).not.toBeNull();
    // Invalid edits are refused.
    expect((await admin.put('/admin/percentages', { seasonId: L.season, set: [{ teamId: L.teams.CCC, activity: 101, upset: 40, star: 30 }] })).status).toBe(400);
    expect((await admin.put('/admin/percentages', { seasonId: L.season, set: [{ teamId: 'not-a-team', activity: 1, upset: 2, star: 3 }] })).status).toBe(422);
    expect((await pub.put('/admin/percentages', { seasonId: L.season, set: [{ teamId: L.teams.CCC, activity: 1, upset: 1, star: 1 }] })).status).toBe(401);
    await expect(env.DB.prepare('INSERT INTO team_percentages (season_id, team_id, activity, upset, star, updated_at) VALUES (?1, ?2, 150, 1, 1, 1) ON CONFLICT DO UPDATE SET activity = 150').bind(L.season, L.teams.CCC).run()).rejects.toThrow(/CHECK/);
    // Snapshots taken for simulations stay immutable.
    await expect(env.DB.prepare('UPDATE percentage_snapshot_entries SET activity = 1').run()).rejects.toThrow(/immutable/);
  });
  it('refuses to simulate a team that has no stored percentages', async () => {
    const g = await addGame(admin, L.season, 4, L.teams.CCC, L.teams.DDD);
    const kept = await pctOf('DDD');
    expect((await admin.put('/admin/percentages', { seasonId: L.season, clear: [L.teams.DDD] })).json.coverage.missing).toEqual(['DDD Testers']);
    const r = await admin.post(`/admin/games/${g}/simulate`, {});
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('MISSING_PERCENTAGES');
    expect(r.json.error).toMatch(/Team Percentages/);
    await admin.put('/admin/percentages', { seasonId: L.season, set: [{ teamId: L.teams.DDD, activity: kept.activity, upset: kept.upset, star: kept.star }] });
    await admin.del(`/admin/games/${g}`);
  });
  it('simulates from the current D1 values, freezing them in a snapshot each run keeps', async () => {
    const g = await addGame(admin, L.season, 4, L.teams.CCC, L.teams.DDD);
    const run = async (body: Record<string, unknown>) => {
      const r = await admin.post(`/admin/games/${g}/simulate`, { regenerate: true, ...body });
      expect(r.status).toBe(201);
      return { r, detail: (await admin.get(`/admin/runs/${r.json.runId}`)).json };
    };
    const first = await run({ seed: 'db-1' });
    expect(first.detail.snapshot).toMatchObject({ source: 'database', away: { activity: 50, upset: 40, star: 30 } });
    expect(first.detail.result.percentageChecks.filter((c: any) => c.side === 0).map((c: any) => c.percentage)).toEqual(expect.arrayContaining([50, 40, 30]));
    // Unchanged values reuse the same snapshot instead of piling up copies.
    const again = await run({ seed: 'db-2' });
    expect(again.detail.snapshot.id).toBe(first.detail.snapshot.id);
    // An edit is picked up by the next simulation; the earlier result keeps the values it was simulated with.
    await admin.put('/admin/percentages', { seasonId: L.season, set: [{ teamId: L.teams.DDD, activity: 11, upset: 22, star: 33 }] });
    const edited = await run({ seed: 'db-3' });
    expect(edited.detail.snapshot.id).not.toBe(first.detail.snapshot.id);
    expect(edited.detail.snapshot.home).toMatchObject({ activity: 11, upset: 22, star: 33 });
    expect(edited.detail.result.percentageChecks.filter((c: any) => c.side === 1 && c.category === 'star').every((c: any) => c.percentage === 33)).toBe(true);
    expect((await admin.get(`/admin/runs/${first.r.json.runId}`)).json.snapshot.home.star).not.toBe(33);
    // Same seed + same snapshot reproduces the game exactly.
    const repro = await run({ seed: 'db-3', snapshotId: edited.detail.snapshot.id });
    expect(repro.r.json.final).toEqual(edited.r.json.final);
    // An administrator may deliberately reuse an earlier snapshot.
    const old = await run({ seed: 'db-4', snapshotId: L.snapshotId });
    expect(old.detail.snapshot.id).toBe(L.snapshotId);
    await admin.post(`/admin/runs/${old.r.json.runId}/reject`, { note: 'test' });
  });
  it('needs no percentage API in the deployment configuration', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['wrangler.jsonc', '.dev.vars.example']) expect(readFileSync(f, 'utf8')).not.toMatch(/PERCENTAGE_API/);
    expect(Object.keys(env)).not.toContain('PERCENTAGE_API_URL');
    const routes = await Promise.all(['/admin/percentages/fetch', '/admin/percentages/source'].map((p) => admin.post(p, { seasonId: L.season })));
    expect(routes.map((r) => r.status)).toEqual([404, 404]);
  });
  it('prevents duplicate games unless explicitly allowed', async () => {
    const g = await addGame(admin, L.season, 1, L.teams.AAA, L.teams.BBB);
    const dup = await admin.post('/admin/games', { seasonId: L.season, week: 1, awayTeamId: L.teams.BBB, homeTeamId: L.teams.AAA });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('DUPLICATE_GAME');
    const allowed = await admin.post('/admin/games', { seasonId: L.season, week: 1, awayTeamId: L.teams.BBB, homeTeamId: L.teams.AAA, allowDuplicate: true });
    expect(allowed.status).toBe(201);
    expect((await admin.del(`/admin/games/${allowed.json.id}`)).status).toBe(200);
    expect((await admin.post('/admin/games', { seasonId: L.season, week: 1, awayTeamId: L.teams.AAA, homeTeamId: L.teams.AAA })).status).toBe(422);
    (L as any).g1 = g;
  });
});

describe('simulation, review and publishing', () => {
  let runId: string, final: [number, number];
  it('simulates reproducibly from a seed and stores the percentage snapshot used', async () => {
    const g = (L as any).g1 as string;
    const sim = await admin.post(`/admin/games/${g}/simulate`, { seed: 'repro-1', snapshotId: L.snapshotId });
    expect(sim.status).toBe(201);
    expect(sim.json.valid).toBe(true);
    runId = sim.json.runId; final = sim.json.final;
    const again = await admin.post(`/admin/games/${g}/simulate`, { seed: 'repro-1', snapshotId: L.snapshotId });
    expect(again.status).toBe(409); // duplicate processing blocked
    const regen = await admin.post(`/admin/games/${g}/simulate`, { seed: 'repro-1', snapshotId: L.snapshotId, regenerate: true });
    expect(regen.json.final).toEqual(final); // same seed + same snapshot = same game
    runId = regen.json.runId;
    const detail = (await admin.get(`/admin/runs/${runId}`)).json;
    expect(detail.snapshot.id).toBe(L.snapshotId);
    expect(detail.result.percentageChecks.map((c: any) => c.category)).toEqual(expect.arrayContaining(['activity', 'upset', 'star']));
    expect(detail.result.seed).toBe('repro-1');
  });
  it('keeps unpublished results private and blocks publishing before approval', async () => {
    const g = (L as any).g1 as string;
    expect((await pub.get(`/games/${g}`)).json.result).toBeNull();
    expect((await pub.get(`/admin/runs/${runId}`)).status).toBe(401);
    const early = await admin.post(`/admin/runs/${runId}/publish`, {});
    expect(early.status).toBe(409);
    expect(Object.values(await recordsNow()).every((r) => r.games === 0)).toBe(true);
    expect((await pub.get('/standings')).status).toBe(404); // standings are not part of this site
  });
  it('cannot approve or publish a result that failed validation (database rule)', async () => {
    await expect(env.DB.prepare("INSERT INTO simulation_runs (id, game_id, mode, seed, status, away_score, home_score, valid, result, created_at) VALUES ('bad', ?1, 'sim', 's', 'rejected', 1, 0, 0, '{}', 1)").bind((L as any).g1).run()).resolves.toBeTruthy();
    await expect(env.DB.prepare("UPDATE simulation_runs SET status = 'approved' WHERE id = 'bad'").run()).rejects.toThrow(/failed validation/);
    await expect(env.DB.prepare("UPDATE simulation_runs SET away_score = 99 WHERE id = ?1").bind(runId).run()).rejects.toThrow(/immutable/);
  });
  it('publishes exactly once under concurrent requests and updates team records', async () => {
    expect((await admin.post(`/admin/runs/${runId}/approve`)).status).toBe(200);
    const other = await login(env, 3);
    const [a, b] = await Promise.all([admin.post(`/admin/runs/${runId}/publish`, {}), other.post(`/admin/runs/${runId}/publish`, {})]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM published_results WHERE game_id = ?1').bind((L as any).g1).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const { AAA: A, BBB: B } = await recordsNow();
    expect(A.games).toBe(1); expect(B.games).toBe(1);
    expect(A.wins).toBe(final[0] > final[1] ? 1 : 0);
    expect(A.pf).toBe(final[0]); expect(B.pf).toBe(final[1]);
    const game = (await pub.get(`/games/${(L as any).g1}`)).json;
    expect(game.game.status).toBe('final');
    expect([game.game.away.score, game.game.home.score]).toEqual(final);
    expect(game.result.plays.length).toBeGreaterThan(100);
    expect(game.labels.score).toMatch(/Simulated/);
  });
  it('aggregates season statistics from published games without double counting', async () => {
    const g = (L as any).g1 as string;
    const box = (await pub.get(`/games/${g}`)).json.result.playerStats;
    const leaders = (await pub.get('/leaders')).json.players;
    const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + r[k], 0);
    for (const k of ['passYds', 'rushYds', 'recYds', 'passTd', 'tackles']) expect(sum(leaders, k)).toBe(sum(box, k));
    // Team passing yards equal the sum of receivers' yards in the stored box score.
    const team = (await pub.get(`/games/${g}`)).json.result.teamStats;
    expect(sum(team, 'passYds')).toBe(sum(box, 'recYds'));
  });
  it('requires confirmation and a reason to correct an official result, then recalculates everything', async () => {
    const g = (L as any).g1 as string;
    const sim = await admin.post(`/admin/games/${g}/simulate`, { seed: 'correction-7', snapshotId: L.snapshotId });
    expect(sim.status).toBe(201);
    await admin.post(`/admin/runs/${sim.json.runId}/approve`);
    const noConfirm = await admin.post(`/admin/runs/${sim.json.runId}/publish`, {});
    expect(noConfirm.status).toBe(409);
    expect(noConfirm.json.code).toBe('CONFIRM_REQUIRED');
    expect((await admin.post(`/admin/runs/${sim.json.runId}/publish`, { confirm: true })).status).toBe(422);
    const ok = await admin.post(`/admin/runs/${sim.json.runId}/publish`, { confirm: true, reason: 'Wrong seed used' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ version: 2, correction: true });
    const A = (await recordsNow()).AAA;
    expect(A.games).toBe(1); // still one game, not two
    expect(A.pf).toBe(sim.json.final[0]);
    const box = (await pub.get(`/games/${g}`)).json.result.playerStats;
    const leaders = (await pub.get('/leaders')).json.players;
    expect(leaders.reduce((a: number, r: any) => a + r.passYds, 0)).toBe(box.reduce((a: number, r: any) => a + r.passYds, 0));
    // History is preserved and the correction is audited with previous and new values.
    const hist = (await admin.get(`/admin/games/${g}/runs`)).json;
    expect(hist.published).toHaveLength(2);
    expect(hist.published.filter((p: any) => p.is_current)).toHaveLength(1);
    const audit = (await admin.get(`/admin/audit?game=${g}`)).json.entries.find((e: any) => e.action === 'result_corrected');
    expect(audit).toMatchObject({ reason: 'Wrong seed used', admin_name: 'Admin 1' });
    expect(audit.previous_value.away).toBe(final[0]);
    expect(audit.new_value.away).toBe(sim.json.final[0]);
    await expect(env.DB.prepare('DELETE FROM audit_logs').run()).rejects.toThrow(/append-only/);
  });
  it('blocks matchup edits on a published game and supports withdrawing a result', async () => {
    const g = (L as any).g1 as string;
    expect((await admin.patch(`/admin/games/${g}`, { awayTeamId: L.teams.CCC })).status).toBe(409);
    expect((await admin.post(`/admin/games/${g}/unpublish`, { reason: 'x' })).status).toBe(400);
    expect((await admin.post(`/admin/games/${g}/unpublish`, { reason: 'Played with wrong roster', confirm: true })).status).toBe(200);
    expect(Object.values(await recordsNow()).every((r) => r.games === 0)).toBe(true);
    expect((await pub.get('/leaders')).json.players).toHaveLength(0);
    expect((await pub.get(`/games/${g}`)).json.game.status).toBe('scheduled');
  });
  it('replays a published simulation progressively without counting it until the replay ends', async () => {
    const g = await addGame(admin, L.season, 2, L.teams.CCC, L.teams.DDD);
    const sim = await admin.post(`/admin/games/${g}/simulate`, { seed: 'replay-1', snapshotId: L.snapshotId });
    await admin.post(`/admin/runs/${sim.json.runId}/approve`);
    const p = await admin.post(`/admin/runs/${sim.json.runId}/publish`, { presentationMsPerPlay: 60000 });
    expect(p.status).toBe(200);
    const view = (await pub.get(`/games/${g}`)).json;
    expect(view.game.status).toBe('in_progress');
    expect(view.game.replay).toBe(true);
    expect(view.replay.note).toMatch(/not being played live/i);
    expect(view.result.plays.length).toBeLessThan(5);
    expect(view.result.playerStats).toBeNull();
    expect((await recordsNow()).CCC.games).toBe(0);
    await admin.post(`/admin/games/${g}/unpublish`, { reason: 'end of test', confirm: true });
  });
  it('isolates failures in a batch: one bad game does not affect the others', async () => {
    const good = await addGame(admin, L.season, 3, L.teams.AAA, L.teams.CCC);
    const bad = await addGame(admin, L.season, 3, L.teams.BBB, L.teams.DDD);
    // Deactivate every DDD quarterback so that game cannot be simulated.
    const roster = (await admin.get(`/admin/roster?season=${L.season}&team=${L.teams.DDD}`)).json.players;
    for (const p of roster.filter((x: any) => x.position === 'QB')) await admin.patch(`/admin/roster/${p.id}`, { active: false });
    const results = [];
    for (const g of [bad, good]) results.push(await admin.post(`/admin/games/${g}/simulate`, { seed: `batch-${g}`, snapshotId: L.snapshotId }));
    expect(results[0].status).toBe(422);
    expect(results[0].json.error).toMatch(/no rostered QB/);
    expect(results[1].status).toBe(201);
    const pre = (await admin.get(`/admin/games/${bad}/preflight`)).json.teams;
    expect(pre.find((t: any) => t.teamId === L.teams.DDD).errors.length).toBeGreaterThan(0);
    for (const p of roster.filter((x: any) => x.position === 'QB')) await admin.patch(`/admin/roster/${p.id}`, { active: true });
  });
});

describe('primetime imports', () => {
  it('preserves the imported score and locked stats, and labels the game as a reconstruction', async () => {
    const g = await addGame(admin, L.season, 4, L.teams.AAA, L.teams.DDD, { allowDuplicate: true });
    const qb = L.players.AAA.QB1;
    const imp = await admin.post(`/admin/games/${g}/primetime`, { input: { final: [38, 31], locks: { players: { [qb]: { passYds: 285, passTd: 3, passInt: 1 } } } }, seed: 'pt-1' });
    expect(imp.status).toBe(201);
    expect(imp.json.final).toEqual([38, 31]);
    expect(imp.json.valid).toBe(true);
    await admin.post(`/admin/runs/${imp.json.runId}/approve`);
    expect((await admin.post(`/admin/runs/${imp.json.runId}/publish`, {})).status).toBe(200);
    const view = (await pub.get(`/games/${g}`)).json;
    expect([view.game.away.score, view.game.home.score]).toEqual([38, 31]);
    expect(view.game.mode).toBe('primetime');
    expect(view.game.designations).toContain('primetime');
    expect(view.labels.score).toMatch(/Verified CFB 27/);
    expect(view.labels.playByPlay).toMatch(/reconstruction/i);
    expect(view.result.recap.reconstruction).toBe(true);
    const line = view.result.playerStats.find((p: any) => p.playerId === qb);
    expect(line).toMatchObject({ passYds: 285, passTd: 3, passInt: 1 });
    expect(line.lockedFields.sort()).toEqual(['passInt', 'passTd', 'passYds']);
  });
  it('rejects impossible or conflicting inputs with an explanation', async () => {
    const g = await addGame(admin, L.season, 4, L.teams.BBB, L.teams.CCC, { allowDuplicate: true });
    const tie = await admin.post(`/admin/games/${g}/primetime`, { input: { final: [21, 21] } });
    expect(tie.status).toBe(422);
    const q = await admin.post(`/admin/games/${g}/primetime`, { input: { final: [21, 14], quarters: [[7, 7, 0, 0], [7, 7, 0, 0]] } });
    expect(q.status).toBe(422);
    expect(q.json.error).toMatch(/add up to 14/);
    const td = await admin.post(`/admin/games/${g}/primetime`, { input: { final: [10, 3], locks: { players: { [L.players.BBB.QB1]: { passTd: 4 } } } } });
    expect(td.status).toBe(422);
    const ghost = await admin.post(`/admin/games/${g}/primetime`, { input: { final: [10, 3], locks: { players: { 'not-a-player': { passYds: 100 } } } } });
    expect(ghost.status).toBe(422);
    expect(ghost.json.error).toMatch(/not on either roster/);
    // A player from another team cannot be credited in this game.
    const wrongTeam = await admin.post(`/admin/games/${g}/primetime`, { input: { final: [10, 3], locks: { players: { [L.players.AAA.QB1]: { passYds: 100 } } } } });
    expect(wrongTeam.status).toBe(422);
  });
  it('verifies a browser-solved reconstruction on the server and rejects a tampered one', async () => {
    const g = await addGame(admin, L.season, 4, L.teams.BBB, L.teams.CCC, { allowDuplicate: true });
    const { reconstructPrimetime } = await import('../engine/index');
    const inp = (await admin.get(`/admin/games/${g}/sim-input`)).json;
    const input = { final: [27, 24] as [number, number], quarters: [[7, 10, 3, 7], [10, 0, 7, 7]] as [number[], number[]] };
    const local = reconstructPrimetime({ seed: 'client-1', teams: inp.teams, config: inp.config, input });
    const tampered = local.plays.map((p) => ({ ...p }));
    tampered.find((p) => p.type === 'run' && p.offense === 0 && p.rusher)!.rusher = L.players.CCC.RB1; // credit the other team's player
    const bad = await admin.post(`/admin/games/${g}/primetime`, { input, seed: 'client-1', plays: tampered.map(({ desc, ...p }) => p) });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('VERIFY');
    expect(bad.json.details.join(' ')).toMatch(/not on the active/);
    const extra = local.plays.map((p) => ({ ...p, scoreAfter: [p.scoreAfter[0] + (p.seq > 50 ? 7 : 0), p.scoreAfter[1]] }));
    expect((await admin.post(`/admin/games/${g}/primetime`, { input, seed: 'client-1', plays: extra.map(({ desc, ...p }) => p) })).status).toBe(422);
    const ok = await admin.post(`/admin/games/${g}/primetime`, { input, seed: 'client-1', plays: local.plays.map(({ desc, ...p }) => p) });
    expect(ok.status).toBe(201);
    expect(ok.json.final).toEqual([27, 24]);
    expect(ok.json.quarters).toEqual(input.quarters);
  });
  it('never stores screenshot values automatically and reports when AI is not configured', async () => {
    const g = (await admin.get(`/admin/games?season=${L.season}&week=4`)).json.games[0].id;
    const r = await admin.post('/admin/screenshots/extract', { gameId: g, images: [{ mediaType: 'image/png', data: 'A'.repeat(200) }] });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe('AI_NOT_CONFIGURED');
  });
  it('accepts manually entered live scores for a primetime game and labels them as manual', async () => {
    const g = await addGame(admin, L.season, 2, L.teams.AAA, L.teams.BBB, { mode: 'primetime' });
    expect((await admin.patch(`/admin/games/${g}`, { status: 'in_progress' })).status).toBe(422);
    expect((await admin.patch(`/admin/games/${g}`, { status: 'in_progress', liveAway: 14, liveHome: 10, livePeriod: 'Q3', liveClock: '8:21' })).status).toBe(200);
    const v = (await pub.get(`/games/${g}`)).json.game;
    expect(v).toMatchObject({ status: 'in_progress', manualLive: true, replay: false, period: 'Q3' });
    expect([v.away.score, v.home.score]).toEqual([14, 10]);
  });
});

describe('rankings', () => {
  it('stores manual AP rankings; computed recommendations never overwrite them', async () => {
    const order = [L.teams.DDD, L.teams.AAA, L.teams.CCC];
    expect((await admin.put('/admin/rankings', { seasonId: L.season, week: 1, teamIds: order })).status).toBe(200);
    expect((await admin.put('/admin/rankings', { seasonId: L.season, week: 1, teamIds: [L.teams.AAA, L.teams.AAA] })).status).toBe(422);
    const rec = await admin.get(`/admin/rankings/recommendation?season=${L.season}`);
    expect(rec.status).toBe(200);
    const pubRank = (await pub.get('/rankings')).json.rankings;
    expect(pubRank.map((r: any) => r.team.id)).toEqual(order);
  });
});
