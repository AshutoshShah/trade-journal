-- Trade journal: the D1 schema, for reference.
--
-- You do not need to run this. The Worker creates every table the first time
-- it needs it (CREATE ... IF NOT EXISTS), so a new database works as it is.
-- Running it is harmless: nothing here drops or changes existing data.
--   npx wrangler d1 execute trade-journal --remote --file=./schema.sql

-- ── Raw fills, as sent to /ingest/v1 or pasted into the app ──────────────────
-- The source of truth. Positions are computed from these on read.

-- One row per send of one trading day, or of one part of it. A whole-day send
-- supersedes every current send for the same source, date and platform; a part
-- supersedes the same part number and any whole-day send. Old rows are kept for
-- audit. superseded_by = 0 means the day was removed in the app.
CREATE TABLE IF NOT EXISTS ingest_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,              -- the API key's name, or 'manual' for the paste-in import
  date_local    TEXT NOT NULL,              -- the trading day as sent, YYYY-MM-DD
  platform      TEXT NOT NULL DEFAULT '',
  account       TEXT,
  part          INTEGER,                    -- 1, 2, ... when a day is sent in parts; NULL for a whole day
  time_zone     TEXT,                       -- the zone times without an offset were read in
  raw_log       TEXT,                       -- the original log, verbatim
  payload       TEXT NOT NULL,              -- the request body, image bytes removed
  warnings      TEXT,                       -- JSON array
  superseded_by INTEGER,
  received_at   TEXT NOT NULL DEFAULT (datetime('now'))   -- UTC
);
CREATE INDEX IF NOT EXISTS idx_ingest_batches_day
  ON ingest_batches (source, date_local, platform, superseded_by);

-- A sender's own grouping of fills into trades. Kept as sent; positions are
-- built from the fills, not from this.
CREATE TABLE IF NOT EXISTS ingest_trades (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id   INTEGER NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
  trade_ref  TEXT,
  instrument TEXT,
  direction  TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_trades_batch ON ingest_trades (batch_id);

-- Every execution, with its time as sent, as a wall time in the zone it was
-- read in, as the UTC instant, and as New York wall time.
CREATE TABLE IF NOT EXISTS ingest_fills (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id   INTEGER NOT NULL REFERENCES ingest_batches(id) ON DELETE CASCADE,
  trade_ref  TEXT,
  seq        INTEGER NOT NULL,
  ts_raw     TEXT,
  ts_local   TEXT,
  ts_utc     TEXT,
  ts_et      TEXT,
  side       TEXT,                          -- 'buy' or 'sell'
  qty        REAL,
  price      REAL,
  instrument TEXT,
  extra      TEXT                           -- any other fields sent, as JSON
);
CREATE INDEX IF NOT EXISTS idx_ingest_fills_batch ON ingest_fills (batch_id, seq);
CREATE INDEX IF NOT EXISTS idx_ingest_fills_time ON ingest_fills (ts_utc);

-- Images sent with a day. The bytes live in R2; this is the index.
CREATE TABLE IF NOT EXISTS ingest_screenshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  date_local   TEXT NOT NULL,
  trade_ref    TEXT,
  batch_id     INTEGER,
  r2_key       TEXT NOT NULL,
  content_type TEXT,
  bytes        INTEGER,
  sha256       TEXT NOT NULL,
  caption      TEXT,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_screenshots_hash
  ON ingest_screenshots (source, date_local, sha256);

-- ── What the pages add ───────────────────────────────────────────────────────

-- A label, note and review mark per position. pos_key identifies a position by
-- platform, account, instrument and the time of its first fill.
CREATE TABLE IF NOT EXISTS session_tags (
  pos_key    TEXT PRIMARY KEY,
  setup      TEXT,
  note       TEXT,
  review     INTEGER,                       -- 1 = marked for review
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notes before and after a trading day, as JSON {plan, review}.
CREATE TABLE IF NOT EXISTS session_days (
  date       TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Screenshots added on the Today page. The bytes live in R2.
CREATE TABLE IF NOT EXISTS daily_charts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  caption    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Settings and the "How I trade" page: one JSON row, id 'me'.
CREATE TABLE IF NOT EXISTS profiles (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- ── Price bars ───────────────────────────────────────────────────────────────

-- One-minute bars for NQ and ES (micros use the same prices), fetched from
-- Yahoo Finance or uploaded from a chart export. ts is the minute's start, UTC seconds.
CREATE TABLE IF NOT EXISTS session_bars (
  root  TEXT NOT NULL,
  ts    INTEGER NOT NULL,
  open  REAL NOT NULL,
  high  REAL NOT NULL,
  low   REAL NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (root, ts)
) WITHOUT ROWID;

-- What was fetched for each trading day, so a missed day is backfilled and a
-- running day is refreshed.
CREATE TABLE IF NOT EXISTS session_bar_cover (
  root       TEXT NOT NULL,
  date       TEXT NOT NULL,
  tgt_from   INTEGER NOT NULL,
  tgt_to     INTEGER NOT NULL,
  req_from   INTEGER NOT NULL,
  req_to     INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  rows       INTEGER NOT NULL,
  last_bar   INTEGER,
  note       TEXT,
  PRIMARY KEY (root, date)
) WITHOUT ROWID;

-- ── Access ───────────────────────────────────────────────────────────────────

-- API keys for agents and scripts, made in Settings. Only a SHA-256 hash of
-- each key is stored; the key itself is shown once.
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- Failed password sign-ins per address, for slowing down guessing.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip       TEXT PRIMARY KEY,
  fails    INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);
