import { useEffect, useState } from 'react';
import { DEF_SCHEMES, OFF_SCHEMES, POSITIONS, TEMPOS } from '../../../engine/types';
import { api, qs, useApi } from '../../api';
import { DESIGNATION, TeamLogo, fmtKick, useSeason } from '../../shared';
import { Badge, Button, Card, Check, Empty, ErrorBox, Field, Input, Load, Modal, Notice, Select, Textarea, cx, td, tdr, th, thr, useAction } from '../../ui';
import { useTeams, weeksOf } from './sim';

type Row = Record<string, any>;
const toLocalInput = (ms: number | null) => { if (!ms) return ''; const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const numOr = (v: string, fallback: number | null) => (v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

// ================================================================== SCHEDULE MANAGER
function GameForm({ game, onClose, onSaved }: { game: Row | null; onClose: () => void; onSaved: () => void }) {
  const { meta, seasonId } = useSeason();
  const published = game?.status === 'final';
  const [f, setF] = useState<Row>(() => game ? {
    week: game.week, awayTeamId: game.away_team_id, homeTeamId: game.home_team_id, kickoffAt: toLocalInput(game.kickoff_at), network: game.network ?? '', stadium: game.stadium ?? '', neutralSite: !!game.neutral_site,
    mode: game.mode, designations: game.designations as string[], status: game.status, liveAway: game.live_away ?? '', liveHome: game.live_home ?? '', livePeriod: game.live_period ?? '', liveClock: game.live_clock ?? '', allowDuplicate: false,
  } : { week: meta?.currentWeek ?? 1, awayTeamId: '', homeTeamId: '', kickoffAt: '', network: '', stadium: '', neutralSite: false, mode: 'sim', designations: [], status: 'scheduled', allowDuplicate: false });
  const act = useAction();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = () => act.run(async () => {
    const base = { week: Number(f.week), awayTeamId: f.awayTeamId, homeTeamId: f.homeTeamId, kickoffAt: f.kickoffAt ? new Date(f.kickoffAt).getTime() : null, network: f.network || null, stadium: f.stadium || null, neutralSite: f.neutralSite, mode: f.mode, designations: f.designations, allowDuplicate: f.allowDuplicate };
    if (!game) await api.post('/admin/games', { ...base, seasonId });
    else if (published) await api.patch(`/admin/games/${game.id}`, { week: base.week, kickoffAt: base.kickoffAt, network: base.network, stadium: base.stadium, neutralSite: base.neutralSite, designations: base.designations, allowDuplicate: base.allowDuplicate });
    else await api.patch(`/admin/games/${game.id}`, { ...base, status: f.status, ...(f.status === 'in_progress' ? { liveAway: numOr(String(f.liveAway), null), liveHome: numOr(String(f.liveHome), null), livePeriod: f.livePeriod || null, liveClock: f.liveClock || null } : {}) });
    onSaved();
  });
  const teams = meta?.teams ?? [];
  return (
    <Modal title={game ? 'Edit game' : 'Schedule a game'} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        {published && <Notice tone="warn" className="sm:col-span-2">This game has an official result. The matchup and status are locked; to change them, withdraw the result in Publishing Center first.</Notice>}
        <Field label="Away team"><Select disabled={published} value={f.awayTeamId} onChange={(e) => set('awayTeamId', e.target.value)}><option value="">Select…</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Field label="Home team"><Select disabled={published} value={f.homeTeamId} onChange={(e) => set('homeTeamId', e.target.value)}><option value="">Select…</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Field label="Week"><Input type="number" min={0} max={40} value={f.week} onChange={(e) => set('week', e.target.value)} /></Field>
        <Field label="Kickoff (your local time)"><Input type="datetime-local" value={f.kickoffAt} onChange={(e) => set('kickoffAt', e.target.value)} /></Field>
        <Field label="Network"><Input value={f.network} onChange={(e) => set('network', e.target.value)} placeholder="e.g. MCAA Network" /></Field>
        <Field label="Stadium" hint="Defaults to the home team's stadium."><Input value={f.stadium} onChange={(e) => set('stadium', e.target.value)} /></Field>
        <Field label="Game mode"><Select disabled={published} value={f.mode} onChange={(e) => set('mode', e.target.value)}><option value="sim">Full simulation</option><option value="primetime">CFB 27 primetime (score imported)</option></Select></Field>
        {game && !published && <Field label="Status"><Select value={f.status} onChange={(e) => set('status', e.target.value)}><option value="scheduled">Scheduled</option><option value="in_progress">In progress (manual live score)</option><option value="postponed">Postponed</option><option value="canceled">Canceled</option></Select></Field>}
        {game && f.status === 'in_progress' && !published && (
          <div className="grid grid-cols-4 gap-2 rounded-lg border border-ink-700 p-3 sm:col-span-2">
            <p className="col-span-4 text-xs text-ink-300">Live scores are typed in by you while the game is played. The public page says the score was entered by league staff. There is no automatic connection to College Football 27.</p>
            <Field label="Away score"><Input inputMode="numeric" value={f.liveAway} onChange={(e) => set('liveAway', e.target.value)} /></Field><Field label="Home score"><Input inputMode="numeric" value={f.liveHome} onChange={(e) => set('liveHome', e.target.value)} /></Field>
            <Field label="Period"><Input value={f.livePeriod} onChange={(e) => set('livePeriod', e.target.value)} placeholder="Q3" /></Field><Field label="Clock"><Input value={f.liveClock} onChange={(e) => set('liveClock', e.target.value)} placeholder="8:21" /></Field>
          </div>)}
        <div className="sm:col-span-2">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-300">Designations</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">{Object.entries(DESIGNATION).map(([k, v]) => <Check key={k} label={v.label} checked={f.designations.includes(k)} onChange={(on) => set('designations', on ? [...f.designations, k] : f.designations.filter((x: string) => x !== k))} />)}</div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 sm:col-span-2"><Check label="Neutral site" checked={f.neutralSite} onChange={(v) => set('neutralSite', v)} /><Check label="Allow a duplicate matchup / second game in the same week" checked={f.allowDuplicate} onChange={(v) => set('allowDuplicate', v)} /></div>
        <ErrorBox className="sm:col-span-2" error={act.error} />
        <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={act.busy} disabled={!f.awayTeamId || !f.homeTeamId} onClick={save}>{game ? 'Save changes' : 'Create game'}</Button></div>
      </div>
    </Modal>
  );
}

export function ScheduleManager() {
  const { seasonId, meta, reload } = useSeason();
  const team = useTeams();
  const [week, setWeek] = useState<string>('all');
  const q = useApi<any>(`/admin/games${qs({ season: seasonId, week: week === 'all' ? null : week })}`);
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const act = useAction();
  const refresh = () => { q.reload(); reload(); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="font-display text-3xl font-bold uppercase">Schedule Manager</h1>
        <Field label="Week" className="ml-auto w-36"><Select value={week} onChange={(e) => setWeek(e.target.value)}><option value="all">All weeks</option>{weeksOf(meta).map((w) => <option key={w} value={w}>Week {w}</option>)}</Select></Field>
        <Button variant="primary" onClick={() => setEdit('new')} disabled={(meta?.teams.length ?? 0) < 2}>Schedule a game</Button>
      </div>
      {(meta?.teams.length ?? 0) < 2 && <Notice>Add at least two teams to this season in Team Manager before scheduling games.</Notice>}
      <ErrorBox error={act.error} />
      <Load q={q}>{(d) => !d.games.length ? <Card><Empty>No games scheduled{week === 'all' ? ' this season' : ` in week ${week}`}.</Empty></Card> : (
        <Card pad={false}><div className="scroll-x"><table className="w-full min-w-[820px]">
          <thead><tr className="border-b border-ink-700"><th className={th}>Wk</th><th className={th}>Matchup</th><th className={th}>Kickoff</th><th className={th}>Network</th><th className={th}>Designations</th><th className={th}>Status</th><th className={thr}>Actions</th></tr></thead>
          <tbody>{d.games.map((g: Row) => (
            <tr key={g.id} className={cx('border-b border-ink-800 last:border-0', g.status === 'canceled' && 'opacity-50')}>
              <td className={cx(td, 'tnum')}>{g.week}</td>
              <td className={td}><span className="flex items-center gap-2"><TeamLogo team={team(g.away_team_id)} size={20} /><b>{team(g.away_team_id).short}</b><span className="text-ink-400">{g.neutral_site ? 'vs' : 'at'}</span><TeamLogo team={team(g.home_team_id)} size={20} /><b>{team(g.home_team_id).short}</b></span></td>
              <td className={cx(td, 'text-ink-200')}>{fmtKick(g.kickoff_at)}</td><td className={td}>{g.network ?? '—'}</td>
              <td className={td}><span className="flex flex-wrap gap-1">{g.designations.map((x: string) => DESIGNATION[x] && <Badge key={x} tone={DESIGNATION[x].tone}>{DESIGNATION[x].label}</Badge>)}</span></td>
              <td className={td}>{g.status === 'final' ? <Badge tone="green">Final {g.away_score}–{g.home_score}</Badge> : g.status === 'in_progress' ? <Badge tone="live">Live {g.live_away}–{g.live_home}</Badge> : <Badge tone={g.status === 'canceled' ? 'red' : g.status === 'postponed' ? 'gold' : 'neutral'}>{g.status}</Badge>}</td>
              <td className={cx(td, 'text-right')}><span className="inline-flex gap-1.5">
                <Button size="sm" onClick={() => setEdit(g)}>Edit</Button>
                {g.status !== 'final' && g.status !== 'canceled' && <Button size="sm" variant="outline" onClick={() => confirm('Cancel this game? It will be shown as canceled and cannot receive a result.') && act.run(async () => { await api.patch(`/admin/games/${g.id}`, { status: 'canceled' }); refresh(); })}>Cancel</Button>}
                {!g.run && g.status !== 'final' && <Button size="sm" variant="ghost" onClick={() => confirm('Delete this game from the schedule?') && act.run(async () => { await api.del(`/admin/games/${g.id}`); refresh(); })}>Delete</Button>}
              </span></td>
            </tr>))}</tbody></table></div></Card>)}</Load>
      {edit && <GameForm game={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
    </div>
  );
}

// ================================================================== TEAM MANAGER
/** Shrink an uploaded logo in the browser so it fits comfortably in the database. */
async function logoDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function TeamForm({ team, onClose, onSaved }: { team: Row | null; onClose: () => void; onSaved: () => void }) {
  const { meta, seasonId } = useSeason();
  const confs = useApi<any>('/admin/conferences');
  const [f, setF] = useState<Row>(() => ({
    name: team?.name ?? '', shortName: team?.short_name ?? '', abbr: team?.abbr ?? '', mascot: team?.mascot ?? '', primaryColor: team?.primary_color ?? '#1e3a5f', secondaryColor: team?.secondary_color ?? '#ffffff', stadium: team?.stadium ?? '',
    logo: null as string | null, removeLogo: false, inSeason: team ? !!team.in_season : true, conferenceId: team?.conference_id ?? '', offRating: team?.off_rating ?? 70, defRating: team?.def_rating ?? 70, stRating: team?.st_rating ?? 70,
    offScheme: team?.off_scheme ?? 'Balanced', defScheme: team?.def_scheme ?? '4-3', customRun: team?.run_pct != null, runPct: team?.run_pct ?? 50, tempo: team?.tempo ?? 'normal',
  }));
  const act = useAction();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = () => act.run(async () => {
    const base = { name: f.name, shortName: f.shortName || f.name, abbr: f.abbr, mascot: f.mascot || null, primaryColor: f.primaryColor, secondaryColor: f.secondaryColor, stadium: f.stadium || null, ...(f.logo ? { logo: f.logo } : {}) };
    const id = team ? team.id : (await api.post('/admin/teams', base)).id;
    if (team) await api.patch(`/admin/teams/${id}`, { ...base, removeLogo: f.removeLogo || undefined });
    if (seasonId && f.inSeason) await api.put(`/admin/teams/${id}/season`, { seasonId, conferenceId: f.conferenceId || null, offRating: Number(f.offRating), defRating: Number(f.defRating), stRating: Number(f.stRating), offScheme: f.offScheme, defScheme: f.defScheme, runPct: f.customRun ? Number(f.runPct) : null, tempo: f.tempo });
    else if (seasonId && team?.in_season && !f.inSeason) await api.del(`/admin/teams/${id}/season?season=${seasonId}`);
    onSaved();
  });
  return (
    <Modal wide title={team ? `Edit ${team.name}` : 'Add a team'} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Team name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Tulsa Golden Wolves" /></Field>
        <Field label="Abbreviation"><Input value={f.abbr} maxLength={6} onChange={(e) => set('abbr', e.target.value.toUpperCase())} placeholder="TUL" /></Field>
        <Field label="Short name"><Input value={f.shortName} onChange={(e) => set('shortName', e.target.value)} placeholder="Tulsa" /></Field>
        <Field label="Mascot"><Input value={f.mascot} onChange={(e) => set('mascot', e.target.value)} /></Field>
        <Field label="Stadium"><Input value={f.stadium} onChange={(e) => set('stadium', e.target.value)} /></Field>
        <Field label="Primary color"><span className="flex gap-2"><input type="color" value={f.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} className="h-9 w-12 rounded border border-ink-600 bg-ink-900" /><Input value={f.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} /></span></Field>
        <Field label="Secondary color"><span className="flex gap-2"><input type="color" value={f.secondaryColor} onChange={(e) => set('secondaryColor', e.target.value)} className="h-9 w-12 rounded border border-ink-600 bg-ink-900" /><Input value={f.secondaryColor} onChange={(e) => set('secondaryColor', e.target.value)} /></span></Field>
        <Field label="Logo" hint="PNG, JPEG or WebP. Resized to 256 px.">
          <span className="flex items-center gap-2">
            <TeamLogo team={{ abbr: f.abbr || '?', color: f.primaryColor, color2: f.secondaryColor, logo: f.removeLogo ? null : f.logo ?? team?.logo ?? null }} size={36} />
            <input type="file" accept="image/png,image/jpeg,image/webp" className="text-xs" onChange={async (e) => { const file = e.target.files?.[0]; if (file) { set('logo', await logoDataUrl(file)); set('removeLogo', false); } }} />
            {(team?.logo || f.logo) && <Button size="sm" variant="ghost" onClick={() => { set('logo', null); set('removeLogo', true); }}>Remove</Button>}
          </span>
        </Field>
        {seasonId && <>
          <div className="mt-2 border-t border-ink-700 pt-3 sm:col-span-3"><Check label={`Entered in ${meta?.season?.name ?? 'this season'}`} checked={f.inSeason} onChange={(v) => set('inSeason', v)} /></div>
          {f.inSeason && <>
            <Field label="Conference"><Select value={f.conferenceId} onChange={(e) => set('conferenceId', e.target.value)}><option value="">Independent</option>{confs.data?.conferences.map((c: Row) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Offensive identity"><Select value={f.offScheme} onChange={(e) => set('offScheme', e.target.value)}>{OFF_SCHEMES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label="Defensive identity"><Select value={f.defScheme} onChange={(e) => set('defScheme', e.target.value)}>{DEF_SCHEMES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label="Offense rating (40–99)"><Input type="number" min={40} max={99} value={f.offRating} onChange={(e) => set('offRating', e.target.value)} /></Field>
            <Field label="Defense rating (40–99)"><Input type="number" min={40} max={99} value={f.defRating} onChange={(e) => set('defRating', e.target.value)} /></Field>
            <Field label="Special teams rating (40–99)"><Input type="number" min={40} max={99} value={f.stRating} onChange={(e) => set('stRating', e.target.value)} /></Field>
            <Field label="Tempo"><Select value={f.tempo} onChange={(e) => set('tempo', e.target.value)}>{TEMPOS.map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <div className="sm:col-span-2">
              <Check label="Custom run / pass ratio (overrides the scheme default)" checked={f.customRun} onChange={(v) => set('customRun', v)} />
              {f.customRun && <div className="mt-2 flex items-center gap-3"><input type="range" min={5} max={95} step={5} value={f.runPct} onChange={(e) => set('runPct', Number(e.target.value))} className="flex-1 accent-[#f5b301]" /><span className="w-40 text-sm tnum">{f.runPct}% run / {100 - f.runPct}% pass</span></div>}
            </div>
          </>}
        </>}
        <ErrorBox className="sm:col-span-3" error={act.error} />
        <div className="flex justify-end gap-2 sm:col-span-3"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={act.busy} disabled={!f.name || f.abbr.length < 2} onClick={save}>{team ? 'Save team' : 'Create team'}</Button></div>
      </div>
    </Modal>
  );
}

export function TeamManager() {
  const { seasonId, meta, reload, setSeason } = useSeason();
  const q = useApi<any>(seasonId ? `/admin/teams${qs({ season: seasonId })}` : null);
  const seasons = useApi<any>('/admin/seasons');
  const confs = useApi<any>('/admin/conferences');
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const [ns, setNs] = useState({ year: String(new Date().getFullYear()), name: '', weeks: '14' });
  const [nc, setNc] = useState({ name: '', abbr: '' });
  const act = useAction();
  const refresh = () => { q.reload(); seasons.reload(); confs.reload(); reload(); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><h1 className="font-display text-3xl font-bold uppercase">Team Manager</h1>{seasonId && <Button className="ml-auto" variant="primary" onClick={() => setEdit('new')}>Add a team</Button>}</div>
      <ErrorBox error={act.error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Seasons">
          <ul className="mb-3 divide-y divide-ink-700">{(seasons.data?.seasons ?? []).map((s: Row) => (
            <li key={s.id} className="flex items-center gap-2 py-1.5 text-sm"><b>{s.name}</b><span className="text-ink-400">{s.weeks} weeks</span>{s.is_current ? <Badge tone="green">Current</Badge> : <Button size="sm" variant="ghost" onClick={() => act.run(async () => { await api.patch(`/admin/seasons/${s.id}`, { isCurrent: true }); refresh(); })}>Make current</Button>}
              {s.id !== seasonId && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSeason(s.id)}>Work on this season</Button>}</li>))}
            {!seasons.data?.seasons.length && <li className="py-2 text-sm text-ink-400">No seasons yet. Create the first one to begin.</li>}</ul>
          <form className="grid grid-cols-[5rem_1fr_5rem_auto] items-end gap-2" onSubmit={(e) => { e.preventDefault(); act.run(async () => { const r = await api.post('/admin/seasons', { year: Number(ns.year), name: ns.name || `${ns.year} Season`, weeks: Number(ns.weeks), isCurrent: !seasons.data?.seasons.length }); if (!seasonId) setSeason(r.id); setNs({ ...ns, name: '' }); refresh(); }); }}>
            <Field label="Year"><Input value={ns.year} onChange={(e) => setNs({ ...ns, year: e.target.value })} /></Field><Field label="Name"><Input value={ns.name} placeholder={`${ns.year} Season`} onChange={(e) => setNs({ ...ns, name: e.target.value })} /></Field><Field label="Weeks"><Input value={ns.weeks} onChange={(e) => setNs({ ...ns, weeks: e.target.value })} /></Field><Button busy={act.busy}>Add season</Button>
          </form>
        </Card>
        <Card title="Conferences">
          <ul className="mb-3 divide-y divide-ink-700">{(confs.data?.conferences ?? []).map((c: Row) => (
            <li key={c.id} className="flex items-center gap-2 py-1.5 text-sm"><b>{c.name}</b><span className="text-ink-400">{c.abbr}</span><Button size="sm" variant="ghost" className="ml-auto" onClick={() => confirm(`Delete ${c.name}?`) && act.run(async () => { await api.del(`/admin/conferences/${c.id}`); refresh(); })}>Delete</Button></li>))}
            {!confs.data?.conferences.length && <li className="py-2 text-sm text-ink-400">No conferences yet.</li>}</ul>
          <form className="grid grid-cols-[1fr_6rem_auto] items-end gap-2" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api.post('/admin/conferences', nc); setNc({ name: '', abbr: '' }); refresh(); }); }}>
            <Field label="Name"><Input required value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></Field><Field label="Abbr"><Input required value={nc.abbr} onChange={(e) => setNc({ ...nc, abbr: e.target.value.toUpperCase() })} /></Field><Button busy={act.busy}>Add</Button>
          </form>
        </Card>
      </div>
      {seasonId && <Load q={q}>{(d) => !d.teams.length ? <Card><Empty>No teams yet. Add the league's teams — names, colors, logos, ratings and schemes are all yours to set.</Empty></Card> : (
        <Card title={`Teams (${d.teams.filter((t: Row) => t.in_season).length} in ${meta?.season?.name})`} pad={false}><div className="scroll-x"><table className="w-full min-w-[820px]">
          <thead><tr className="border-b border-ink-700"><th className={th}>Team</th><th className={th}>Conference</th><th className={thr}>Off</th><th className={thr}>Def</th><th className={thr}>ST</th><th className={th}>Offense</th><th className={th}>Defense</th><th className={thr}>Roster</th><th className={thr} /></tr></thead>
          <tbody>{d.teams.map((t: Row) => (
            <tr key={t.id} className={cx('border-b border-ink-800 last:border-0', !t.in_season && 'opacity-55')}>
              <td className={td}><span className="flex items-center gap-2"><TeamLogo team={{ abbr: t.abbr, color: t.primary_color, color2: t.secondary_color, logo: t.logo }} size={26} /><b>{t.name}</b><span className="text-xs text-ink-400">{t.abbr}</span></span></td>
              <td className={td}>{t.in_season ? t.conference_name ?? 'Independent' : <Badge>Not in this season</Badge>}</td>
              <td className={tdr}>{t.off_rating ?? '—'}</td><td className={tdr}>{t.def_rating ?? '—'}</td><td className={tdr}>{t.st_rating ?? '—'}</td>
              <td className={td}>{t.off_scheme ?? '—'}{t.run_pct != null && <span className="text-xs text-ink-400"> · {t.run_pct}% run</span>}</td><td className={td}>{t.def_scheme ?? '—'}</td>
              <td className={tdr}>{t.activeCount}{t.rosterCount !== t.activeCount && <span className="text-xs text-ink-400"> / {t.rosterCount}</span>}</td>
              <td className={cx(td, 'text-right')}><span className="inline-flex gap-1.5"><Button size="sm" onClick={() => setEdit(t)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => confirm(`Delete ${t.name}? This is only possible for a team with no games and no roster.`) && act.run(async () => { await api.del(`/admin/teams/${t.id}`); refresh(); })}>Delete</Button></span></td>
            </tr>))}</tbody></table></div></Card>)}</Load>}
      {edit && <TeamForm team={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
    </div>
  );
}

// ================================================================== ROSTER MANAGER
function PlayerForm({ player, teamId, onClose, onSaved }: { player: Row | null; teamId: string; onClose: () => void; onSaved: () => void }) {
  const { seasonId } = useSeason();
  const [f, setF] = useState<Row>(() => ({ name: player?.name ?? '', jersey: player?.jersey ?? '', position: player?.position ?? 'QB', secondary: (player?.secondary_positions ?? []) as string[], depth: player?.depth_rank ?? 1, rating: player?.rating ?? '', active: player?.active ?? true, awards: (player?.awards ?? []).join('\n') }));
  const act = useAction();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = () => act.run(async () => {
    const b = { name: f.name, jersey: numOr(String(f.jersey), null), position: f.position, secondary: f.secondary.filter((p: string) => p !== f.position), depth: Number(f.depth) || 1, rating: numOr(String(f.rating), null), active: f.active };
    if (player) await api.patch(`/admin/roster/${player.id}`, { ...b, awards: String(f.awards).split('\n').map((s) => s.trim()).filter(Boolean) });
    else await api.post('/admin/roster', { ...b, seasonId, teamId });
    onSaved();
  });
  return (
    <Modal title={player ? `Edit ${player.name}` : 'Add a player'} onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Name" className="sm:col-span-3"><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Jersey"><Input inputMode="numeric" value={f.jersey} onChange={(e) => set('jersey', e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Primary position" className="sm:col-span-2"><Select value={f.position} onChange={(e) => set('position', e.target.value)}>{POSITIONS.map((p) => <option key={p}>{p}</option>)}</Select></Field>
        <Field label="Depth rank" hint="1 = starter"><Input type="number" min={1} max={9} value={f.depth} onChange={(e) => set('depth', e.target.value)} /></Field>
        <Field label="Rating" hint="40–99, optional"><Input inputMode="numeric" value={f.rating} onChange={(e) => set('rating', e.target.value.replace(/\D/g, ''))} /></Field>
        <div className="sm:col-span-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-300">Secondary positions <span className="normal-case text-ink-400">— a player may earn statistics at any position listed here</span></p>
          <div className="flex flex-wrap gap-1">{POSITIONS.filter((p) => p !== f.position).map((p) => { const on = f.secondary.includes(p); return <button key={p} type="button" onClick={() => set('secondary', on ? f.secondary.filter((x: string) => x !== p) : [...f.secondary, p])} className={cx('rounded px-2 py-1 text-xs font-semibold', on ? 'bg-gold text-ink-950' : 'bg-ink-700 text-ink-200 hover:bg-ink-600')}>{p}</button>; })}</div>
        </div>
        {player && <Field label="Awards (one per line)" className="sm:col-span-4"><Textarea rows={2} value={f.awards} onChange={(e) => set('awards', e.target.value)} /></Field>}
        <div className="sm:col-span-4"><Check label="Active (inactive players never receive statistics)" checked={f.active} onChange={(v) => set('active', v)} /></div>
        <ErrorBox className="sm:col-span-4" error={act.error} />
        <div className="flex justify-end gap-2 sm:col-span-4"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={act.busy} disabled={!f.name.trim()} onClick={save}>{player ? 'Save player' : 'Add player'}</Button></div>
      </div>
    </Modal>
  );
}

export function RosterManager() {
  const { seasonId, meta } = useSeason();
  const [teamId, setTeamId] = useState('');
  useEffect(() => { if (!teamId && meta?.teams[0]) setTeamId(meta.teams[0].id); }, [meta, teamId]);
  const q = useApi<any>(teamId ? `/admin/roster${qs({ season: seasonId, team: teamId })}` : null);
  const [edit, setEdit] = useState<Row | 'new' | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const act = useAction();
  const others = (meta?.seasons ?? []).filter((s) => s.id !== seasonId);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="font-display text-3xl font-bold uppercase">Roster Manager</h1>
        <Field label="Team" className="ml-auto w-64"><Select value={teamId} onChange={(e) => setTeamId(e.target.value)}>{meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Button onClick={() => setCsv('name,jersey,position,secondary,depth,rating\n')} disabled={!teamId}>Import CSV</Button>
        <Button variant="primary" onClick={() => setEdit('new')} disabled={!teamId}>Add a player</Button>
      </div>
      {!meta?.teams.length && <Notice>Add teams to this season in Team Manager first.</Notice>}
      <Notice>Only players on this roster can ever receive individual statistics. If a position needed for a play is empty, the engine first uses a player with that secondary position, then credits the team; it never invents a player.</Notice>
      <ErrorBox error={act.error} />
      {q.data?.check && (q.data.check.errors.length > 0 || q.data.check.warnings.length > 0) && (
        <div className="space-y-2">
          {q.data.check.errors.length > 0 && <Notice tone="warn"><b>This team cannot be simulated yet:</b><ul className="list-disc pl-5">{q.data.check.errors.map((e: string) => <li key={e}>{e}</li>)}</ul></Notice>}
          {q.data.check.warnings.length > 0 && <details className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200"><summary className="cursor-pointer">Team-level attribution in effect ({q.data.check.warnings.length})</summary><ul className="mt-1 list-disc pl-5 text-ink-300">{q.data.check.warnings.map((e: string) => <li key={e}>{e}</li>)}</ul></details>}
        </div>)}
      {teamId && <Load q={q}>{(d) => !d.players.length ? (
        <Card><Empty>No players on this roster.</Empty>
          {others.length > 0 && <div className="flex justify-center gap-2">{others.map((s) => <Button key={s.id} size="sm" onClick={() => act.run(async () => { await api.post('/admin/roster/copy', { fromSeasonId: s.id, toSeasonId: seasonId, teamId }); q.reload(); })}>Carry over the {s.name} roster</Button>)}</div>}
        </Card>) : (
        <Card pad={false}><div className="scroll-x"><table className="w-full min-w-[640px]">
          <thead><tr className="border-b border-ink-700"><th className={th}>#</th><th className={th}>Player</th><th className={th}>Pos</th><th className={th}>Secondary</th><th className={thr}>Depth</th><th className={thr}>Rating</th><th className={th}>Status</th><th className={thr} /></tr></thead>
          <tbody>{d.players.map((p: Row) => (
            <tr key={p.id} className={cx('border-b border-ink-800 last:border-0', !p.active && 'opacity-55')}>
              <td className={cx(td, 'tnum text-ink-400')}>{p.jersey ?? ''}</td><td className={cx(td, 'font-medium')}>{p.name}</td><td className={td}><Badge>{p.position}</Badge></td><td className={cx(td, 'text-ink-300')}>{p.secondary_positions.join(', ')}</td>
              <td className={tdr}>{p.depth_rank}</td><td className={tdr}>{p.rating ?? '—'}</td><td className={td}>{p.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
              <td className={cx(td, 'text-right')}><span className="inline-flex gap-1.5"><Button size="sm" onClick={() => setEdit(p)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => act.run(async () => { await api.patch(`/admin/roster/${p.id}`, { active: !p.active }); q.reload(); })}>{p.active ? 'Deactivate' : 'Activate'}</Button><Button size="sm" variant="ghost" onClick={() => confirm(`Remove ${p.name} from the roster?`) && act.run(async () => { await api.del(`/admin/roster/${p.id}`); q.reload(); })}>Remove</Button></span></td>
            </tr>))}</tbody></table></div></Card>)}</Load>}
      {edit && <PlayerForm player={edit === 'new' ? null : edit} teamId={teamId} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
      {csv !== null && (
        <Modal wide title="Import a roster from CSV" onClose={() => setCsv(null)}>
          <p className="mb-2 text-sm text-ink-300">Columns: <code>name, jersey, position, secondary, depth, rating, active</code>. Only <code>name</code> and <code>position</code> are required. Separate several secondary positions with a slash (QB/FS). If any row is invalid, nothing is imported.</p>
          <Textarea rows={12} value={csv} onChange={(e) => setCsv(e.target.value)} spellCheck={false} />
          <ErrorBox className="mt-2" error={act.error} />
          <div className="mt-3 flex justify-end gap-2"><Button variant="ghost" onClick={() => setCsv(null)}>Cancel</Button><Button variant="primary" busy={act.busy} onClick={() => act.run(async () => { await api.post('/admin/roster/import', { seasonId, teamId, csv }); setCsv(null); q.reload(); })}>Import players</Button></div>
        </Modal>)}
    </div>
  );
}
