import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { qs, useApi } from './api';
import { Badge, Select, cx } from './ui';

// ------------------------------------------------------------------ types returned by the public API
export interface TeamRef { id: string; name: string; short: string; abbr: string; color: string; color2: string; logo: string | null; rank: number | null; record: string; confRecord?: string; score: number | null }
export interface Game {
  id: string; seasonId: string; week: number; status: string; mode: string; kickoffAt: number | null; network: string | null; stadium: string | null; neutralSite: boolean;
  designations: string[]; away: TeamRef; home: TeamRef; period: string | null; clock: string | null; replay: boolean; manualLive: boolean; hasResult: boolean;
}
export interface Meta {
  seasons: { id: string; year: number; name: string; current: boolean; weeks: number }[];
  season: { id: string; year: number; name: string; weeks: number } | null;
  weeks: number[]; currentWeek: number;
  conferences: { id: string; name: string; abbr: string }[];
  teams: { id: string; name: string; short: string; abbr: string; color: string; color2: string; logo: string | null; conferenceId: string | null; conference: string | null }[];
}

// ------------------------------------------------------------------ season context
interface SeasonCtx { meta: Meta | null; seasonId: string | null; setSeason: (id: string) => void; loading: boolean; error: unknown; reload: () => void }
const Ctx = createContext<SeasonCtx>({ meta: null, seasonId: null, setSeason: () => {}, loading: true, error: null, reload: () => {} });
export const useSeason = () => useContext(Ctx);

export function SeasonProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<string | null>(() => sessionStorage.getItem('mcaa-season'));
  const q = useApi<Meta>(`/meta${qs({ season: chosen })}`);
  // A stale stored season (deleted, or another deployment) falls back to the current one.
  useEffect(() => {
    if (q.error && chosen) { sessionStorage.removeItem('mcaa-season'); setChosen(null); }
  }, [q.error, chosen]);
  const value = useMemo<SeasonCtx>(() => ({
    meta: q.data, seasonId: q.data?.season?.id ?? null, loading: q.loading, error: q.error, reload: q.reload,
    setSeason: (id) => { sessionStorage.setItem('mcaa-season', id); setChosen(id); },
  }), [q.data, q.loading, q.error, q.reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function SeasonSelect({ className }: { className?: string }) {
  const { meta, seasonId, setSeason } = useSeason();
  if (!meta?.seasons.length) return null;
  return (
    <Select aria-label="Season" className={cx('!w-auto', className)} value={seasonId ?? ''} onChange={(e) => setSeason(e.target.value)}>
      {meta.seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );
}

// ------------------------------------------------------------------ formatting
export const fmtKick = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Time TBD');
export const fmtTime = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'TBD');
export const fmtDay = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Date to be announced');
export const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const periodLabel = (q: number) => (q <= 4 ? `Q${q}` : q === 5 ? 'OT' : `${q - 4}OT`);
export const fmtAgo = (ms: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 48) return `${Math.round(m / 60)} hr ago`;
  return `${Math.round(m / 1440)} days ago`;
};
export const fmtTop = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export const DESIGNATION: Record<string, { label: string; tone: 'gold' | 'red' | 'purple' | 'blue' | 'green' }> = {
  gotw: { label: 'Game of the Week', tone: 'gold' }, rivalry: { label: 'Rivalry', tone: 'red' }, primetime: { label: 'CFB 27 Primetime', tone: 'purple' },
  conference_championship: { label: 'Conference Championship', tone: 'blue' }, playoff: { label: 'Playoff', tone: 'green' }, bowl: { label: 'Bowl Game', tone: 'blue' },
};
export const Designations = ({ list }: { list: string[] }) => <>{list.map((d) => DESIGNATION[d] && <Badge key={d} tone={DESIGNATION[d].tone}>{DESIGNATION[d].label}</Badge>)}</>;

export function statusText(g: Game): string {
  if (g.status === 'final') return 'Final';
  if (g.status === 'in_progress') return [g.period, g.clock].filter(Boolean).join(' ') || 'In progress';
  if (g.status === 'postponed') return 'Postponed';
  if (g.status === 'canceled') return 'Canceled';
  return fmtKick(g.kickoffAt);
}
export function StatusPill({ g }: { g: Game }) {
  if (g.status === 'in_progress')
    return g.replay
      ? <Badge tone="blue" title="Replay of a completed simulation — not a live game">Sim replay · {statusText(g)}</Badge>
      : <Badge tone="live" title="Score entered by league staff"><span className="size-1.5 rounded-full bg-live animate-pulse" /> Live · {statusText(g)}</Badge>;
  if (g.status === 'final') return <Badge tone="neutral">Final</Badge>;
  if (g.status === 'postponed') return <Badge tone="gold">Postponed</Badge>;
  if (g.status === 'canceled') return <Badge tone="red">Canceled</Badge>;
  return <span className="text-xs text-ink-300">{fmtKick(g.kickoffAt)}</span>;
}

// ------------------------------------------------------------------ team identity
const readable = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.6 ? '#0a1020' : '#ffffff';
};
export function TeamLogo({ team, size = 32, className }: { team: { abbr: string; color: string; color2?: string; logo: string | null; name?: string }; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (team.logo && !broken) return <img src={team.logo} alt={team.name ? `${team.name} logo` : ''} width={size} height={size} onError={() => setBroken(true)} className={cx('shrink-0 object-contain', className)} style={{ width: size, height: size }} />;
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center rounded-md font-display font-bold', className)}
      style={{ width: size, height: size, background: team.color, color: readable(team.color), fontSize: Math.max(9, size * 0.36), boxShadow: `inset 0 0 0 2px ${team.color2 ?? '#fff'}33` }}>
      {team.abbr.slice(0, 4)}
    </span>
  );
}
export const Rank = ({ n }: { n: number | null | undefined }) => (n ? <span className="mr-[0.3em] align-[0.2em] text-[0.62em] font-semibold text-ink-300 tnum" title={`Ranked No. ${n}`}>{n}</span> : null);

// ------------------------------------------------------------------ game cards
function Row({ t, win, showScore }: { t: TeamRef; win: boolean; showScore: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <TeamLogo team={t} size={24} />
      <span className={cx('min-w-0 flex-1 truncate font-display text-lg font-semibold leading-tight', win ? 'text-white' : 'text-ink-200')}><Rank n={t.rank} />{t.short}</span>
      <span className="text-[11px] text-ink-400 tnum">{t.record}</span>
      {showScore && <span className={cx('w-8 text-right font-display text-2xl font-bold leading-none tnum', win ? 'text-white' : 'text-ink-300')}>{t.score ?? '–'}</span>}
    </div>
  );
}
export function GameCard({ g, compact }: { g: Game; compact?: boolean }) {
  const showScore = g.status === 'final' || g.status === 'in_progress';
  const aw = g.status === 'final' && (g.away.score ?? 0) > (g.home.score ?? 0);
  const hw = g.status === 'final' && (g.home.score ?? 0) > (g.away.score ?? 0);
  return (
    <Link to={`/games/${g.id}`} className={cx('block rounded-lg border border-ink-700 bg-ink-850 p-3 transition-colors hover:border-ink-500 hover:bg-ink-800', compact && 'w-56 shrink-0')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <StatusPill g={g} />
        {g.network && <span className="text-[11px] font-semibold uppercase text-ink-400">{g.network}</span>}
      </div>
      <div className="space-y-1.5">
        <Row t={g.away} win={aw} showScore={showScore} />
        <Row t={g.home} win={hw} showScore={showScore} />
      </div>
      {!compact && g.designations.length > 0 && <div className="mt-2 flex flex-wrap gap-1"><Designations list={g.designations} /></div>}
    </Link>
  );
}

// ------------------------------------------------------------------ page chrome
const NAV = [['/', 'Scores'], ['/schedule', 'Schedule'], ['/rankings', 'Rankings'], ['/teams', 'Teams'], ['/stats', 'Stats']] as const;
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-ink-700 bg-ink-900/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-3 sm:px-5">
          <Link to="/" className="flex items-center gap-2 py-2.5" aria-label="MCAA Football home">
            <span className="flex size-8 items-center justify-center rounded-md bg-gold font-display text-lg font-extrabold text-ink-950">M</span>
            <span className="hidden font-display text-xl font-bold uppercase tracking-wider sm:block">MCAA <span className="text-gold">Football</span></span>
          </Link>
          <nav className="scroll-x flex flex-1 items-center gap-0.5" aria-label="Main">
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => cx('whitespace-nowrap rounded px-2.5 py-3.5 font-display text-base font-semibold uppercase tracking-wide transition-colors', isActive ? 'text-gold-soft' : 'text-ink-200 hover:text-white')}>{label}</NavLink>
            ))}
          </nav>
          <SeasonSelect className="hidden !py-1 !text-xs sm:block" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-5 sm:px-5">{children}</main>
      <footer className="border-t border-ink-800 bg-ink-900 py-6 text-center text-xs text-ink-400">
        <p>Minecraft Collegiate Athletic Association — a fictional league. Simulated games and reconstructions are generated by the MCAA statistics engine and are labeled as such.</p>
        <p className="mt-1"><Link to="/admin" className="hover:text-ink-200">League administration</Link></p>
      </footer>
    </div>
  );
}
export const PageTitle = ({ children, sub, right }: { children: ReactNode; sub?: ReactNode; right?: ReactNode }) => (
  <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="font-display text-3xl font-bold uppercase tracking-wide">{children}</h1>
      {sub && <p className="mt-0.5 text-sm text-ink-300">{sub}</p>}
    </div>
    {right}
  </div>
);
export function NoSeason() {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-ink-700 bg-ink-850 p-8 text-center">
      <h1 className="font-display text-2xl font-bold uppercase">The season has not been set up yet</h1>
      <p className="mt-2 text-sm text-ink-300">League administrators can create the first season, teams and schedule from the administration area.</p>
      <Link to="/admin" className="mt-4 inline-block rounded-md bg-gold px-4 py-2 text-sm font-semibold text-ink-950">Open administration</Link>
    </div>
  );
}
