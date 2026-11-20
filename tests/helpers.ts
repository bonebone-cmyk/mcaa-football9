import { getPlatformProxy } from 'wrangler';
import { app } from '../worker/index';
import type { Env } from '../worker/auth';
import { makeTeam } from './fixtures';

export const SETUP_TOKEN = 'test-setup-token-0123456789';

export async function makeEnv(extra: Partial<Env> = {}) {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: false });
  const env = { DB: proxy.env.DB, SETUP_TOKEN, ASSETS: { fetch: async () => new Response('asset') }, ...extra } as unknown as Env;
  return { env, dispose: proxy.dispose };
}

export class Client {
  cookie = '';
  constructor(public env: Env) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(`http://mcaa.test/api${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-MCAA-Request': '1', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
    }, this.env);
    const set = res.headers.get('Set-Cookie');
    if (set) this.cookie = set.split(';')[0];
    const json = (await res.json().catch(() => null)) as any;
    return { status: res.status, json };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req('POST', p, b ?? {}, h);
  put = (p: string, b?: unknown) => this.req('PUT', p, b ?? {});
  patch = (p: string, b?: unknown) => this.req('PATCH', p, b ?? {});
  del = (p: string, h?: Record<string, string>) => this.req('DELETE', p, undefined, h);
}

export async function createAdmin(env: Env, n = 1) {
  const c = new Client(env);
  const email = `admin${n}@mcaa.test`, password = `correct-horse-${n}-battery`;
  const res = await c.post('/setup/admins', { email, name: `Admin ${n}`, password }, { Authorization: `Bearer ${SETUP_TOKEN}` });
  return { res, email, password };
}

export async function login(env: Env, n = 1) {
  const c = new Client(env);
  const res = await c.post('/auth/login', { email: `admin${n}@mcaa.test`, password: `correct-horse-${n}-battery` });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.json)}`);
  return c;
}

/** Build a small synthetic league through the real admin API: one season, two conferences, `abbrs.length` teams with full rosters and percentages. */
export async function seedLeague(admin: Client, abbrs = ['AAA', 'BBB', 'CCC', 'DDD']) {
  const season = (await admin.post('/admin/seasons', { year: 2026, name: '2026 Test Season', weeks: 4, isCurrent: true })).json.id as string;
  const confs = [
    (await admin.post('/admin/conferences', { name: 'East Test', abbr: 'EAST' })).json.id as string,
    (await admin.post('/admin/conferences', { name: 'West Test', abbr: 'WEST' })).json.id as string,
  ];
  const teams: Record<string, string> = {};
  const players: Record<string, Record<string, string>> = {};
  for (const [i, abbr] of abbrs.entries()) {
    const t = makeTeam(abbr);
    const id = (await admin.post('/admin/teams', { name: t.name, shortName: abbr, abbr, primaryColor: '#123456', secondaryColor: '#ffffff' })).json.id as string;
    teams[abbr] = id;
    await admin.put(`/admin/teams/${id}/season`, { seasonId: season, conferenceId: confs[i % 2], offRating: 75, defRating: 75, stRating: 70 });
    const csv = ['name,jersey,position,secondary,depth,rating', ...t.roster.map((p) => `${p.name},${p.jersey},${p.position},${p.secondary.join('/')},${p.depth},${p.rating}`)].join('\n');
    const imp = await admin.post('/admin/roster/import', { seasonId: season, teamId: id, csv });
    if (imp.status !== 201) throw new Error(`roster import failed: ${JSON.stringify(imp.json)}`);
    const r = (await admin.get(`/admin/roster?season=${season}&team=${id}`)).json.players as { player_id: string; position: string; depth_rank: number }[];
    players[abbr] = Object.fromEntries(r.map((p) => [`${p.position}${p.depth_rank}`, p.player_id]));
  }
  const pct = await admin.post('/admin/percentages/import', { seasonId: season, format: 'csv', content: ['team,activity,upset,star', ...abbrs.map((a, i) => `${a},${60 + i * 5},${30 + i * 5},${40 + i * 3}`)].join('\n') });
  if (pct.status !== 201) throw new Error(`pct import failed: ${JSON.stringify(pct.json)}`);
  // Freeze the starting values so later tests can re-simulate against exactly these numbers.
  const snap = await admin.post('/admin/percentages/snapshot', { seasonId: season });
  if (snap.status !== 201) throw new Error(`snapshot failed: ${JSON.stringify(snap.json)}`);
  return { season, confs, teams, players, snapshotId: snap.json.snapshot.id as string };
}

export async function addGame(admin: Client, season: string, week: number, away: string, home: string, extra: Record<string, unknown> = {}) {
  const r = await admin.post('/admin/games', { seasonId: season, week, awayTeamId: away, homeTeamId: home, ...extra });
  if (r.status !== 201) throw new Error(`game create failed: ${JSON.stringify(r.json)}`);
  return r.json.id as string;
}

/** simulate -> approve -> publish, returning the run id. */
export async function playGame(admin: Client, gameId: string, seed = 'seed-1') {
  const sim = await admin.post(`/admin/games/${gameId}/simulate`, { seed });
  if (sim.status !== 201) throw new Error(`simulate failed: ${JSON.stringify(sim.json)}`);
  const ap = await admin.post(`/admin/runs/${sim.json.runId}/approve`);
  if (ap.status !== 200) throw new Error(`approve failed: ${JSON.stringify(ap.json)}`);
  const pub = await admin.post(`/admin/runs/${sim.json.runId}/publish`, {});
  if (pub.status !== 200) throw new Error(`publish failed: ${JSON.stringify(pub.json)}`);
  return { runId: sim.json.runId as string, final: sim.json.final as [number, number] };
}
