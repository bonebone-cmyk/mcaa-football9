// Authentication and the four-administrator rule.
//  * There is no public registration endpoint. Administrator accounts can only be created by someone holding the
//    SETUP_TOKEN Worker secret (a trusted, server-side credential set in the Cloudflare dashboard).
//  * The cap of four is enforced twice: in this module and by a database trigger.
//  * Every /api/admin route passes through requireAdmin, which checks a server-side session and the admin role.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { all, first, now, stmt, uid, type DB } from './db';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SETUP_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  /** Optional: replaces the built-in access code for the "Code" login. */
  ADMIN_CODE?: string;
}
export interface AdminUser {
  id: string;
  email: string;
  name: string;
}
export type AppEnv = { Bindings: Env; Variables: { admin: AdminUser } };

export const MAX_ADMINS = 4;
const ITERATIONS = 100_000;
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const COOKIE = 'mcaa_session';

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
/** Constant-time string comparison (both sides are hashed first so length does not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password: string, salt?: string, iterations = ITERATIONS): Promise<{ hash: string; salt: string; iterations: number }> {
  const saltBytes = salt ? unb64(salt) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return { hash: b64(bits), salt: b64(saltBytes), iterations };
}

const passwordSchema = z.string().min(10, 'Password must be at least 10 characters.').max(200);

export async function createAdmin(db: DB, input: { email: string; name: string; password: string }): Promise<AdminUser> {
  const count = (await first<{ c: number }>(db, "SELECT COUNT(*) AS c FROM users WHERE role_id = 'admin'"))!.c;
  if (count >= MAX_ADMINS) throw new HttpError(409, `All ${MAX_ADMINS} administrator accounts already exist. Remove one before adding another.`);
  if (await first(db, 'SELECT 1 FROM users WHERE email = ?1', input.email)) throw new HttpError(409, 'An account with that email already exists.');
  const pw = await hashPassword(input.password);
  const id = uid();
  // The database trigger is the final authority if two requests race.
  await stmt(db, "INSERT INTO users (id, email, name, role_id, password_hash, password_salt, password_iter, created_at) VALUES (?1, ?2, ?3, 'admin', ?4, ?5, ?6, ?7)", id, input.email.toLowerCase(), input.name, pw.hash, pw.salt, pw.iterations, now()).run();
  return { id, email: input.email.toLowerCase(), name: input.name };
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function cookieValue(c: Context, name: string): string | null {
  const header = c.req.header('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setCookie(c: Context, value: string, maxAgeSec: number) {
  const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : '';
  c.header('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAgeSec}`);
}

export async function currentAdmin(c: Context<AppEnv>): Promise<AdminUser | null> {
  const token = cookieValue(c, COOKIE);
  if (!token) return null;
  const row = await first<AdminUser>(c.env.DB, "SELECT u.id, u.email, COALESCE(s.display_name, u.name) AS name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.role_id IN ('admin', 'code_admin')", await sha256(token), now());
  return row ?? null;
}

/** State-changing requests must come from our own pages: same origin plus a custom header that cross-site forms cannot send. */
function checkCsrf(c: Context): void {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return;
  const origin = c.req.header('Origin');
  if (origin && new URL(origin).host !== new URL(c.req.url).host) throw new HttpError(403, 'Cross-site request blocked.');
  if (c.req.header('X-MCAA-Request') !== '1') throw new HttpError(403, 'Missing request header.');
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  checkCsrf(c);
  const admin = await currentAdmin(c);
  if (!admin) throw new HttpError(401, 'Administrator sign-in required.');
  c.set('admin', admin);
  await next();
};

async function requireSetupToken(c: Context<AppEnv>) {
  const configured = c.env.SETUP_TOKEN?.trim();
  if (!configured || configured.length < 16) throw new HttpError(503, 'Administrator setup is disabled. Set the SETUP_TOKEN secret (16+ characters) on the Worker, then try again.');
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!given || !(await safeEqual(given, configured))) throw new HttpError(401, 'Invalid setup token.');
}

export function auditStmt(db: DB, admin: { id: string | null; name: string }, e: { action: string; entity: string; entityId?: string | null; gameId?: string | null; previous?: unknown; next?: unknown; reason?: string | null }) {
  return stmt(db, 'INSERT INTO audit_logs (admin_id, admin_name, action, entity, entity_id, game_id, previous_value, new_value, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
    admin.id, admin.name, e.action, e.entity, e.entityId ?? null, e.gameId ?? null, e.previous === undefined ? null : JSON.stringify(e.previous), e.next === undefined ? null : JSON.stringify(e.next), e.reason ?? null, now());
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/login', async (c) => {
  checkCsrf(c);
  const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(await c.req.json());
  const db = c.env.DB;
  const email = body.email.toLowerCase();
  const recent = (await first<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM login_attempts WHERE email = ?1 AND ok = 0 AND at > ?2', email, now() - 15 * 60_000))!.c;
  if (recent >= 8) throw new HttpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
  const user = await first<{ id: string; email: string; name: string; password_hash: string; password_salt: string; password_iter: number }>(db, "SELECT * FROM users WHERE email = ?1 AND role_id = 'admin'", email);
  // Hash even when the account does not exist so timing does not reveal which emails are administrators.
  const attempt = await hashPassword(body.password, user?.password_salt ?? 'AAAAAAAAAAAAAAAAAAAAAA==', user?.password_iter ?? ITERATIONS);
  const ok = !!user && (await safeEqual(attempt.hash, user.password_hash));
  await stmt(db, 'INSERT INTO login_attempts (email, at, ok) VALUES (?1, ?2, ?3)', email, now(), ok ? 1 : 0).run();
  if (!ok) throw new HttpError(401, 'Incorrect email or password.');
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  await db.batch([
    stmt(db, 'DELETE FROM sessions WHERE expires_at < ?1', now()),
    stmt(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)', await sha256(token), user!.id, now(), now() + SESSION_MS),
    stmt(db, 'UPDATE users SET last_login_at = ?1 WHERE id = ?2', now(), user!.id),
    auditStmt(db, { id: user!.id, name: user!.name }, { action: 'login', entity: 'session' }),
  ]);
  setCookie(c, token, SESSION_MS / 1000);
  return c.json({ admin: { id: user!.id, email: user!.email, name: user!.name } });
});

// ---- Shared access-code login ("Code").
// Only a PBKDF2 hash of the default code is in the source. Setting the optional ADMIN_CODE secret on the Worker
// replaces the default code without a code change.
const DEFAULT_CODE = { salt: 'r7UcW8WkdwDwSHYriJk+wA==', hash: 'eCuFhfeUsCcfCcoSSZIJH42u9NIjtXryr+Z3oX19NcE=', iterations: 100_000 };
async function codeMatches(env: Env, given: string): Promise<boolean> {
  const custom = env.ADMIN_CODE?.trim();
  if (custom) return safeEqual(given, custom);
  return safeEqual((await hashPassword(given, DEFAULT_CODE.salt, DEFAULT_CODE.iterations)).hash, DEFAULT_CODE.hash);
}

authRoutes.post('/auth/code', async (c) => {
  checkCsrf(c);
  const body = z.object({ code: z.string().trim().min(1, 'Enter the code.').max(200), name: z.string().trim().max(60).optional() }).parse(await c.req.json());
  const db = c.env.DB;
  // Failed attempts are limited per network address so one person guessing cannot lock everyone else out.
  const key = `code:${c.req.header('CF-Connecting-IP') ?? 'local'}`;
  const recent = (await first<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM login_attempts WHERE email = ?1 AND ok = 0 AND at > ?2', key, now() - 15 * 60_000))!.c;
  if (recent >= 8) throw new HttpError(429, 'Too many incorrect codes. Try again in 15 minutes.');
  const ok = await codeMatches(c.env, body.code);
  await stmt(db, 'INSERT INTO login_attempts (email, at, ok) VALUES (?1, ?2, ?3)', key, now(), ok ? 1 : 0).run();
  if (!ok) throw new HttpError(401, 'Incorrect code.');
  const user = await first<{ id: string; email: string; name: string }>(db, "SELECT id, email, name FROM users WHERE id = 'code-admin' AND role_id = 'code_admin'");
  if (!user) throw new HttpError(503, 'Code login is not available on this database.');
  const name = body.name ? `${body.name} (code)` : user.name;
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  await db.batch([
    stmt(db, 'DELETE FROM sessions WHERE expires_at < ?1', now()),
    stmt(db, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, display_name) VALUES (?1, ?2, ?3, ?4, ?5)', await sha256(token), user.id, now(), now() + SESSION_MS, name),
    stmt(db, 'UPDATE users SET last_login_at = ?1 WHERE id = ?2', now(), user.id),
    auditStmt(db, { id: user.id, name }, { action: 'login', entity: 'session', next: { method: 'code' } }),
  ]);
  setCookie(c, token, SESSION_MS / 1000);
  return c.json({ admin: { id: user.id, email: user.email, name } });
});

authRoutes.post('/auth/logout', async (c) => {
  checkCsrf(c);
  const token = cookieValue(c, COOKIE);
  if (token) await stmt(c.env.DB, 'DELETE FROM sessions WHERE token_hash = ?1', await sha256(token)).run();
  setCookie(c, '', 0);
  return c.json({ ok: true });
});

authRoutes.get('/auth/me', async (c) => c.json({ admin: await currentAdmin(c) }));

authRoutes.post('/auth/password', requireAdmin, async (c) => {
  const body = z.object({ current: z.string(), next: passwordSchema }).parse(await c.req.json());
  const admin = c.get('admin');
  if (admin.id === 'code-admin') throw new HttpError(403, 'You signed in with the access code, which has no password to change.');
  const user = (await first<{ password_hash: string; password_salt: string; password_iter: number }>(c.env.DB, 'SELECT * FROM users WHERE id = ?1', admin.id))!;
  const attempt = await hashPassword(body.current, user.password_salt, user.password_iter);
  if (!(await safeEqual(attempt.hash, user.password_hash))) throw new HttpError(401, 'Current password is incorrect.');
  const pw = await hashPassword(body.next);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE users SET password_hash = ?1, password_salt = ?2, password_iter = ?3 WHERE id = ?4', pw.hash, pw.salt, pw.iterations, admin.id),
    auditStmt(c.env.DB, admin, { action: 'password_change', entity: 'user', entityId: admin.id }),
  ]);
  return c.json({ ok: true });
});

// ---- Administrator provisioning (trusted server-side process: requires the SETUP_TOKEN secret).
authRoutes.get('/setup/status', async (c) => {
  const count = (await first<{ c: number }>(c.env.DB, "SELECT COUNT(*) AS c FROM users WHERE role_id = 'admin'"))!.c;
  return c.json({ setupEnabled: (c.env.SETUP_TOKEN?.trim().length ?? 0) >= 16, adminCount: count, maxAdmins: MAX_ADMINS });
});
authRoutes.get('/setup/admins', async (c) => {
  await requireSetupToken(c);
  return c.json({ admins: await all(c.env.DB, "SELECT id, email, name, created_at, last_login_at FROM users WHERE role_id = 'admin' ORDER BY created_at"), maxAdmins: MAX_ADMINS });
});
authRoutes.post('/setup/admins', async (c) => {
  checkCsrf(c);
  await requireSetupToken(c);
  const body = z.object({ email: z.string().email().max(200), name: z.string().trim().min(1).max(80), password: passwordSchema }).parse(await c.req.json());
  const admin = await createAdmin(c.env.DB, body);
  await auditStmt(c.env.DB, { id: null, name: 'setup token' }, { action: 'admin_created', entity: 'user', entityId: admin.id, next: { email: admin.email, name: admin.name } }).run();
  return c.json({ admin }, 201);
});
authRoutes.delete('/setup/admins/:id', async (c) => {
  checkCsrf(c);
  await requireSetupToken(c);
  const u = await first<{ id: string; email: string; name: string }>(c.env.DB, "SELECT id, email, name FROM users WHERE id = ?1 AND role_id = 'admin'", c.req.param('id'));
  if (!u) throw new HttpError(404, 'Administrator not found.');
  // Historical records keep the administrator's id, and the audit log keeps the name, so removing the account frees the slot safely.
  await c.env.DB.batch([
    stmt(c.env.DB, 'DELETE FROM sessions WHERE user_id = ?1', u.id),
    stmt(c.env.DB, 'DELETE FROM users WHERE id = ?1', u.id),
    auditStmt(c.env.DB, { id: null, name: 'setup token' }, { action: 'admin_removed', entity: 'user', entityId: u.id, previous: { email: u.email, name: u.name } }),
  ]);
  return c.json({ ok: true });
});
