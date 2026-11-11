// End-to-end checks against a running local journal:
//   npx wrangler dev --port 8799      (with APP_PASSWORD in .dev.vars)
//   E2E_URL=http://localhost:8799 E2E_PASSWORD=... node test/e2e.mjs
// Uses generated data only. Run it against a local database, or a throwaway
// deploy, never a journal with real trades: it creates a key, sends a made-up
// day and tries a wrong password. A non-local address needs E2E_ALLOW_REMOTE=1.

import assert from 'node:assert/strict';

const BASE = process.env.E2E_URL || 'http://localhost:8799';
const PASSWORD = process.env.E2E_PASSWORD;
if (!PASSWORD) { console.error('Set E2E_PASSWORD to the APP_PASSWORD in .dev.vars'); process.exit(2); }
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env.E2E_ALLOW_REMOTE !== '1') {
  console.error('E2E_URL is not a local address. Set E2E_ALLOW_REMOTE=1 to run against a throwaway deploy.'); process.exit(2);
}

let cookie = '';
const call = async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined && !raw) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, set };
};
const step = async (name, fn) => { await fn(); console.log(`ok  ${name}`); };
const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;

await step('pages carry security headers', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
await step('locked before sign-in', async () => {
  assert.equal((await call('/api/sessions')).status, 401);
  assert.equal((await call('/api/config')).json.auth.signedIn, false);
});
await step('wrong password refused, cross-site sign-in refused', async () => {
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: 'wrong' }, headers: { 'cf-connecting-ip': ip } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { password: PASSWORD }, headers: { origin: 'https://other.example' } })).status, 403);
});
await step('sign in sets an HttpOnly, SameSite=Strict cookie', async () => {
  const r = await call('/api/auth/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.match(r.set, /HttpOnly/);
  assert.match(r.set, /SameSite=Strict/);
});
await step('form posts are refused', async () => {
  assert.equal((await call('/api/profile', { method: 'PATCH', raw: true, body: 'time_zone=UTC', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
});
await step('time zone setting', async () => {
  assert.equal((await call('/api/profile', { method: 'PATCH', body: { time_zone: 'Europe/London' } })).json.effective_time_zone, 'Europe/London');
  assert.equal((await call('/api/profile', { method: 'PATCH', body: { time_zone: 'Mars/Base' } })).status, 400);
});

const name = `e2e-${Date.now()}`;
let key;
await step('API key made, shown once, listed by prefix only', async () => {
  const r = await call('/api/keys', { method: 'POST', body: { name } });
  assert.equal(r.status, 201);
  key = r.json.key;
  assert.match(key, /^tj_[A-Za-z0-9_-]{43}$/);
  const list = (await call('/api/keys')).json;
  assert.ok(list.some((k) => k.name === name && key.startsWith(k.prefix)));
  assert.ok(!JSON.stringify(list).includes(key));
});

const agent = (path, opts = {}) => call(path, { ...opts, headers: { ...(opts.headers || {}), 'x-api-key': key } });
await step('ingest refuses no key and a wrong key', async () => {
  const saved = cookie; cookie = '';
  assert.equal((await call('/ingest/v1/ping')).status, 401);
  assert.equal((await call('/ingest/v1/ping', { headers: { 'x-api-key': 'tj_' + 'x'.repeat(43) } })).status, 401);
  cookie = saved;
});
await step('ingest stores a day, reading times in the journal zone', async () => {
  const saved = cookie; cookie = '';
  const r = await agent('/ingest/v1/day', { method: 'POST', body: {
    date: '2026-07-15', platform: 'e2e', raw_log: 'generated', fills: [
      { time: '2026-07-15 14:31:00', side: 'buy', qty: 2, price: 20000, instrument: 'MNQU6' },
      { time: '2026-07-15 14:40:00', side: 'sell', qty: 2, price: 20010, instrument: 'MNQU6' },
    ] } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.time_zone, 'Europe/London');
  assert.equal(r.json.fills[0].utc, '2026-07-15T13:31:00.000Z');
  assert.equal(r.json.fills[0].et, '2026-07-15 09:31:00');
  const help = await agent('/ingest/v1/help');
  assert.match(help.text, /Time zone: {2}Europe\/London/);
  cookie = saved;
});
await step('the day shows up as a position', async () => {
  const r = await call('/api/sessions?from=2026-07-15&to=2026-07-15');
  const p = r.json.positions.find((x) => x.platform === 'e2e');
  assert.ok(p);
  assert.equal(p.pnl, 40);
  assert.equal(p.size, 2);
});
await step('a revoked key stops working', async () => {
  const id = (await call('/api/keys')).json.find((k) => k.name === name).id;
  await call(`/api/keys/${id}`, { method: 'DELETE' });
  const saved = cookie; cookie = '';
  assert.equal((await agent('/ingest/v1/ping')).status, 401);
  cookie = saved;
});
await step('sign out clears the cookie', async () => {
  const r = await call('/api/auth/logout', { method: 'POST', body: {} });
  assert.match(r.set, /Max-Age=0/);
  cookie = '';
  assert.equal((await call('/api/sessions')).status, 401);
});
console.log('all end-to-end checks passed');
