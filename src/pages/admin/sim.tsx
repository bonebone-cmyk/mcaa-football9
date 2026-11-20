import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { playResult } from '../../../engine/describe';
import { passerRating } from '../../../engine/stats';
import type { GameResult } from '../../../engine/types';
import { ApiError, api, qs, useApi } from '../../api';
import { TeamLogo, fmtAgo, useSeason, type TeamRef } from '../../shared';
import { Badge, Button, Card, Check, Empty, ErrorBox, Field, Input, Load, Modal, Notice, Select, Tabs, cx, td, tdr, tdw, th, thr, useAction } from '../../ui';
import { BoxScore, Highlights, PlayByPlay, ScoreChart, ScoringSummary, TeamStats } from '../Game';

type Row = Record<string, any>;
export const RUN_TONE: Record<string, 'gold' | 'green' | 'blue' | 'red' | 'neutral'> = { candidate: 'gold', approved: 'blue', published: 'green', rejected: 'red', superseded: 'neutral' };
export const RUN_LABEL: Record<string, string> = { candidate: 'Awaiting review', approved: 'Approved', published: 'Published', rejected: 'Rejected', superseded: 'Superseded' };

export function useTeams() {
  const { meta } = useSeason();
  return useMemo(() => {
    const m = new Map((meta?.teams ?? []).map((t) => [t.id, t]));
    return (id: string): TeamRef => {
      const t = m.get(id);
      return { id, name: t?.name ?? 'Unknown team', short: t?.short ?? '?', abbr: t?.abbr ?? '?', color: t?.color ?? '#334155', color2: t?.color2 ?? '#fff', logo: t?.logo ?? null, rank: null, record: '', score: null };
    };
  }, [meta]);
}
export const weeksOf = (meta: ReturnType<typeof useSeason>['meta']) => [...new Set([...(meta?.weeks ?? []), ...Array.from({ length: meta?.season?.weeks ?? 1 }, (_, i) => i + 1)])].sort((a, b) => a - b);

const Pct = ({ p }: { p: Row | null }) => p ? <span className="text-xs tnum text-ink-200" title="Activity / Upset / Star">{p.activity}<span className="text-ink-500">/</span>{p.upset}<span className="text-ink-500">/</span>{p.star}</span> : <Badge tone="red" title="No percentages stored for this team">not set</Badge>;

/** Publish dialog: instant or replay presentation; a correction of an official result needs confirmation and a reason. */
export function PublishDialog({ runId, mode, correction, onClose, onDone }: { runId: string; mode: string; correction: Row | null; onClose: () => void; onDone: () => void }) {
  const [present, setPresent] = useState(false);
  const [seconds, setSeconds] = useState(4);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState('');
  const act = useAction();
  return (
    <Modal title={correction ? 'Correct an official result' : 'Publish result'} onClose={onClose}>
      <div className="space-y-3">
        {correction && <Notice tone="warn">This game already has an official result ({correction.away}–{correction.home}). Publishing replaces it; team records and season statistics are recalculated, the previous version is kept in history and the change is written to the audit log.</Notice>}
        {mode === 'sim' ? (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm"><input type="radio" className="mt-1 accent-[#f5b301]" checked={!present} onChange={() => setPresent(false)} /><span><b>Instant.</b> The final score, box score and play-by-play are public immediately.</span></label>
            <label className="flex items-start gap-2 text-sm"><input type="radio" className="mt-1 accent-[#f5b301]" checked={present} onChange={() => setPresent(true)} /><span><b>Presentation.</b> The finished game is replayed play by play for viewers, labeled as a simulation replay. The result is already decided and cannot change; it counts in team records and statistics when the replay ends.</span></label>
            {present && <Field label="Seconds per play"><Select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>{[1, 2, 4, 8, 15, 30].map((s) => <option key={s} value={s}>{s} s per play (about {Math.round((170 * s) / 60)} min total)</option>)}</Select></Field>}
          </div>
        ) : <p className="text-sm text-ink-200">The verified CFB 27 score becomes official immediately. Reconstructed statistics and highlights are labeled as generated on the public page.</p>}
        {correction && <><Field label="Reason for the correction (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong score entered" /></Field><Check label="I confirm I am replacing an official result." checked={confirm} onChange={setConfirm} /></>}
        <ErrorBox error={act.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={act.busy} disabled={!!correction && (!confirm || !reason.trim())} onClick={() => act.run(async () => { await api.post(`/admin/runs/${runId}/publish`, { presentationMsPerPlay: present && mode === 'sim' ? seconds * 1000 : null, confirm: correction ? confirm : undefined, reason: correction ? reason : undefined }); onDone(); })}>{correction ? 'Publish correction' : 'Publish'}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ================================================================== SIMULATION CENTER
export function SimulationCenter() {
  const { seasonId, meta, reload: reloadMeta } = useSeason();
  const team = useTeams();
  const [week, setWeek] = useState<number>(meta?.currentWeek ?? 1);
  const games = useApi<any>(`/admin/games${qs({ season: seasonId, week })}`);
  const pct = useApi<any>(`/admin/percentages${qs({ season: seasonId })}`);
  const settings = useApi<any>(`/admin/settings${qs({ season: seasonId })}`);
  const [snapshot, setSnapshot] = useState('');
  const [aiRecap, setAiRecap] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [batch, setBatch] = useState<{ done: number; total: number; log: { game: string; ok: boolean; text: string; runId?: string }[] } | null>(null);
  const [publish, setPublish] = useState<Row | null>(null);
  const nav = useNavigate();
  const refresh = () => { games.reload(); reloadMeta(); };
  const label = (g: Row) => `${team(g.away_team_id).short} at ${team(g.home_team_id).short}`;

  const simulate = async (g: Row, regenerate: boolean, snapshotId?: string) => api.post(`/admin/games/${g.id}/simulate`, { snapshotId: snapshotId ?? (snapshot || null), regenerate, aiRecap });
  const one = async (g: Row, regenerate: boolean) => {
    setBusy(g.id); setError(null);
    try { await simulate(g, regenerate); refresh(); } catch (e) { setError(e); } finally { setBusy(null); }
  };
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); refresh(); } catch (e) { setError(e); } finally { setBusy(null); }
  };

  const simulateWeek = async () => {
    const list: Row[] = (games.data?.games ?? []).filter((g: Row) => g.mode === 'sim' && (g.status === 'scheduled' || g.status === 'postponed') && !g.run);
    if (!list.length) return setError(new Error('No unsimulated games in this week. Games with a pending or published result are skipped to prevent duplicate processing.'));
    setError(null);
    const log: { game: string; ok: boolean; text: string; runId?: string }[] = [];
    setBatch({ done: 0, total: list.length, log });
    // 1. One percentage snapshot for the whole batch.
    let snapId = snapshot;
    try {
      if (!snapId) snapId = (await api.post('/admin/percentages/snapshot', { seasonId })).snapshot.id;
    } catch (e) {
      setBatch(null);
      return setError(e);
    }
    // 2. Validate every matchup before anything runs.
    const ready: Row[] = [];
    for (const g of list) {
      try {
        const pre = await api.get(`/admin/games/${g.id}/preflight`);
        const errs = pre.teams.flatMap((t: Row) => t.errors);
        if (errs.length) log.push({ game: label(g), ok: false, text: errs.join(' ') });
        else ready.push(g);
      } catch (e) { log.push({ game: label(g), ok: false, text: (e as Error).message }); }
      setBatch({ done: log.length, total: list.length, log: [...log] });
    }
    // 3. Simulate each game in its own request: a failure in one cannot affect another.
    for (const g of ready) {
      try {
        const r = await simulate(g, false, snapId);
        log.push({ game: label(g), ok: r.valid, text: r.valid ? `${team(g.away_team_id).abbr} ${r.final[0]}, ${team(g.home_team_id).abbr} ${r.final[1]}` : 'Simulated but failed validation — review before use.', runId: r.runId });
      } catch (e) {
        const err = e as ApiError;
        log.push({ game: label(g), ok: false, text: [err.message, ...(err.details ?? [])].join(' ') });
      }
      setBatch({ done: log.length, total: list.length, log: [...log] });
    }
    pct.reload();
    refresh();
  };

  const snaps: Row[] = pct.data?.snapshots ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="font-display text-3xl font-bold uppercase">Simulation Center</h1>
        <Field label="Week" className="ml-auto w-28"><Select value={week} onChange={(e) => setWeek(Number(e.target.value))}>{weeksOf(meta).map((w) => <option key={w} value={w}>Week {w}</option>)}</Select></Field>
        <Field label="Percentages" className="w-72">
          <Select value={snapshot} onChange={(e) => setSnapshot(e.target.value)}>
            <option value="">Current team percentages{pct.data ? ` (${pct.data.teams.filter((t: Row) => t.activity != null).length} of ${pct.data.teams.length} teams set)` : ''}</option>
            {snaps.map((s) => <option key={s.id} value={s.id}>{new Date(s.fetched_at).toLocaleString()} · {s.source} · {s.team_count} teams · {fmtAgo(s.fetched_at, pct.data.serverTime)}</option>)}
          </Select>
        </Field>
        <Button variant="primary" onClick={simulateWeek} disabled={!!busy || (!!batch && batch.done < batch.total)}>Simulate week {week}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <Check label="Write recaps with AI (falls back to the standard recap if unavailable)" checked={aiRecap && !!settings.data?.aiConfigured} onChange={setAiRecap} disabled={!settings.data?.aiConfigured} />
        {snapshot && <span className="text-amber-200">Using a previously verified snapshot from {fmtAgo(snaps.find((s) => s.id === snapshot)?.fetched_at ?? 0, pct.data?.serverTime)}.</span>}
        <span className="text-xs text-ink-400">Percentages show the current Activity / Upset / Star values stored for each team. <Link className="underline" to="/admin/percentages">Edit them</Link>.</span>
      </div>
      <ErrorBox error={error} />
      {batch && (
        <Card title={`Batch progress: ${batch.done} of ${batch.total}`} action={batch.done >= batch.total ? <Button size="sm" variant="ghost" onClick={() => setBatch(null)}>Dismiss</Button> : undefined}>
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-ink-700"><div className="h-full bg-gold transition-all" style={{ width: `${(100 * batch.done) / Math.max(1, batch.total)}%` }} /></div>
          <ul className="space-y-1 text-sm">{batch.log.map((l, i) => <li key={i} className="flex flex-wrap items-center gap-2"><Badge tone={l.ok ? 'green' : 'red'}>{l.ok ? 'Simulated' : 'Failed'}</Badge><b>{l.game}</b><span className={l.ok ? 'text-ink-200' : 'text-red-200'}>{l.text}</span>{l.runId && <Link className="text-gold-soft underline" to={`/admin/review/${l.runId}`}>Review</Link>}</li>)}</ul>
        </Card>)}
      <Load q={games}>{(d) => !d.games.length ? <Card><Empty>No games are scheduled for week {week}. Add them in Schedule Manager.</Empty></Card> : (
        <Card pad={false}>
          <div className="scroll-x"><table className="w-full min-w-[900px]">
            <thead><tr className="border-b border-ink-700"><th className={th}>Matchup</th><th className={th}>Records</th><th className={th}>Percentages (A/U/S)</th><th className={th}>Mode</th><th className={th}>Status</th><th className={thr}>Actions</th></tr></thead>
            <tbody>{d.games.map((g: Row) => {
              const a = team(g.away_team_id), h = team(g.home_team_id);
              const run = g.run;
              const pending = run && (run.status === 'candidate' || run.status === 'approved');
              const b = busy === g.id;
              return (
                <tr key={g.id} className="border-b border-ink-800 last:border-0 align-middle">
                  <td className={td}><span className="flex items-center gap-2"><TeamLogo team={a} size={20} /><b>{a.short}</b><span className="text-ink-400">at</span><TeamLogo team={h} size={20} /><b>{h.short}</b></span></td>
                  <td className={cx(td, 'tnum text-ink-200')}>{g.awayRecord} · {g.homeRecord}</td>
                  <td className={td}><Pct p={g.awayPct} /> <span className="mx-1 text-ink-500">·</span> <Pct p={g.homePct} /></td>
                  <td className={td}><Badge tone={g.mode === 'primetime' ? 'purple' : 'neutral'}>{g.mode === 'primetime' ? 'CFB 27 primetime' : 'Simulation'}</Badge></td>
                  <td className={td}>
                    {g.status === 'final' && <Badge tone="green">Final {g.away_score}–{g.home_score}</Badge>}
                    {g.status !== 'final' && !run && <Badge>{g.status.replace('_', ' ')}</Badge>}
                    {pending && <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]} · {run.away_score}–{run.home_score}{run.valid ? '' : ' · invalid'}</Badge>}
                  </td>
                  <td className={cx(td, 'text-right')}>
                    <span className="inline-flex flex-wrap justify-end gap-1.5">
                      {g.status === 'canceled' ? null : pending ? <>
                        <Button size="sm" variant="outline" onClick={() => nav(`/admin/review/${run.id}`)}>Preview</Button>
                        {run.mode === 'sim' && <Button size="sm" busy={b} onClick={() => one(g, true)}>Regenerate</Button>}
                        {run.status === 'candidate' && <Button size="sm" busy={b} disabled={!run.valid} onClick={() => act(g.id, () => api.post(`/admin/runs/${run.id}/approve`))}>Approve</Button>}
                        {run.status === 'approved' && <Button size="sm" variant="primary" onClick={() => setPublish({ runId: run.id, mode: run.mode, correction: g.status === 'final' ? { away: g.away_score, home: g.home_score } : null })}>Publish</Button>}
                      </> : <>
                        {g.status === 'final' && <Link className="self-center text-xs text-gold-soft underline" to={`/games/${g.id}`}>Public page</Link>}
                        <Button size="sm" variant={g.mode === 'sim' && g.status !== 'final' ? 'primary' : 'secondary'} busy={b} onClick={() => one(g, false)}>{g.status === 'final' ? 'Re-simulate' : 'Simulate game'}</Button>
                        <Button size="sm" variant={g.mode === 'primetime' && g.status !== 'final' ? 'primary' : 'outline'} onClick={() => nav(`/admin/primetime?game=${g.id}`)}>Import primetime</Button>
                      </>}
                    </span>
                  </td>
                </tr>);
            })}</tbody>
          </table></div>
        </Card>)}</Load>
      {publish && <PublishDialog runId={publish.runId} mode={publish.mode} correction={publish.correction} onClose={() => setPublish(null)} onDone={() => { setPublish(null); refresh(); }} />}
    </div>
  );
}

// ================================================================== RESULTS REVIEW
export function ResultsReview() {
  const { seasonId } = useSeason();
  const team = useTeams();
  const q = useApi<any>(`/admin/review${qs({ season: seasonId })}`);
  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase">Results Review</h1>
      <p className="text-sm text-ink-300">Every simulated or imported result waits here. Open one to inspect the score, statistics, highlights, recap, percentage checks and validation before approving or rejecting it. Nothing here is visible to the public.</p>
      <Load q={q}>{(d) => !d.runs.length ? <Card><Empty>No results are waiting for review.</Empty></Card> : (
        <Card pad={false}><table className="w-full">
          <thead><tr className="border-b border-ink-700"><th className={th}>Week</th><th className={th}>Game</th><th className={th}>Result</th><th className={th}>Type</th><th className={th}>Status</th><th className={th}>Created</th><th className={thr} /></tr></thead>
          <tbody>{d.runs.map((r: Row) => (
            <tr key={r.id} className="border-b border-ink-800 last:border-0">
              <td className={cx(td, 'tnum')}>{r.week}</td>
              <td className={td}><b>{team(r.away_team_id).short}</b> at <b>{team(r.home_team_id).short}</b>{r.game_status === 'final' && <Badge tone="gold" className="ml-2">Correction of {r.official_away}–{r.official_home}</Badge>}</td>
              <td className={cx(td, 'font-display text-lg font-bold tnum')}>{r.away_score}–{r.home_score}</td>
              <td className={td}><Badge tone={r.mode === 'primetime' ? 'purple' : 'neutral'}>{r.mode === 'primetime' ? 'CFB 27 import' : 'Simulation'}</Badge></td>
              <td className={td}><Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge>{!r.valid && <Badge tone="red" className="ml-1">Failed validation</Badge>}</td>
              <td className={cx(td, 'text-ink-300')}>{fmtAgo(r.created_at)}</td>
              <td className={cx(td, 'text-right')}><Link to={`/admin/review/${r.id}`}><Button size="sm" variant="primary">Review</Button></Link></td>
            </tr>))}</tbody></table></Card>)}</Load>
    </div>
  );
}

const derive = (l: Row) => {
  const d = (a: number, b: number) => (b ? Math.round((a / b) * 10) / 10 : 0);
  return { ...l, tackles: l.tklSolo + l.tklAst, cmpPct: d(100 * l.passCmp, l.passAtt), ypa: d(l.passYds, l.passAtt), passRating: passerRating(l.passCmp, l.passAtt, l.passYds, l.passTd, l.passInt), ypc: d(l.rushYds, l.rushAtt), ypr: d(l.recYds, l.rec), fgPct: d(100 * l.fgm, l.fga), puntAvg: d(l.puntYds, l.punts) };
};

export function RunDetail() {
  const { runId } = useParams();
  const q = useApi<any>(`/admin/runs/${runId}`);
  const team = useTeams();
  const nav = useNavigate();
  const act = useAction();
  const [tab, setTab] = useState<'overview' | 'box' | 'team' | 'scoring' | 'highlights' | 'pbp' | 'percentages'>('overview');
  const [publish, setPublish] = useState(false);
  const [rejectNote, setRejectNote] = useState<string | null>(null);
  return (
    <Load q={q}>{(d) => {
      const r: GameResult = d.result;
      const run = d.run, g = d.game;
      const teams: [TeamRef, TeamRef] = [{ ...team(g.away_team_id), score: r.final[0] }, { ...team(g.home_team_id), score: r.final[1] }];
      const tid = [g.away_team_id, g.home_team_id];
      const locked = r.primetime?.locks?.players ?? {};
      const players = r.playerStats.map((l) => ({ ...derive(l as unknown as Row), teamId: tid[l.side], name: d.players[l.playerId]?.name ?? `Unknown (${l.playerId})`, position: d.players[l.playerId]?.position, jersey: d.players[l.playerId]?.jersey, lockedFields: Object.keys(locked[l.playerId] ?? {}) }));
      const plays = r.plays.map((p) => ({ seq: p.seq, drive: p.drive, quarter: p.quarter, clock: p.clock, teamId: tid[p.offense], down: p.down, distance: p.distance, ballOn: p.ballOn, type: p.type, yards: p.yards, result: playResult(p), description: p.desc }));
      const drives = r.drives.map((x) => ({ ...x, teamId: tid[x.side] }));
      const scoring = r.scoring.map((s) => ({ ...s, teamId: tid[s.side], description: s.desc, away: s.score[0], home: s.score[1] }));
      const highlights = r.highlights.map((h) => ({ ...h, teamId: tid[h.side] }));
      const teamStats = r.teamStats.map((t) => ({ ...t, teamId: tid[t.side] }));
      const failed = r.validation.filter((v) => !v.ok);
      const correction = g.status === 'final' ? { away: g.away_score, home: g.home_score } : null;
      const done = () => { q.reload(); };
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/admin/review" className="text-sm text-ink-300 hover:text-ink-100">← Results Review</Link>
            <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
            <Badge tone={r.mode === 'primetime' ? 'purple' : 'neutral'}>{r.mode === 'primetime' ? 'CFB 27 primetime import' : 'Full simulation'}</Badge>
            {correction && run.status !== 'published' && <Badge tone="gold">Would replace official {correction.away}–{correction.home}</Badge>}
            <span className="ml-auto flex flex-wrap gap-2">
              {(run.status === 'candidate' || run.status === 'approved') && <Button variant="danger" onClick={() => setRejectNote('')}>Reject</Button>}
              {run.status === 'candidate' && <Button variant="primary" busy={act.busy} disabled={!run.valid} onClick={() => act.run(async () => { await api.post(`/admin/runs/${run.id}/approve`); done(); })}>Approve</Button>}
              {run.status === 'approved' && <Button variant="primary" onClick={() => setPublish(true)}>Publish…</Button>}
              {run.status === 'published' && <Link to={`/games/${g.id}`}><Button variant="outline">Public page</Button></Link>}
            </span>
          </div>
          <ErrorBox error={act.error} />
          <Card>
            <div className="flex flex-wrap items-center justify-center gap-6">
              {teams.map((t, s) => <div key={t.id} className={cx('flex items-center gap-3', s === 1 && 'flex-row-reverse')}><TeamLogo team={t} size={48} /><div className={s === 1 ? 'text-right' : ''}><p className="font-display text-2xl font-bold uppercase leading-none">{t.name}</p></div><span className="font-display text-5xl font-extrabold tnum">{r.final[s]}</span></div>)}
            </div>
            <table className="mx-auto mt-3 text-sm tnum"><thead><tr><th />{r.quarters[0].map((_, i) => <th key={i} className="px-2.5 text-[11px] uppercase text-ink-400">{i < 4 ? i + 1 : `OT${i - 3}`}</th>)}<th className="px-2.5 text-[11px] uppercase text-ink-300">T</th></tr></thead>
              <tbody>{teams.map((t, s) => <tr key={t.id}><td className="pr-3 font-display font-semibold">{t.abbr}</td>{r.quarters[s].map((v, i) => <td key={i} className="px-2.5 text-center">{v}</td>)}<td className="px-2.5 text-center font-bold">{r.final[s]}</td></tr>)}</tbody></table>
          </Card>
          {failed.length > 0 && <Notice tone="warn"><b>This result failed validation and cannot be approved or published.</b><ul className="mt-1 list-disc pl-5">{failed.map((f) => <li key={f.check}>{f.check}{f.detail ? `: ${f.detail}` : ''}</li>)}</ul></Notice>}
          {r.warnings.length > 0 && <Notice><b>Notes</b><ul className="mt-1 list-disc pl-5">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Notice>}
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'box', label: 'Player stats' }, { id: 'team', label: 'Team stats' }, { id: 'scoring', label: 'Scoring' }, { id: 'highlights', label: `Highlights (${r.highlights.length})` }, { id: 'pbp', label: 'Play-by-play' }, { id: 'percentages', label: r.mode === 'sim' ? 'Percentages & seed' : 'Imported inputs' }]} />
          {tab === 'overview' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Game recap">
                <div className="mb-2 flex gap-1.5">{r.recap.reconstruction && <Badge tone="purple">Reconstruction-based summary</Badge>}<Badge>{r.recap.source === 'ai' ? 'AI-written, grounded in game data' : 'Standard recap'}</Badge></div>
                <h3 className="font-display text-xl font-bold">{r.recap.headline}</h3>
                <div className="mt-2 space-y-2 text-sm leading-relaxed text-ink-100">{r.recap.text.split(/\n\n+/).map((p, i) => <p key={i}>{p}</p>)}</div>
              </Card>
              <Card title={`Validation (${r.validation.length - failed.length} of ${r.validation.length} passed)`}>
                <ul className="space-y-1 text-sm">{r.validation.map((v) => <li key={v.check} className="flex gap-2"><span className={v.ok ? 'text-emerald-400' : 'text-red-400'}>{v.ok ? '✓' : '✗'}</span><span>{v.check}{v.detail && <span className="block text-xs text-red-300">{v.detail}</span>}</span></li>)}</ul>
              </Card>
              <div className="lg:col-span-2"><ScoreChart scoring={scoring} teams={teams} quarters={r.quarters[0].length} /></div>
            </div>)}
          {tab === 'box' && <BoxScore players={players} teams={teams} primetime={r.mode === 'primetime'} />}
          {tab === 'team' && <TeamStats stats={teamStats} teams={teams} />}
          {tab === 'scoring' && <ScoringSummary scoring={scoring} teams={teams} />}
          {tab === 'highlights' && <Highlights list={highlights} teams={teams} generated={r.mode === 'primetime' ? 'Generated reconstruction — these moments were not observed.' : undefined} />}
          {tab === 'pbp' && <PlayByPlay plays={plays} drives={drives} teams={teams} />}
          {tab === 'percentages' && (r.mode === 'sim' ? (
            <div className="space-y-4">
              <Card title="Simulation record">
                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-xs uppercase text-ink-400">Seed</dt><dd className="font-mono">{r.seed}</dd></div>
                  <div><dt className="text-xs uppercase text-ink-400">Engine version</dt><dd>{r.engineVersion}</dd></div>
                  <div><dt className="text-xs uppercase text-ink-400">Percentage snapshot</dt><dd>{d.snapshot ? <>{new Date(d.snapshot.fetched_at).toLocaleString()} · source: {d.snapshot.source}{d.snapshot.source_detail ? ` (${d.snapshot.source_detail})` : ''} · {fmtAgo(d.snapshot.fetched_at, run.created_at)} before the simulation</> : '—'}</dd></div>
                  <div><dt className="text-xs uppercase text-ink-400">Settings</dt><dd>Home field +{r.config.neutralSite ? 0 : r.config.homeFieldAdvantage} · sacks counted {r.config.sackConvention.toUpperCase()}-style</dd></div>
                </dl>
                {d.snapshot && <table className="mt-3 w-full max-w-md text-sm"><thead><tr className="border-b border-ink-700"><th className={th}>Source percentages</th><th className={thr}>Activity</th><th className={thr}>Upset</th><th className={thr}>Star</th></tr></thead>
                  <tbody>{[d.snapshot.away, d.snapshot.home].map((p: Row, s: number) => <tr key={s} className="border-b border-ink-800"><td className={td}>{teams[s].name}</td><td className={tdr}>{p?.activity}%</td><td className={tdr}>{p?.upset}%</td><td className={tdr}>{p?.star}%</td></tr>)}</tbody></table>}
              </Card>
              {(['activity', 'upset', 'star'] as const).map((cat) => (
                <Card key={cat} title={`${cat} checks — rolled independently`} pad={false}>
                  <div className="scroll-x"><table className="w-full"><thead><tr className="border-b border-ink-700"><th className={th}>Team</th><th className={th}>Scope</th><th className={thr}>Percentage</th><th className={thr}>Roll</th><th className={th}>Result</th><th className={th}>Effect applied</th></tr></thead>
                    <tbody>{r.percentageChecks.filter((c) => c.category === cat).map((c, i) => <tr key={i} className="border-b border-ink-800 last:border-0"><td className={td}>{teams[c.side].abbr}</td><td className={td}>{c.scopeLabel}</td><td className={tdr}>{c.percentage}%</td><td className={tdr}>{c.roll.toFixed(2)}</td><td className={td}><Badge tone={c.passed ? 'green' : 'neutral'}>{c.passed ? 'Passed' : 'Not passed'}</Badge></td><td className={cx(tdw, 'min-w-64 text-ink-200')}>{c.effect}</td></tr>)}</tbody></table></div>
                </Card>))}
            </div>
          ) : (
            <Card title="Authoritative inputs (never altered)">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div><dt className="text-xs uppercase text-ink-400">Imported final score</dt><dd className="font-display text-xl font-bold">{teams[0].abbr} {r.primetime?.final[0]} – {teams[1].abbr} {r.primetime?.final[1]}</dd></div>
                <div><dt className="text-xs uppercase text-ink-400">Imported period scores</dt><dd>{r.primetime?.quarters ? r.primetime.quarters.map((x) => x.join(' / ')).join('  ·  ') : 'Not supplied — generated'}</dd></div>
                <div><dt className="text-xs uppercase text-ink-400">Reconstruction seed</dt><dd className="font-mono">{r.seed}</dd></div>
                <div><dt className="text-xs uppercase text-ink-400">Percentages</dt><dd>Not applied: nothing can change an imported result.</dd></div>
              </dl>
              <h4 className="mt-4 text-xs font-semibold uppercase text-ink-300">Locked statistics</h4>
              {Object.keys(locked).length ? <ul className="mt-1 space-y-1 text-sm">{Object.entries(locked).map(([pid, st]) => <li key={pid}><b>{d.players[pid]?.name ?? pid}</b>: {Object.entries(st as Row).map(([k, v]) => `${k} ${v}`).join(', ')}</li>)}</ul> : <p className="text-sm text-ink-400">None. All individual statistics are generated.</p>}
            </Card>))}
          {publish && <PublishDialog runId={run.id} mode={r.mode} correction={correction} onClose={() => setPublish(false)} onDone={() => { setPublish(false); nav('/admin/publishing'); }} />}
          {rejectNote !== null && (
            <Modal title="Reject this result" onClose={() => setRejectNote(null)}>
              <Field label="Note (optional)"><Input value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Why is it being rejected?" /></Field>
              <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" onClick={() => setRejectNote(null)}>Cancel</Button><Button variant="danger" busy={act.busy} onClick={() => act.run(async () => { await api.post(`/admin/runs/${run.id}/reject`, { note: rejectNote || undefined }); setRejectNote(null); nav('/admin/review'); })}>Reject result</Button></div>
            </Modal>)}
        </div>);
    }}</Load>
  );
}

// ================================================================== PUBLISHING CENTER
export function PublishingCenter() {
  const { seasonId, reload: reloadMeta } = useSeason();
  const team = useTeams();
  const review = useApi<any>(`/admin/review${qs({ season: seasonId })}`);
  const games = useApi<any>(`/admin/games${qs({ season: seasonId })}`);
  const [publish, setPublish] = useState<Row | null>(null);
  const [withdraw, setWithdraw] = useState<Row | null>(null);
  const [history, setHistory] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const act = useAction();
  const refresh = () => { review.reload(); games.reload(); reloadMeta(); };
  const approved = (review.data?.runs ?? []).filter((r: Row) => r.status === 'approved');
  const finals = (games.data?.games ?? []).filter((g: Row) => g.status === 'final');
  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase">Publishing Center</h1>
      <Card title={`Approved and ready to publish (${approved.length})`} pad={false}>
        {approved.length ? <table className="w-full"><tbody>{approved.map((r: Row) => (
          <tr key={r.id} className="border-b border-ink-800 last:border-0">
            <td className={cx(td, 'tnum text-ink-300')}>Week {r.week}</td><td className={td}><b>{team(r.away_team_id).short}</b> {r.away_score} – {r.home_score} <b>{team(r.home_team_id).short}</b></td>
            <td className={td}><Badge tone={r.mode === 'primetime' ? 'purple' : 'neutral'}>{r.mode === 'primetime' ? 'CFB 27 import' : 'Simulation'}</Badge>{r.game_status === 'final' && <Badge tone="gold" className="ml-1">Correction</Badge>}</td>
            <td className={cx(td, 'text-right')}><Link to={`/admin/review/${r.id}`} className="mr-2 text-xs text-ink-300 underline">Preview</Link><Button size="sm" variant="primary" onClick={() => setPublish({ runId: r.id, mode: r.mode, correction: r.game_status === 'final' ? { away: r.official_away, home: r.official_home } : null })}>Publish</Button></td>
          </tr>))}</tbody></table> : <Empty>Nothing is waiting. Approve results in Results Review first — an unapproved result cannot be published.</Empty>}
      </Card>
      <Card title={`Official results this season (${finals.length})`} pad={false}>
        {finals.length ? <table className="w-full"><thead><tr className="border-b border-ink-700"><th className={th}>Week</th><th className={th}>Game</th><th className={th}>Type</th><th className={thr}>Actions</th></tr></thead><tbody>{finals.map((g: Row) => (
          <tr key={g.id} className="border-b border-ink-800 last:border-0">
            <td className={cx(td, 'tnum')}>{g.week}</td><td className={td}><b>{team(g.away_team_id).short}</b> {g.away_score} – {g.home_score} <b>{team(g.home_team_id).short}</b>{g.final_at > Date.now() && <Badge tone="blue" className="ml-2">Replay in progress</Badge>}</td>
            <td className={td}><Badge tone={g.mode === 'primetime' ? 'purple' : 'neutral'}>{g.mode === 'primetime' ? 'CFB 27' : 'Simulated'}</Badge></td>
            <td className={cx(td, 'text-right')}><span className="inline-flex gap-1.5"><Link to={`/games/${g.id}`}><Button size="sm" variant="ghost">View</Button></Link><Button size="sm" variant="ghost" onClick={async () => setHistory({ game: g, ...(await api.get(`/admin/games/${g.id}/runs`)) })}>History</Button><Button size="sm" variant="outline" onClick={() => { setWithdraw(g); setReason(''); setConfirm(false); }}>Withdraw</Button></span></td>
          </tr>))}</tbody></table> : <Empty>No results have been published yet.</Empty>}
      </Card>
      <p className="text-xs text-ink-400">To correct a published game, create a new result for it (re-simulate, or re-import the CFB 27 score with the right values), approve it, and publish it as a correction. Statistics are always re-derived from the new play ledger, so individual numbers are never edited by hand and can never drift from the game they belong to.</p>
      {publish && <PublishDialog runId={publish.runId} mode={publish.mode} correction={publish.correction} onClose={() => setPublish(null)} onDone={() => { setPublish(null); refresh(); }} />}
      {withdraw && (
        <Modal title="Withdraw an official result" onClose={() => setWithdraw(null)}>
          <div className="space-y-3">
            <Notice tone="warn">{team(withdraw.away_team_id).short} {withdraw.away_score} – {withdraw.home_score} {team(withdraw.home_team_id).short} will no longer be official. The game returns to “scheduled”, team records and season statistics are recalculated without it, and the withdrawn version stays in history.</Notice>
            <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <Check label="I confirm I am withdrawing an official result." checked={confirm} onChange={setConfirm} />
            <ErrorBox error={act.error} />
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setWithdraw(null)}>Cancel</Button><Button variant="danger" busy={act.busy} disabled={!confirm || reason.trim().length < 3} onClick={() => act.run(async () => { await api.post(`/admin/games/${withdraw.id}/unpublish`, { reason, confirm: true }); setWithdraw(null); refresh(); })}>Withdraw result</Button></div>
          </div>
        </Modal>)}
      {history && (
        <Modal wide title="Result history" onClose={() => setHistory(null)}>
          <h4 className="text-xs font-semibold uppercase text-ink-300">Official versions</h4>
          <table className="mb-4 w-full"><tbody>{history.published.map((p: Row) => <tr key={p.id} className="border-b border-ink-800"><td className={td}>v{p.version}</td><td className={cx(td, 'tnum font-semibold')}>{p.away_score}–{p.home_score}</td><td className={td}>{new Date(p.published_at).toLocaleString()}</td><td className={td}>{p.is_current ? <Badge tone="green">Current</Badge> : <Badge>Replaced {p.superseded_at ? new Date(p.superseded_at).toLocaleDateString() : ''}</Badge>}</td><td className={cx(tdw, 'text-ink-300')}>{p.reason}</td></tr>)}</tbody></table>
          <h4 className="text-xs font-semibold uppercase text-ink-300">All simulation records</h4>
          <table className="w-full"><tbody>{history.runs.map((r: Row) => <tr key={r.id} className="border-b border-ink-800"><td className={td}><Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge></td><td className={cx(td, 'tnum')}>{r.away_score}–{r.home_score}</td><td className={td}>{r.mode}</td><td className={cx(td, 'font-mono text-xs')}>{r.seed}</td><td className={td}>{new Date(r.created_at).toLocaleString()}</td><td className={td}>{r.created_by_name ?? 'former administrator'}</td><td className={td}><Link className="text-gold-soft underline" to={`/admin/review/${r.id}`}>Open</Link></td></tr>)}</tbody></table>
        </Modal>)}
    </div>
  );
}
