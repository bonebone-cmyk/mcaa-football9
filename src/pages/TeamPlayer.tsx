import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { qs, useApi } from '../api';
import { Designations, Rank, StatusPill, TeamLogo, fmtTop, useSeason, type Game } from '../shared';
import { Badge, Card, Empty, Load, Tabs, cx, td, tdr, th, thr } from '../ui';

type Row = Record<string, any>;
const POS_GROUPS: [string, string[]][] = [['Offense', ['QB', 'RB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT']], ['Defense', ['DE', 'DT', 'EDGE', 'LB', 'CB', 'FS', 'SS']], ['Special teams', ['K', 'P', 'KR', 'PR']]];

function Leader({ label, rows, k, text }: { label: string; rows: Row[]; k: string; text: (p: Row) => string }) {
  const p = [...rows].filter((r) => r[k] > 0).sort((a, b) => b[k] - a[k])[0];
  if (!p) return null;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{label}</p>
      <Link to={`/players/${p.playerId}`} className="font-display text-xl font-semibold hover:text-gold-soft">{p.name}</Link>
      <p className="text-sm text-ink-200 tnum">{text(p)}</p>
    </div>
  );
}

export function TeamPage() {
  const { id } = useParams();
  const { seasonId } = useSeason();
  const q = useApi<any>(`/teams/${id}${qs({ season: seasonId })}`);
  const [tab, setTab] = useState<'schedule' | 'roster' | 'stats' | 'history'>('schedule');
  return (
    <Load q={q}>
      {(d) => {
        const t = d.team;
        const per = (v: number, gp: number) => (gp ? (v / gp).toFixed(1) : '0.0');
        const ts = d.teamStats, os = d.opponentStats;
        return (
          <div className="space-y-4">
            <section className="overflow-hidden rounded-2xl border border-ink-600" style={{ background: `linear-gradient(110deg, ${t.color} 0%, #0a1020 70%)` }}>
              <div className="flex flex-wrap items-center gap-4 bg-ink-950/40 p-5">
                <TeamLogo team={t} size={88} />
                <div className="min-w-0 flex-1">
                  <h1 className="font-display text-4xl font-extrabold uppercase leading-none"><Rank n={t.rank} />{t.name}</h1>
                  <p className="mt-1 text-sm text-white/75">{[t.mascot, t.conference ?? 'Independent', t.stadium].filter(Boolean).join(' · ')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">{t.rank && <Badge tone="gold">AP No. {t.rank}</Badge>}{t.offScheme && <Badge>{t.offScheme} offense</Badge>}{t.defScheme && <Badge>{t.defScheme} defense</Badge>}</div>
                </div>
                <dl className="grid grid-cols-4 gap-4 text-center">
                  {[['Overall', t.record], ['Conference', t.confRecord], ['Points', `${t.pf}-${t.pa}`], ['Streak', t.streak || '—']].map(([k, v]) => <div key={k}><dt className="text-[11px] uppercase tracking-wide text-white/60">{k}</dt><dd className="font-display text-2xl font-bold tnum">{v}</dd></div>)}
                </dl>
              </div>
            </section>
            <Tabs value={tab} onChange={setTab} tabs={[{ id: 'schedule', label: 'Schedule & results' }, { id: 'roster', label: 'Roster' }, { id: 'stats', label: 'Statistics' }, { id: 'history', label: 'Season history' }]} />
            {tab === 'schedule' && (
              <Card pad={false}>
                {d.schedule.length ? d.schedule.map((g: Game) => {
                  const home = g.home.id === t.id;
                  const opp = home ? g.away : g.home, me = home ? g.home : g.away;
                  const fin = g.status === 'final';
                  const won = fin && (me.score ?? 0) > (opp.score ?? 0);
                  return (
                    <Link key={g.id} to={`/games/${g.id}`} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 border-b border-ink-800 px-3 py-2.5 last:border-0 hover:bg-ink-800">
                      <span className="text-xs uppercase text-ink-400">Wk {g.week}</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="w-5 text-xs text-ink-400">{g.neutralSite ? 'vs' : home ? 'vs' : 'at'}</span><TeamLogo team={opp} size={22} /><span className="font-display text-lg font-semibold"><Rank n={opp.rank} />{opp.name}</span><Designations list={g.designations} /></span>
                      {fin ? <span className="font-display text-lg font-bold tnum"><span className={won ? 'text-emerald-300' : 'text-red-300'}>{won ? 'W' : 'L'}</span> {me.score}-{opp.score}</span> : <StatusPill g={g} />}
                    </Link>);
                }) : <Empty>No games scheduled.</Empty>}
              </Card>)}
            {tab === 'roster' && (
              <div className="grid gap-4 lg:grid-cols-3">
                {POS_GROUPS.map(([name, pos]) => {
                  const rows = d.roster.filter((p: Row) => pos.includes(p.position)).sort((a: Row, b: Row) => pos.indexOf(a.position) - pos.indexOf(b.position) || a.depth - b.depth);
                  return (
                    <Card key={name} title={name} pad={false}>
                      {rows.length ? <table className="w-full"><thead><tr className="border-b border-ink-700"><th className={th}>#</th><th className={th}>Player</th><th className={th}>Pos</th><th className={thr}>Depth</th></tr></thead>
                        <tbody>{rows.map((p: Row) => <tr key={p.playerId} className={cx('border-b border-ink-800 last:border-0', !p.active && 'opacity-50')}>
                          <td className={cx(td, 'tnum text-ink-400')}>{p.jersey ?? ''}</td><td className={td}><Link to={`/players/${p.playerId}`} className="font-medium hover:text-gold-soft">{p.name}</Link>{!p.active && <span className="ml-1 text-xs text-ink-400">(inactive)</span>}</td>
                          <td className={td}>{p.position}{p.secondary.length ? <span className="text-xs text-ink-400"> / {p.secondary.join(', ')}</span> : null}</td><td className={tdr}>{p.depth}</td></tr>)}</tbody></table> : <Empty>None rostered.</Empty>}
                    </Card>);
                })}
              </div>)}
            {tab === 'stats' && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Leader label="Passing" rows={d.players} k="passYds" text={(p) => `${p.passYds} yds, ${p.passTd} TD, ${p.passInt} INT`} />
                  <Leader label="Rushing" rows={d.players} k="rushYds" text={(p) => `${p.rushYds} yds, ${p.rushTd} TD (${p.ypc} avg)`} />
                  <Leader label="Receiving" rows={d.players} k="recYds" text={(p) => `${p.rec} rec, ${p.recYds} yds, ${p.recTd} TD`} />
                  <Leader label="Tackles" rows={d.players} k="tackles" text={(p) => `${p.tackles} tkl, ${p.sacks} sacks, ${p.defInt} INT`} />
                </div>
                {ts ? (
                  <Card title={`Team statistics (${ts.gp} game${ts.gp === 1 ? '' : 's'})`} pad={false}>
                    <table className="w-full"><thead><tr className="border-b border-ink-700"><th className={th}>Per game</th><th className={thr}>{t.abbr}</th><th className={thr}>Opponents</th></tr></thead>
                      <tbody>{([['Points', 'points'], ['Total yards', 'totalYds'], ['Passing yards', 'passYds'], ['Rushing yards', 'rushYds'], ['First downs', 'firstDowns'], ['Turnovers', 'turnovers'], ['Sacks', 'sacks'], ['Penalties', 'penalties']] as const).map(([l, k]) =>
                        <tr key={k} className="border-b border-ink-800 last:border-0"><td className={td}>{l}</td><td className={cx(tdr, 'font-semibold')}>{per(ts[k], ts.gp)}</td><td className={tdr}>{os ? per(os[k], os.gp) : '—'}</td></tr>)}
                        <tr className="border-b border-ink-800"><td className={td}>Third downs</td><td className={cx(tdr, 'font-semibold')}>{ts.thirdAtt ? `${((100 * ts.thirdConv) / ts.thirdAtt).toFixed(1)}%` : '—'}</td><td className={tdr}>{os?.thirdAtt ? `${((100 * os.thirdConv) / os.thirdAtt).toFixed(1)}%` : '—'}</td></tr>
                        <tr><td className={td}>Time of possession</td><td className={cx(tdr, 'font-semibold')}>{fmtTop(ts.top / ts.gp)}</td><td className={tdr}>{os ? fmtTop(os.top / os.gp) : '—'}</td></tr></tbody></table>
                  </Card>) : <Empty>Statistics appear after this team's first published game.</Empty>}
              </div>)}
            {tab === 'history' && (
              <Card pad={false}>
                <table className="w-full"><thead><tr className="border-b border-ink-700"><th className={th}>Season</th><th className={th}>Conference</th><th className={thr}>Overall</th><th className={thr}>Conf</th><th className={thr}>PF</th><th className={thr}>PA</th><th className={thr}>Last rank</th></tr></thead>
                  <tbody>{d.history.map((h: Row) => <tr key={h.seasonId} className="border-b border-ink-800 last:border-0"><td className={cx(td, 'font-medium')}>{h.name}</td><td className={td}>{h.conference ?? 'Independent'}</td><td className={tdr}>{h.record}</td><td className={tdr}>{h.confRecord}</td><td className={tdr}>{h.pf}</td><td className={tdr}>{h.pa}</td><td className={tdr}>{h.lastRank ?? '—'}</td></tr>)}</tbody></table>
              </Card>)}
          </div>);
      }}
    </Load>
  );
}

const STAT_TABLES: { title: string; show: (r: Row) => boolean; cols: [string, string, number?][] }[] = [
  { title: 'Passing', show: (r) => r.passAtt > 0, cols: [['passCmp', 'Cmp'], ['passAtt', 'Att'], ['cmpPct', 'Pct', 1], ['passYds', 'Yds'], ['ypa', 'Y/A', 1], ['passTd', 'TD'], ['passInt', 'Int'], ['passRating', 'Rtg', 1]] },
  { title: 'Rushing', show: (r) => r.rushAtt > 0, cols: [['rushAtt', 'Car'], ['rushYds', 'Yds'], ['ypc', 'Avg', 1], ['rushTd', 'TD'], ['rushLong', 'Lg'], ['fumblesLost', 'Fum']] },
  { title: 'Receiving', show: (r) => r.targets > 0, cols: [['rec', 'Rec'], ['targets', 'Tgt'], ['recYds', 'Yds'], ['ypr', 'Avg', 1], ['recTd', 'TD'], ['recLong', 'Lg']] },
  { title: 'Defense', show: (r) => r.tackles + r.sacks + r.defInt + r.pd > 0, cols: [['tackles', 'Tkl'], ['tklSolo', 'Solo'], ['tfl', 'TFL', 1], ['sacks', 'Sk', 1], ['defInt', 'Int'], ['pd', 'PD'], ['ff', 'FF'], ['fr', 'FR']] },
  { title: 'Kicking & punting', show: (r) => r.fga + r.xpa + r.punts > 0, cols: [['fgm', 'FGM'], ['fga', 'FGA'], ['fgPct', 'Pct', 1], ['fgLong', 'Lg'], ['xpm', 'XPM'], ['xpa', 'XPA'], ['punts', 'Punts'], ['puntAvg', 'Avg', 1]] },
  { title: 'Returns', show: (r) => r.kr + r.pr > 0, cols: [['kr', 'KR'], ['krYds', 'Yds'], ['krTd', 'TD'], ['pr', 'PR'], ['prYds', 'Yds'], ['prTd', 'TD']] },
];
export function PlayerPage() {
  const { id } = useParams();
  const q = useApi<any>(`/players/${id}`);
  return (
    <Load q={q}>
      {(d) => {
        const m = d.memberships[0];
        const cell = (r: Row, c: [string, string, number?]) => (c[2] ? Number(r[c[0]]).toFixed(c[2]) : r[c[0]]);
        const awards = d.memberships.flatMap((x: Row) => x.awards.map((a: string) => `${a} (${x.year})`));
        return (
          <div className="space-y-4">
            <section className="overflow-hidden rounded-2xl border border-ink-600" style={{ background: `linear-gradient(110deg, ${m?.color ?? '#1d2942'} 0%, #0a1020 70%)` }}>
              <div className="flex flex-wrap items-center gap-4 bg-ink-950/40 p-5">
                {m && <TeamLogo team={{ abbr: m.teamAbbr, color: m.color, color2: m.color2, logo: m.logo }} size={72} />}
                <div className="min-w-0 flex-1">
                  <h1 className="font-display text-4xl font-extrabold uppercase leading-none">{m?.jersey != null && <span className="mr-2 text-white/60">#{m.jersey}</span>}{d.player.name}</h1>
                  {m ? <p className="mt-1 text-sm text-white/80"><Link to={`/teams/${m.teamId}`} className="font-semibold hover:underline">{m.teamName}</Link> · {m.position}{m.secondary.length ? ` (also ${m.secondary.join(', ')})` : ''} · {m.seasonName}{!m.active ? ' · inactive' : ''}</p> : <p className="mt-1 text-sm text-white/70">Not currently rostered.</p>}
                  {awards.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{awards.map((a: string) => <Badge key={a} tone="gold">{a}</Badge>)}</div>}
                </div>
              </div>
            </section>
            {!d.seasons.length && <Card><Empty>This player has no official statistics yet. Statistics come only from published game records.</Empty></Card>}
            {STAT_TABLES.map((tb) => {
              const rows = d.seasons.filter(tb.show);
              if (!rows.length) return null;
              const car = d.career && tb.show(d.career) ? d.career : null;
              return (
                <Card key={tb.title} title={`${tb.title} — by season`} pad={false}>
                  <div className="scroll-x"><table className="w-full"><thead><tr className="border-b border-ink-700"><th className={th}>Season</th><th className={th}>Team</th><th className={thr}>GP</th>{tb.cols.map((c) => <th key={c[0] + c[1]} className={thr}>{c[1]}</th>)}</tr></thead>
                    <tbody>{rows.map((r: Row) => <tr key={r.seasonId + r.teamId} className="border-b border-ink-800"><td className={td}>{r.year}</td><td className={td}>{r.teamAbbr}</td><td className={tdr}>{r.gp}</td>{tb.cols.map((c) => <td key={c[0] + c[1]} className={tdr}>{cell(r, c)}</td>)}</tr>)}
                      {car && <tr className="bg-ink-800 font-semibold"><td className={td} colSpan={2}>Career</td><td className={tdr}>{car.gp}</td>{tb.cols.map((c) => <td key={c[0] + c[1]} className={tdr}>{cell(car, c)}</td>)}</tr>}</tbody></table></div>
                </Card>);
            })}
            {d.gameLog.length > 0 && (
              <Card title="Game log" pad={false}>
                <div className="scroll-x"><table className="w-full min-w-[720px]"><thead><tr className="border-b border-ink-700"><th className={th}>Wk</th><th className={th}>Opponent</th><th className={th}>Result</th><th className={thr}>C/Att</th><th className={thr}>Pass</th><th className={thr}>TD</th><th className={thr}>Int</th><th className={thr}>Car</th><th className={thr}>Rush</th><th className={thr}>Rec</th><th className={thr}>Rec yds</th><th className={thr}>Tkl</th><th className={thr}>Sk</th><th className={thr}>Total TD</th></tr></thead>
                  <tbody>{d.gameLog.map((g: Row) => {
                    const mine = g.isHome ? g.homeScore : g.awayScore, theirs = g.isHome ? g.awayScore : g.homeScore;
                    return <tr key={g.gameId} className="border-b border-ink-800 last:border-0 hover:bg-ink-800">
                      <td className={cx(td, 'tnum')}>{g.week}</td><td className={td}>{g.isHome ? 'vs' : 'at'} {g.opp?.abbr ?? '?'} {g.mode === 'primetime' && <Badge tone="purple" title="CFB 27 primetime game: unverified statistics are reconstructions">CFB 27</Badge>}</td>
                      <td className={td}><Link to={`/games/${g.gameId}`} className="hover:text-gold-soft"><span className={mine > theirs ? 'text-emerald-300' : 'text-red-300'}>{mine > theirs ? 'W' : 'L'}</span> {mine}-{theirs}</Link></td>
                      <td className={tdr}>{g.passAtt ? `${g.passCmp}/${g.passAtt}` : '—'}</td><td className={tdr}>{g.passAtt ? g.passYds : '—'}</td><td className={tdr}>{g.passAtt ? g.passTd : '—'}</td><td className={tdr}>{g.passAtt ? g.passInt : '—'}</td>
                      <td className={tdr}>{g.rushAtt || '—'}</td><td className={tdr}>{g.rushAtt ? g.rushYds : '—'}</td><td className={tdr}>{g.rec || '—'}</td><td className={tdr}>{g.rec ? g.recYds : '—'}</td><td className={tdr}>{g.tackles || '—'}</td><td className={tdr}>{g.sacks || '—'}</td>
                      <td className={tdr}>{g.passTd + g.rushTd + g.recTd + g.defTd + g.krTd + g.prTd || '—'}</td></tr>;
                  })}</tbody></table></div>
              </Card>)}
          </div>);
      }}
    </Load>
  );
}
