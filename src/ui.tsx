// Small UI primitives in the shadcn/ui idiom (composable, class-based variants), written locally so the build has no generator step.
import { X } from 'lucide-react';
import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError } from './api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
const VARIANT: Record<Variant, string> = {
  primary: 'bg-gold text-ink-950 hover:bg-gold-soft font-semibold',
  secondary: 'bg-ink-700 text-ink-100 hover:bg-ink-600',
  outline: 'border border-ink-600 text-ink-100 hover:bg-ink-800',
  ghost: 'text-ink-200 hover:bg-ink-800',
  danger: 'bg-red-600/90 text-white hover:bg-red-500',
};
export function Button({ variant = 'secondary', size = 'md', className, busy, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }) {
  return (
    <button {...p} disabled={p.disabled || busy} className={cx('inline-flex items-center justify-center gap-1.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap', size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm', VARIANT[variant], className)}>
      {busy && <span className="size-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ className, children, title, action, pad = true }: { className?: string; children: ReactNode; title?: ReactNode; action?: ReactNode; pad?: boolean }) {
  return (
    <section className={cx('min-w-0 rounded-xl border border-ink-700 bg-ink-850', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-2.5">
          <h2 className="font-display text-lg font-semibold uppercase tracking-wide text-ink-100">{title}</h2>
          {action}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

const TONE: Record<string, string> = {
  neutral: 'bg-ink-700 text-ink-200', gold: 'bg-gold/15 text-gold-soft ring-1 ring-gold/30', live: 'bg-live/15 text-red-300 ring-1 ring-live/40',
  green: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30', blue: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30', red: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
  purple: 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30',
};
export function Badge({ tone = 'neutral', children, className, title }: { tone?: keyof typeof TONE; children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide', TONE[tone], className)}>{children}</span>;
}

const field = 'w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-gold focus:outline-none disabled:opacity-60';
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field, className)} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(field, 'font-mono text-xs leading-relaxed', className)} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(field, 'pr-7', className)}>{children}</select>;
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}
export function Check({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex items-center gap-2 text-sm text-ink-200', disabled && 'opacity-50')}>
      <input type="checkbox" className="size-4 accent-[#f5b301]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx('scroll-x flex gap-1 border-b border-ink-700', className)}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 font-display text-base font-semibold uppercase tracking-wide transition-colors', value === t.id ? 'border-gold text-gold-soft' : 'border-transparent text-ink-300 hover:text-ink-100')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={cx('w-full rounded-xl border border-ink-600 bg-ink-850 shadow-2xl', wide ? 'max-w-4xl' : 'max-w-xl')}>
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h2 className="font-display text-xl font-semibold uppercase tracking-wide">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-300 hover:bg-ink-700 hover:text-white"><X className="size-5" /></button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export const Spinner = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-300" role="status">
    <span className="size-4 rounded-full border-2 border-ink-400 border-t-transparent animate-spin" aria-hidden /> {label}
  </div>
);

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = error as ApiError;
  const details = e instanceof ApiError ? e.details : [];
  return (
    <div role="alert" className={cx('rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200', className)}>
      <p className="font-medium">{e.message ?? String(error)}</p>
      {details.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-red-200/90">{details.slice(0, 20).map((d, i) => <li key={i}>{d}</li>)}</ul>}
      {details.length > 20 && <p className="mt-1 text-xs">…and {details.length - 20} more.</p>}
    </div>
  );
}
export const Notice = ({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode; className?: string }) => (
  <div className={cx('rounded-lg border px-3 py-2 text-sm', tone === 'warn' ? 'border-amber-500/40 bg-amber-500/10 text-amber-100' : tone === 'ok' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100' : 'border-sky-500/30 bg-sky-500/10 text-sky-100', className)}>{children}</div>
);
export const Empty = ({ children }: { children: ReactNode }) => <p className="py-8 text-center text-sm text-ink-400">{children}</p>;

/** Loading / error / empty wrapper for a useApi result. */
export function Load<T>({ q, children }: { q: { data: T | null; error: unknown; loading: boolean }; children: (data: T) => ReactNode }) {
  if (q.loading && !q.data) return <Spinner />;
  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  if (!q.data) return null;
  return <>{children(q.data)}</>;
}

export const th = 'px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-400 whitespace-nowrap';
export const td = 'px-2 py-1.5 text-sm whitespace-nowrap';
export const thr = `${th} text-right`;
/** A cell whose text may wrap. */
export const tdw = 'px-2 py-1.5 text-sm';
export const tdr = `${td} text-right tnum`;

/** Run an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clear: () => setError(null) };
}
