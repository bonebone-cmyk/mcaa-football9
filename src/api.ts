import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(public status: number, message: string, public data: Record<string, any> = {}) {
    super(message);
  }
  get details(): string[] {
    return Array.isArray(this.data.details) ? this.data.details : [];
  }
  get code(): string | undefined {
    return this.data.code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-MCAA-Request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`, data ?? {});
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T = any>(p: string, b: unknown = {}) => request<T>('PUT', p, b),
  patch: <T = any>(p: string, b: unknown = {}) => request<T>('PATCH', p, b),
  del: <T = any>(p: string) => request<T>('DELETE', p),
};

export interface Loaded<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }

/** Fetch on mount and whenever the path changes. Pass null to skip. `pollMs` re-fetches quietly on an interval. */
export function useApi<T = any>(path: string | null, pollMs = 0): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const seq = useRef(0);
  const load = useCallback((quiet = false) => {
    if (!path) return setState({ data: null, error: null, loading: false });
    const my = ++seq.current;
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
    api.get<T>(path).then(
      (data) => my === seq.current && setState({ data, error: null, loading: false }),
      (error) => my === seq.current && setState((s) => ({ data: quiet ? s.data : null, error, loading: false })),
    );
  }, [path]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!pollMs || !path) return;
    const t = setInterval(() => load(true), pollMs);
    return () => clearInterval(t);
  }, [pollMs, path, load]);
  return { ...state, reload: () => load(true) };
}

export const qs = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
