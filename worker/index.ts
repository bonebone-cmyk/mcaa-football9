// MCAA Football — Cloudflare Worker entry point.
// /api/*  -> this API (Hono).   everything else -> the built React site in ./dist (served by the ASSETS binding).
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { adminRoutes } from './admin';
import { HttpError, authRoutes, requireAdmin, type AppEnv } from './auth';
import { ensureSchema } from './db';
import { publicRoutes } from './public';

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (c, next) => {
  if (!c.env.DB) throw new HttpError(503, 'The D1 database binding "DB" is missing. Check wrangler.jsonc and redeploy.');
  await ensureSchema(c.env.DB);
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...err.extra }, err.status as 400);
  if (err instanceof ZodError) return c.json({ error: err.issues[0]?.message ? `${err.issues[0].path.join('.') || 'input'}: ${err.issues[0].message}` : 'Invalid input.', details: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`) }, 400);
  const msg = err instanceof Error ? err.message : String(err);
  // Database policies (triggers and constraints) surface as readable errors rather than generic failures.
  if (/SQLITE_CONSTRAINT|D1_ERROR/.test(msg)) {
    if (/_assert/.test(msg)) return c.json({ error: 'Another administrator changed this record at the same moment. Refresh and try again.', code: 'CONFLICT' }, 409);
    const m = /D1_ERROR: ([^:]+):/.exec(msg);
    return c.json({ error: m && !/constraint failed/i.test(m[1]) ? m[1].trim() : 'The database rejected this change because it would break a data rule.', code: 'DB_RULE' }, 409);
  }
  console.error(err);
  return c.json({ error: 'Unexpected server error. Nothing was saved.' }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));
app.route('/', authRoutes);
app.use('/admin/*', requireAdmin);
app.route('/admin', adminRoutes);
app.route('/', publicRoutes);
app.all('*', (c) => c.json({ error: 'Not found.' }, 404));

export default {
  fetch(request: Request, env: AppEnv['Bindings'], ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<AppEnv['Bindings']>;
