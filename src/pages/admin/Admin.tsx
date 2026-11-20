import { CalendarDays, ClipboardCheck, Gauge, History, ListOrdered, LogOut, Percent, Send, Settings as SettingsIcon, Shield, Tv, Users, UsersRound } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, useApi } from '../../api';
import { SeasonSelect, fmtAgo, useSeason } from '../../shared';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Spinner, cx, useAction } from '../../ui';
import { RosterManager, ScheduleManager, TeamManager } from './data';
import { AuditHistory, Percentages, RankingsManager, SimSettings } from './misc';
import { PrimetimeImport } from './primetime';
import { PublishingCenter, ResultsReview, RunDetail, SimulationCenter } from './sim';

const SECTIONS: [string, string, typeof Gauge][] = [
  ['simulation', 'Simulation Center', Gauge], ['primetime', 'Primetime Import', Tv], ['schedule', 'Schedule Manager', CalendarDays], ['teams', 'Team Manager', Shield], ['roster', 'Roster Manager', UsersRound],
  ['percentages', 'Team Percentages', Percent], ['rankings', 'Rankings Manager', ListOrdered], ['review', 'Results Review', ClipboardCheck], ['publishing', 'Publishing Center', Send], ['settings', 'Simulation Settings', SettingsIcon], ['audit', 'Audit History', History],
];

function Frame({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="flex min-h-screen items-start justify-center p-4 pt-[8vh]">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-5 flex items-center justify-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-md bg-gold font-display text-xl font-extrabold text-ink-950">M</span>
          <span className="font-display text-2xl font-bold uppercase tracking-wider">MCAA <span className="text-gold">Football</span></span>
        </Link>
        <Card title={title}>{children}</Card>
        <p className="mt-3 text-center text-xs text-ink-400"><Link to="/" className="hover:text-ink-200">← Back to the public site</Link></p>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'code' | 'account'>('code');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const act = useAction();
  const status = useApi<{ adminCount: number; maxAdmins: number; setupEnabled: boolean }>('/setup/status');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    act.run(async () => {
      if (mode === 'code') await api.post('/auth/code', { code, name: name.trim() || undefined });
      else await api.post('/auth/login', { email, password });
      onDone();
    });
  };
  const tab = (m: typeof mode, label: string) => (
    <button type="button" onClick={() => { setMode(m); act.clear(); }} className={cx('flex-1 rounded-md px-3 py-1.5 text-sm font-semibold', mode === m ? 'bg-gold text-ink-950' : 'text-ink-200 hover:bg-ink-800')}>{label}</button>
  );
  return (
    <Frame title="Administrator sign-in">
      <div className="mb-4 flex gap-1 rounded-lg border border-ink-700 bg-ink-900 p-1">{tab('code', 'Access code')}{tab('account', 'Admin account')}</div>
      <form onSubmit={submit} className="space-y-3">
        {mode === 'code' ? <>
          <Field label="Code"><Input type="password" autoComplete="off" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label="Your name (optional)" hint="Shown in the audit log next to the changes you make."><Input autoComplete="nickname" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </> : <>
          <Field label="Email"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        </>}
        <ErrorBox error={act.error} />
        <Button variant="primary" className="w-full" busy={act.busy}>Sign in</Button>
      </form>
      {mode === 'account' && status.data && status.data.adminCount < status.data.maxAdmins && (
        <Notice className="mt-4">{status.data.adminCount === 0 ? 'No administrator accounts exist yet.' : `${status.data.adminCount} of ${status.data.maxAdmins} administrator accounts have been created.`} <Link to="/setup" className="font-semibold underline">Open administrator setup</Link></Notice>
      )}
      <p className="mt-3 text-xs text-ink-400">League administrators only. Enter the access code, or sign in with your own administrator account.</p>
    </Frame>
  );
}

/** Administrator provisioning. Requires the SETUP_TOKEN secret that only the person who deployed the Worker knows. */
function Setup() {
  const [token, setToken] = useState('');
  const [list, setList] = useState<any | null>(null);
  const [form, setForm] = useState({ email: '', name: '', password: '' });
  const act = useAction();
  const status = useApi<{ adminCount: number; maxAdmins: number; setupEnabled: boolean }>('/setup/status');
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-MCAA-Request': '1', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  };
  const load = () => act.run(async () => setList(await call('GET', '/setup/admins')));
  return (
    <Frame title="Administrator setup">
      {status.data && !status.data.setupEnabled ? (
        <Notice tone="warn">
          <p className="font-semibold">Setup is disabled until a setup token is configured.</p>
          <p className="mt-1">In the Cloudflare dashboard open this Worker → Settings → Variables and Secrets, add a secret named <code className="rounded bg-ink-900 px-1">SETUP_TOKEN</code> (16+ random characters), then reload this page.</p>
        </Notice>
      ) : !list ? (
        <form onSubmit={(e) => { e.preventDefault(); load(); }} className="space-y-3">
          <p className="text-sm text-ink-300">Enter the setup token (the <code className="rounded bg-ink-900 px-1">SETUP_TOKEN</code> secret on the Worker) to create or replace the four administrator accounts.</p>
          <Field label="Setup token"><Input type="password" required value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></Field>
          <ErrorBox error={act.error} />
          <Button variant="primary" className="w-full" busy={act.busy}>Continue</Button>
        </form>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-300">Administrator slots ({list.admins.length} of {list.maxAdmins} used)</p>
            <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700">
              {Array.from({ length: list.maxAdmins }, (_, i) => list.admins[i]).map((a: any, i: number) => (
                <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="w-5 text-ink-400 tnum">{i + 1}</span>
                  {a ? <><span className="min-w-0 flex-1 truncate"><b>{a.name}</b> <span className="text-ink-400">{a.email}</span></span>
                    <Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${a.name}? They will no longer be able to sign in.`) && act.run(async () => { await call('DELETE', `/setup/admins/${a.id}`); await load(); })}>Remove</Button></> : <span className="text-ink-500">Empty</span>}
                </li>))}
            </ul>
          </div>
          {list.admins.length < list.maxAdmins ? (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await call('POST', '/setup/admins', form); setForm({ email: '', name: '', password: '' }); setList(await call('GET', '/setup/admins')); }); }}>
              <Field label="Name"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Email"><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              <Field label="Password" hint="At least 10 characters. The administrator can change it after signing in."><Input type="password" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></Field>
              <Button variant="primary" className="w-full" busy={act.busy}>Create administrator</Button>
            </form>
          ) : <Notice tone="ok">All four administrator accounts exist. To change one, remove it first.</Notice>}
          <ErrorBox error={act.error} />
          <Link to="/admin" className="block text-center text-sm font-semibold text-gold-soft hover:underline">Go to sign-in →</Link>
        </div>
      )}
    </Frame>
  );
}

function Overview() {
  const { seasonId } = useSeason();
  const q = useApi<any>(`/admin/summary${seasonId ? `?season=${seasonId}` : ''}`);
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : <Spinner />;
  const c = q.data.counts;
  if (!c) return (
    <Card title="Welcome">
      <p className="text-sm text-ink-200">Nothing has been set up yet. Start in <Link className="font-semibold text-gold-soft underline" to="/admin/teams">Team Manager</Link>: create the first season, then conferences and teams. After that add rosters, build the schedule and import team percentages.</p>
    </Card>);
  const tile = (label: string, value: number | string, to: string, tone?: string) => <Link to={to} className="rounded-xl border border-ink-700 bg-ink-850 p-4 hover:border-ink-500"><p className="text-xs uppercase tracking-wide text-ink-400">{label}</p><p className={cx('font-display text-4xl font-bold tnum', tone)}>{value}</p></Link>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tile('Teams this season', c.teams, '/admin/teams')}{tile('Active players', c.players, '/admin/roster')}{tile('Games scheduled', c.scheduled, '/admin/simulation')}{tile('Games final', `${c.final} / ${c.games}`, '/admin/publishing')}
        {tile('Awaiting review', c.awaitingReview, '/admin/review', c.awaitingReview ? 'text-gold-soft' : '')}{tile('Approved, not published', c.awaitingPublish, '/admin/publishing', c.awaitingPublish ? 'text-gold-soft' : '')}
      </div>
      <Card title="Readiness">
        <ul className="space-y-2 text-sm">
          <li>{q.data.percentages.total && !q.data.percentages.missing.length ? <><Badge tone="green">OK</Badge> Team percentages are set for all {q.data.percentages.total} teams.</> : <><Badge tone="red">Missing</Badge> {q.data.percentages.total ? `Team percentages are missing for ${q.data.percentages.missing.length} of ${q.data.percentages.total} teams (${q.data.percentages.missing.slice(0, 6).join(', ')}${q.data.percentages.missing.length > 6 ? '…' : ''}). Their games cannot be simulated until they are entered.` : 'No teams are entered in this season yet.'} <Link className="underline" to="/admin/percentages">Team Percentages</Link></>}</li>
          <li>{q.data.aiConfigured ? <><Badge tone="green">On</Badge> AI recaps and screenshot reading are available.</> : <><Badge>Off</Badge> AI recaps and screenshot reading are off (no <code>ANTHROPIC_API_KEY</code> secret). Standard recaps and manual entry are used.</>}</li>
        </ul>
      </Card>
    </div>
  );
}

function Shell({ admin, onLogout }: { admin: { name: string; email: string }; onLogout: () => void }) {
  const { meta, loading } = useSeason();
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="border-b border-ink-700 bg-ink-900 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-b-0 lg:border-r">
        <Link to="/admin" className="flex items-center gap-2 px-4 py-3">
          <span className="flex size-8 items-center justify-center rounded-md bg-gold font-display text-lg font-extrabold text-ink-950">M</span>
          <span className="font-display text-lg font-bold uppercase tracking-wider">League office</span>
        </Link>
        <nav className="scroll-x flex gap-1 px-2 pb-2 lg:block lg:space-y-0.5" aria-label="Administration">
          {SECTIONS.map(([to, label, Icon]) => (
            <NavLink key={to} to={`/admin/${to}`} className={({ isActive }) => cx('flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm', isActive ? 'bg-gold/15 font-semibold text-gold-soft' : 'text-ink-200 hover:bg-ink-800')}><Icon className="size-4 shrink-0" />{label}</NavLink>))}
        </nav>
        <div className="hidden border-t border-ink-700 p-3 text-xs text-ink-400 lg:block">
          <p className="flex items-center gap-1.5 text-ink-200"><Users className="size-3.5" />{admin.name}</p><p className="truncate">{admin.email}</p>
          <div className="mt-2 flex gap-2"><Link to="/" className="hover:text-ink-100">Public site</Link><button onClick={onLogout} className="inline-flex items-center gap-1 hover:text-ink-100"><LogOut className="size-3" />Sign out</button></div>
        </div>
      </aside>
      <main className="min-w-0 p-3 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-400">Season</span><SeasonSelect className="!py-1 !text-xs" />
          <button onClick={onLogout} className="text-xs text-ink-400 hover:text-ink-100 lg:hidden">Sign out</button>
        </div>
        {loading && !meta ? <Spinner /> : !meta?.season ? (
          <Routes><Route path="teams" element={<TeamManager />} /><Route path="audit" element={<AuditHistory />} /><Route path="*" element={<><Overview /><div className="mt-4"><TeamManager /></div></>} /></Routes>
        ) : (
          <Routes>
            <Route index element={<Overview />} />
            <Route path="simulation" element={<SimulationCenter />} />
            <Route path="primetime" element={<PrimetimeImport />} />
            <Route path="schedule" element={<ScheduleManager />} />
            <Route path="teams" element={<TeamManager />} />
            <Route path="roster" element={<RosterManager />} />
            <Route path="percentages" element={<Percentages />} />
            <Route path="rankings" element={<RankingsManager />} />
            <Route path="review" element={<ResultsReview />} />
            <Route path="review/:runId" element={<RunDetail />} />
            <Route path="publishing" element={<PublishingCenter />} />
            <Route path="settings" element={<SimSettings />} />
            <Route path="audit" element={<AuditHistory />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

export default function Admin({ setup }: { setup?: boolean }) {
  const me = useApi<{ admin: { id: string; name: string; email: string } | null }>('/auth/me');
  if (setup) return <Setup />;
  if (me.loading && !me.data) return <Spinner />;
  if (!me.data?.admin) return <Login onDone={me.reload} />;
  return <Shell admin={me.data.admin} onLogout={async () => { await api.post('/auth/logout').catch(() => {}); me.reload(); }} />;
}
