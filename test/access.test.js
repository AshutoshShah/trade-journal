import test from 'node:test';
import assert from 'node:assert/strict';
import { allowed, authStatus } from '../worker/auth.js';

// A stand-in for Cloudflare Access: our own key pair, served as the team's certs.
const TEAM = 'example-team.cloudflareaccess.com';
const AUD = 'aud-tag-for-tests';
const enc = (s) => new TextEncoder().encode(s);
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-key', alg: 'RS256' };
const other = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);

globalThis.fetch = async (url) => {
  assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
};

async function token(claims, key = pair.privateKey, kid = 'test-key') {
  const h = b64url(enc(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
  const p = b64url(enc(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => ({ aud: [AUD], email: 'trader@example.com', iss: `https://${TEAM}`, exp: now() + 600, iat: now() });
const req = (t) => new Request('https://journal.example.com/api/sessions', t ? { headers: { 'cf-access-jwt-assertion': t } } : {});
const env = { AUTH: 'access', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

test('a valid Access token is let through', async () => {
  assert.equal(await allowed(req(await token(good())), env), true);
});

test('no token, a wrong audience, an expired token or a foreign key are refused', async () => {
  assert.equal(await allowed(req(), env), false);
  assert.equal(await allowed(req(await token({ ...good(), aud: ['someone-else'] })), env), false);
  assert.equal(await allowed(req(await token({ ...good(), exp: now() - 5 })), env), false);
  assert.equal(await allowed(req(await token(good(), other.privateKey)), env), false);
  assert.equal(await allowed(req('not.a.token'), env), false);
});

test('access mode without its settings stays locked', async () => {
  const t = await token(good());
  assert.equal(await allowed(req(t), { AUTH: 'access' }), false);
  assert.deepEqual(await authStatus(req(t), { AUTH: 'access' }), { mode: 'access', configured: false, signedIn: false });
  assert.equal(await allowed(req(t), { ...env, ACCESS_TEAM_DOMAIN: 'evil.example.com' }), false);
});

test('password mode without a password lets nothing through', async () => {
  assert.equal(await allowed(req(), {}), false);
  assert.deepEqual(await authStatus(req(), {}), { mode: 'password', configured: false, problem: 'missing', signedIn: false });
});

test('a short or example password turns sign-in off', async () => {
  for (const APP_PASSWORD of ['short-pass', 'change-me-to-a-long-password']) {
    const s = await authStatus(req(), { APP_PASSWORD });
    assert.equal(s.configured, false);
    assert.equal(s.problem, 'weak');
  }
  assert.equal((await authStatus(req(), { APP_PASSWORD: 'a-perfectly-long-password' })).configured, true);
});

test('an Access token without an issuer is refused', async () => {
  const { iss, ...noIss } = good();
  assert.equal(await allowed(req(await token(noIss)), env), false);
});
