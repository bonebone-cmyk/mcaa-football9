// Team percentages (Activity / Upset / Star).
// The current values live in the D1 table `team_percentages`, one row per team per season, and are entered by
// administrators (directly, or from a CSV/JSON file). This module never invents, defaults or estimates a value.
// Before a simulation the current values are copied into an immutable, timestamped snapshot; the simulation
// record points at that snapshot, so later edits never change what a stored game was simulated with.
import { HttpError, sha256, type AdminUser } from './auth';
import { all, first, insertRows, j, now, stmt, uid, type DB } from './db';
import type { TeamRow } from './league';

export interface PctEntry { teamId: string; activity: number; upset: number; star: number; extra: Record<string, number> }
export interface Snapshot { id: string; season_id: string; source: string; source_detail: string | null; fetched_at: number; team_count: number; checksum: string }

const CORE = ['activity', 'upset', 'star'];
const TEAM_KEYS = ['team', 'team_id', 'teamid', 'id', 'abbr', 'name', 'school'];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t' || ch === ';') (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(content: string): Record<string, string>[] {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/(percentage|percent|pct)$/, ''));
  return lines.slice(1).map((l) => Object.fromEntries(splitCsvLine(l).map((v, i) => [head[i] ?? `col${i}`, v])));
}

const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || !v.trim()) return NaN;
  return Number(v.trim().replace(/%$/, ''));
};

/** Parse and validate a percentage export. Any problem rejects the whole import; nothing is defaulted or guessed. */
export function parsePercentages(format: 'csv' | 'json', content: string, teams: TeamRow[]): { entries: PctEntry[]; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let raw: Record<string, unknown>[] = [];
  if (format === 'csv') raw = parseCsv(content);
  else {
    try {
      const data = JSON.parse(content);
      const arr = Array.isArray(data) ? data : data?.teams ?? data?.percentages ?? data?.data;
      if (Array.isArray(arr)) raw = arr;
      else if (data && typeof data === 'object') raw = Object.entries(data).map(([team, v]) => ({ team, ...(v as object) }));
    } catch {
      errors.push('The JSON could not be parsed.');
    }
    raw = raw.map((r) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/(percentage|percent|pct)$/, ''), v])));
  }
  if (!raw.length && !errors.length) errors.push('No rows found. Expected a header row with: team, activity, upset, star.');
  const byKey = new Map<string, TeamRow>();
  for (const t of teams) for (const k of [t.id, t.abbr, t.name, t.short_name]) byKey.set(k.toLowerCase(), t);
  const seen = new Set<string>();
  const entries: PctEntry[] = [];
  raw.forEach((r, i) => {
    const row = `Row ${i + 1}`;
    const key = TEAM_KEYS.map((k) => r[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    if (!key) return void errors.push(`${row}: no team column (expected one of: team, abbr, name, id).`);
    const t = byKey.get(key.trim().toLowerCase());
    if (!t) return void errors.push(`${row}: team "${key}" does not match any MCAA team name, short name, abbreviation or id.`);
    if (!t.in_season) return void errors.push(`${row}: ${t.name} is not entered in this season.`);
    if (seen.has(t.id)) return void errors.push(`${row}: ${t.name} appears more than once.`);
    seen.add(t.id);
    const vals: Record<string, number> = {};
    for (const c of CORE) {
      const n = toNum(r[c]);
      if (!Number.isFinite(n)) errors.push(`${row} (${t.name}): ${c} percentage is missing or not a number.`);
      else if (n < 0 || n > 100) errors.push(`${row} (${t.name}): ${c} percentage ${n} is outside 0-100.`);
      vals[c] = n;
    }
    const extra: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) {
      if (CORE.includes(k) || TEAM_KEYS.includes(k)) continue;
      const n = toNum(v);
      if (Number.isFinite(n) && n >= 0 && n <= 100) extra[k] = n;
    }
    entries.push({ teamId: t.id, activity: vals.activity, upset: vals.upset, star: vals.star, extra });
  });
  return { entries: errors.length ? [] : entries, errors, warnings };
}

export interface StoredPct { activity: number; upset: number; star: number; extra: Record<string, number> }
export interface CurrentRow extends StoredPct { teamId: string; updatedAt: number; updatedBy: string | null }

/** The current percentages for a season, as stored in D1. */
export async function currentPercentages(db: DB, seasonId: string): Promise<Map<string, CurrentRow>> {
  const rows = await all<{ team_id: string; activity: number; upset: number; star: number; extra: string; updated_at: number; updated_by_name: string | null }>(db, 'SELECT * FROM team_percentages WHERE season_id = ?1', seasonId);
  return new Map(rows.map((r) => [r.team_id, { teamId: r.team_id, activity: r.activity, upset: r.upset, star: r.star, extra: j(r.extra, {}), updatedAt: r.updated_at, updatedBy: r.updated_by_name }]));
}

/** Insert or update rows. When `keepExtra` is set, existing extra categories survive an edit that does not supply any. */
export function upsertPercentagesStmt(db: DB, seasonId: string, entries: PctEntry[], admin: AdminUser | null, keepExtra = true): D1PreparedStatement {
  const rows = entries.map((e) => ({ teamId: e.teamId, activity: e.activity, upset: e.upset, star: e.star, extra: JSON.stringify(e.extra ?? {}) }));
  return db.prepare(`INSERT INTO team_percentages (season_id, team_id, activity, upset, star, extra, updated_at, updated_by, updated_by_name)
      SELECT ?1, json_extract(value, '$.teamId'), json_extract(value, '$.activity'), json_extract(value, '$.upset'), json_extract(value, '$.star'), json_extract(value, '$.extra'), ?3, ?4, ?5
      FROM json_each(?2) WHERE true
      ON CONFLICT (season_id, team_id) DO UPDATE SET activity = excluded.activity, upset = excluded.upset, star = excluded.star,
        extra = ${keepExtra ? "CASE WHEN excluded.extra = '{}' THEN team_percentages.extra ELSE excluded.extra END" : 'excluded.extra'},
        updated_at = excluded.updated_at, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name`)
    .bind(seasonId, JSON.stringify(rows), now(), admin?.id ?? null, admin?.name ?? null);
}

const checksumOf = (entries: PctEntry[]) => sha256(JSON.stringify([...entries].sort((a, b) => a.teamId.localeCompare(b.teamId)).map((e) => ({ teamId: e.teamId, activity: e.activity, upset: e.upset, star: e.star, extra: e.extra }))));

export async function saveSnapshot(db: DB, seasonId: string, source: string, detail: string | null, entries: PctEntry[], admin: AdminUser | null): Promise<Snapshot> {
  if (!entries.length) throw new HttpError(422, 'A snapshot needs at least one team.');
  const id = uid();
  const snap: Snapshot = { id, season_id: seasonId, source, source_detail: detail, fetched_at: now(), team_count: entries.length, checksum: await checksumOf(entries) };
  await db.batch([
    stmt(db, 'INSERT INTO percentage_snapshots (id, season_id, source, source_detail, fetched_at, created_by, checksum, team_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)', id, seasonId, source, detail, snap.fetched_at, admin?.id ?? null, snap.checksum, entries.length),
    insertRows(db, 'percentage_snapshot_entries', ['snapshot_id', 'team_id', 'activity', 'upset', 'star', 'extra'], entries.map((e) => ({ snapshot_id: id, team_id: e.teamId, activity: e.activity, upset: e.upset, star: e.star, extra: e.extra }))),
  ]);
  return snap;
}

/**
 * Freeze the current D1 percentages into a snapshot. If nothing changed since the latest snapshot, that snapshot is
 * reused, so repeated simulations do not pile up identical copies.
 */
export async function snapshotCurrent(db: DB, seasonId: string, admin: AdminUser | null): Promise<Snapshot> {
  const cur = await currentPercentages(db, seasonId);
  if (!cur.size) throw new HttpError(422, 'No team percentages are stored for this season. Enter them in Team Percentages before simulating.', { code: 'NO_PERCENTAGES' });
  const entries: PctEntry[] = [...cur.values()].map((r) => ({ teamId: r.teamId, activity: r.activity, upset: r.upset, star: r.star, extra: r.extra }));
  const sum = await checksumOf(entries);
  const latest = await first<Snapshot>(db, 'SELECT * FROM percentage_snapshots WHERE season_id = ?1 ORDER BY fetched_at DESC, id DESC LIMIT 1', seasonId);
  if (latest && latest.checksum === sum && latest.team_count === entries.length) return latest;
  return saveSnapshot(db, seasonId, 'database', 'current team percentages', entries, admin);
}

export async function snapshotEntries(db: DB, snapshotId: string): Promise<Map<string, StoredPct>> {
  const rows = await all<{ team_id: string; activity: number; upset: number; star: number; extra: string }>(db, 'SELECT * FROM percentage_snapshot_entries WHERE snapshot_id = ?1', snapshotId);
  return new Map(rows.map((r) => [r.team_id, { activity: r.activity, upset: r.upset, star: r.star, extra: j(r.extra, {}) }]));
}

/**
 * Decide which percentages a simulation uses.
 *  - explicit snapshotId: an administrator deliberately re-uses an earlier snapshot (its age is shown in the UI);
 *  - otherwise: the current values stored in D1, frozen into a snapshot now.
 */
export async function resolveSnapshot(db: DB, seasonId: string, admin: AdminUser, snapshotId?: string | null): Promise<Snapshot> {
  if (snapshotId) {
    const s = await first<Snapshot>(db, 'SELECT * FROM percentage_snapshots WHERE id = ?1 AND season_id = ?2', snapshotId, seasonId);
    if (!s) throw new HttpError(404, 'That percentage snapshot does not exist for this season.');
    return s;
  }
  return snapshotCurrent(db, seasonId, admin);
}
