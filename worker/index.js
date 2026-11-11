// Trade journal: one Cloudflare Worker.
//
// Serves the React app (web/dist via ASSETS) and a JSON API over D1, with an
// optional R2 bucket for screenshots.
//
//   /ingest/v1/*      fills in from agents and scripts, by API key   worker/ingest.js
//   /api/auth/*       sign in and out with the journal password      worker/auth.js
//   /api/config       what the page needs before signing in
//   /api/sessions*    positions built from the fills                 worker/sessions.js
//   /api/profile      settings and the "How I trade" page
//   /api/keys         API keys for agents
//   /api/charts, /api/img   screenshots per day (needs R2)

import { handleIngest, sniff } from './ingest.js';
import { handleSessions, ensureBars } from './sessions.js';
import { authStatus, allowed, signIn, signOut, listKeys, createKey, revokeKey } from './auth.js';
import { getProfile, saveProfile, journalZone } from './settings.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const notify = (msg) => notifyWebhook(env, msg);

    // Matched case-insensitively, so every spelling lands on the key check.
    const pl = p.toLowerCase();
    if (pl === '/ingest' || pl.startsWith('/ingest/')) {
      return handleIngest(request, env, ctx, url, notify, () => ensureBars(env, { force: true }));
    }

    if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      // A browser always sends Origin on a cross-site write. Refusing a foreign
      // one stops another site from making a signed-in browser change anything.
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return json({ error: 'Cross-site request refused.' }, 403);
      }

      // Open routes: the page asks these before anyone has signed in.
      if (p === '/api/config' && request.method === 'GET') {
        return json({ auth: await authStatus(request, env), images: !!env.IMG });
      }
      if (p === '/api/auth/login' && request.method === 'POST') return signIn(request, env, (m) => ctx.waitUntil(notify(m)));
      if (p === '/api/auth/logout' && request.method === 'POST') return signOut(request);

      if (!(await allowed(request, env))) return json({ error: 'Sign in first.' }, 401);

      // Writes must be JSON, a file upload or CSV. This is not the CSRF
      // protection (a cross-site form can send multipart); the SameSite=Strict
      // cookie and the Origin check above are. It keeps stray form posts out.
      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        const ct = (request.headers.get('content-type') || '').toLowerCase();
        if (!ct.startsWith('application/json') && !ct.startsWith('multipart/form-data') && !ct.startsWith('text/csv')) {
          return json({ error: 'Send JSON.' }, 415);
        }
      }

      const r = await route(request, env, url);
      return r || json({ error: 'not found' }, 404);
    } catch (err) {
      const msg = String((err && err.message) || err);
      ctx.waitUntil(notify(`API error on ${request.method} ${p}: ${msg}`));
      return json({ error: msg }, 500);
    }
  },
};

async function route(request, env, url) {
  const p = url.pathname;
  const method = request.method;
  const q = url.searchParams;

  if (p.startsWith('/api/sessions')) return handleSessions(request, env, url);

  // ---- settings and the "How I trade" page (one row) ----
  if (p === '/api/profile') {
    if (method === 'GET') return json({ ...(await getProfile(env)), effective_time_zone: await journalZone(env) });
    if (method === 'PATCH' || method === 'POST') {
      const body = await request.json();
      delete body.effective_time_zone;
      try {
        const next = await saveProfile(env, body);
        return json({ ...next, effective_time_zone: await journalZone(env) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
  }

  // ---- API keys for agents ----
  if (p === '/api/keys') {
    if (method === 'GET') return json(await listKeys(env));
    if (method === 'POST') {
      try {
        return json(await createKey(env, (await request.json()).name), 201);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
  }
  const km = p.match(/^\/api\/keys\/(\d+)$/);
  if (km && method === 'DELETE') { await revokeKey(env, km[1]); return json({ ok: true }); }

  // ---- screenshots for a day (R2) ----
  if (p.startsWith('/api/charts') || p.startsWith('/api/img/')) {
    if (!env.IMG) return json({ error: 'Screenshots are turned off: no R2 bucket is bound to this Worker. See the README.' }, 501);
  }
  if (p === '/api/charts') {
    await ensureChartTable(env);
    if (method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT id, date, file_path, caption, created_at FROM daily_charts WHERE date = ? ORDER BY created_at',
      ).bind(q.get('date')).all();
      return json(rows.results || []);
    }
    if (method === 'POST') {
      const form = await request.formData();
      const file = form.get('file');
      const date = String(form.get('date') || '');
      if (!file || typeof file === 'string') return json({ error: 'file is required' }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date=YYYY-MM-DD is required' }, 400);
      if (file.size > 12 * 1024 * 1024) return json({ error: 'image larger than 12 MB' }, 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = sniff(bytes);
      if (!kind) return json({ error: 'only PNG, JPEG, GIF, WEBP or HEIC images can be added' }, 400);
      const key = `${date}/${Date.now()}.${kind.ext}`;
      await env.IMG.put(key, bytes, { httpMetadata: { contentType: kind.type } });
      const res = await env.DB.prepare(
        'INSERT INTO daily_charts (date, file_path, caption) VALUES (?, ?, ?)',
      ).bind(date, key, String(form.get('caption') || '').slice(0, 300)).run();
      return json(await env.DB.prepare(
        'SELECT id, date, file_path, caption, created_at FROM daily_charts WHERE id = ?',
      ).bind(res.meta.last_row_id).first(), 201);
    }
  }
  const cm = p.match(/^\/api\/charts\/(\d+)$/);
  if (cm && method === 'DELETE') {
    await ensureChartTable(env);
    const row = await env.DB.prepare('SELECT file_path FROM daily_charts WHERE id = ?').bind(Number(cm[1])).first();
    if (row) {
      if (row.file_path) await env.IMG.delete(row.file_path).catch(() => {});
      await env.DB.prepare('DELETE FROM daily_charts WHERE id = ?').bind(Number(cm[1])).run();
    }
    return json({ ok: true });
  }

  const im = p.match(/^\/api\/img\/(.+)$/);
  if (im && method === 'GET') {
    const obj = await env.IMG.get(decodeURIComponent(im[1]));
    if (!obj) return json({ error: 'not found' }, 404);
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('cache-control', 'private, max-age=86400');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(obj.body, { headers });
  }

  return null;
}

let chartsReady = false;
async function ensureChartTable(env) {
  if (chartsReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS daily_charts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, file_path TEXT NOT NULL,
    caption TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run();
  chartsReady = true;
}

// Optional: server errors are posted to a webhook that takes {"content": "..."}
// (a Discord channel webhook works as is). Set ERROR_WEBHOOK_URL to turn it on.
async function notifyWebhook(env, content) {
  try {
    const hook = env.ERROR_WEBHOOK_URL;
    if (!hook) return;
    await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(content).slice(0, 1900) }),
    });
  } catch { /* alerting must never throw */ }
}
