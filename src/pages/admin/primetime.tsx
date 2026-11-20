import { Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { checkPrimetimeInput, reconstructPrimetime } from '../../../engine/index';
import { SimError, type LockablePlayerStat, type PrimetimeInput, type RosterPlayer, type TeamInput } from '../../../engine/types';
import { ApiError, api, qs, useApi } from '../../api';
import { useSeason } from '../../shared';
import { Badge, Button, Card, Check, ErrorBox, Field, Input, Notice, Select, cx, useAction } from '../../ui';
import { useTeams } from './sim';

type Row = Record<string, any>;
const GROUPS: { title: string; pos: string[]; stats: [LockablePlayerStat, string][] }[] = [
  { title: 'Passing', pos: ['QB'], stats: [['passCmp', 'Cmp'], ['passAtt', 'Att'], ['passYds', 'Yds'], ['passTd', 'TD'], ['passInt', 'Int']] },
  { title: 'Rushing', pos: ['QB', 'RB', 'FB', 'WR', 'TE'], stats: [['rushAtt', 'Car'], ['rushYds', 'Yds'], ['rushTd', 'TD']] },
  { title: 'Receiving', pos: ['WR', 'TE', 'RB', 'FB', 'QB'], stats: [['rec', 'Rec'], ['recYds', 'Yds'], ['recTd', 'TD']] },
  { title: 'Defense', pos: ['DE', 'DT', 'EDGE', 'LB', 'CB', 'FS', 'SS'], stats: [['tackles', 'Tkl'], ['sacks', 'Sacks'], ['defInt', 'Int']] },
  { title: 'Kicking', pos: ['K', 'P'], stats: [['fgm', 'FGM'], ['fga', 'FGA'], ['xpm', 'XPM'], ['xpa', 'XPA']] },
];
interface LockRow { playerId: string; stats: Partial<Record<LockablePlayerStat, string>>; fromScreenshot?: boolean }
const numOrNull = (v: string | undefined) => (v == null || v.trim() === '' ? null : Number(v));
const fileToB64 = (f: File) => new Promise<{ mediaType: string; data: string }>((res, rej) => { const r = new FileReader(); r.onload = () => { const s = String(r.result); res({ mediaType: f.type, data: s.slice(s.indexOf(',') + 1) }); }; r.onerror = () => rej(new Error('Could not read the image.')); r.readAsDataURL(f); });

export function PrimetimeImport() {
  const { seasonId } = useSeason();
  const team = useTeams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const gameId = params.get('game') ?? '';
  const games = useApi<any>(`/admin/games${qs({ season: seasonId })}`);
  const input = useApi<{ teams: [TeamInput, TeamInput]; config: Row; game: Row }>(gameId ? `/admin/games/${gameId}/sim-input` : null);
  const settings = useApi<any>(`/admin/settings${qs({ season: seasonId })}`);
  const [final, setFinal] = useState<[string, string]>(['', '']);
  const [useQ, setUseQ] = useState(false);
  const [quarters, setQuarters] = useState<[string[], string[]]>([['', '', '', ''], ['', '', '', '']]);
  const [ot, setOt] = useState('0');
  const [locks, setLocks] = useState<LockRow[]>([]);
  const [teamLocks, setTeamLocks] = useState<[Row, Row]>([{}, {}]);
  const [shot, setShot] = useState<Row | null>(null);
  const [verified, setVerified] = useState(false);
  const [aiRecap, setAiRecap] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [working, setWorking] = useState('');
  const act = useAction();
  const extract = useAction();

  useEffect(() => { setFinal(['', '']); setUseQ(false); setQuarters([['', '', '', ''], ['', '', '', '']]); setOt('0'); setLocks([]); setTeamLocks([{}, {}]); setShot(null); setVerified(false); setProblems([]); }, [gameId]);

  const teams = input.data?.teams;
  const players = useMemo(() => (teams ?? []).flatMap((t, s) => t.roster.filter((p) => p.active).map((p) => ({ ...p, side: s, team: t.abbr }))), [teams]);
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const eligibleFor = (p: RosterPlayer, pos: string[]) => [p.position, ...p.secondary].some((x) => pos.includes(x));

  const build = (): PrimetimeInput => {
    const pl: Record<string, Partial<Record<LockablePlayerStat, number>>> = {};
    for (const l of locks) {
      const st: Partial<Record<LockablePlayerStat, number>> = {};
      for (const [k, v] of Object.entries(l.stats)) { const n = numOrNull(v); if (n != null && !Number.isNaN(n)) st[k as LockablePlayerStat] = n; }
      if (l.playerId && Object.keys(st).length) pl[l.playerId] = { ...(pl[l.playerId] ?? {}), ...st };
    }
    const tl = teamLocks.map((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, numOrNull(v as string)]).filter(([, v]) => v != null && !Number.isNaN(v)))) as [Row, Row];
    const hasTeam = tl.some((t) => Object.keys(t).length);
    return {
      final: [Number(final[0]), Number(final[1])],
      quarters: useQ ? [quarters[0].map((v) => Number(v || 0)), quarters[1].map((v) => Number(v || 0))] : null,
      overtimePeriods: useQ ? undefined : Number(ot) || 0,
      locks: Object.keys(pl).length || hasTeam ? { players: pl, ...(hasTeam ? { teams: tl } : {}) } : null,
    };
  };

  const generate = (regenerate = false): Promise<unknown> => act.run(async (): Promise<unknown> => {
    setProblems([]);
    if (!teams) return;
    if (final[0] === '' || final[1] === '') return setProblems(['Enter both final scores.']);
    if (shot && !verified) return setProblems(['Confirm that you have checked the screenshot values before generating.']);
    const inp = build();
    const pre = checkPrimetimeInput(inp, teams);
    if (pre.length) return setProblems(pre);
    setWorking('Reconstructing a game around the imported score…');
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint before the solver runs
    const seed = `pt-${gameId.slice(0, 8)}-${Date.now().toString(36)}`;
    let result;
    try {
      result = reconstructPrimetime({ seed, teams, config: input.data!.config, input: inp });
    } catch (e) {
      setWorking('');
      if (e instanceof SimError) return setProblems([e.message, ...e.details.filter((d) => d !== e.message)]);
      throw e;
    }
    setWorking('Verifying on the server…');
    try {
      const saved = await api.post(`/admin/games/${gameId}/primetime`, { input: inp, seed, plays: result.plays.map(({ desc, ...p }) => p), regenerate, aiRecap });
      nav(`/admin/review/${saved.runId}`);
    } catch (e) {
      setWorking('');
      if (e instanceof ApiError && e.code === 'RUN_EXISTS' && confirm('This game already has a result awaiting review. Replace it with this import?')) return generate(true);
      throw e;
    }
  });

  const onFiles = (files: FileList | null) => files && extract.run(async () => {
    const images = await Promise.all([...files].slice(0, 4).map(fileToB64));
    const res = await api.post('/admin/screenshots/extract', { gameId, images });
    const ex = res.extraction;
    setShot(ex);
    setVerified(false);
    if (ex.awayFinal != null && ex.homeFinal != null) setFinal([String(ex.awayFinal), String(ex.homeFinal)]);
    if (ex.awayByPeriod?.length >= 4 && ex.homeByPeriod?.length === ex.awayByPeriod.length) { setUseQ(true); setQuarters([ex.awayByPeriod.map(String), ex.homeByPeriod.map(String)]); }
    const rows: LockRow[] = ex.players.map((p: Row) => ({ playerId: p.playerId ?? '', fromScreenshot: true, stats: Object.fromEntries(GROUPS.flatMap((g) => g.stats.map((s) => s[0])).filter((k) => p[k] != null).map((k) => [k, String(p[k])])), _name: p.name, _note: p.note }));
    setLocks((cur) => [...cur.filter((c) => !c.fromScreenshot), ...rows]);
  });

  const setLock = (i: number, patch: Partial<LockRow>) => setLocks((cur) => cur.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setQ = (s: 0 | 1, i: number, v: string) => setQuarters((q) => { const n: [string[], string[]] = [[...q[0]], [...q[1]]]; n[s][i] = v; return n; });
  const list: Row[] = (games.data?.games ?? []).filter((g: Row) => g.status !== 'canceled');
  const t0 = teams?.[0], t1 = teams?.[1];

  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase">Primetime Import Center</h1>
      <p className="max-w-3xl text-sm text-ink-300">Import the result of a game that was actually played in College Football 27. The score you enter is authoritative and is never changed. The engine builds a consistent box score, play-by-play and highlights around it, clearly labeled as a reconstruction. Team percentages and ratings are not applied.</p>
      <Card title="1 · Choose the matchup">
        <Select value={gameId} onChange={(e) => setParams(e.target.value ? { game: e.target.value } : {})}>
          <option value="">Select a scheduled game…</option>
          {list.map((g) => <option key={g.id} value={g.id}>Week {g.week}: {team(g.away_team_id).name} at {team(g.home_team_id).name}{g.status === 'final' ? ` (official: ${g.away_score}-${g.home_score} — import will be a correction)` : ''}{g.mode === 'primetime' ? ' · primetime' : ''}</option>)}
        </Select>
        {input.error && <ErrorBox className="mt-3" error={input.error} />}
      </Card>
      {t0 && t1 && <>
        <Card title="2 · Read screenshots (optional)" action={<Badge tone={settings.data?.aiConfigured ? 'green' : 'neutral'}>{settings.data?.aiConfigured ? 'AI reading available' : 'AI not configured'}</Badge>}>
          {settings.data?.aiConfigured ? <>
            <p className="mb-2 text-sm text-ink-300">Upload up to four CFB 27 screenshots (final scoreboard, quarter scores, team stats, passing, rushing, receiving or defensive stats). Values that are read are placed in the form below for you to check and correct. Nothing is saved or published from a screenshot automatically.</p>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-ink-500 px-4 py-3 text-sm hover:bg-ink-800"><Upload className="size-4" />{extract.busy ? 'Reading screenshots…' : 'Choose images'}<input type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" disabled={extract.busy} onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} /></label>
            <ErrorBox className="mt-2" error={extract.error} />
            {shot && <Notice tone="warn" className="mt-3"><b>Unconfirmed values from: {shot.screenType}.</b> Check every highlighted field against the screenshots.{shot.unreadable?.length ? ` Could not be read: ${shot.unreadable.join('; ')}.` : ''}{shot.teamStats?.length ? ` Team stats seen: ${shot.teamStats.map((t: Row) => `${t.team} pass ${t.passYds ?? '?'} / rush ${t.rushYds ?? '?'} / TO ${t.turnovers ?? '?'}`).join('; ')} — enter them under team totals if you want them locked.` : ''}</Notice>}
          </> : <p className="text-sm text-ink-300">Screenshot reading needs the <code className="rounded bg-ink-900 px-1">ANTHROPIC_API_KEY</code> secret on the Worker. Until then, enter the values by hand below.</p>}
        </Card>

        <Card title="3 · Actual result">
          <div className="grid max-w-xl grid-cols-2 gap-3">
            <Field label={`${t0.name} (away)`}><Input inputMode="numeric" className={cx('!text-2xl font-display font-bold', shot && 'ring-1 ring-amber-400/60')} value={final[0]} onChange={(e) => setFinal([e.target.value.replace(/\D/g, ''), final[1]])} /></Field>
            <Field label={`${t1.name} (home)`}><Input inputMode="numeric" className={cx('!text-2xl font-display font-bold', shot && 'ring-1 ring-amber-400/60')} value={final[1]} onChange={(e) => setFinal([final[0], e.target.value.replace(/\D/g, '')])} /></Field>
          </div>
          <div className="mt-4 space-y-3">
            <Check label="Enter quarter-by-quarter scores (optional; otherwise they are generated)" checked={useQ} onChange={setUseQ} />
            {useQ ? (
              <div className="scroll-x">
                <table className="text-sm"><thead><tr><th />{quarters[0].map((_, i) => <th key={i} className="px-1 text-[11px] uppercase text-ink-400">{i < 4 ? `Q${i + 1}` : `OT${i - 3}`}</th>)}<th /></tr></thead>
                  <tbody>{([0, 1] as const).map((s) => <tr key={s}><td className="pr-2 font-display font-semibold">{(s ? t1 : t0).abbr}</td>{quarters[s].map((v, i) => <td key={i} className="p-0.5"><Input inputMode="numeric" className={cx('!w-14 text-center', shot && 'ring-1 ring-amber-400/60')} value={v} onChange={(e) => setQ(s, i, e.target.value.replace(/\D/g, ''))} /></td>)}
                    {s === 0 && <td rowSpan={2} className="pl-2 align-middle"><div className="flex flex-col gap-1"><Button size="sm" variant="outline" onClick={() => setQuarters([[...quarters[0], ''], [...quarters[1], '']])}>+ OT period</Button>{quarters[0].length > 4 && <Button size="sm" variant="ghost" onClick={() => setQuarters([quarters[0].slice(0, -1), quarters[1].slice(0, -1)])}>Remove OT</Button>}</div></td>}</tr>)}</tbody></table>
              </div>
            ) : <Field label="Overtime periods played" className="w-48"><Select value={ot} onChange={(e) => setOt(e.target.value)}>{[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 0 ? 'None (ended in regulation)' : n}</option>)}</Select></Field>}
          </div>
        </Card>

        <Card title="4 · Real player statistics to lock (optional)" action={<Button size="sm" onClick={() => setLocks([...locks, { playerId: '', stats: {} }])}>Add player</Button>}>
          <p className="mb-3 text-sm text-ink-300">Enter only numbers you know are real. Locked numbers are reproduced exactly and shown publicly as verified; blanks are generated. Only rostered, active players can be chosen — a name that is not on a roster must be mapped to a rostered player or left out.</p>
          {!locks.length && <p className="text-sm text-ink-500">No statistics locked. Every individual statistic will be generated.</p>}
          <div className="space-y-3">
            {locks.map((l, i) => {
              const p = byId.get(l.playerId);
              const extra = l as Row;
              return (
                <div key={i} className={cx('rounded-lg border p-3', l.fromScreenshot ? 'border-amber-500/40 bg-amber-500/5' : 'border-ink-700 bg-ink-900')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select className="!w-72" value={l.playerId} onChange={(e) => setLock(i, { playerId: e.target.value })}>
                      <option value="">{extra._name ? `Map “${extra._name}” to a rostered player…` : 'Choose a rostered player…'}</option>
                      {[t0, t1].map((t, s) => <optgroup key={t.id} label={t.name}>{players.filter((x) => x.side === s).map((x) => <option key={x.id} value={x.id}>{x.name} — {x.position}{x.jersey != null ? ` #${x.jersey}` : ''}</option>)}</optgroup>)}
                    </Select>
                    {l.fromScreenshot && <Badge tone="gold">From screenshot — check</Badge>}
                    {extra._note && !l.playerId && <span className="text-xs text-amber-200">{extra._note}</span>}
                    <button aria-label="Remove" className="ml-auto rounded p-1 text-ink-400 hover:bg-ink-700 hover:text-white" onClick={() => setLocks(locks.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
                  </div>
                  {p ? (
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                      {GROUPS.filter((g) => eligibleFor(p, g.pos) || g.stats.some((s) => l.stats[s[0]] != null && l.stats[s[0]] !== '')).map((g) => (
                        <div key={g.title}>
                          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">{g.title}{!eligibleFor(p, g.pos) && <span className="ml-1 text-red-300">(not eligible at {p.position})</span>}</p>
                          <div className="flex gap-1">{g.stats.map(([k, label]) => <label key={k} className="text-center text-[10px] uppercase text-ink-400">{label}<Input inputMode="decimal" className="!w-14 text-center !text-sm" value={l.stats[k] ?? ''} onChange={(e) => setLock(i, { stats: { ...l.stats, [k]: e.target.value.replace(/[^0-9.\-]/g, '') } })} /></label>)}</div>
                        </div>))}
                    </div>
                  ) : l.fromScreenshot && <p className="mt-2 text-xs text-ink-300">Read values: {Object.entries(l.stats).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}. This line is ignored unless you map it to a rostered player.</p>}
                </div>);
            })}
          </div>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-ink-200">Team totals to lock (optional)</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">{([0, 1] as const).map((s) => (
              <div key={s} className="rounded-lg border border-ink-700 p-3"><p className="mb-2 font-display font-semibold uppercase">{(s ? t1 : t0).name}</p>
                <div className="flex gap-2">{([['passYds', 'Passing yards'], ['rushYds', 'Rushing yards'], ['turnovers', 'Turnovers']] as const).map(([k, label]) => <Field key={k} label={label}><Input inputMode="numeric" value={teamLocks[s][k] ?? ''} onChange={(e) => setTeamLocks((cur) => { const n: [Row, Row] = [{ ...cur[0] }, { ...cur[1] }]; n[s][k] = e.target.value.replace(/[^0-9\-]/g, ''); return n; })} /></Field>)}</div>
              </div>))}</div>
          </details>
        </Card>

        <Card title="5 · Generate and preview">
          <div className="space-y-3">
            {shot && <Check label="I have checked every value read from the screenshots and corrected any mistakes." checked={verified} onChange={setVerified} />}
            <Check label="Write the recap with AI (labeled as reconstruction-based)" checked={aiRecap && !!settings.data?.aiConfigured} onChange={setAiRecap} disabled={!settings.data?.aiConfigured} />
            {problems.length > 0 && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200"><p className="font-semibold">These inputs conflict. Nothing was changed — correct them and try again:</p><ul className="mt-1 list-disc pl-5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
            <ErrorBox error={act.error} />
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" busy={act.busy} onClick={() => generate(false)}>Generate reconstruction</Button>
              {act.busy && <span className="text-sm text-ink-300">{working}</span>}
              <span className="text-xs text-ink-400">You will see the full preview next. It is only published after you approve it.</span>
            </div>
          </div>
        </Card>
      </>}
    </div>
  );
}
