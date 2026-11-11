// The journal's settings and profile: one JSON row in `profiles`. Holds the
// time zone, commissions, the "How I trade" text and its numbers, and the
// labels offered for positions.

import { isZone } from './time.js';

let ready = false;

export async function ensureProfileTable(env) {
  if (ready) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL)').run();
  ready = true;
}

export async function getProfile(env) {
  await ensureProfileTable(env);
  const row = await env.DB.prepare("SELECT data FROM profiles WHERE id = 'me'").first();
  return row ? JSON.parse(row.data) : {};
}

export async function saveProfile(env, patch) {
  const next = { ...(await getProfile(env)), ...patch };
  if (next.time_zone != null && !isZone(next.time_zone)) throw new Error(`unknown time zone ${JSON.stringify(next.time_zone)}`);
  await env.DB.prepare(
    `INSERT INTO profiles (id, data) VALUES ('me', ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
  ).bind(JSON.stringify(next)).run();
  return next;
}

// The time zone fills are read in when a send gives no offset and names no
// zone: the one saved in Settings, else the TIME_ZONE variable, else UTC.
export async function journalZone(env) {
  const p = await getProfile(env);
  if (isZone(p.time_zone)) return p.time_zone;
  if (isZone(env.TIME_ZONE)) return env.TIME_ZONE;
  return 'UTC';
}
