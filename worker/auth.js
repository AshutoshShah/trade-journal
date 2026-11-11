// Who may use the journal.
//
// The pages and /api, chosen by the AUTH variable:
//
//   "password" (the default): the APP_PASSWORD secret, at least 12 characters
//   and not the example value. Signing in sets a signed, HttpOnly,
//   SameSite=Strict cookie for 30 days. Changing the password signs every
//   browser out. Wrong passwords are slowed; after 10 from one address (one
//   /64 for IPv6) in 15 minutes, that address is refused until the window
//   passes, and after 50 from all addresses together, sign-in is closed for
//   the window and the error webhook is told.
//
//   "access": Cloudflare Access signs people in. Every request must carry the
//   token Access adds (Cf-Access-Jwt-Assertion), and the Worker checks its
//   signature against the team's public keys, its audience (ACCESS_AUD) and its
//   expiry. Without a valid token nothing is served, so a hostname that Access
//   does not actually protect stays locked rather than open.
//
// /ingest (agents and scripts): API keys. Each key belongs to one named source,
// such as "my-agent", and every day it sends is stored under that name. Keys are
// created and revoked in Settings and kept only as SHA-256 hashes. A Worker
// secret named INGEST_KEY_<NAME> also works, for those who prefer secrets.

const COOKIE = 'tj_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 10;              // failed sign-ins per address (IPv6: per /64)...
const MAX_FAILS_ALL = 50;          // ...and from all addresses together...
const FAIL_WINDOW_SEC = 15 * 60;   // ...in this window, then refused until it passes
const MIN_PASSWORD = 12;
const EXAMPLE_PASSWORD = 'change-me-to-a-long-password';   // the value in .dev.vars.example

const enc = (s) => new TextEncoder().encode(s);
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = (s) => crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc(s) : s);

export const authMode = (env) => (String(env.AUTH || 'password').toLowerCase() === 'access' ? 'access' : 'password');

// ── Cloudflare Access ────────────────────────────────────────────────────────

// "yourteam.cloudflareaccess.com", from ACCESS_TEAM_DOMAIN with or without https://.
function accessTeam(env) {
  const t = String(env.ACCESS_TEAM_DOMAIN || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(t) ? t : null;
}
const accessConfigured = (env) => !!(accessTeam(env) && String(env.ACCESS_AUD || '').trim());

const unb64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

let certCache = { team: null, at: 0, keys: [] };
async function accessKeys(team, refresh) {
  if (!refresh && certCache.team === team && Date.now() - certCache.at < 3600 * 1000) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`could not read Access keys (${res.status})`);
  const body = await res.json();
  certCache = { team, at: Date.now(), keys: Array.isArray(body.keys) ? body.keys : [] };
  return certCache.keys;
}

// The signed-in email (or "access") when the request carries a valid Access token.
async function accessIdentity(request, env) {
  if (!accessConfigured(env)) return null;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(unb64url(parts[1])));
  } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const team = accessTeam(env);
  let jwk = (await accessKeys(team, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), enc(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Date.now() / 1000;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(String(env.ACCESS_AUD).trim())) return null;
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
  if (payload.iss !== `https://${team}`) return null;
  return payload.email || 'access';
}

// Why the password cannot be used, or null when it can.
function passwordProblem(env) {
  const p = env.APP_PASSWORD;
  if (typeof p !== 'string' || !p.length) return 'missing';
  if (p === EXAMPLE_PASSWORD || p.length < MIN_PASSWORD) return 'weak';
  return null;
}
// The password, only when it is usable.
const password = (env) => (passwordProblem(env) ? null : env.APP_PASSWORD);

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc(`${env.SESSION_SECRET || ''}|${password(env)}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function readCookie(request, name) {
  const all = request.headers.get('cookie') || '';
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function sessionValid(request, env) {
  const v = readCookie(request, COOKIE);
  if (!v || !password(env)) return false;
  const [exp, sig] = v.split('.');
  if (!/^\d+$/.test(exp || '') || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc(`session:${exp}`)));
  const a = enc(want), b = enc(sig);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

// What the page needs to know before it shows anything.
export async function authStatus(request, env) {
  if (authMode(env) === 'access') {
    return { mode: 'access', configured: accessConfigured(env), signedIn: !!(await accessIdentity(request, env)) };
  }
  const problem = passwordProblem(env);
  return { mode: 'password', configured: !problem, ...(problem ? { problem } : {}), signedIn: await sessionValid(request, env) };
}

export async function allowed(request, env) {
  if (authMode(env) === 'access') return !!(await accessIdentity(request, env));
  return sessionValid(request, env);
}

const secure = (request) => (new URL(request.url).protocol === 'https:' ? '; Secure' : '');

// The address failures are counted against. IPv6 users usually hold a whole
// /64, so an IPv6 address counts by its first four groups.
export function failKey(ip) {
  if (!ip || !ip.includes(':')) return ip || 'unknown';
  let [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => String(parseInt(g || '0', 16).toString(16))).join(':')}::/64`;
}

export async function signIn(request, env, notify = () => {}) {
  const json = (data, status, headers = {}) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
  if (authMode(env) === 'access') return json({ error: 'This journal signs in through Cloudflare Access.' }, 400);
  const problem = passwordProblem(env);
  if (problem === 'missing') return json({ error: 'No password is set. Add the APP_PASSWORD secret to the Worker, then sign in.' }, 503);
  if (problem === 'weak') {
    return json({ error: `The APP_PASSWORD secret is the example value or shorter than ${MIN_PASSWORD} characters, so sign-in is turned off. Set a longer password.` }, 503);
  }

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, first_at INTEGER NOT NULL)`).run();
  const ip = failKey(request.headers.get('cf-connecting-ip'));
  const now = Math.floor(Date.now() / 1000);
  const rows = (await env.DB.prepare("SELECT ip, fails, first_at FROM login_attempts WHERE ip IN (?, '*')").bind(ip).all()).results || [];
  const live = (r) => r && now - r.first_at < FAIL_WINDOW_SEC;
  const mine = rows.find((r) => r.ip === ip), all = rows.find((r) => r.ip === '*');
  if (live(all) && all.fails >= MAX_FAILS_ALL) {
    return json({ error: 'Too many wrong passwords. Sign-in is closed for 15 minutes.' }, 429);
  }
  if (live(mine) && mine.fails >= MAX_FAILS) {
    return json({ error: 'Too many wrong passwords. Try again in 15 minutes.' }, 429);
  }

  let body = {};
  try { body = await request.json(); } catch { /* empty or not JSON: treated as a wrong password */ }
  const given = typeof body.password === 'string' ? body.password : '';
  const ok = crypto.subtle.timingSafeEqual(await sha256(given), await sha256(password(env)));
  if (!ok) {
    // Count against this address and against all addresses together, and drop
    // rows whose window has passed, in one batch.
    const count = (key) => env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, first_at) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET fails = CASE WHEN ? - first_at < ? THEN fails + 1 ELSE 1 END,
         first_at = CASE WHEN ? - first_at < ? THEN first_at ELSE excluded.first_at END`,
    ).bind(key, now, now, FAIL_WINDOW_SEC, now, FAIL_WINDOW_SEC);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_attempts WHERE first_at < ?').bind(now - FAIL_WINDOW_SEC),
      count(ip),
      count('*'),
    ]);
    const total = live(all) ? all.fails + 1 : 1;
    if (total === MAX_FAILS_ALL) notify(`Sign-in closed for 15 minutes: ${MAX_FAILS_ALL} wrong passwords from all addresses together.`);
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: 'Wrong password.' }, 401);
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const exp = now + SESSION_DAYS * 86400;
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc(`session:${exp}`)));
  return json({ ok: true }, 200, {
    'set-cookie': `${COOKIE}=${exp}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure(request)}`,
  });
}

export function signOut(request) {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(request)}`,
    },
  });
}

// ── API keys for /ingest ─────────────────────────────────────────────────────

let keysReady = false;
async function ensureKeys(env) {
  if (keysReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT)`).run();
  keysReady = true;
}

export const sourceName = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

export async function listKeys(env) {
  await ensureKeys(env);
  return (await env.DB.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY id').all()).results || [];
}

// Returns the key itself once; only its hash is stored.
export async function createKey(env, name) {
  await ensureKeys(env);
  const n = sourceName(name);
  if (!n || n === 'manual') throw new Error('Give the key a name of letters, numbers or dashes (not "manual").');
  const taken = await env.DB.prepare('SELECT 1 FROM api_keys WHERE name = ?').bind(n).first();
  if (taken) throw new Error(`A key named "${n}" exists already. Revoke it first, or pick another name.`);
  const key = `tj_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  await env.DB.prepare('INSERT INTO api_keys (name, key_hash, prefix) VALUES (?, ?, ?)')
    .bind(n, hex(await sha256(key)), key.slice(0, 7)).run();
  return { name: n, key };
}

export async function revokeKey(env, id) {
  await ensureKeys(env);
  await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(Number(id)).run();
}

function presentedKey(request) {
  const m = /^Bearer\s+(\S+)$/i.exec((request.headers.get('authorization') || '').trim());
  if (m) return m[1];
  return (request.headers.get('x-api-key') || '').trim() || null;
}

// The source name for the key on the request, or null.
export async function ingestSource(request, env) {
  const got = presentedKey(request);
  if (!got || got.length < 24 || got.length > 200) return null;
  const gotHash = await sha256(got);

  // Worker secrets named INGEST_KEY_<NAME>, compared in constant time.
  let source = null;
  for (const [name, value] of Object.entries(env)) {
    const m = /^INGEST_KEY_([A-Z0-9_]+)$/.exec(name);
    if (!m || typeof value !== 'string' || value.length < 24) continue;
    if (crypto.subtle.timingSafeEqual(gotHash, await sha256(value))) source = sourceName(m[1]);
  }
  if (source) return source;

  // Keys made in Settings: looked up by hash, so timing reveals nothing useful.
  await ensureKeys(env);
  const row = await env.DB.prepare('SELECT id, name, last_used_at FROM api_keys WHERE key_hash = ?').bind(hex(gotHash)).first();
  if (!row) return null;
  // Record use at most once an hour, to keep writes down.
  if (!row.last_used_at || Date.now() - Date.parse(`${row.last_used_at}Z`) > 3600 * 1000) {
    await env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").bind(row.id).run();
  }
  return row.name;
}
