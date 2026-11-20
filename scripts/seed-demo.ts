// DEMO DATA ONLY. Fills a local or preview deployment with an obviously fictional sample league so the site can be
// explored before real MCAA teams, rosters and percentages are entered. Never run this against the real league database:
// it invents teams, players and percentages, which the production rules forbid for official data.
//
//   SETUP_TOKEN=... npm run seed:demo -- http://127.0.0.1:8787
import { Rng } from '../engine/rng';
import { DEF_SCHEMES, OFF_SCHEMES } from '../engine/types';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.SETUP_TOKEN ?? '';
const EMAIL = process.env.DEMO_ADMIN_EMAIL ?? 'demo-admin@mcaa.example';
const PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'demo-password-change-me';
let cookie = '';
const rng = new Rng('demo-league');

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-MCAA-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const post = (p: string, b?: unknown) => call('POST', p, b ?? {});

const TEAMS = [
  ['Blockfield State Miners', 'Blockfield St', 'BFS', '#7a1f2b', '#f2c14e', 'Quarry Stadium'], ['Redstone Tech Engineers', 'Redstone Tech', 'RST', '#c1121f', '#fdf0d5', 'Circuit Field'],
  ['Nether A&M Blazes', 'Nether A&M', 'NAM', '#ff7b00', '#3d0c02', 'Fortress Bowl'], ['Ender University Dragons', 'Ender', 'END', '#5a189a', '#e0aaff', 'The End Zone'],
  ['Creeper Valley Vines', 'Creeper Valley', 'CRV', '#2d6a4f', '#d8f3dc', 'Mosswood Park'], ['Obsidian College Knights', 'Obsidian', 'OBS', '#22223b', '#c9ada7', 'Blackrock Coliseum'],
  ['Pixel Coast Mariners', 'Pixel Coast', 'PXC', '#0077b6', '#caf0f8', 'Harbor Stadium'], ['Diamond Ridge Prospectors', 'Diamond Ridge', 'DRP', '#00b4d8', '#03045e', 'Lapis Field'],
];
const A = ['Stone', 'Iron', 'Moss', 'Ember', 'Frost', 'Shadow', 'Copper', 'Amber', 'Storm', 'Pixel', 'Cobble', 'Lava', 'Birch', 'Slate', 'Onyx', 'Echo', 'Nova', 'Rift', 'Quartz', 'Dune'];
const B = ['Fox', 'Wolf', 'Hawk', 'Rider', 'Smith', 'Runner', 'Miner', 'Scout', 'Baron', 'Knight', 'Archer', 'Golem', 'Wraith', 'Drake', 'Lynx', 'Otter', 'Viper', 'Crane', 'Bison', 'Moth'];
const used = new Set<string>();
const gamertag = () => { for (;;) { const n = `${rng.pick(A)}${rng.pick(B)}${rng.chance(0.5) ? rng.int(1, 99) : ''}`; if (!used.has(n)) { used.add(n); return n; } } };
const SLOTS: [string, number, string][] = [['QB', 1, ''], ['QB', 2, ''], ['RB', 1, ''], ['RB', 2, 'KR'], ['FB', 1, ''], ['WR', 1, ''], ['WR', 2, 'PR'], ['WR', 3, ''], ['WR', 4, ''], ['TE', 1, ''], ['TE', 2, ''], ['LT', 1, ''], ['LG', 1, ''], ['C', 1, ''], ['RG', 1, ''], ['RT', 1, ''],
  ['DE', 1, ''], ['DE', 2, ''], ['DT', 1, ''], ['DT', 2, ''], ['EDGE', 1, ''], ['LB', 1, ''], ['LB', 2, ''], ['LB', 3, ''], ['CB', 1, ''], ['CB', 2, ''], ['CB', 3, ''], ['FS', 1, ''], ['SS', 1, ''], ['K', 1, ''], ['P', 1, '']];

async function main() {
  if (!TOKEN) throw new Error('Set SETUP_TOKEN to the same value as the Worker secret (see .dev.vars).');
  const status = await call('GET', '/setup/status');
  if (status.adminCount < 4) await call('POST', '/setup/admins', { email: EMAIL, name: 'Demo Admin', password: PASSWORD }, { Authorization: `Bearer ${TOKEN}` }).catch((e) => console.log('admin not created:', e.message));
  await post('/auth/login', { email: EMAIL, password: PASSWORD });
  const season = (await post('/admin/seasons', { year: 2026, name: '2026 Demo Season', weeks: 7, isCurrent: true })).id;
  const confs = [(await post('/admin/conferences', { name: 'Overworld Conference', abbr: 'OWC' })).id, (await post('/admin/conferences', { name: 'Deepslate Conference', abbr: 'DSC' })).id];
  const ids: string[] = [];
  for (const [i, [name, shortName, abbr, primaryColor, secondaryColor, stadium]] of TEAMS.entries()) {
    const id = (await post('/admin/teams', { name, shortName, abbr, primaryColor, secondaryColor, stadium, mascot: name.split(' ').pop() })).id;
    ids.push(id);
    const base = 66 + ((i * 7) % 16);
    await call('PUT', `/admin/teams/${id}/season`, { seasonId: season, conferenceId: confs[i % 2], offRating: base + rng.int(-3, 5), defRating: base + rng.int(-4, 4), stRating: 65 + rng.int(0, 15), offScheme: OFF_SCHEMES[i % OFF_SCHEMES.length], defScheme: DEF_SCHEMES[(i * 2) % DEF_SCHEMES.length], runPct: i === 3 ? 65 : null, tempo: ['normal', 'fast', 'slow'][i % 3] });
    const csv = ['name,jersey,position,secondary,depth,rating', ...SLOTS.map(([pos, depth, sec], k) => `${gamertag()},${k + 1},${pos},${sec},${depth},${Math.round(base + 8 - depth * 5 + rng.int(-4, 6))}`)].join('\n');
    await post('/admin/roster/import', { seasonId: season, teamId: id, csv });
  }
  await post('/admin/percentages/import', { seasonId: season, format: 'csv', content: ['team,activity,upset,star', ...TEAMS.map((t) => `${t[2]},${rng.int(40, 95)},${rng.int(15, 70)},${rng.int(20, 80)}`)].join('\n') });
  // Round-robin schedule (circle method), 7 weeks.
  const n = ids.length;
  const kick = (week: number, slot: number) => Date.UTC(2026, 8, 5 + (week - 1) * 7, 16 + slot * 3, slot % 2 ? 30 : 0);
  const games: { id: string; week: number }[] = [];
  const order = [...ids];
  for (let w = 1; w <= 7; w++) {
    for (let k = 0; k < n / 2; k++) {
      const [a, h] = w % 2 ? [order[k], order[n - 1 - k]] : [order[n - 1 - k], order[k]];
      const des = k === 0 ? ['gotw'] : k === 1 && w % 3 === 0 ? ['rivalry'] : [];
      const g = await post('/admin/games', { seasonId: season, week: w, awayTeamId: a, homeTeamId: h, kickoffAt: kick(w, k), network: ['MCAA Network', 'BlockSports', 'MCAA+', 'The Overworld Channel'][k], designations: des, mode: w === 4 && k === 1 ? 'primetime' : 'sim' });
      games.push({ id: g.id, week: w });
    }
    order.splice(1, 0, order.pop()!);
  }
  const play = async (id: string, opts: Record<string, unknown> = {}) => {
    const sim = await post(`/admin/games/${id}/simulate`, { seed: `demo-${id.slice(0, 6)}` });
    await post(`/admin/runs/${sim.runId}/approve`);
    await post(`/admin/runs/${sim.runId}/publish`, opts);
    return sim;
  };
  for (const w of [1, 2, 3]) {
    for (const g of games.filter((x) => x.week === w)) await play(g.id);
    const rec = await call('GET', `/admin/rankings/recommendation?season=${season}`);
    await call('PUT', '/admin/rankings', { seasonId: season, week: w + 1, teamIds: rec.recommendation.slice(0, 6).map((r: any) => r.teamId) });
    console.log(`week ${w} played`);
  }
  const wk4 = games.filter((x) => x.week === 4);
  await play(wk4[0].id);
  // A CFB 27 primetime import with a locked quarterback line.
  const input = await call('GET', `/admin/games/${wk4[1].id}/sim-input`);
  const qb = input.teams[0].roster.find((p: any) => p.position === 'QB' && p.depth === 1);
  const imp = await post(`/admin/games/${wk4[1].id}/primetime`, { input: { final: [38, 31], quarters: [[7, 14, 3, 14], [10, 7, 7, 7]], locks: { players: { [qb.id]: { passYds: 285, passTd: 3, passInt: 1 } } } }, seed: 'demo-primetime' });
  await post(`/admin/runs/${imp.runId}/approve`);
  await post(`/admin/runs/${imp.runId}/publish`);
  // One game replaying as a presentation, one awaiting review.
  await play(wk4[2].id, { presentationMsPerPlay: 4000 });
  await post(`/admin/games/${wk4[3].id}/simulate`, { seed: 'demo-pending' });
  console.log(`Demo league ready at ${BASE}. Admin sign-in: ${EMAIL} / ${PASSWORD}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
