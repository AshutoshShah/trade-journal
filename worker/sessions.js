// Sessions: positions built from the stored fills (/api/sessions*).
//
// The raw fills that /ingest/v1 collects (or the page's paste-in import) are
// grouped flat-to-flat into positions, the unit for a scale-in/scale-out style:
// thirteen 2-lot round trips on a platform's report can be six positions here.
//
// Everything is computed on read from ingest_fills. Nothing is written back to
// the ingest tables; the only stored state is an optional label, note and
// review mark per position (session_tags), notes per day (session_days), and
// one-minute bars (session_bars) for charts and excursions.

import { etParts } from './time.js';
import { MULT, BAR_ROOT, rootOf, r2, groupFills, excursion, AFTER_SEC } from './positions.js';
import { storeDay, ensureIngestTables } from './ingest.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const REENTRY_MS = 5 * 60 * 1000;      // a new position this soon after a losing one...
const REENTRY_PTS = 40;                // ...this close to its exit, same side, is a re-entry
const MAX_BARS = 20000;                // rows per upload

const pad = (n) => String(n).padStart(2, '0');

// The trading day a fill belongs to, as an ET date: 18:00 ET starts the next day.
function sessionDate(ms) {
  const e = etParts(new Date(ms));
  if (e.hour < 18) return `${e.year}-${pad(e.month)}-${pad(e.day)}`;
  const n = new Date(Date.UTC(e.year, e.month - 1, e.day + 1));
  return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`;
}

function windowOf(ms) {
  const e = etParts(new Date(ms));
  const m = e.hour * 60 + e.minute;
  if (m >= 18 * 60 || m < 4 * 60) return 'Overnight';
  if (m < 9 * 60 + 30) return 'Premarket';
  if (m < 10 * 60) return 'First 30 min';
  if (m < 12 * 60) return 'Morning';
  return 'Afternoon';
}

// The free plan allows 50 database queries per request, and every statement in
// a batch counts as one. So bulk work goes through single statements that take
// a JSON array (json_each), and the table check runs once per Worker instance.
let tablesReady = false;

async function ensureTables(env) {
  if (tablesReady) return;
  await ensureIngestTables(env);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS session_tags (
      pos_key TEXT PRIMARY KEY, setup TEXT, note TEXT, review INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS session_bars (
      root TEXT NOT NULL, ts INTEGER NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      PRIMARY KEY (root, ts)) WITHOUT ROWID`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS session_bar_cover (
      root TEXT NOT NULL, date TEXT NOT NULL,
      tgt_from INTEGER NOT NULL, tgt_to INTEGER NOT NULL,
      req_from INTEGER NOT NULL, req_to INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL, rows INTEGER NOT NULL, last_bar INTEGER, note TEXT,
      PRIMARY KEY (root, date)) WITHOUT ROWID`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS session_days (
      date TEXT PRIMARY KEY, data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  ]);
  // session_tags gained `review` (a position marked for a second look) after it
  // first shipped; tables made before that get the column added once.
  const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('session_tags')").all()).results || [];
  if (!cols.some((c) => c.name === 'review')) await env.DB.prepare('ALTER TABLE session_tags ADD COLUMN review INTEGER').run();
  tablesReady = true;
}

// Insert many bars, 1,500 rows per statement (about 70 KB of JSON, well under
// D1's statement size limit). `overwrite` is for a chart export the user
// uploaded; fetched bars never replace what is already stored.
const BAR_CHUNK = 1500;

async function insertBars(env, root, bars, overwrite) {
  const tail = overwrite
    ? 'DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close'
    : 'DO NOTHING';
  for (let i = 0; i < bars.length; i += BAR_CHUNK) {
    await env.DB.prepare(
      `INSERT INTO session_bars (root, ts, open, high, low, close)
       SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
              json_extract(value, '$[3]'), json_extract(value, '$[4]')
       FROM json_each(?) WHERE true
       ON CONFLICT(root, ts) ${tail}`,
    ).bind(root, JSON.stringify(bars.slice(i, i + BAR_CHUNK))).run();
  }
}

async function loadPositions(env, from, to) {
  // Fills from the current (not superseded) batch of each day, any source.
  // The date filter is on the date as sent, widened a day each side because a
  // US session can straddle midnight in the sender's time zone; the exact cut
  // is on the New York session date.
  const where = ['b.superseded_by IS NULL', 'f.ts_utc IS NOT NULL'];
  const args = [];
  if (from) { where.push("b.date_local >= date(?, '-1 day')"); args.push(from); }
  if (to) { where.push("b.date_local <= date(?, '+1 day')"); args.push(to); }
  const rows = (await env.DB.prepare(
    `SELECT f.ts_utc, f.side, f.qty, f.price, f.instrument, f.seq, f.batch_id,
            b.platform, b.account, b.source, b.date_local
     FROM ingest_fills f JOIN ingest_batches b ON b.id = f.batch_id
     WHERE ${where.join(' AND ')}
     ORDER BY f.ts_utc, f.batch_id, f.seq`,
  ).bind(...args).all()).results || [];

  // The same day can arrive twice: from the bot and from a paste, or under two
  // platform names. When two batches for one date share most of their fills,
  // only the later one counts.
  const batches = new Map();
  for (const r of rows) {
    if (!batches.has(r.batch_id)) batches.set(r.batch_id, { id: r.batch_id, date: r.date_local, prints: new Set() });
    batches.get(r.batch_id).prints.add(`${r.ts_utc}|${r.side}|${r.price}|${rootOf(r.instrument)}`);
  }
  const dropped = new Set();
  const list = [...batches.values()].sort((a, b) => a.id - b.id);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.date !== b.date || dropped.has(a.id)) continue;
      let shared = 0;
      for (const x of a.prints) if (b.prints.has(x)) shared++;
      if (shared >= 0.6 * Math.min(a.prints.size, b.prints.size)) dropped.add(a.id);
    }
  }

  const streams = new Map();
  for (const r of rows) {
    if (dropped.has(r.batch_id)) continue;
    const root = rootOf(r.instrument);
    if (!root) continue;
    const key = `${r.platform || ''}|${r.account || ''}|${r.instrument}`;
    if (!streams.has(key)) streams.set(key, { platform: r.platform || '', account: r.account || '', instrument: r.instrument, root, fills: [] });
    streams.get(key).fills.push({ ms: Date.parse(r.ts_utc), side: r.side, qty: r.qty, price: r.price, batch: r.batch_id });
  }

  const out = [];
  for (const [key, s] of streams) {
    for (const g of groupFills(s.fills)) {
      const entry = g.inCost / g.inQty;
      const closed = Math.min(g.inQty, g.outQty);
      const exit = g.outQty ? g.outCost / g.outQty : null;
      const points = exit == null ? null : (exit - entry) * g.dir;
      out.push({
        key: `${key}|${g.t0}`,
        date: sessionDate(g.t0),
        platform: s.platform, account: s.account, instrument: s.instrument, root: s.root,
        side: g.dir === 1 ? 'long' : 'short',
        t0: g.t0, t1: g.t1, hold_sec: Math.round((g.t1 - g.t0) / 1000),
        window: windowOf(g.t0),
        size: g.peak, clips_in: g.clipsIn, clips_out: g.clipsOut,
        entry: r2(entry), exit: exit == null ? null : r2(exit),
        points: points == null ? null : r2(points),
        pnl: points == null ? null : r2(points * closed * MULT[s.root]),
        open: !!g.open,
        batch_id: g.batch,
        fills: g.fills,
      });
    }
  }
  out.sort((a, b) => a.t0 - b.t0);

  // Position number within the day, and re-entries: same side, soon after a
  // losing position on the same instrument, close to where that one got out.
  const lastByDay = new Map();
  const n = new Map();
  for (const p of out) {
    n.set(p.date, (n.get(p.date) || 0) + 1);
    p.n = n.get(p.date);
    const k = `${p.date}|${p.account}|${p.instrument}`;
    const prev = lastByDay.get(k);
    p.reentry = !!(prev && prev.pnl != null && prev.pnl < 0 && prev.side === p.side
      && p.t0 - prev.t1 <= REENTRY_MS && Math.abs(p.entry - prev.exit) <= REENTRY_PTS);
    lastByDay.set(k, p);
  }
  return out.filter((p) => (!from || p.date >= from) && (!to || p.date <= to));
}

async function addExcursions(env, positions) {
  const todo = positions.filter((p) => !p.open);
  if (!todo.length) return;
  const wins = todo.map((p) => [BAR_ROOT[p.root], Math.floor(p.t0 / 60000) * 60, Math.floor(p.t1 / 60000) * 60 + AFTER_SEC])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const merged = [];
  for (const w of wins) {
    const m = merged[merged.length - 1];
    if (m && m[0] === w[0] && w[1] <= m[2] + 60) m[2] = Math.max(m[2], w[2]);
    else merged.push([...w]);
  }
  const series = new Map();
  for (let i = 0; i < merged.length; i += 200) {
    const rows = (await env.DB.prepare(
      `SELECT b.root, b.ts, b.high, b.low, b.open, b.close
       FROM json_each(?) AS w
       JOIN session_bars b ON b.root = json_extract(w.value, '$[0]')
        AND b.ts >= json_extract(w.value, '$[1]') AND b.ts <= json_extract(w.value, '$[2]')`,
    ).bind(JSON.stringify(merged.slice(i, i + 200))).all()).results || [];
    for (const r of rows) {
      if (!series.has(r.root)) series.set(r.root, new Map());
      series.get(r.root).set(r.ts, [r.high, r.low, r.open, r.close]);
    }
  }
  for (const p of todo) excursion(p, series.get(BAR_ROOT[p.root]));
}

// ── Bars from Yahoo Finance ──────────────────────────────────────────────────
// Yahoo serves one-minute bars for the front-month future (NQ=F, ES=F) for about
// the last 30 days, free and without a key. It is an unofficial endpoint: it can
// refuse or change without notice, so every failure here is recorded and
// retried later, never shown as an error on the page. Bars uploaded from a chart
// export are never overwritten by these.
//
// There is no cron (the account's free cron slots are taken), so the work runs
// whenever the journal is read and whenever a bot sends fills. Each trading day
// with fills has a target window: four hours before its first fill to four
// hours after its last. session_bar_cover remembers what was fetched for it, and
// a day is fetched again when:
//   - it was never fetched (a missed day is backfilled),
//   - its target grew (new fills, or a day fetched with a narrower window),
//   - the last fetch failed (retried after 30 minutes), or
//   - the window is still running (refreshed every 10 minutes, from the last
//     stored bar onwards, so a live session keeps filling in).
// A day is done once a fetch made after its window closed came back clean.
const YAHOO = { NQ: 'NQ=F', ES: 'ES=F' };
const AROUND_SEC = 4 * 3600;
const MAX_AGE_SEC = 29 * 86400;
const RETRY_FAILED_SEC = 30 * 60;
const REFRESH_OPEN_SEC = 10 * 60;
const SETTLE_SEC = 10 * 60;            // a window is final this long after it closes
const FETCHES_PER_RUN = 3;
let lastBarCheck = 0;                  // per Worker instance; spares a query on rapid reloads

async function fetchYahooBars(root, fromSec, toSec) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[root])}`
    + `?interval=1m&period1=${fromSec}&period2=${toSec}&includePrePost=true`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo answered ${res.status}`);
  const body = await res.json();
  const r = body && body.chart && body.chart.result && body.chart.result[0];
  if (!r) throw new Error((body && body.chart && body.chart.error && body.chart.error.description) || 'Yahoo returned no data');
  if (!r.timestamp) return [];                    // a closed market (weekend, holiday) has no bars
  const q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((ts, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v))) bars.push([ts - (ts % 60), o, h, l, c]);
  });
  return bars;
}

// The trading days of the last month that have fills, each with the window of
// bars it should have. One query: current batches joined to their fills.
async function barTargets(env, now) {
  const since = new Date((now - MAX_AGE_SEC - 2 * 86400) * 1000).toISOString().slice(0, 10);
  const rows = (await env.DB.prepare(
    `SELECT f.instrument, MIN(f.ts_utc) AS a, MAX(f.ts_utc) AS b
     FROM ingest_fills f JOIN ingest_batches b ON b.id = f.batch_id
     WHERE b.superseded_by IS NULL AND b.date_local >= ? AND f.ts_utc IS NOT NULL
     GROUP BY f.batch_id, f.instrument`,
  ).bind(since).all()).results || [];
  const targets = new Map();
  for (const r of rows) {
    const root = BAR_ROOT[rootOf(r.instrument)];
    if (!YAHOO[root]) continue;
    const a = Math.floor(Date.parse(r.a) / 1000), b = Math.ceil(Date.parse(r.b) / 1000);
    if (now - b > MAX_AGE_SEC) continue;
    const key = `${root}|${sessionDate(a * 1000)}`;
    const t = targets.get(key) || { root, date: sessionDate(a * 1000), first: a, last: b };
    t.first = Math.min(t.first, a); t.last = Math.max(t.last, b);
    targets.set(key, t);
  }
  for (const t of targets.values()) {
    t.from = t.first - AROUND_SEC - (t.first % 60);
    t.to = t.last + AROUND_SEC - (t.last % 60);
  }
  return [...targets.values()];
}

// Fetches what is missing for up to FETCHES_PER_RUN days. Returns a summary for
// the page, or null when there was nothing to do.
export async function ensureBars(env, { force = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && now - lastBarCheck < 60) return null;
  lastBarCheck = now;
  await ensureTables(env);
  const targets = await barTargets(env, now);
  if (!targets.length) return null;

  const cover = new Map(((await env.DB.prepare(
    'SELECT root, date, tgt_from, tgt_to, req_from, req_to, fetched_at, last_bar, note FROM session_bar_cover WHERE date >= ?',
  ).bind(targets.reduce((m, t) => (t.date < m ? t.date : m), '9999')).all()).results || []).map((c) => [`${c.root}|${c.date}`, c]));

  const due = [];
  for (const t of targets) {
    const c = cover.get(`${t.root}|${t.date}`);
    const open = now < t.to + SETTLE_SEC;
    if (!c) { due.push({ t, c, rank: 0 }); continue; }
    const grew = c.tgt_from > t.from || c.tgt_to < t.to;
    const done = !c.note && !grew && c.req_from <= t.from && c.req_to >= t.to && c.fetched_at >= t.to + SETTLE_SEC;
    if (done) continue;
    if (grew && now - c.fetched_at >= 60) due.push({ t, c, rank: 1 });
    else if (c.note && now - c.fetched_at >= RETRY_FAILED_SEC) due.push({ t, c, rank: 2 });
    else if (!c.note && (open ? now - c.fetched_at >= REFRESH_OPEN_SEC : true)) due.push({ t, c, rank: 3 });
  }
  if (!due.length) return null;
  due.sort((x, y) => x.rank - y.rank || (y.t.date > x.t.date ? 1 : -1));

  const out = { days: 0, rows: 0, error: null };
  for (const { t, c } of due.slice(0, FETCHES_PER_RUN)) {
    // A live day continues from its last stored bar; anything else gets its
    // whole window. The forming minute is left out until it has closed.
    const grew = c && (c.tgt_from > t.from || c.tgt_to < t.to);
    const resume = c && !c.note && !grew && c.req_from <= t.from && c.last_bar;
    const from = resume ? Math.max(t.from, c.last_bar - 10 * 60) : t.from;
    const to = Math.min(now, t.to);
    let rows = 0, note = null, lastBar = c ? c.last_bar : null;
    try {
      const bars = (await fetchYahooBars(t.root, from, to)).filter((b) => b[0] + 60 <= now);
      if (bars.length) {
        await insertBars(env, t.root, bars, false);
        lastBar = Math.max(lastBar || 0, bars[bars.length - 1][0]);
      }
      rows = bars.length;
    } catch (e) { note = String((e && e.message) || e).slice(0, 200); out.error = note; }
    await env.DB.prepare(
      `INSERT INTO session_bar_cover (root, date, tgt_from, tgt_to, req_from, req_to, fetched_at, rows, last_bar, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root, date) DO UPDATE SET tgt_from = excluded.tgt_from, tgt_to = excluded.tgt_to,
         req_from = excluded.req_from, req_to = excluded.req_to, fetched_at = excluded.fetched_at,
         rows = excluded.rows, last_bar = excluded.last_bar, note = excluded.note`,
    ).bind(t.root, t.date, t.from, t.to, resume ? c.req_from : from, to, now, rows, lastBar, note).run();
    out.days++; out.rows += rows;
  }
  return out;
}

// TradingView's chart export: time,open,high,low,close[,...] with `time` in
// unix seconds (or ISO). Any other columns are ignored.
function parseBarsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error('the file has no rows');
  const head = lines[0].toLowerCase().split(',').map((s) => s.trim());
  const col = (name) => head.indexOf(name);
  const [ti, oi, hi, li, ci] = ['time', 'open', 'high', 'low', 'close'].map(col);
  if ([ti, oi, hi, li, ci].some((i) => i < 0)) throw new Error('expected columns time, open, high, low, close');
  const bars = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const raw = c[ti].trim();
    const ts = /^\d+$/.test(raw) ? (raw.length > 11 ? Math.floor(+raw / 1000) : +raw) : Math.floor(Date.parse(raw) / 1000);
    const [o, h, l, cl] = [oi, hi, li, ci].map((i) => parseFloat(c[i]));
    if (!Number.isFinite(ts) || ![o, h, l, cl].every(Number.isFinite)) continue;
    bars.push([ts - (ts % 60), o, h, l, cl]);
  }
  if (!bars.length) throw new Error('no readable rows');
  if (bars.length > MAX_BARS) throw new Error(`at most ${MAX_BARS} rows per upload`);
  return bars;
}

export async function handleSessions(request, env, url) {
  const p = url.pathname;
  const method = request.method;
  const q = url.searchParams;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

  if (p === '/api/sessions' && method === 'GET') {
    await ensureTables(env);
    const from = isDate(q.get('from')) ? q.get('from') : null;
    const to = isDate(q.get('to')) ? q.get('to') : null;
    const positions = await loadPositions(env, from, to);
    let pulled = null;
    try { pulled = await ensureBars(env); } catch (e) { pulled = { days: 0, rows: 0, error: String((e && e.message) || e).slice(0, 200) }; }
    await addExcursions(env, positions);
    const tags = (await env.DB.prepare('SELECT pos_key, setup, note, review FROM session_tags').all()).results || [];
    const byKey = new Map(tags.map((t) => [t.pos_key, t]));
    for (const pos of positions) {
      const t = byKey.get(pos.key);
      pos.setup = (t && t.setup) || '';
      pos.note = (t && t.note) || '';
      pos.review = !!(t && t.review);
    }
    // Two index lookups, not a scan: this runs on every page load and refresh.
    const span = await env.DB.prepare(
      `SELECT 'NQ' AS root, (SELECT MIN(ts) FROM session_bars WHERE root = 'NQ') AS t0, (SELECT MAX(ts) FROM session_bars WHERE root = 'NQ') AS t1`,
    ).first();
    return json({ positions, bars: span && span.t1 != null ? [span] : [], pulled });
  }

  // Free-text notes for one trading day: what was marked beforehand and how it
  // went. Deliberately unstructured.
  if (p === '/api/sessions/day') {
    await ensureTables(env);
    const date = q.get('date');
    if (!isDate(date)) return json({ error: 'date=YYYY-MM-DD is required' }, 400);
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT data FROM session_days WHERE date = ?').bind(date).first();
      return json({ date, plan: '', review: '', ...(row ? JSON.parse(row.data) : {}) });
    }
    if (method === 'PUT') {
      const b = await request.json();
      const data = { plan: String(b.plan || '').slice(0, 8000), review: String(b.review || '').slice(0, 8000) };
      if (!data.plan && !data.review) {
        await env.DB.prepare('DELETE FROM session_days WHERE date = ?').bind(date).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO session_days (date, data) VALUES (?, ?)
           ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
        ).bind(date, JSON.stringify(data)).run();
      }
      return json({ date, ...data });
    }
  }

  // Remove a day's fills from the journal. The batches stay in the table for
  // audit (superseded_by = 0 marks them removed); they just stop counting.
  if (p === '/api/sessions/fills' && method === 'DELETE') {
    const date = q.get('date');
    if (!isDate(date)) return json({ error: 'date=YYYY-MM-DD (the ET trading day) is required' }, 400);
    const positions = await loadPositions(env, date, date);
    const ids = [...new Set(positions.flatMap((x) => x.fills.map((f) => f.batch)))].filter((x) => x != null);
    if (ids.length) {
      await env.DB.prepare(
        `UPDATE ingest_batches SET superseded_by = 0 WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).bind(...ids).run();
    }
    return json({ ok: true, date, batches_removed: ids.length });
  }

  // Paste-in import: the page parses the platform's trade table into fills and
  // sends them here in the /ingest/v1/day shape. Stored as source 'manual'.
  if (p === '/api/sessions/import' && method === 'POST') {
    try {
      return await storeDay(await request.json(), env, 'manual');
    } catch (e) {
      if (e && e.status && e.status < 500) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }

  if (p === '/api/sessions/tag' && method === 'PUT') {
    await ensureTables(env);
    const b = await request.json();
    const key = String(b.key || '').slice(0, 300);
    if (!key) return json({ error: 'key is required' }, 400);
    const setup = String(b.setup || '').slice(0, 40);
    const note = String(b.note || '').slice(0, 2000);
    const review = b.review ? 1 : null;
    if (!setup && !note && !review) {
      await env.DB.prepare('DELETE FROM session_tags WHERE pos_key = ?').bind(key).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO session_tags (pos_key, setup, note, review) VALUES (?, ?, ?, ?)
         ON CONFLICT(pos_key) DO UPDATE SET setup = excluded.setup, note = excluded.note, review = excluded.review,
           updated_at = datetime('now')`,
      ).bind(key, setup, note, review).run();
    }
    return json({ ok: true, key, setup, note, review: !!review });
  }

  // One-minute bars for a window, for drawing a position or a day on its chart.
  if (p === '/api/sessions/bars' && method === 'GET') {
    await ensureTables(env);
    const root = BAR_ROOT[rootOf(q.get('symbol') || 'NQ')];
    const from = parseInt(q.get('from'), 10), to = parseInt(q.get('to'), 10);
    if (!root || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return json({ error: 'symbol, from and to (unix seconds) are required' }, 400);
    const rows = (await env.DB.prepare(
      'SELECT ts, open, high, low, close FROM session_bars WHERE root = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 1500',
    ).bind(root, from, to).all()).results || [];
    return json({ root, bars: rows.map((r) => [r.ts, r.open, r.high, r.low, r.close]) });
  }

  if (p === '/api/sessions/bars' && method === 'POST') {
    await ensureTables(env);
    const root = BAR_ROOT[rootOf(q.get('symbol') || 'NQ')];
    if (!root) return json({ error: 'symbol must be NQ, MNQ, ES or MES' }, 400);
    let bars;
    try { bars = parseBarsCsv(await request.text()); } catch (e) { return json({ error: e.message }, 400); }
    await insertBars(env, root, bars, true);
    return json({ ok: true, root, rows: bars.length, from: bars[0][0], to: bars[bars.length - 1][0] }, 201);
  }

  return null;
}
