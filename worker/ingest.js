// Ingest API — /ingest/v1/*: how agents, bots and scripts send trades.
//
// Each request carries an API key (see worker/auth.js). The key's name becomes
// the "source" every send is stored under, so two agents never overwrite each
// other's days.
//
// What arrives is kept verbatim (the original log text and the JSON sent) next
// to what was extracted from it, so a bad extraction can be fixed and re-sent
// rather than lost. Positions and statistics are worked out from these fills on
// read (worker/sessions.js); nothing here computes P&L.
//
// Times: a fill time with an offset ("...+05:30", "...Z") is taken as it is.
// Without one, it is read in the "time_zone" sent with the day, or else the
// journal's own time zone (Settings). Each fill keeps what was sent (ts_raw),
// the wall time in that zone (ts_local), the UTC instant (ts_utc) and the New
// York wall time (ts_et).

import { isZone, wallIn, parseTime } from './time.js';
import { ingestSource } from './auth.js';
import { journalZone } from './settings.js';
import guide from './ingest-guide.txt';

const MAX_BODY = 10 * 1024 * 1024;         // one request
const MAX_SHOT = 5 * 1024 * 1024;          // one decoded image
const MAX_SHOTS = 10;                      // images per POST /day
const MAX_FILLS = 2000;                    // fills per POST /day
const MAX_PARTS = 50;                      // parts a day can be split into
const FILL_CHUNK = 500;                    // fills per INSERT statement (D1 statement size)
const MAX_RAW_LOG = 900 * 1024;            // keeps a batch row well under D1's 2 MB cap

const out = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// A client error: reported to the sender as-is, never sent to the error webhook.
class Bad extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export async function handleIngest(request, env, ctx, url, notify, onStored) {
  try {
    // Authenticate before routing, so an unauthenticated caller learns nothing
    // about which paths exist.
    const source = await ingestSource(request, env);
    if (!source) {
      return out({ ok: false, error: 'unauthorized: send "Authorization: Bearer <key>" or "X-API-Key: <key>"' }, 401);
    }

    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    const method = request.method;

    if ((path === '/ingest/v1' || path === '/ingest/v1/help') && method === 'GET') {
      const zone = await journalZone(env);
      return new Response(guide.replaceAll('{{BASE_URL}}', `${url.origin}/ingest/v1`).replaceAll('{{TIME_ZONE}}', zone), {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (path === '/ingest/v1/ping' && method === 'GET') {
      const now = Date.now();
      const zone = await journalZone(env);
      return out({ ok: true, source, time_zone: zone, server_time_utc: new Date(now).toISOString(), server_time_local: wallIn(now, zone, false) });
    }
    if (path === '/ingest/v1/day' && method === 'POST') {
      const res = await postDay(request, env, source);
      // New fills mean bars to fetch; do it after answering.
      if (res.status === 201 && onStored) ctx.waitUntil(Promise.resolve().then(onStored).catch(() => {}));
      return res;
    }
    if (path === '/ingest/v1/day' && method === 'GET') return await getDay(env, source, url.searchParams);
    if (path === '/ingest/v1/days' && method === 'GET') return await listDays(env, source, url.searchParams);
    if (path === '/ingest/v1/screenshot' && method === 'POST') return await postScreenshot(request, env, source, url);

    return out({ ok: false, error: `no route ${method} ${url.pathname}. GET /ingest/v1/help for the contract.` }, 404);
  } catch (e) {
    if (e instanceof Bad) return out({ ok: false, error: e.message }, e.status);
    const msg = String((e && e.message) || e);
    ctx.waitUntil(notify(`Ingest error on ${request.method} ${url.pathname}: ${msg}`));
    return out({ ok: false, error: msg }, 500);
  }
}

const sha256 = (bytes) => crypto.subtle.digest('SHA-256', bytes);

// ---------------------------------------------------------------------------
// POST /ingest/v1/day
// ---------------------------------------------------------------------------

async function postDay(request, env, source) {
  return storeDay(await readJson(request), env, source);
}

// Stores one day's body under `source`. Also used by the page's own paste-in
// import (source 'manual'), which is signed in rather than keyed.
// The tables are created on first use, so a new database needs no setup step.
let tablesReady = false;
export async function ensureIngestTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingest_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      date_local TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      account TEXT,
      part INTEGER,
      time_zone TEXT,
      raw_log TEXT,
      payload TEXT NOT NULL,
      warnings TEXT,
      superseded_by INTEGER,
      received_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ingest_batches_day
      ON ingest_batches (source, date_local, platform, superseded_by)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
      trade_ref TEXT, instrument TEXT, direction TEXT, data TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ingest_trades_batch ON ingest_trades (batch_id)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingest_fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
      trade_ref TEXT, seq INTEGER NOT NULL,
      ts_raw TEXT, ts_local TEXT, ts_utc TEXT, ts_et TEXT,
      side TEXT, qty REAL, price REAL, instrument TEXT, extra TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ingest_fills_batch ON ingest_fills (batch_id, seq)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ingest_fills_time ON ingest_fills (ts_utc)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ingest_screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, date_local TEXT NOT NULL, trade_ref TEXT, batch_id INTEGER,
      r2_key TEXT NOT NULL, content_type TEXT, bytes INTEGER, sha256 TEXT NOT NULL, caption TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_screenshots_hash
      ON ingest_screenshots (source, date_local, sha256)`),
  ]);
  tablesReady = true;
}

export async function storeDay(body, env, source) {
  const warnings = [];
  await ensureIngestTables(env);

  // Parts: { "part": 2, "parts": 3 }. A part replaces an earlier send of the same
  // part number (and a whole-day send), never the other parts. A send without
  // `part` is the whole day and replaces every part.
  let part = null, parts = null;
  if (body.part != null) {
    part = Number(body.part);
    if (!Number.isInteger(part) || part < 1 || part > MAX_PARTS) throw new Bad(`"part" must be a whole number from 1 to ${MAX_PARTS}`);
    if (body.parts != null) {
      parts = Number(body.parts);
      if (!Number.isInteger(parts) || parts < part || parts > MAX_PARTS) throw new Bad(`"parts" must be a whole number from ${part} to ${MAX_PARTS}`);
    }
  } else if (body.parts != null) {
    throw new Bad('"parts" was sent without "part"; send "part" too, or neither for a whole day');
  }

  let date = body.date == null ? null : normDate(body.date);
  if (body.date != null && !date) throw new Bad(`"date" must be a date YYYY-MM-DD, got ${JSON.stringify(body.date)}`);

  // The zone for times sent without an offset.
  let zone;
  if (body.time_zone != null) {
    if (!isZone(body.time_zone)) throw new Bad(`"time_zone" must be an IANA time zone such as "Europe/London", got ${JSON.stringify(body.time_zone)}`);
    zone = body.time_zone;
  } else {
    zone = await journalZone(env);
  }
  const platform = clip(body.platform, 40)?.toLowerCase() || '';
  const account = clip(body.account, 80);

  // Trades, each with its fills. Fills sent at the top level have no grouping.
  const groups = [];
  if (body.trades != null && !Array.isArray(body.trades)) throw new Bad('"trades" must be an array');
  (body.trades || []).forEach((t, i) => {
    if (!t || typeof t !== 'object' || Array.isArray(t)) { warnings.push(`trades[${i}] is not an object, skipped`); return; }
    const { fills, ...rest } = t;
    const ref = clip(t.ref, 40) || `T${i + 1}`;
    if (fills != null && !Array.isArray(fills)) warnings.push(`${ref}: "fills" is not an array, ignored`);
    groups.push({ ref, trade: rest, fills: Array.isArray(fills) ? fills : [] });
  });
  if (body.fills != null && !Array.isArray(body.fills)) throw new Bad('"fills" must be an array');
  if (Array.isArray(body.fills) && body.fills.length) groups.push({ ref: null, trade: null, fills: body.fills });

  const fillCount = groups.reduce((n, g) => n + g.fills.length, 0);
  if (!fillCount && !(body.screenshots || []).length) throw new Bad('nothing to store: send "trades" with "fills", top-level "fills", or "screenshots"');
  if (fillCount > MAX_FILLS) throw new Bad(`at most ${MAX_FILLS} fills per request; split the day into parts ("part": 1, "parts": N)`, 413);

  const tradeRows = [];
  const fillRows = [];
  let seq = 0, timeOnly = 0;

  for (const g of groups) {
    if (g.trade) tradeRows.push({ ref: g.ref, instrument: clip(g.trade.instrument, 40), direction: clip(g.trade.direction, 20), data: g.trade });
    if (g.ref && !g.fills.length) warnings.push(`${g.ref}: no fills`);

    let net = 0, prevMs = null, outOfOrder = false;
    g.fills.forEach((f, k) => {
      const label = `${g.ref || 'fills'}[${k}]`;
      if (!f || typeof f !== 'object' || Array.isArray(f)) { warnings.push(`${label} is not an object, skipped`); return; }
      const { time, timestamp, ts, datetime, side, qty, quantity, contracts, price, fill_price, instrument, ...extra } = f;
      const rawTime = time ?? timestamp ?? ts ?? datetime;

      const t = parseTime(rawTime, date, zone);
      if (t.error) warnings.push(`${label}: ${t.error}`);
      else {
        if (t.timeOnly) timeOnly++;
        if (prevMs != null && t.utcMs < prevMs) outOfOrder = true;
        prevMs = t.utcMs;
      }

      let q = num(qty ?? quantity ?? contracts);
      let s = normSide(side);
      if (!s && q != null && q < 0) s = 'sell';
      if (q != null && q < 0) q = -q;
      if (!s) warnings.push(`${label}: side ${JSON.stringify(side ?? null)} is not buy/sell`);
      if (q == null || q === 0) warnings.push(`${label}: missing or zero qty`);
      const px = num(price ?? fill_price);
      if (px == null) warnings.push(`${label}: missing price`);
      if (s && q) net += s === 'buy' ? q : -q;

      fillRows.push({
        trade_ref: g.ref,
        seq: seq++,
        ts_raw: rawTime == null ? null : String(rawTime),
        ts_local: t.error ? null : wallIn(t.utcMs, zone, t.hadMs),
        ts_utc: t.error ? null : new Date(t.utcMs).toISOString(),
        ts_et: t.error ? null : wallIn(t.utcMs, 'America/New_York', t.hadMs),
        side: s,
        qty: q,
        price: px,
        instrument: clip(instrument ?? g.trade?.instrument, 40),
        extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        _ms: t.error ? null : t.utcMs,
      });
    });
    net = Math.round(net * 1e6) / 1e6;
    // In a multi-part send a trade can continue in the next part, so flatness is
    // checked for the whole day once every part is in (below).
    if (g.ref && net !== 0 && part == null) warnings.push(`${g.ref}: position not flat after its fills (net ${net > 0 ? '+' : ''}${net})`);
    if (outOfOrder) warnings.push(`${g.ref || 'fills'}: fill times are not in time order (kept as sent)`);
  }

  if (timeOnly) warnings.push(`${timeOnly} fill time(s) had no date, so ${date} was assumed. That is wrong for any fill after midnight in ${zone}; send full "YYYY-MM-DD HH:MM:SS".`);

  // No date given: use the local date of the earliest fill.
  if (!date) {
    const first = fillRows.filter((f) => f._ms != null).sort((a, b) => a._ms - b._ms)[0];
    if (!first) throw new Bad('"date" is required when no fill time can be parsed');
    date = first.ts_local.slice(0, 10);
    warnings.push(`no "date" sent; used ${date}, the ${zone} date of the earliest fill`);
  }

  let rawLog = body.raw_log ?? body.raw ?? body.log ?? null;
  if (rawLog != null && typeof rawLog !== 'string') rawLog = JSON.stringify(rawLog);
  if (rawLog && rawLog.length > MAX_RAW_LOG) {
    rawLog = rawLog.slice(0, MAX_RAW_LOG);
    warnings.push(`raw_log truncated to ${MAX_RAW_LOG} characters`);
  }
  if (!rawLog) warnings.push('no raw_log sent; include the original log text so a bad extraction can be re-parsed later');

  // Screenshots: a bad image is a warning, not a reason to drop the day's trades.
  const shotsIn = body.screenshots == null ? [] : body.screenshots;
  if (!Array.isArray(shotsIn)) throw new Bad('"screenshots" must be an array');
  if (shotsIn.length > MAX_SHOTS) throw new Bad(`at most ${MAX_SHOTS} screenshots per request; send the rest to POST /ingest/v1/screenshot`, 413);
  const shots = [];
  if (shotsIn.length && !env.IMG) {
    warnings.push(`${shotsIn.length} screenshot(s) not stored: screenshots are turned off on this journal (no R2 bucket is bound)`);
    shotsIn.length = 0;
  }
  shotsIn.forEach((s, i) => {
    try {
      if (!s || typeof s !== 'object') throw new Bad('not an object');
      const bytes = decodeB64(s.data_base64 ?? s.base64 ?? s.data);
      const kind = sniff(bytes);
      if (!kind) throw new Bad('not a PNG, JPEG, WEBP, GIF or HEIC image');
      shots.push({ bytes, kind, tradeRef: clip(s.trade_ref, 40), caption: clip(s.caption, 300) });
    } catch (e) {
      warnings.push(`screenshots[${i}]: ${e.message}, skipped`);
    }
  });

  const payload = {
    ...body,
    raw_log: undefined, raw: undefined, log: undefined,
    screenshots: shotsIn.map((s) => (s && typeof s === 'object'
      ? { ...s, data_base64: undefined, base64: undefined, data: undefined } : s)),
  };

  // Which current sends this one replaces: all of them for a whole day; for a
  // part, the same part number and any whole-day send.
  const replaces = part == null ? '' : 'AND (part = ? OR part IS NULL)';
  const replaceArgs = part == null ? [] : [part];
  const previous = (await env.DB.prepare(
    `SELECT id FROM ingest_batches WHERE source = ? AND date_local = ? AND platform = ? AND superseded_by IS NULL ${replaces}`,
  ).bind(source, date, platform, ...replaceArgs).all()).results.map((r) => r.id);

  const batch = await env.DB.prepare(
    `INSERT INTO ingest_batches (source, date_local, platform, account, raw_log, payload, warnings, part, time_zone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(source, date, platform, account, rawLog, JSON.stringify(payload), JSON.stringify(warnings), part, zone).first();
  const batchId = batch.id;

  const fresh = [];
  try {
    const shotRows = [];
    let duplicates = 0;
    const known = await knownShots(env, source, date);
    for (const s of shots) {
      const r = await putShot(env, source, date, s.bytes, s.kind, known);
      if (r.duplicate) { duplicates++; continue; }
      fresh.push(r.key);
      shotRows.push({ ...r, tradeRef: s.tradeRef, caption: s.caption });
    }
    if (duplicates) warnings.push(`${duplicates} screenshot(s) already stored for ${date}, not stored again`);

    // One D1 batch is one transaction: the supersede and every insert land
    // together or not at all.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE ingest_batches SET superseded_by = ?
         WHERE source = ? AND date_local = ? AND platform = ? AND superseded_by IS NULL AND id <> ? ${replaces}`,
      ).bind(batchId, source, date, platform, batchId, ...replaceArgs),
      // Trades and fills go in as JSON arrays (json_each), FILL_CHUNK rows per
      // statement, not one statement per row: the free plan caps a request at 50
      // queries and a batch counts each statement.
      ...(tradeRows.length ? [env.DB.prepare(
        `INSERT INTO ingest_trades (batch_id, trade_ref, instrument, direction, data)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]')
         FROM json_each(?)`,
      ).bind(batchId, JSON.stringify(tradeRows.map((t) => [t.ref, t.instrument, t.direction, JSON.stringify(t.data)])))] : []),
      ...chunks(fillRows, FILL_CHUNK).map((rows) => env.DB.prepare(
        `INSERT INTO ingest_fills (batch_id, trade_ref, seq, ts_raw, ts_local, ts_utc, ts_et, side, qty, price, instrument, extra)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
                json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),
                json_extract(value, '$[8]'), json_extract(value, '$[9]'), json_extract(value, '$[10]')
         FROM json_each(?)`,
      ).bind(batchId, JSON.stringify(rows.map((f) => [f.trade_ref, f.seq, f.ts_raw, f.ts_local, f.ts_utc, f.ts_et, f.side, f.qty, f.price, f.instrument, f.extra])))),
      ...shotRows.map((s) => shotInsert(env, source, date, s, batchId)),
      env.DB.prepare('UPDATE ingest_batches SET warnings = ? WHERE id = ?').bind(JSON.stringify(warnings), batchId),
    ]);

    // For a part: which parts are now in, and once all are, whether every
    // instrument nets back to flat across the whole day.
    let partInfo = {};
    if (part != null) {
      const cur = (await env.DB.prepare(
        `SELECT id, part FROM ingest_batches
         WHERE source = ? AND date_local = ? AND platform = ? AND superseded_by IS NULL AND part IS NOT NULL ORDER BY part`,
      ).bind(source, date, platform).all()).results || [];
      const received = cur.map((r) => r.part);
      const missing = parts ? Array.from({ length: parts }, (_, i) => i + 1).filter((n) => !received.includes(n)) : [];
      const complete = parts != null && !missing.length;
      if (complete) {
        const nets = (await env.DB.prepare(
          `SELECT instrument, SUM(CASE WHEN side = 'buy' THEN qty ELSE -qty END) AS net
           FROM ingest_fills WHERE batch_id IN (${cur.map(() => '?').join(',')}) GROUP BY instrument`,
        ).bind(...cur.map((r) => r.id)).all()).results || [];
        for (const n of nets) {
          const v = Math.round((n.net || 0) * 1e6) / 1e6;
          if (v !== 0) warnings.push(`all ${parts} parts are in, but ${n.instrument || 'an instrument'} is not flat for the day (net ${v > 0 ? '+' : ''}${v})`);
        }
        if (nets.length) await env.DB.prepare('UPDATE ingest_batches SET warnings = ? WHERE id = ?').bind(JSON.stringify(warnings), batchId).run();
      }
      partInfo = { part, parts, parts_received: received, parts_missing: missing, complete };
    }

    return out({
      ok: true,
      batch_id: batchId,
      source,
      date,
      time_zone: zone,
      platform,
      ...partInfo,
      superseded_batch_ids: previous,
      counts: {
        trades: tradeRows.length,
        fills: fillRows.length,
        screenshots_stored: shotRows.length,
        screenshots_duplicate: duplicates,
      },
      fills: fillRows.map((f) => ({
        trade_ref: f.trade_ref, seq: f.seq, sent: f.ts_raw,
        local: f.ts_local, utc: f.ts_utc, et: f.ts_et,
        side: f.side, qty: f.qty, price: f.price,
      })),
      warnings,
    }, 201);
  } catch (e) {
    // Undo what landed outside the transaction. Only images this request created
    // are removed: an image that was already stored for the day shares its key.
    if (env.IMG) await Promise.all(fresh.map((k) => env.IMG.delete(k).catch(() => {})));
    await env.DB.prepare('DELETE FROM ingest_batches WHERE id = ?').bind(batchId).run().catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GET /ingest/v1/day?date=YYYY-MM-DD[&raw=1]   and   GET /ingest/v1/days
// ---------------------------------------------------------------------------

async function getDay(env, source, q) {
  await ensureIngestTables(env);
  const date = normDate(q.get('date'));
  if (!date) throw new Bad('date=YYYY-MM-DD is required');
  const withRaw = q.get('raw') === '1';

  const batches = (await env.DB.prepare(
    `SELECT id, platform, account, part, time_zone, received_at, warnings, raw_log FROM ingest_batches
     WHERE source = ? AND date_local = ? AND superseded_by IS NULL ORDER BY platform, part, id`,
  ).bind(source, date).all()).results;
  const superseded = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ingest_batches WHERE source = ? AND date_local = ? AND superseded_by IS NOT NULL`,
  ).bind(source, date).first()).n;

  const ids = batches.map((b) => b.id);
  const marks = ids.map(() => '?').join(',');
  const trades = ids.length ? (await env.DB.prepare(
    `SELECT batch_id, trade_ref, data FROM ingest_trades WHERE batch_id IN (${marks}) ORDER BY id`,
  ).bind(...ids).all()).results : [];
  const fills = ids.length ? (await env.DB.prepare(
    `SELECT batch_id, trade_ref, seq, ts_raw, ts_local, ts_utc, ts_et, side, qty, price, instrument, extra
     FROM ingest_fills WHERE batch_id IN (${marks}) ORDER BY batch_id, seq`,
  ).bind(...ids).all()).results : [];
  const shots = (await env.DB.prepare(
    `SELECT trade_ref, r2_key, content_type, bytes, caption, received_at FROM ingest_screenshots
     WHERE source = ? AND date_local = ? ORDER BY id`,
  ).bind(source, date).all()).results;

  const fillOut = (f) => ({
    seq: f.seq, sent: f.ts_raw, local: f.ts_local, utc: f.ts_utc, et: f.ts_et,
    side: f.side, qty: f.qty, price: f.price, instrument: f.instrument,
    ...(f.extra ? { extra: JSON.parse(f.extra) } : {}),
  });

  return out({
    ok: true,
    source,
    date,
    superseded_versions: superseded,
    batches: batches.map((b) => ({
      batch_id: b.id,
      platform: b.platform,
      account: b.account,
      part: b.part,
      time_zone: b.time_zone,
      received_at_utc: b.received_at,
      warnings: JSON.parse(b.warnings || '[]'),
      raw_log_chars: b.raw_log ? b.raw_log.length : 0,
      ...(withRaw ? { raw_log: b.raw_log } : {}),
      trades: trades.filter((t) => t.batch_id === b.id).map((t) => ({
        ...JSON.parse(t.data),
        ref: t.trade_ref,
        fills: fills.filter((f) => f.batch_id === b.id && f.trade_ref === t.trade_ref).map(fillOut),
      })),
      ungrouped_fills: fills.filter((f) => f.batch_id === b.id && f.trade_ref == null).map(fillOut),
    })),
    screenshots: shots,
  });
}

async function listDays(env, source, q) {
  await ensureIngestTables(env);
  const limit = Math.min(Math.max(parseInt(q.get('limit') || '30', 10) || 30, 1), 365);
  const rows = (await env.DB.prepare(
    `SELECT b.date_local, b.platform, b.part, b.id AS batch_id, b.received_at,
       (SELECT COUNT(*) FROM ingest_trades t WHERE t.batch_id = b.id) AS trades,
       (SELECT COUNT(*) FROM ingest_fills f WHERE f.batch_id = b.id) AS fills
     FROM ingest_batches b WHERE b.source = ? AND b.superseded_by IS NULL
     ORDER BY b.date_local DESC, b.id DESC LIMIT ?`,
  ).bind(source, limit).all()).results;
  const shots = (await env.DB.prepare(
    `SELECT date_local, COUNT(*) AS n FROM ingest_screenshots WHERE source = ? GROUP BY date_local`,
  ).bind(source).all()).results;
  const shotsByDay = Object.fromEntries(shots.map((s) => [s.date_local, s.n]));
  return out({
    ok: true,
    source,
    days: rows.map((r) => ({ date: r.date_local, platform: r.platform, part: r.part, batch_id: r.batch_id, trades: r.trades, fills: r.fills, received_at_utc: r.received_at, screenshots: shotsByDay[r.date_local] || 0 })),
  });
}

// ---------------------------------------------------------------------------
// POST /ingest/v1/screenshot?date=YYYY-MM-DD[&trade_ref=T1][&caption=...]
// Body: raw image bytes, multipart/form-data with a "file" field, or JSON with
// data_base64 — whichever the bot can produce.
// ---------------------------------------------------------------------------

async function postScreenshot(request, env, source, url) {
  await ensureIngestTables(env);
  if (!env.IMG) throw new Bad('screenshots are turned off on this journal (no R2 bucket is bound)', 501);
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  const qp = url.searchParams;
  let date = qp.get('date'), tradeRef = qp.get('trade_ref'), caption = qp.get('caption'), bytes;

  if (ct.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file') || form.get('image') || form.get('screenshot');
    if (!file || typeof file === 'string') throw new Bad('multipart body needs a "file" field holding the image');
    bytes = new Uint8Array(await file.arrayBuffer());
    date = date || form.get('date');
    tradeRef = tradeRef || form.get('trade_ref');
    caption = caption || form.get('caption');
  } else if (ct.includes('application/json')) {
    const b = await readJson(request);
    date = date || b.date;
    tradeRef = tradeRef || b.trade_ref;
    caption = caption || b.caption;
    bytes = decodeB64(b.data_base64 ?? b.base64 ?? b.data);
  } else {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_SHOT) throw new Bad(`image larger than ${MAX_SHOT} bytes`, 413);
    bytes = new Uint8Array(await request.arrayBuffer());
  }

  date = normDate(date);
  if (!date) throw new Bad('date=YYYY-MM-DD (the trading day) is required');
  if (!bytes || !bytes.length) throw new Bad('empty image');
  if (bytes.length > MAX_SHOT) throw new Bad(`image larger than ${MAX_SHOT} bytes`, 413);
  const kind = sniff(bytes);
  if (!kind) throw new Bad('not a PNG, JPEG, WEBP, GIF or HEIC image');

  const current = await env.DB.prepare(
    `SELECT id FROM ingest_batches WHERE source = ? AND date_local = ? AND superseded_by IS NULL ORDER BY id DESC LIMIT 1`,
  ).bind(source, date).first();
  const r = await putShot(env, source, date, bytes, kind, await knownShots(env, source, date));
  if (!r.duplicate) {
    await shotInsert(env, source, date, { ...r, tradeRef: clip(tradeRef, 40), caption: clip(caption, 300) }, current ? current.id : null).run();
  }
  return out({
    ok: true, source, date, duplicate: r.duplicate,
    r2_key: r.key, bytes: bytes.length, content_type: kind.type,
  }, r.duplicate ? 200 : 201);
}

// ---------------------------------------------------------------------------
// Screenshot storage — content-addressed, so a repeat send is a no-op.
// ---------------------------------------------------------------------------

async function knownShots(env, source, date) {
  const rows = (await env.DB.prepare(
    'SELECT sha256 FROM ingest_screenshots WHERE source = ? AND date_local = ?',
  ).bind(source, date).all()).results;
  return new Set(rows.map((r) => r.sha256));
}

async function putShot(env, source, date, bytes, kind, known) {
  const sha = [...new Uint8Array(await sha256(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = `ingest/${source}/${date}/${sha.slice(0, 24)}.${kind.ext}`;
  if (known.has(sha)) return { duplicate: true, key, sha };
  known.add(sha);
  await env.IMG.put(key, bytes, { httpMetadata: { contentType: kind.type } });
  return { duplicate: false, key, sha, type: kind.type, bytes: bytes.length };
}

function shotInsert(env, source, date, s, batchId) {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO ingest_screenshots
       (source, date_local, trade_ref, batch_id, r2_key, content_type, bytes, sha256, caption)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(source, date, s.tradeRef || null, batchId, s.key, s.type, s.bytes, s.sha, s.caption || null);
}

// PNG, JPEG, GIF, WEBP or HEIC, judged by the file's first bytes, not its name.
export function sniff(b) {
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 6 && ascii(0, 4) === 'GIF8') return { type: 'image/gif', ext: 'gif' };
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (b.length > 12 && ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(8, 12))) return { type: 'image/heic', ext: 'heic' };
  return null;
}

function decodeB64(v) {
  if (typeof v !== 'string' || !v.trim()) throw new Bad('data_base64 is missing');
  let s = v.trim();
  if (s.startsWith('data:') && s.includes(',')) s = s.slice(s.indexOf(',') + 1);
  s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length > Math.ceil((MAX_SHOT * 4) / 3) + 8) throw new Bad(`image larger than ${MAX_SHOT} bytes`, 413);
  let bin;
  try { bin = atob(s); } catch { throw new Bad('data_base64 is not valid base64'); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Time: local wall time in, local + UTC + New York out
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new Bad(`request larger than ${MAX_BODY} bytes`, 413);
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Bad(`request larger than ${MAX_BODY} bytes`, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Bad(`body is not valid JSON: ${e.message}`); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Bad('body must be a JSON object');
  return body;
}

function normDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3] ? m[0] : null;
}

function normSide(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['buy', 'b', 'bought', 'bot'].includes(s)) return 'buy';
  if (['sell', 's', 'sold', 'sld'].includes(s)) return 'sell';
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[$,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const f = Number(s);
  return Number.isFinite(f) ? (neg ? -f : f) : null;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function clip(v, n) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, n) : null;
}
