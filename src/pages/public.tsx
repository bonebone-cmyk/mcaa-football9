import { ChevronLeft, ChevronRight, MapPin, Tv } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { qs, useApi } from '../api';
import { Designations, GameCard, NoSeason, PageTitle, Rank, StatusPill, TeamLogo, fmtDay, fmtKick, fmtTime, periodLabel, fmtClock, useSeason, type Game, type TeamRef } from '../shared';
import { Badge, Card, Empty, Load, Select, Tabs, cx, td, tdr, th, thr } from '../ui';

// ================================================================== HOME
function Featured({ g }: { g: Game }) {
  const side = (t: TeamRef, align: 'left' | 'right') => (
    <Link to={`/teams/${t.id}`} className={cx('flex min-w-0 flex-1 flex-col items-center gap-2 text-center sm:flex-row sm:gap-4', align === 'right' ? 'sm:flex-row-reverse sm:text-right' : 'sm:text-left')}>
      <span className="sm:hidden"><TeamLogo team={t} size={56} className="drop-shadow-lg" /></span><span className="hidden shrink-0 sm:block"><TeamLogo team={t} size={84} className="drop-shadow-lg" /></span>
      <div className="min-w-0 max-w-full">
        <p className="font-display text-xl font-bold uppercase leading-none sm:text-4xl"><Rank n={t.rank} /><span className="sm:hidden">{t.short}</span><span className="hidden sm:inline">{t.name}</span></p>
        <p className="mt-1 text-xs text-white/75 tnum sm:text-sm">{t.record}<span className="hidden sm:inline"> overall · {t.confRecord} conf</span></p>
      </div>
    </Link>
  );
  const showScore = g.status === 'final' || g.status === 'in_progress';
  return (
    <section className="relative overflow-hidden rounded-2xl border border-ink-600" style={{ background: `linear-gradient(105deg, ${g.away.color} 0%, #0a1020 46%, #0a1020 54%, ${g.home.color} 100%)` }}>
      <div className="absolute inset-0 bg-ink-950/45" aria-hidden />
      <div className="relative p-5 sm:p-7">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge tone="gold">{g.designations.includes('gotw') ? 'Game of the Week' : 'Featured matchup'}</Badge>
          <Designations list={g.designations.filter((d) => d !== 'gotw')} />
          <span className="text-xs font-medium uppercase tracking-wide text-white/70">Week {g.week}</span>
        </div>
        <div className="flex items-center gap-3 sm:gap-6">
          {side(g.away, 'left')}
          <Link to={`/games/${g.id}`} className="shrink-0 text-center">
            {showScore ? <p className="whitespace-nowrap font-display text-4xl font-extrabold tnum sm:text-6xl">{g.away.score ?? 0}<span className="mx-1.5 text-white/40 sm:mx-2">–</span>{g.home.score ?? 0}</p> : <p className="font-display text-3xl font-bold text-white/60">{g.neutralSite ? 'VS' : 'AT'}</p>}
            <div className="mt-1"><StatusPill g={g} /></div>
          </Link>
          {side(g.home, 'right')}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-white/80">
          <span>{fmtKick(g.kickoffAt)}</span>
          {g.network && <span className="inline-flex items-center gap-1"><Tv className="size-4" />{g.network}</span>}
          {g.stadium && <span className="inline-flex items-center gap-1"><MapPin className="size-4" />{g.stadium}{g.neutralSite ? ' (neutral site)' : ''}</span>}
          <Link to={`/games/${g.id}`} className="font-semibold text-gold-soft hover:underline">Game page →</Link>
        </div>
      </div>
    </section>
  );
}

export function Home() {
  const { seasonId, meta, loading } = useSeason();
  const [week, setWeek] = useState<number | null>(null);
  const q = useApi<any>(seasonId ? `/home${qs({ season: seasonId, week })}` : null, 30000);
  if (!loading && meta && !meta.season) return <NoSeason />;
  return (
    <Load q={q}>
      {(d) => {
        const idx = d.weeks.indexOf(d.week);
        return (
          <div className="space-y-5">
            <section aria-label="Scoreboard">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="font-display text-xl font-bold uppercase tracking-wide">Scoreboard</h2>
                <div className="ml-auto flex items-center gap-1">
                  <button aria-label="Previous week" disabled={idx <= 0} onClick={() => setWeek(d.weeks[idx - 1])} className="rounded p-1 text-ink-200 hover:bg-ink-800 disabled:opacity-30"><ChevronLeft className="size-5" /></button>
                  <Select aria-label="Week" className="!w-auto !py-1 !text-xs" value={d.week} onChange={(e) => setWeek(Number(e.target.value))}>
                    {(d.weeks.length ? d.weeks : [d.week]).map((w: number) => <option key={w} value={w}>Week {w}{w === d.currentWeek ? ' (current)' : ''}</option>)}
                  </Select>
                  <button aria-label="Next week" disabled={idx < 0 || idx >= d.weeks.length - 1} onClick={() => setWeek(d.weeks[idx + 1])} className="rounded p-1 text-ink-200 hover:bg-ink-800 disabled:opacity-30"><ChevronRight className="size-5" /></button>
                </div>
              </div>
              {d.scoreboard.length ? <div className="scroll-x flex gap-2 pb-2">{d.scoreboard.map((g: Game) => <GameCard key={g.id} g={g} compact />)}</div> : <Empty>No games are scheduled for week {d.week}.</Empty>}
            </section>

            {d.featured && <Featured g={d.featured} />}

            <div>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
                <h2 className="font-display text-xl font-bold uppercase tracking-wide">Around the league</h2>
                <p className="text-xs text-ink-400">Compiled automatically from official MCAA results and statistics.</p>
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <Card title="Recent results">
                  {d.recent.length ? <ul className="divide-y divide-ink-700">{d.recent.map((g: Game) => {
                    const aw = (g.away.score ?? 0) > (g.home.score ?? 0);
                    const w = aw ? g.away : g.home, l = aw ? g.home : g.away;
                    return <li key={g.id}><Link to={`/games/${g.id}`} className="flex items-center gap-2 py-2 hover:text-gold-soft">
                      <TeamLogo team={w} size={22} /><span className="min-w-0 flex-1 truncate text-sm"><b>{w.short}</b> {w.score}, {l.short} {l.score}</span>
                      {g.mode === 'primetime' && <Badge tone="purple">CFB 27</Badge>}<span className="text-xs text-ink-400">Wk {g.week}</span>
                    </Link></li>;
                  })}</ul> : <Empty>No final scores yet.</Empty>}
                </Card>
                <Card title="Top performances">
                  {d.topPerformances.length ? <ul className="divide-y divide-ink-700">{d.topPerformances.map((p: any, i: number) => (
                    <li key={i} className="flex items-center gap-2 py-2 text-sm">
                      <span className="w-12 font-display text-xl font-bold text-gold-soft tnum">{p.value}</span>
                      <div className="min-w-0 flex-1"><Link to={`/players/${p.playerId}`} className="font-medium hover:text-gold-soft">{p.name}</Link> <span className="text-ink-400">{p.teamAbbr}</span>
                        <p className="text-xs text-ink-400">{p.label}{p.label === 'Passing yards' ? ` · ${p.a}/${p.b}` : ` · ${p.a} ${p.label === 'Rushing yards' ? 'car' : 'rec'}`}{p.td ? ` · ${p.td} TD` : ''}</p></div>
                      <Link to={`/games/${p.gameId}`} className="text-xs text-ink-400 hover:text-ink-100">Wk {p.week}</Link>
                    </li>))}</ul> : <Empty>Performances appear after the first published game.</Empty>}
                </Card>
                <Card title="Statistical leaders" action={<Link to="/stats" className="text-xs font-semibold text-gold-soft hover:underline">All stats</Link>}>
                  {d.leaders.length ? <ul className="divide-y divide-ink-700">{d.leaders.map((p: any, i: number) => (
                    <li key={i} className="flex items-center gap-2 py-2 text-sm">
                      <span className="w-28 text-xs uppercase tracking-wide text-ink-400">{p.label}</span>
                      <Link to={`/players/${p.playerId}`} className="min-w-0 flex-1 truncate font-medium hover:text-gold-soft">{p.name} <span className="font-normal text-ink-400">{p.teamAbbr}</span></Link>
                      <span className="font-display text-lg font-bold tnum">{p.value}</span>
                    </li>))}</ul> : <Empty>No statistics yet.</Empty>}
                </Card>
                <Card title="Biggest upsets">
                  {d.upsets.length ? <ul className="divide-y divide-ink-700">{d.upsets.map((u: any) => (
                    <li key={u.gameId}><Link to={`/games/${u.gameId}`} className="block py-2 text-sm hover:text-gold-soft">
                      <b>{u.winnerRank ? `No. ${u.winnerRank} ` : ''}{u.winner}</b> beat No. {u.loserRank} {u.loser}, {u.score} <span className="text-xs text-ink-400">· Week {u.week}</span>
                    </Link></li>))}</ul> : <Empty>No ranked team has been upset yet.</Empty>}
                </Card>
                <Card title="Featured highlights" className="lg:col-span-1">
                  {d.highlights.length ? <ul className="divide-y divide-ink-700">{d.highlights.map((h: any, i: number) => (
                    <li key={i}><Link to={`/games/${h.gameId}`} className="block py-2 hover:text-gold-soft">
                      <p className="text-sm font-semibold">{h.title} {h.mode === 'primetime' && <Badge tone="purple" title="Generated reconstruction, not observed gameplay">Reconstruction</Badge>}</p>
                      <p className="text-xs text-ink-300">{periodLabel(h.quarter)}{h.quarter <= 4 ? ` ${fmtClock(h.clock)}` : ''} — {h.text}</p>
                    </Link></li>))}</ul> : <Empty>Highlights appear after the first published game.</Empty>}
                </Card>
                <Card title="Upcoming games" action={<Link to="/schedule" className="text-xs font-semibold text-gold-soft hover:underline">Full schedule</Link>}>
                  {d.upcoming.length ? <ul className="divide-y divide-ink-700">{d.upcoming.map((g: Game) => (
                    <li key={g.id}><Link to={`/games/${g.id}`} className="flex items-center gap-2 py-2 text-sm hover:text-gold-soft">
                      <TeamLogo team={g.away} size={20} /><span className="min-w-0 flex-1 truncate"><Rank n={g.away.rank} />{g.away.short} at <Rank n={g.home.rank} />{g.home.short}</span><TeamLogo team={g.home} size={20} />
                      <span className="w-24 text-right text-xs text-ink-400">Wk {g.week} · {g.kickoffAt ? fmtTime(g.kickoffAt) : 'TBD'}</span>
                    </Link></li>))}</ul> : <Empty>Nothing on the calendar.</Empty>}
                </Card>
              </div>
            </div>
          </div>
        );
      }}
    </Load>
  );
}

// ================================================================== SCHEDULE
export function Schedule() {
  const { seasonId, meta } = useSeason();
  const [week, setWeek] = useState<string>('current');
  const [conference, setConference] = useState('');
  const [team, setTeam] = useState('');
  const [status, setStatus] = useState('');
  const w = week === 'current' ? meta?.currentWeek : week === 'all' ? null : Number(week);
  const q = useApi<{ games: Game[] }>(seasonId ? `/schedule${qs({ season: seasonId, week: w, conference, team, status })}` : null, 30000);
  if (meta && !meta.season) return <NoSeason />;
  const weeks = meta?.weeks.length ? meta.weeks : Array.from({ length: meta?.season?.weeks ?? 1 }, (_, i) => i + 1);
  return (
    <>
      <PageTitle sub={meta?.season?.name}>Schedule</PageTitle>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Select aria-label="Week" value={week} onChange={(e) => setWeek(e.target.value)}>
          <option value="current">Current week ({meta?.currentWeek ?? 1})</option><option value="all">All weeks</option>
          {weeks.map((x) => <option key={x} value={x}>Week {x}</option>)}
        </Select>
        <Select aria-label="Conference" value={conference} onChange={(e) => setConference(e.target.value)}><option value="">All conferences</option>{meta?.conferences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}><option value="">All teams</option>{meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option value="scheduled">Scheduled</option><option value="in_progress">In progress</option><option value="final">Final</option><option value="postponed">Postponed</option><option value="canceled">Canceled</option></Select>
      </div>
      <Load q={q}>
        {(d) => {
          if (!d.games.length) return <Empty>No games match these filters.</Empty>;
          const groups = new Map<string, Game[]>();
          for (const g of d.games) { const k = `${g.week}|${g.kickoffAt ? new Date(g.kickoffAt).toDateString() : ''}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(g); }
          return <div className="space-y-5">{[...groups.entries()].map(([k, gs]) => (
            <section key={k}>
              <h2 className="mb-2 font-display text-lg font-semibold uppercase tracking-wide text-ink-200">Week {gs[0].week} <span className="text-ink-400">· {fmtDay(gs[0].kickoffAt)}</span></h2>
              <div className="overflow-hidden rounded-xl border border-ink-700 bg-ink-850">
                {gs.map((g) => {
                  const fin = g.status === 'final' || g.status === 'in_progress';
                  return (
                    <Link key={g.id} to={`/games/${g.id}`} className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-ink-700 px-3 py-2.5 last:border-0 hover:bg-ink-800 sm:grid-cols-[5rem_1fr_auto_10rem]">
                      <span className="hidden text-sm text-ink-300 tnum sm:block">{g.status === 'scheduled' ? fmtTime(g.kickoffAt) : ''}</span>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <TeamLogo team={g.away} size={22} /><span className="font-display text-lg font-semibold"><Rank n={g.away.rank} />{g.away.short}</span>
                        {fin && <span className="font-display text-lg font-bold tnum">{g.away.score}</span>}
                        <span className="text-ink-400">{g.neutralSite ? 'vs' : 'at'}</span>
                        <TeamLogo team={g.home} size={22} /><span className="font-display text-lg font-semibold"><Rank n={g.home.rank} />{g.home.short}</span>
                        {fin && <span className="font-display text-lg font-bold tnum">{g.home.score}</span>}
                        <Designations list={g.designations} />
                      </div>
                      <StatusPill g={g} />
                      <span className="hidden truncate text-right text-xs text-ink-400 sm:block">{[g.network, g.stadium].filter(Boolean).join(' · ')}</span>
                    </Link>
                  );
                })}
              </div>
            </section>))}</div>;
        }}
      </Load>
    </>
  );
}

// ================================================================== RANKINGS
export function Rankings() {
  const { seasonId, meta } = useSeason();
  const [week, setWeek] = useState<number | null>(null);
  const q = useApi<any>(seasonId ? `/rankings${qs({ season: seasonId, week })}` : null);
  if (meta && !meta.season) return <NoSeason />;
  return (
    <>
      <PageTitle sub="The official MCAA Top 25, set by the league office."
        right={q.data?.weeks.length ? <Select aria-label="Poll week" className="!w-auto" value={q.data.week ?? ''} onChange={(e) => setWeek(Number(e.target.value))}>{q.data.weeks.map((w: number) => <option key={w} value={w}>Week {w} poll</option>)}</Select> : null}>AP Top 25</PageTitle>
      <Load q={q}>{(d) => !d.rankings.length ? <Empty>No rankings have been published for this season.</Empty> : (
        <Card pad={false}>
          <table className="w-full">
            <thead><tr className="border-b border-ink-700"><th className={th}>Rank</th><th className={th}>Team</th><th className={thr}>Record</th><th className={thr}>Last poll</th></tr></thead>
            <tbody>{d.rankings.map((r: any) => {
              const ch = r.previous == null ? null : r.previous - r.rank;
              return (
                <tr key={r.rank} className="border-b border-ink-800 last:border-0 hover:bg-ink-800">
                  <td className={cx(td, 'w-14 font-display text-2xl font-bold tnum')}>{r.rank}</td>
                  <td className={td}>{r.team && <Link to={`/teams/${r.team.id}`} className="flex items-center gap-2.5 font-medium hover:text-gold-soft"><TeamLogo team={r.team} size={28} /><span>{r.team.name} <span className="text-xs text-ink-400">{r.team.conference}</span></span></Link>}</td>
                  <td className={tdr}>{r.record}</td>
                  <td className={tdr}>{ch == null ? <Badge tone="gold">New</Badge> : ch === 0 ? <span className="text-ink-400">—</span> : <span className={ch > 0 ? 'text-emerald-300' : 'text-red-300'}>{ch > 0 ? '▲' : '▼'} {Math.abs(ch)}</span>}</td>
                </tr>);
            })}</tbody>
          </table>
        </Card>)}</Load>
    </>
  );
}

// ================================================================== TEAMS
export function Teams() {
  const { seasonId, meta } = useSeason();
  const q = useApi<any>(seasonId ? `/teams${qs({ season: seasonId })}` : null);
  if (meta && !meta.season) return <NoSeason />;
  return (
    <>
      <PageTitle sub={meta?.season?.name}>Teams</PageTitle>
      <Load q={q}>{(d) => {
        if (!d.teams.length) return <Empty>No teams have been entered in this season.</Empty>;
        const groups = new Map<string, any[]>();
        for (const t of d.teams) (groups.get(t.conference ?? 'Independents') ?? groups.set(t.conference ?? 'Independents', []).get(t.conference ?? 'Independents')!).push(t);
        return <div className="space-y-6">{[...groups.entries()].sort().map(([conf, ts]) => (
          <section key={conf}>
            <h2 className="mb-2 font-display text-xl font-semibold uppercase tracking-wide text-ink-200">{conf}</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{ts.map((t) => (
              <Link key={t.id} to={`/teams/${t.id}`} className="flex items-center gap-3 overflow-hidden rounded-lg border border-ink-700 bg-ink-850 p-3 hover:border-ink-500" style={{ borderLeft: `4px solid ${t.color}` }}>
                <TeamLogo team={t} size={44} />
                <div className="min-w-0"><p className="truncate font-display text-xl font-semibold leading-tight"><Rank n={t.rank} />{t.name}</p><p className="text-xs text-ink-400 tnum">{t.record} ({t.confRecord} conf)</p></div>
              </Link>))}</div>
          </section>))}</div>;
      }}</Load>
    </>
  );
}

// ================================================================== LEADERBOARDS
type Col = { key: string; label: string; digits?: number };
const C = (key: string, label: string, digits?: number): Col => ({ key, label, digits });
const BOARDS: { id: string; label: string; sort: string; qualify?: string; cols: Col[] }[] = [
  { id: 'passYds', label: 'Passing Yards', sort: 'passYds', cols: [C('passCmp', 'Cmp'), C('passAtt', 'Att'), C('passYds', 'Yds'), C('ypa', 'Y/A', 1), C('passTd', 'TD'), C('passInt', 'Int'), C('passRating', 'Rating', 1)] },
  { id: 'passTd', label: 'Passing TDs', sort: 'passTd', cols: [C('passTd', 'TD'), C('passYds', 'Yds'), C('passInt', 'Int'), C('passCmp', 'Cmp'), C('passAtt', 'Att')] },
  { id: 'cmpPct', label: 'Completion %', sort: 'cmpPct', qualify: 'cmpPct', cols: [C('cmpPct', 'Pct', 1), C('passCmp', 'Cmp'), C('passAtt', 'Att'), C('passYds', 'Yds'), C('passRating', 'Rating', 1)] },
  { id: 'rushYds', label: 'Rushing Yards', sort: 'rushYds', cols: [C('rushAtt', 'Car'), C('rushYds', 'Yds'), C('ypc', 'Avg', 1), C('rushTd', 'TD'), C('rushLong', 'Long'), C('fumblesLost', 'Fum')] },
  { id: 'rushTd', label: 'Rushing TDs', sort: 'rushTd', cols: [C('rushTd', 'TD'), C('rushYds', 'Yds'), C('rushAtt', 'Car'), C('ypc', 'Avg', 1)] },
  { id: 'recYds', label: 'Receiving Yards', sort: 'recYds', cols: [C('rec', 'Rec'), C('targets', 'Tgt'), C('recYds', 'Yds'), C('ypr', 'Avg', 1), C('recTd', 'TD'), C('recLong', 'Long')] },
  { id: 'rec', label: 'Receptions', sort: 'rec', cols: [C('rec', 'Rec'), C('recYds', 'Yds'), C('ypr', 'Avg', 1), C('recTd', 'TD')] },
  { id: 'recTd', label: 'Receiving TDs', sort: 'recTd', cols: [C('recTd', 'TD'), C('rec', 'Rec'), C('recYds', 'Yds')] },
  { id: 'tackles', label: 'Tackles', sort: 'tackles', cols: [C('tackles', 'Total'), C('tklSolo', 'Solo'), C('tklAst', 'Ast'), C('tfl', 'TFL', 1), C('sacks', 'Sacks', 1), C('ff', 'FF')] },
  { id: 'sacks', label: 'Sacks', sort: 'sacks', cols: [C('sacks', 'Sacks', 1), C('tfl', 'TFL', 1), C('tackles', 'Tkl'), C('ff', 'FF')] },
  { id: 'defInt', label: 'Interceptions', sort: 'defInt', cols: [C('defInt', 'Int'), C('intRetYds', 'Ret Yds'), C('pd', 'PD'), C('defTd', 'TD')] },
  { id: 'fgm', label: 'Field Goals', sort: 'fgm', cols: [C('fgm', 'FGM'), C('fga', 'FGA'), C('fgPct', 'Pct', 1), C('fgLong', 'Long'), C('xpm', 'XPM'), C('xpa', 'XPA')] },
];
export function Leaders() {
  const { seasonId, meta } = useSeason();
  const [board, setBoard] = useState('passYds');
  const [conference, setConference] = useState('');
  const [team, setTeam] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const q = useApi<any>(seasonId ? `/leaders${qs({ season: seasonId, conference, team })}` : null);
  const b = BOARDS.find((x) => x.id === board)!;
  const s = sort ?? { key: b.sort, dir: -1 as const };
  const rows = useMemo(() => {
    const all: any[] = q.data?.players ?? [];
    return all.filter((p) => p[b.sort] > 0 && (!b.qualify || p.qualified[b.qualify])).sort((x, y) => (y[s.key] - x[s.key]) * -s.dir || y[b.sort] - x[b.sort]).slice(0, 50);
  }, [q.data, b, s.key, s.dir]);
  if (meta && !meta.season) return <NoSeason />;
  const min = b.qualify && q.data?.minimums[b.qualify];
  return (
    <>
      <PageTitle sub="Season totals from officially published games.">Statistical leaders</PageTitle>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:max-w-md">
        <Select aria-label="Conference" value={conference} onChange={(e) => { setConference(e.target.value); setTeam(''); }}><option value="">All conferences</option>{meta?.conferences.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}><option value="">All teams</option>{meta?.teams.filter((t) => !conference || t.conferenceId === conference).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
      </div>
      <Tabs tabs={BOARDS.map((x) => ({ id: x.id, label: x.label }))} value={board} onChange={(v) => { setBoard(v); setSort(null); }} />
      <Load q={q}>{() => (
        <Card pad={false} className="mt-3">
          {min && <p className="border-b border-ink-700 px-3 py-2 text-xs text-ink-400">Minimum to qualify: {min.perGame} {min.stat === 'passAtt' ? 'pass attempts' : min.stat === 'fga' ? 'field-goal attempts' : min.stat} per team game played.</p>}
          {rows.length ? <div className="scroll-x"><table className="w-full min-w-[560px]">
            <thead><tr className="border-b border-ink-700"><th className={th}>#</th><th className={th}>Player</th><th className={th}>Team</th><th className={thr}>GP</th>
              {b.cols.map((c) => <th key={c.key} className={thr}><button onClick={() => setSort({ key: c.key, dir: s.key === c.key ? (s.dir === -1 ? 1 : -1) : -1 })} className={cx('uppercase hover:text-ink-100', s.key === c.key && 'text-gold-soft')}>{c.label}{s.key === c.key ? (s.dir === -1 ? ' ▾' : ' ▴') : ''}</button></th>)}</tr></thead>
            <tbody>{rows.map((p, i) => (
              <tr key={p.playerId + p.teamId} className="border-b border-ink-800 last:border-0 hover:bg-ink-800">
                <td className={cx(td, 'w-8 text-ink-400 tnum')}>{i + 1}</td>
                <td className={td}><Link to={`/players/${p.playerId}`} className="font-medium hover:text-gold-soft">{p.name}</Link> <span className="text-xs text-ink-400">{p.position}</span></td>
                <td className={td}><Link to={`/teams/${p.teamId}`} className="text-ink-200 hover:text-gold-soft">{p.teamAbbr}</Link></td>
                <td className={tdr}>{p.gp}</td>
                {b.cols.map((c) => <td key={c.key} className={cx(tdr, c.key === s.key && 'font-semibold text-white')}>{c.digits ? Number(p[c.key]).toFixed(c.digits) : p[c.key]}</td>)}
              </tr>))}</tbody>
          </table></div> : <Empty>No qualifying players yet.</Empty>}
        </Card>)}</Load>
    </>
  );
}
