import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useApi } from '../api';
import { Designations, Rank, StatusPill, TeamLogo, fmtClock, fmtKick, fmtTop, periodLabel, type Game as GameT, type TeamRef } from '../shared';
import { Badge, Card, Empty, Load, Notice, Tabs, cx, td, tdr, th, thr } from '../ui';

type Row = Record<string, any>;
const ord = (n: number) => ['', '1st', '2nd', '3rd', '4th'][n] ?? `${n}th`;
const fieldSpot = (ballOn: number, off: TeamRef, def: TeamRef) => (ballOn === 50 ? '50' : ballOn < 50 ? `${off.abbr} ${ballOn}` : `${def.abbr} ${100 - ballOn}`);

function Scoreboard({ g, quarters, labels }: { g: GameT; quarters: [number[], number[]] | null; labels?: Row }) {
  const fin = g.status === 'final';
  const showScore = fin || g.status === 'in_progress';
  const aw = fin && (g.away.score ?? 0) > (g.home.score ?? 0);
  const hw = fin && (g.home.score ?? 0) > (g.away.score ?? 0);
  const side = (t: TeamRef, win: boolean, right?: boolean) => (
    <div className={cx('flex min-w-0 flex-1 items-center gap-3', right && 'sm:flex-row-reverse sm:text-right')}>
      <Link to={`/teams/${t.id}`} className="shrink-0"><span className="sm:hidden"><TeamLogo team={t} size={44} /></span><span className="hidden sm:block"><TeamLogo team={t} size={64} /></span></Link>
      <div className="min-w-0 flex-1">
        <Link to={`/teams/${t.id}`} className="block truncate font-display text-2xl font-bold uppercase leading-tight hover:text-gold-soft sm:text-3xl"><Rank n={t.rank} /><span className="lg:hidden">{t.short}</span><span className="hidden lg:inline">{t.name}</span></Link>
        <p className="text-xs text-white/70 tnum">{t.record} · {t.confRecord} conf</p>
      </div>
      {showScore && <span className={cx('shrink-0 font-display text-5xl font-extrabold tnum sm:text-6xl', fin && !win && 'text-white/55')}>{t.score ?? 0}{win && <span className="ml-1 align-middle text-base text-gold" aria-label="winner">◀</span>}</span>}
    </div>
  );
  return (
    <section className="overflow-hidden rounded-2xl border border-ink-600" style={{ background: `linear-gradient(100deg, ${g.away.color}cc 0%, #0a1020 42%, #0a1020 58%, ${g.home.color}cc 100%)` }}>
      <div className="bg-ink-950/50 p-4 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold uppercase tracking-wide text-white/70">Week {g.week}</span><Designations list={g.designations} />
          {labels && <Badge tone={g.mode === 'primetime' ? 'purple' : 'blue'}>{labels.score}</Badge>}
        </div>
        <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
          {side(g.away, aw)}
          <div className="shrink-0 text-center"><StatusPill g={g} />{!showScore && <p className="mt-1 font-display text-2xl font-bold text-white/50">{g.neutralSite ? 'VS' : 'AT'}</p>}</div>
          {side(g.home, hw, true)}
        </div>
        {quarters && (
          <div className="scroll-x mt-4">
            <table className="mx-auto text-sm tnum">
              <thead><tr><th className="px-3 py-1 text-left text-[11px] uppercase text-white/50" /> {quarters[0].map((_, i) => <th key={i} className="px-2.5 py-1 text-[11px] font-semibold uppercase text-white/60">{i < 4 ? i + 1 : i === 4 ? 'OT' : `${i - 3}OT`}</th>)}<th className="px-2.5 py-1 text-[11px] font-semibold uppercase text-white/80">T</th></tr></thead>
              <tbody>{[g.away, g.home].map((t, s) => <tr key={t.id}><td className="px-3 py-0.5 text-left font-display text-base font-semibold">{t.abbr}</td>{quarters[s].map((v, i) => <td key={i} className="px-2.5 py-0.5 text-center text-white/85">{v}</td>)}<td className="px-2.5 py-0.5 text-center font-bold">{quarters[s].reduce((a, b) => a + b, 0)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-center text-xs text-white/65">{[fmtKick(g.kickoffAt), g.network, g.stadium && `${g.stadium}${g.neutralSite ? ' (neutral site)' : ''}`].filter(Boolean).join(' · ')}</p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ box score
const BOX: { title: string; filter: (p: Row) => boolean; sort: string; cols: [string, string, number?][] }[] = [
  { title: 'Passing', filter: (p) => p.passAtt > 0, sort: 'passYds', cols: [['passCmp', 'C'], ['passAtt', 'Att'], ['passYds', 'Yds'], ['cmpPct', 'Pct', 1], ['passTd', 'TD'], ['passInt', 'Int'], ['sacked', 'Sk'], ['passRating', 'Rtg', 1]] },
  { title: 'Rushing', filter: (p) => p.rushAtt > 0, sort: 'rushYds', cols: [['rushAtt', 'Car'], ['rushYds', 'Yds'], ['ypc', 'Avg', 1], ['rushTd', 'TD'], ['rushLong', 'Lg'], ['fumbles', 'Fum']] },
  { title: 'Receiving', filter: (p) => p.targets > 0, sort: 'recYds', cols: [['targets', 'Tgt'], ['rec', 'Rec'], ['recYds', 'Yds'], ['ypr', 'Avg', 1], ['recTd', 'TD'], ['recLong', 'Lg']] },
  { title: 'Defense', filter: (p) => p.tackles + p.sacks + p.defInt + p.pd + p.ff + p.fr + p.blocks > 0, sort: 'tackles', cols: [['tackles', 'Tot'], ['tklSolo', 'Solo'], ['tklAst', 'Ast'], ['tfl', 'TFL', 1], ['sacks', 'Sk', 1], ['defInt', 'Int'], ['pd', 'PD'], ['ff', 'FF'], ['fr', 'FR'], ['defTd', 'TD']] },
  { title: 'Kicking', filter: (p) => p.fga + p.xpa > 0, sort: 'fgm', cols: [['fgm', 'FGM'], ['fga', 'FGA'], ['fgPct', 'Pct', 1], ['fgLong', 'Lg'], ['xpm', 'XPM'], ['xpa', 'XPA']] },
  { title: 'Punting', filter: (p) => p.punts > 0, sort: 'punts', cols: [['punts', 'No'], ['puntYds', 'Yds'], ['puntAvg', 'Avg', 1], ['puntLong', 'Lg'], ['puntIn20', 'In20']] },
  { title: 'Returns', filter: (p) => p.kr + p.pr > 0, sort: 'krYds', cols: [['kr', 'KR'], ['krYds', 'KR Yds'], ['krTd', 'KR TD'], ['pr', 'PR'], ['prYds', 'PR Yds'], ['prTd', 'PR TD']] },
  { title: 'Offensive line', filter: (p) => p.olSnaps > 0, sort: 'olSnaps', cols: [['olSnaps', 'Snaps'], ['sacksAllowed', 'Sk Alw'], ['penalties', 'Pen']] },
];
export function BoxScore({ players, teams, primetime }: { players: Row[]; teams: [TeamRef, TeamRef]; primetime: boolean }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {teams.map((t) => (
        <div key={t.id} className="space-y-3">
          <h3 className="flex items-center gap-2 font-display text-xl font-bold uppercase"><TeamLogo team={t} size={26} />{t.name}</h3>
          {BOX.map((b) => {
            const rows = players.filter((p) => p.teamId === t.id && b.filter(p)).sort((x, y) => y[b.sort] - x[b.sort]);
            if (!rows.length) return null;
            return (
              <Card key={b.title} title={b.title} pad={false}>
                <div className="scroll-x"><table className="w-full">
                  <thead><tr className="border-b border-ink-700"><th className={th}>Player</th>{b.cols.map((c) => <th key={c[0]} className={thr}>{c[1]}</th>)}</tr></thead>
                  <tbody>{rows.map((p) => (
                    <tr key={p.playerId} className="border-b border-ink-800 last:border-0">
                      <td className={td}><Link to={`/players/${p.playerId}`} className="font-medium hover:text-gold-soft">{p.name}</Link> <span className="text-xs text-ink-400">{p.position}{p.jersey != null ? ` #${p.jersey}` : ''}</span></td>
                      {b.cols.map((c) => {
                        const locked = primetime && (p.lockedFields ?? []).includes(c[0] === 'tackles' ? 'tackles' : c[0]);
                        return <td key={c[0]} className={cx(tdr, locked && 'font-semibold text-violet-200')} title={locked ? 'Verified CFB 27 statistic' : undefined}>{c[2] ? Number(p[c[0]]).toFixed(c[2]) : p[c[0]]}{locked && <sup className="ml-0.5">✓</sup>}</td>;
                      })}
                    </tr>))}</tbody>
                </table></div>
              </Card>);
          })}
        </div>))}
    </div>
  );
}

const TEAM_ROWS: [string, (t: Row) => string | number][] = [
  ['Total yards', (t) => t.totalYds], ['Passing yards', (t) => t.passYds], ['Rushing yards', (t) => t.rushYds], ['Total plays', (t) => t.plays],
  ['Yards per play', (t) => (t.plays ? (t.totalYds / t.plays).toFixed(1) : '0.0')], ['First downs', (t) => t.firstDowns],
  ['Third-down efficiency', (t) => `${t.thirdConv}-${t.thirdAtt}`], ['Fourth-down efficiency', (t) => `${t.fourthConv}-${t.fourthAtt}`],
  ['Comp-Att', (t) => `${t.passCmp}-${t.passAtt}`], ['Rushing attempts', (t) => t.rushAtt], ['Turnovers', (t) => t.turnovers], ['Interceptions thrown', (t) => t.intThrown], ['Fumbles lost', (t) => t.fumblesLost],
  ['Penalties-yards', (t) => `${t.penalties}-${t.penaltyYds}`], ['Time of possession', (t) => fmtTop(t.top)], ['Sacks-yards', (t) => `${t.sacks}-${t.sackYds}`],
  ['Red-zone scores-chances', (t) => `${t.rzScores}-${t.rzAtt}`], ['Red-zone touchdowns', (t) => t.rzTd], ['Punts-yards', (t) => `${t.punts}-${t.puntYds}`],
];
export function TeamStats({ stats, teams }: { stats: Row[]; teams: [TeamRef, TeamRef] }) {
  const a = stats.find((s) => s.teamId === teams[0].id)!, h = stats.find((s) => s.teamId === teams[1].id)!;
  if (!a || !h) return <Empty>Team statistics are not available.</Empty>;
  const bar = (k: 'totalYds' | 'passYds' | 'rushYds') => { const tot = Math.max(1, Math.abs(a[k]) + Math.abs(h[k])); return (100 * Math.abs(a[k])) / tot; };
  return (
    <Card pad={false}>
      <table className="w-full">
        <thead><tr className="border-b border-ink-700"><th className={cx(thr, 'w-1/4')}>{teams[0].abbr}</th><th className={cx(th, 'text-center')}>Team statistics</th><th className={cx(th, 'w-1/4')}>{teams[1].abbr}</th></tr></thead>
        <tbody>{TEAM_ROWS.map(([label, f], i) => (
          <tr key={label} className="border-b border-ink-800 last:border-0">
            <td className={cx(tdr, 'font-semibold')}>{f(a)}</td>
            <td className={cx(td, 'text-center text-ink-300')}>
              {label}
              {i < 3 && <span className="mx-auto mt-1 flex h-1.5 w-40 max-w-full overflow-hidden rounded-full bg-ink-700"><span style={{ width: `${bar(['totalYds', 'passYds', 'rushYds'][i] as 'totalYds')}%`, background: teams[0].color }} /><span className="flex-1" style={{ background: teams[1].color }} /></span>}
            </td>
            <td className={cx(td, 'font-semibold tnum')}>{f(h)}</td>
          </tr>))}</tbody>
      </table>
    </Card>
  );
}

export function ScoringSummary({ scoring, teams }: { scoring: Row[]; teams: [TeamRef, TeamRef] }) {
  if (!scoring.length) return <Empty>No scoring yet.</Empty>;
  const byQ = new Map<number, Row[]>();
  for (const s of scoring) (byQ.get(s.quarter) ?? byQ.set(s.quarter, []).get(s.quarter)!).push(s);
  return (
    <Card pad={false}>
      {[...byQ.entries()].map(([q, list]) => (
        <div key={q}>
          <h4 className="border-b border-ink-700 bg-ink-800 px-3 py-1.5 font-display text-sm font-semibold uppercase tracking-wide text-ink-200">{q <= 4 ? `${ord(q)} quarter` : q === 5 ? 'Overtime' : `${ord(q - 4)} overtime`}</h4>
          {list.map((s) => {
            const t = teams.find((x) => x.id === s.teamId)!;
            return (
              <div key={s.playSeq} className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-3 border-b border-ink-800 px-3 py-2 last:border-0">
                <TeamLogo team={t} size={28} />
                <div className="min-w-0"><p className="text-sm"><Badge tone={s.kind === 'TD' ? 'gold' : 'neutral'}>{s.kind}</Badge> <span className="ml-1 text-xs text-ink-400 tnum">{q <= 4 ? fmtClock(s.clock) : ''}</span></p><p className="text-sm text-ink-200">{s.description}</p></div>
                <p className="font-display text-lg font-bold tnum"><span className={s.teamId === teams[0].id ? 'text-white' : 'text-ink-300'}>{s.away}</span><span className="mx-1 text-ink-500">–</span><span className={s.teamId === teams[1].id ? 'text-white' : 'text-ink-300'}>{s.home}</span></p>
              </div>);
          })}
        </div>))}
    </Card>
  );
}

export function ScoreChart({ scoring, teams, quarters }: { scoring: Row[]; teams: [TeamRef, TeamRef]; quarters: number }) {
  const data = useMemo(() => {
    const x = (q: number, clock: number) => (q <= 4 ? (q - 1) * 15 + (900 - clock) / 60 : 60 + (q - 4) * 5);
    const pts: Row[] = [{ t: 0, away: 0, home: 0 }];
    for (const s of scoring) pts.push({ t: Math.round(x(s.quarter, s.clock) * 100) / 100, away: s.away, home: s.home });
    const end = Math.max(60, 60 + Math.max(0, quarters - 4) * 5);
    const last = pts[pts.length - 1];
    if (last.t < end) pts.push({ t: end, away: last.away, home: last.home });
    return pts;
  }, [scoring, quarters]);
  const light = (c: string) => { const n = parseInt(c.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.25 ? '#cbd5e1' : c; };
  const same = light(teams[0].color) === light(teams[1].color);
  return (
    <Card title="Score progression">
      <div className="h-64" role="img" aria-label={`Score progression chart, ${teams[0].name} versus ${teams[1].name}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#1d2942" vertical={false} />
            <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} ticks={[0, 15, 30, 45, 60]} tickFormatter={(v) => (v === 0 ? 'Kick' : v === 60 ? 'End 4th' : `End Q${v / 15}`)} stroke="#7384a8" fontSize={11} />
            <YAxis allowDecimals={false} stroke="#7384a8" fontSize={11} />
            <Tooltip contentStyle={{ background: '#0f1729', border: '1px solid #2a3856', borderRadius: 8, fontSize: 12 }} labelFormatter={(v) => `${Number(v).toFixed(1)} min elapsed`} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="stepAfter" dataKey="away" name={teams[0].name} stroke={light(teams[0].color)} strokeWidth={2.5} dot={false} isAnimationActive={false} />
            <Line type="stepAfter" dataKey="home" name={teams[1].name} stroke={same ? '#f5b301' : light(teams[1].color)} strokeWidth={2.5} strokeDasharray={same ? undefined : undefined} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function PlayByPlay({ plays, drives, teams, newestFirst }: { plays: Row[]; drives: Row[]; teams: [TeamRef, TeamRef]; newestFirst?: boolean }) {
  const [q, setQ] = useState<number | 'all'>('all');
  const quarters = [...new Set(plays.map((p) => p.quarter))];
  const shown = plays.filter((p) => q === 'all' || p.quarter === q);
  const groups: { key: string; drive: Row | null; plays: Row[] }[] = [];
  for (const p of shown) {
    const last = groups[groups.length - 1];
    const key = p.drive ? `d${p.drive}` : `k${p.seq}`;
    if (last && last.key === key) last.plays.push(p);
    else groups.push({ key, drive: p.drive ? drives.find((d) => d.num === p.drive) ?? null : null, plays: [p] });
  }
  if (newestFirst) groups.reverse();
  const team = (id: string) => teams.find((t) => t.id === id)!;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {(['all', ...quarters] as const).map((x) => <button key={x} onClick={() => setQ(x)} className={cx('rounded px-2.5 py-1 text-xs font-semibold uppercase', q === x ? 'bg-gold text-ink-950' : 'bg-ink-800 text-ink-200 hover:bg-ink-700')}>{x === 'all' ? 'All' : periodLabel(x)}</button>)}
      </div>
      {groups.map((g) => {
        const first = g.plays[0];
        const t = team(g.drive?.teamId ?? first.teamId);
        const list = newestFirst ? [...g.plays].reverse() : g.plays;
        return (
          <div key={g.key} className="overflow-hidden rounded-lg border border-ink-700 bg-ink-850">
            {g.drive && (
              <div className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-3 py-1.5" style={{ borderLeft: `4px solid ${t.color}` }}>
                <TeamLogo team={t} size={20} /><span className="font-display text-base font-semibold uppercase">{t.short} drive</span>
                {g.drive.result && <Badge tone={g.drive.result === 'TD' ? 'gold' : g.drive.result === 'FG' ? 'green' : 'neutral'}>{String(g.drive.result).replace('_', ' ')}</Badge>}
                {g.drive.plays != null && <span className="ml-auto text-xs text-ink-400 tnum">{g.drive.plays} plays, {g.drive.yards} yards{g.drive.seconds ? `, ${fmtTop(g.drive.seconds)}` : ''}</span>}
              </div>)}
            <ol>{list.map((p) => {
              const off = team(p.teamId), def = teams.find((x) => x.id !== p.teamId)!;
              return (
                <li key={p.seq} className="grid grid-cols-[3.5rem_1fr_auto] gap-2 border-b border-ink-800 px-3 py-1.5 text-sm last:border-0">
                  <span className="text-xs text-ink-400 tnum">{periodLabel(p.quarter)}{p.quarter <= 4 ? <><br />{fmtClock(p.clock)}</> : null}</span>
                  <div className="min-w-0">
                    {p.down != null && <p className="text-xs text-ink-400">{ord(p.down)} &amp; {p.distance >= 100 - p.ballOn ? 'Goal' : p.distance} at {fieldSpot(p.ballOn, off, def)}</p>}
                    <p className={cx(p.result === 'TOUCHDOWN' && 'font-semibold text-gold-soft')}>{p.description}</p>
                  </div>
                  <div className="text-right">
                    {p.result && p.result !== 'KICKOFF' && p.result !== 'PUNT' && <Badge tone={p.result === 'TOUCHDOWN' || p.result === 'FIELD GOAL' ? 'gold' : /INTERCEPTION|FUMBLE|DOWNS|SAFETY/.test(p.result) ? 'red' : 'neutral'}>{p.result}</Badge>}
                    {['run', 'pass', 'sack'].includes(p.type) && <p className="text-xs text-ink-400 tnum">{p.yards > 0 ? '+' : ''}{p.yards} yd</p>}
                  </div>
                </li>);
            })}</ol>
          </div>);
      })}
      {!groups.length && <Empty>No plays to show.</Empty>}
    </div>
  );
}

export function Highlights({ list, teams, generated }: { list: Row[]; teams: [TeamRef, TeamRef]; generated?: string }) {
  if (!list.length) return <Empty>No highlights yet.</Empty>;
  return (
    <div className="space-y-2">
      {generated && <Notice tone="warn">{generated}</Notice>}
      {list.map((h) => {
        const t = teams.find((x) => x.id === h.teamId)!;
        return (
          <article key={h.playSeq} className="flex gap-3 rounded-lg border border-ink-700 bg-ink-850 p-3" style={{ borderLeft: `4px solid ${t.color}` }}>
            <TeamLogo team={t} size={36} />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400 tnum">{periodLabel(h.quarter)}{h.quarter <= 4 ? ` — ${fmtClock(h.clock)}` : ''} <span className="mx-1 text-ink-600">|</span> <span className="text-gold-soft">{h.title}</span></p>
              <p className="mt-0.5 text-sm text-ink-100">{h.text}</p>
              <div className="mt-1 flex flex-wrap gap-1">{(h.tags ?? []).filter((x: string) => ['game-winning', 'lead-change', 'comeback', 'overtime', 'explosive', 'turnover'].includes(x)).map((x: string) => <Badge key={x}>{x.replace('-', ' ')}</Badge>)}</div>
            </div>
          </article>);
      })}
    </div>
  );
}

function TopPerformers({ players, teams }: { players: Row[]; teams: [TeamRef, TeamRef] }) {
  const pick = (teamId: string, key: string) => [...players].filter((p) => p.teamId === teamId && p[key] > 0).sort((a, b) => b[key] - a[key])[0];
  const line = (label: string, p: Row | undefined, text: (p: Row) => string) => p && (
    <li className="flex items-baseline gap-2 py-1.5 text-sm"><span className="w-16 text-[11px] uppercase tracking-wide text-ink-400">{label}</span><Link to={`/players/${p.playerId}`} className="font-medium hover:text-gold-soft">{p.name}</Link><span className="ml-auto text-right text-ink-200 tnum">{text(p)}</span></li>);
  return (
    <Card title="Top performers">
      <div className="grid gap-4 sm:grid-cols-2">
        {teams.map((t) => (
          <div key={t.id}>
            <p className="mb-1 flex items-center gap-2 font-display text-base font-semibold uppercase"><TeamLogo team={t} size={20} />{t.short}</p>
            <ul className="divide-y divide-ink-700">
              {line('Passing', pick(t.id, 'passYds'), (p) => `${p.passCmp}/${p.passAtt}, ${p.passYds} yds, ${p.passTd} TD${p.passInt ? `, ${p.passInt} INT` : ''}`)}
              {line('Rushing', pick(t.id, 'rushYds'), (p) => `${p.rushAtt} car, ${p.rushYds} yds${p.rushTd ? `, ${p.rushTd} TD` : ''}`)}
              {line('Receiving', pick(t.id, 'recYds'), (p) => `${p.rec} rec, ${p.recYds} yds${p.recTd ? `, ${p.recTd} TD` : ''}`)}
              {line('Defense', pick(t.id, 'tackles'), (p) => `${p.tackles} tkl${p.sacks ? `, ${p.sacks} sk` : ''}${p.defInt ? `, ${p.defInt} INT` : ''}`)}
            </ul>
          </div>))}
      </div>
    </Card>
  );
}

function DriveTracker({ plays, teams }: { plays: Row[]; teams: [TeamRef, TeamRef] }) {
  const last = plays[plays.length - 1];
  if (!last) return null;
  const off = teams.find((t) => t.id === last.teamId)!;
  const isHome = off.id === teams[1].id;
  // Field drawn left (away goal) to right (home goal); the away team drives right.
  const pos = Math.max(0, Math.min(100, (isHome ? 100 - last.ballOn : last.ballOn) + (isHome ? -1 : 1) * (['run', 'pass', 'sack'].includes(last.type) ? last.yards : 0)));
  return (
    <Card title="Latest play">
      <div className="relative h-10 overflow-hidden rounded-md bg-emerald-900/50" aria-hidden>
        <div className="absolute inset-y-0 left-0 w-[8%]" style={{ background: teams[0].color }} /><div className="absolute inset-y-0 right-0 w-[8%]" style={{ background: teams[1].color }} />
        {[10, 20, 30, 40, 50, 60, 70, 80, 90].map((y) => <div key={y} className="absolute inset-y-0 w-px bg-white/25" style={{ left: `${8 + y * 0.84}%` }} />)}
        <div className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold ring-2 ring-ink-950 transition-all duration-700" style={{ left: `${8 + pos * 0.84}%` }} />
      </div>
      <p className="mt-2 text-xs text-ink-400">{periodLabel(last.quarter)} {last.quarter <= 4 ? fmtClock(last.clock) : ''} · {off.short} ball</p>
      <p className="text-sm">{last.description}</p>
    </Card>
  );
}

type TabId = 'summary' | 'box' | 'team' | 'pbp' | 'highlights' | 'scoring';
export function GamePage() {
  const { id } = useParams();
  const [poll, setPoll] = useState(0);
  const q = useApi<any>(`/games/${id}`, poll);
  const [tab, setTab] = useState<TabId>('summary');
  const replaying = !!q.data?.replay?.active;
  const liveManual = q.data?.game?.manualLive;
  useEffect(() => setPoll(replaying ? Math.max(2000, Math.min(15000, q.data.replay.msPerPlay)) : liveManual ? 20000 : 0), [replaying, liveManual, q.data?.replay?.msPerPlay]);
  return (
    <Load q={q}>
      {(d) => {
        const g: GameT = d.game;
        const teams: [TeamRef, TeamRef] = [g.away, g.home];
        const r = d.result;
        const prime = g.mode === 'primetime';
        if (!r) return (
          <div className="space-y-4">
            <Scoreboard g={g} quarters={null} />
            {g.manualLive && <Notice>This score is entered by league staff while the game is played in College Football 27. It is not an automatic feed.</Notice>}
            <Card><Empty>{g.status === 'canceled' ? 'This game was canceled.' : g.status === 'postponed' ? 'This game has been postponed.' : g.manualLive ? 'Full statistics will be posted when the final result is published.' : `Kickoff: ${fmtKick(g.kickoffAt)}. The box score, play-by-play and highlights appear once the result is official.`}</Empty></Card>
          </div>);
        if (replaying) return (
          <div className="space-y-4">
            <Scoreboard g={g} quarters={r.quarters} labels={d.labels} />
            <Notice><b>Simulation replay.</b> {d.replay.note} Play {d.replay.visible} of {d.replay.total}.
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-ink-700"><span className="block h-full bg-sky-400 transition-all" style={{ width: `${(100 * d.replay.visible) / d.replay.total}%` }} /></span></Notice>
            <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
              <div><h2 className="mb-2 font-display text-xl font-bold uppercase">Play-by-play</h2><PlayByPlay plays={r.plays} drives={r.drives} teams={teams} newestFirst /></div>
              <div className="space-y-4"><DriveTracker plays={r.plays} teams={teams} /><Card title="Highlights so far"><Highlights list={[...r.highlights].reverse()} teams={teams} /></Card><ScoringSummary scoring={r.scoring} teams={teams} /></div>
            </div>
          </div>);
        return (
          <div className="space-y-4">
            <Scoreboard g={g} quarters={r.quarters} labels={d.labels} />
            {prime && <Notice tone="warn"><b>CFB 27 primetime game.</b> The final score{r.playerStats.some((p: Row) => p.lockedFields?.length) ? ' and the statistics marked ✓' : ''} are verified results from the game as played. Everything else on this page — remaining statistics, play-by-play and highlights — is an AI-generated reconstruction that is consistent with the real result. It is not a record of what happened on each play.</Notice>}
            <Tabs<TabId> value={tab} onChange={setTab} tabs={[{ id: 'summary', label: 'Summary' }, { id: 'box', label: 'Box score' }, { id: 'team', label: 'Team stats' }, { id: 'pbp', label: 'Play-by-play' }, { id: 'highlights', label: 'Highlights' }, { id: 'scoring', label: 'Scoring' }]} />
            {tab === 'summary' && (
              <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
                <div className="space-y-4">
                  {r.recap && (
                    <Card>
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {r.recap.reconstruction && <Badge tone="purple">Reconstruction-based summary</Badge>}
                        <Badge tone="neutral">{r.recap.source === 'ai' ? 'AI-written from official game data' : 'Generated from official game data'}</Badge>
                      </div>
                      <h2 className="font-display text-2xl font-bold leading-tight">{r.recap.headline}</h2>
                      <div className="mt-2 space-y-3 text-[15px] leading-relaxed text-ink-100">{String(r.recap.text).split(/\n\n+/).map((p: string, i: number) => <p key={i}>{p}</p>)}</div>
                    </Card>)}
                  <TopPerformers players={r.playerStats} teams={teams} />
                  <ScoreChart scoring={r.scoring} teams={teams} quarters={r.quarters[0].length} />
                </div>
                <div className="space-y-4">
                  <Card title="Key moments"><Highlights list={[...r.highlights].sort((a: Row, b: Row) => a.rank - b.rank).slice(0, 5).sort((a: Row, b: Row) => a.playSeq - b.playSeq)} teams={teams} generated={prime ? 'Generated reconstruction — not observed gameplay.' : undefined} /></Card>
                </div>
              </div>)}
            {tab === 'box' && <>{prime && <p className="text-xs text-ink-400">{d.labels.stats}.</p>}<BoxScore players={r.playerStats} teams={teams} primetime={prime} /></>}
            {tab === 'team' && <TeamStats stats={r.teamStats} teams={teams} />}
            {tab === 'pbp' && <><p className="text-xs text-ink-400">{d.labels.playByPlay}.</p><PlayByPlay plays={r.plays} drives={r.drives} teams={teams} /></>}
            {tab === 'highlights' && <Highlights list={r.highlights} teams={teams} generated={prime ? `${d.labels.highlights}.` : undefined} />}
            {tab === 'scoring' && <div className="grid gap-4 lg:grid-cols-2"><ScoringSummary scoring={r.scoring} teams={teams} /><ScoreChart scoring={r.scoring} teams={teams} quarters={r.quarters[0].length} /></div>}
          </div>);
      }}
    </Load>
  );
}
