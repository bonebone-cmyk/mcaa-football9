import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG } from '../../../engine/types';
import { api, qs, useApi } from '../../api';
import { TeamLogo, fmtAgo, useSeason } from '../../shared';
import { Badge, Button, Card, Check, Empty, ErrorBox, Field, Input, Load, Notice, Select, Textarea, cx, td, tdr, tdw, th, thr, useAction } from '../../ui';
import { useTeams, weeksOf } from './sim';

type Row = Record<string, any>;

// ================================================================== TEAM PERCENTAGES
type PctDraft = { activity: string; upset: string; star: string };
const PCT_KEYS = ['activity', 'upset', 'star'] as const;
const asDraft = (t: Row): PctDraft => ({ activity: t.activity == null ? '' : String(t.activity), upset: t.upset == null ? '' : String(t.upset), star: t.star == null ? '' : String(t.star) });
const pctError = (v: string) => (v.trim() === '' ? 'empty' : Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100 ? null : 'range');

export function Percentages() {
  const { seasonId } = useSeason();
  const team = useTeams();
  const [view, setView] = useState('');
  const q = useApi<any>(`/admin/percentages${qs({ season: seasonId, snapshot: view })}`);
  const [draft, setDraft] = useState<Record<string, PctDraft>>({});
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [content, setContent] = useState('team,activity,upset,star\n');
  const [preview, setPreview] = useState<Row | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState('');
  const act = useAction();
  const save = useAction();
  useEffect(() => { if (q.data) setDraft(Object.fromEntries(q.data.teams.map((t: Row) => [t.teamId, asDraft(t)]))); }, [q.data]);

  const rows: Row[] = q.data ? [...q.data.teams].sort((a: Row, b: Row) => team(a.teamId).name.localeCompare(team(b.teamId).name)) : [];
  const changed = rows.filter((t) => { const d = draft[t.teamId]; return d && PCT_KEYS.some((k) => d[k] !== asDraft(t)[k]); });
  const invalid = changed.filter((t) => { const d = draft[t.teamId]; const blank = PCT_KEYS.every((k) => d[k].trim() === ''); return !blank && PCT_KEYS.some((k) => pctError(d[k])); });
  const setCell = (teamId: string, k: (typeof PCT_KEYS)[number], v: string) => { setSaved(''); setDraft((d) => ({ ...d, [teamId]: { ...d[teamId], [k]: v.replace(/[^0-9.]/g, '') } })); };
  const saveAll = () => save.run(async () => {
    const set = changed.filter((t) => !PCT_KEYS.every((k) => draft[t.teamId][k].trim() === '')).map((t) => ({ teamId: t.teamId, activity: Number(draft[t.teamId].activity), upset: Number(draft[t.teamId].upset), star: Number(draft[t.teamId].star) }));
    const clear = changed.filter((t) => PCT_KEYS.every((k) => draft[t.teamId][k].trim() === '')).map((t) => t.teamId);
    if (clear.length && !confirm(`Remove the stored percentages for ${clear.map((id) => team(id).name).join(', ')}? Their games cannot be simulated until new values are entered.`)) return;
    const r = await api.put('/admin/percentages', { seasonId, set, clear });
    setSaved(`Saved ${set.length + clear.length} team${set.length + clear.length === 1 ? '' : 's'}.${r.coverage.missing.length ? ` Still missing: ${r.coverage.missing.join(', ')}.` : ''}`);
    q.reload();
  });
  const send = (dryRun: boolean) => act.run(async () => {
    const r = await api.post('/admin/percentages/import', { seasonId, format, content, dryRun });
    setWarnings(r.warnings ?? []);
    if (dryRun) setPreview(r); else { setPreview(null); q.reload(); }
  });
  const missing = rows.filter((t) => t.activity == null).length;

  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase">Team Percentages</h1>
      <Notice>
        <p><b>Percentages are stored in the league database and set here by administrators.</b> They are never invented, defaulted or estimated: a team without values cannot be simulated. When a game is simulated, the current values are frozen into a snapshot that the result keeps, so later edits never change a stored game. Activity, Upset and Star are rolled separately and recorded.</p>
        <ul className="mt-1 list-disc pl-5"><li><b>Activity</b> — preparedness. One check per team per quarter: sharper or flatter execution, penalties and fumbles.</li><li><b>Upset</b> — underdog potential. One check per team per half: an underdog closes part of the rating gap and forces more turnovers. It never helps a favorite.</li><li><b>Star</b> — individual brilliance. One check per featured player: more touches and bigger plays for that player only.</li></ul>
      </Notice>
      <Load q={q}>{(d) => (
        <>
          <Card title={`Current percentages (${rows.length - missing} of ${rows.length} teams set)`} pad={false}
            action={<span className="flex items-center gap-2">{changed.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setDraft(Object.fromEntries(rows.map((t) => [t.teamId, asDraft(t)]))); setSaved(''); }}>Discard</Button>}<Button size="sm" variant="primary" busy={save.busy} disabled={!changed.length || invalid.length > 0} onClick={saveAll}>Save {changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'}` : 'changes'}</Button></span>}>
            {rows.length ? (
              <div className="scroll-x"><table className="w-full min-w-[640px]">
                <thead><tr className="border-b border-ink-700"><th className={th}>Team</th>{PCT_KEYS.map((k) => <th key={k} className={thr}>{k}</th>)}<th className={th}>Last changed</th></tr></thead>
                <tbody>{rows.map((t) => {
                  const dr = draft[t.teamId] ?? asDraft(t);
                  const isChanged = changed.includes(t);
                  return (
                    <tr key={t.teamId} className={cx('border-b border-ink-800 last:border-0', isChanged && 'bg-gold/5')}>
                      <td className={td}><span className="flex items-center gap-2"><TeamLogo team={team(t.teamId)} size={20} />{team(t.teamId).name}{t.activity == null && !isChanged && <Badge tone="red">Not set</Badge>}</span></td>
                      {PCT_KEYS.map((k) => {
                        const blankRow = PCT_KEYS.every((x) => dr[x].trim() === '');
                        const err = !blankRow && pctError(dr[k]);
                        return <td key={k} className={cx(td, 'text-right')}><span className="inline-flex items-center gap-1"><Input aria-label={`${team(t.teamId).name} ${k}`} inputMode="decimal" className={cx('!w-20 text-right tnum', err && '!border-red-500')} value={dr[k]} onChange={(e) => setCell(t.teamId, k, e.target.value)} /><span className="text-ink-400">%</span></span></td>;
                      })}
                      <td className={cx(td, 'text-xs text-ink-400')}>{t.updatedAt ? `${fmtAgo(t.updatedAt, d.serverTime)}${t.updatedBy ? ` · ${t.updatedBy}` : ''}` : '—'}</td>
                    </tr>);
                })}</tbody>
              </table></div>
            ) : <Empty>No teams are entered in this season yet. Add them in Team Manager.</Empty>}
            <div className="space-y-2 border-t border-ink-700 px-3 py-2">
              <p className="text-xs text-ink-400">Each value is 0–100. Fill in all three for a team, or clear all three to remove its values.</p>
              {invalid.length > 0 && <p className="text-xs text-red-300">Check {invalid.map((t) => team(t.teamId).name).join(', ')}: every value must be a number from 0 to 100, and all three must be filled in.</p>}
              <ErrorBox error={save.error} />
              {saved && <Notice tone="ok">{saved}</Notice>}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
            <Card title="Import from a file (optional)">
              <div className="mb-2 flex gap-2"><Select className="!w-28" value={format} onChange={(e) => { setFormat(e.target.value as 'csv' | 'json'); setPreview(null); }}><option value="csv">CSV</option><option value="json">JSON</option></Select>
                <input type="file" accept=".csv,.json,.txt" className="text-xs" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setContent(await f.text()); setFormat(f.name.endsWith('.json') ? 'json' : 'csv'); setPreview(null); } }} /></div>
              <Textarea rows={6} value={content} onChange={(e) => { setContent(e.target.value); setPreview(null); }} spellCheck={false} placeholder={format === 'csv' ? 'team,activity,upset,star\nTUL,85,35,70' : '[{"team":"TUL","activity":85,"upset":35,"star":70}]'} />
              <p className="mt-1 text-xs text-ink-400">Updates the teams listed in the file; other teams keep their values. Teams may be identified by name, short name, abbreviation or id. Extra numeric columns are stored as additional categories for future use. Any invalid row rejects the whole file.</p>
              <ErrorBox className="mt-2" error={act.error} />
              {warnings.map((w) => <Notice key={w} tone="warn" className="mt-2">{w}</Notice>)}
              {preview && <Notice tone="ok" className="mt-2">Valid: {preview.entries.length} teams. Review the values, then save them.
                <span className="mt-1 block text-xs">{preview.entries.map((e: Row) => `${team(e.teamId).abbr} ${e.activity}/${e.upset}/${e.star}`).join(' · ')}</span></Notice>}
              <div className="mt-2 flex gap-2"><Button busy={act.busy} onClick={() => send(true)}>Validate</Button><Button variant="primary" busy={act.busy} disabled={!preview || changed.length > 0} title={changed.length ? 'Save or discard the edits above first' : undefined} onClick={() => send(false)}>Save to database</Button></div>
            </Card>
            <Card title="Snapshots used by simulations" pad={false}>
              {d.snapshots.length ? <ul className="max-h-80 divide-y divide-ink-800 overflow-y-auto">{d.snapshots.map((s: Row, i: number) => (
                <li key={s.id}><button onClick={() => setView(view === s.id ? '' : s.id)} className={cx('block w-full px-3 py-2 text-left text-sm hover:bg-ink-800', d.viewing === s.id && 'bg-ink-800')}>
                  <span className="flex items-center gap-2"><b>{new Date(s.fetched_at).toLocaleString()}</b>{i === 0 && <Badge tone="green">Latest</Badge>}</span>
                  <span className="text-xs text-ink-400">{s.team_count} teams · {fmtAgo(s.fetched_at, d.serverTime)} · checksum {s.checksum.slice(0, 8)}</span>
                </button></li>))}</ul> : <Empty>No game has been simulated yet. A snapshot is taken automatically the first time one is.</Empty>}
            </Card>
          </div>
          {d.viewing && (
            <Card title={`Snapshot from ${new Date(d.snapshots.find((s: Row) => s.id === d.viewing)?.fetched_at ?? 0).toLocaleString()} (read-only)`} pad={false} action={<Button size="sm" variant="ghost" onClick={() => setView('')}>Close</Button>}>
              <table className="w-full"><thead><tr className="border-b border-ink-700"><th className={th}>Team</th><th className={thr}>Activity</th><th className={thr}>Upset</th><th className={thr}>Star</th><th className={th}>Other categories</th></tr></thead>
                <tbody>{[...d.entries].sort((a: Row, b: Row) => team(a.teamId).name.localeCompare(team(b.teamId).name)).map((e: Row) => (
                  <tr key={e.teamId} className="border-b border-ink-800 last:border-0"><td className={td}><span className="flex items-center gap-2"><TeamLogo team={team(e.teamId)} size={20} />{team(e.teamId).name}</span></td><td className={tdr}>{e.activity}%</td><td className={tdr}>{e.upset}%</td><td className={tdr}>{e.star}%</td><td className={cx(td, 'text-xs text-ink-400')}>{Object.entries(e.extra).map(([k, v]) => `${k} ${v}%`).join(', ')}</td></tr>))}</tbody></table>
            </Card>)}
        </>)}</Load>
    </div>
  );
}

// ================================================================== RANKINGS MANAGER
export function RankingsManager() {
  const { seasonId, meta } = useSeason();
  const team = useTeams();
  const [week, setWeek] = useState<number>(meta?.currentWeek ?? 1);
  const q = useApi<any>(`/admin/rankings${qs({ season: seasonId, week })}`);
  const [list, setList] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [add, setAdd] = useState('');
  const act = useAction();
  useEffect(() => { if (q.data) { setList(q.data.teamIds); setDraft(null); } }, [q.data]);
  const move = (i: number, d: number) => setList((l) => { const n = [...l]; const j = i + d; if (j < 0 || j >= n.length) return l; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const dirty = q.data && JSON.stringify(list) !== JSON.stringify(q.data.teamIds);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="font-display text-3xl font-bold uppercase">Rankings Manager</h1>
        <Field label="Poll week" className="ml-auto w-32"><Select value={week} onChange={(e) => setWeek(Number(e.target.value))}>{[0, ...weeksOf(meta)].map((w) => <option key={w} value={w}>{w === 0 ? 'Preseason' : `Week ${w}`}</option>)}</Select></Field>
      </div>
      <p className="max-w-3xl text-sm text-ink-300">AP-style rankings are set by administrators. A week without its own poll shows the most recent earlier poll publicly.</p>
      <ErrorBox error={act.error} />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card title={`Week ${week} poll`} action={q.data && (q.data.published ? <Badge tone="green">Published</Badge> : <Badge>Not published</Badge>)}>
          {draft && <Notice tone="warn" className="mb-3">{draft} This is a draft in your browser only. Nothing is official until you press Publish rankings.</Notice>}
          {!list.length && <Empty>No teams ranked for this week yet.</Empty>}
          <ol className="space-y-1">{list.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5">
              <span className="w-7 text-center font-display text-xl font-bold tnum">{i + 1}</span><TeamLogo team={team(id)} size={24} /><span className="flex-1 font-medium">{team(id).name}</span>
              <button aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 hover:bg-ink-700 disabled:opacity-30"><ArrowUp className="size-4" /></button>
              <button aria-label="Move down" onClick={() => move(i, 1)} disabled={i === list.length - 1} className="rounded p-1 hover:bg-ink-700 disabled:opacity-30"><ArrowDown className="size-4" /></button>
              <button aria-label="Remove" onClick={() => setList(list.filter((x) => x !== id))} className="rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-white"><X className="size-4" /></button>
            </li>))}</ol>
          {list.length < 25 && <div className="mt-3 flex gap-2"><Select value={add} onChange={(e) => setAdd(e.target.value)}><option value="">Add a team…</option>{meta?.teams.filter((t) => !list.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select><Button disabled={!add} onClick={() => { setList([...list, add]); setAdd(''); }}>Add</Button></div>}
          <div className="mt-4 flex justify-end gap-2">{dirty && <Button variant="ghost" onClick={() => { setList(q.data.teamIds); setDraft(null); }}>Discard changes</Button>}<Button variant="primary" busy={act.busy} disabled={!dirty && q.data?.published} onClick={() => act.run(async () => { await api.put('/admin/rankings', { seasonId, week, teamIds: list }); q.reload(); })}>Publish rankings</Button></div>
        </Card>
        <Card title="Start from…">
          <div className="space-y-2">
            <Button className="w-full" disabled={!q.data?.carried.length} onClick={() => { setList(q.data.carried); setDraft(`Loaded the week ${q.data.carriedFromWeek} poll.`); }}>The previous poll{q.data?.carriedFromWeek != null ? ` (week ${q.data.carriedFromWeek})` : ''}</Button>
            <Button className="w-full" busy={act.busy} onClick={() => act.run(async () => { const r = await api.get(`/admin/rankings/recommendation${qs({ season: seasonId })}`); if (!r.recommendation.length) throw new Error('No published results yet, so there is nothing to compute a recommendation from.'); setList(r.recommendation.map((x: Row) => x.teamId)); setDraft(`Loaded a computed recommendation. ${r.method}`); })}>A computed recommendation</Button>
            <p className="text-xs text-ink-400">A recommendation is only a starting point based on results so far. It never changes the official rankings by itself.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ================================================================== SIMULATION SETTINGS
export function SimSettings() {
  const { seasonId } = useSeason();
  const q = useApi<any>(`/admin/settings${qs({ season: seasonId })}`);
  const [c, setC] = useState<Row | null>(null);
  const [pw, setPw] = useState({ current: '', next: '' });
  const act = useAction();
  const pwAct = useAction();
  const [saved, setSaved] = useState('');
  useEffect(() => { if (q.data) setC(q.data.config); }, [q.data]);
  if (!c) return q.error ? <ErrorBox error={q.error} /> : null;
  const num = (k: string, label: string, hint: string, step = 0.1) => <Field label={label} hint={hint}><Input type="number" step={step} value={c[k]} onChange={(e) => setC({ ...c, [k]: e.target.value })} /></Field>;
  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase">Simulation Settings</h1>
      <p className="max-w-3xl text-sm text-ink-300">These settings apply to future simulations in this season. Results that already exist keep the settings they were created with; stored simulations are never altered. Team ratings, schemes and run/pass ratios are set per team in Team Manager.</p>
      <Card title="Engine">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {num('homeFieldAdvantage', 'Home-field advantage', `Rating points for the home team (default ${DEFAULT_CONFIG.homeFieldAdvantage}). Ignored at neutral sites.`)}
          <Field label="Sack statistics" hint="NCAA: sack yardage counts against the passer's rushing. NFL: against team passing."><Select value={c.sackConvention} onChange={(e) => setC({ ...c, sackConvention: e.target.value })}><option value="ncaa">NCAA convention</option><option value="nfl">NFL convention</option></Select></Field>
          {num('activityEffect', 'Activity effect', `Rating points gained or lost in a quarter by an Activity check (default ${DEFAULT_CONFIG.activityEffect}).`)}
          {num('upsetGapClosure', 'Upset gap closure', `Share of the rating gap an underdog closes when its Upset check passes, 0–1 (default ${DEFAULT_CONFIG.upsetGapClosure}).`, 0.05)}
          {num('starBoost', 'Star boost', `Individual rating points for a player whose Star check passes (default ${DEFAULT_CONFIG.starBoost}).`, 1)}
          <div className="self-end pb-2"><Check label="Allow inactive players to appear in simulations" checked={!!c.allowInactive} onChange={(v) => setC({ ...c, allowInactive: v })} /></div>
        </div>
        <p className="mt-3 text-xs text-ink-400">The three percentage effects are separate dials because the three checks are separate: they are never added together or averaged into one number.</p>
      </Card>
      <ErrorBox error={act.error} />
      <div className="flex items-center gap-3"><Button variant="primary" busy={act.busy} onClick={() => act.run(async () => {
        setSaved('');
        await api.put('/admin/settings', { seasonId, config: { homeFieldAdvantage: Number(c.homeFieldAdvantage), sackConvention: c.sackConvention, activityEffect: Number(c.activityEffect), upsetGapClosure: Number(c.upsetGapClosure), starBoost: Number(c.starBoost), allowInactive: !!c.allowInactive } });
        setSaved('Settings saved.'); q.reload();
      })}>Save settings</Button>{saved && <span className="text-sm text-emerald-300">{saved}</span>}</div>
      <Card title="AI features">
        <p className="text-sm text-ink-200">{q.data.aiConfigured ? 'AI recaps and screenshot reading are available. AI text is checked against the game data before it is accepted; if it states anything that is not in the data, the standard recap is used instead.' : 'AI recaps and screenshot reading are off. To enable them, add the ANTHROPIC_API_KEY secret to the Worker. Everything else works without it: recaps are written from the game data by the engine.'}</p>
      </Card>
      <Card title="Change your password">
        <form className="grid max-w-xl gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); pwAct.run(async () => { await api.post('/auth/password', pw); setPw({ current: '', next: '' }); alert('Password changed.'); }); }}>
          <Field label="Current password"><Input type="password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></Field>
          <Field label="New password (10+ characters)"><Input type="password" required minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
          <Button busy={pwAct.busy}>Change</Button>
        </form>
        <ErrorBox className="mt-2" error={pwAct.error} />
      </Card>
    </div>
  );
}

// ================================================================== AUDIT HISTORY
export function AuditHistory() {
  const [offset, setOffset] = useState(0);
  const q = useApi<any>(`/admin/audit${qs({ limit: 100, offset })}`);
  const [open, setOpen] = useState<number | null>(null);
  const nice = (a: string) => a.replace(/_/g, ' ');
  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase">Audit History</h1>
      <p className="text-sm text-ink-300">Every administrative action is recorded with who did it, when, and the values before and after. The log is append-only: entries cannot be edited or deleted, even directly in the database.</p>
      <Load q={q}>{(d) => !d.entries.length ? <Card><Empty>No actions recorded yet.</Empty></Card> : (
        <Card pad={false}><div className="scroll-x"><table className="w-full min-w-[720px]">
          <thead><tr className="border-b border-ink-700"><th className={th}>When</th><th className={th}>Administrator</th><th className={th}>Action</th><th className={th}>Record</th><th className={th}>Reason</th><th className={thr} /></tr></thead>
          <tbody>{d.entries.map((e: Row) => (<>
            <tr key={e.id} className="border-b border-ink-800">
              <td className={cx(td, 'text-ink-200')}>{new Date(e.created_at).toLocaleString()}</td><td className={td}>{e.admin_name ?? '—'}</td>
              <td className={td}><Badge tone={/corrected|withdrawn|removed|deleted|canceled|rejected/.test(e.action) ? 'red' : /published|approved/.test(e.action) ? 'green' : 'neutral'}>{nice(e.action)}</Badge></td>
              <td className={cx(td, 'text-xs text-ink-300')}>{e.entity}{e.game_id ? ` · game ${String(e.game_id).slice(0, 8)}` : e.entity_id ? ` · ${String(e.entity_id).slice(0, 8)}` : ''}</td><td className={tdw}>{e.reason ?? ''}</td>
              <td className={cx(td, 'text-right')}>{(e.previous_value != null || e.new_value != null) && <Button size="sm" variant="ghost" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide' : 'Details'}</Button>}</td>
            </tr>
            {open === e.id && <tr key={`${e.id}-d`} className="border-b border-ink-800 bg-ink-900"><td colSpan={6} className="px-3 py-2"><div className="grid gap-3 md:grid-cols-2">
              <div><p className="mb-1 text-[11px] font-semibold uppercase text-ink-400">Previous value</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-ink-950 p-2 text-xs text-ink-200">{e.previous_value == null ? '—' : JSON.stringify(e.previous_value, null, 2)}</pre></div>
              <div><p className="mb-1 text-[11px] font-semibold uppercase text-ink-400">New value</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-ink-950 p-2 text-xs text-ink-200">{e.new_value == null ? '—' : JSON.stringify(e.new_value, null, 2)}</pre></div></div></td></tr>}
          </>))}</tbody></table></div>
          <div className="flex justify-between border-t border-ink-700 p-2"><Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>← Newer</Button><Button size="sm" variant="ghost" disabled={d.entries.length < 100} onClick={() => setOffset(offset + 100)}>Older →</Button></div>
        </Card>)}</Load>
    </div>
  );
}
