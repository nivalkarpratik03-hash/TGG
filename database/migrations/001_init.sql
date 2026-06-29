-- ============================================================
-- TGG Candle Database — Initial Migration
-- Requires: PostgreSQL 13+ (plain PostgreSQL, no TimescaleDB needed)
-- Run once: npm run db:migrate
-- ============================================================

-- ── candles ──────────────────────────────────────────────────
-- Stores only FINALIZED, VALIDATED 1-minute candles.
-- Higher timeframes (3m, 5m, 15m, 1h, 1D, 1W) are derived in-memory
-- by CandleBuilder and are NEVER stored here.

CREATE TABLE IF NOT EXISTS candles (
  symbol      TEXT             NOT NULL,
  resolution  INTEGER          NOT NULL   CHECK (resolution = 1),
  time        TIMESTAMPTZ      NOT NULL,
  open        DOUBLE PRECISION NOT NULL,
  high        DOUBLE PRECISION NOT NULL,
  low         DOUBLE PRECISION NOT NULL,
  close       DOUBLE PRECISION NOT NULL,
  volume      BIGINT           NOT NULL DEFAULT 0,
  validated   BOOLEAN          NOT NULL DEFAULT TRUE,
  inserted_at TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, resolution, time)
);

CREATE INDEX IF NOT EXISTS idx_candles_symbol_res_time
  ON candles (symbol, resolution, time DESC);

CREATE INDEX IF NOT EXISTS idx_candles_inserted_at
  ON candles (inserted_at DESC);

-- ── repair_log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repair_log (
  id               BIGSERIAL   PRIMARY KEY,
  symbol           TEXT        NOT NULL,
  resolution       INTEGER,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at      TIMESTAMPTZ,
  trigger          TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'running',
  detail           TEXT,
  candles_deleted  INTEGER     DEFAULT 0,
  candles_inserted INTEGER     DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_repair_log_symbol_time
  ON repair_log (symbol, started_at DESC);

-- ── symbol_access_log ────────────────────────────────────────
-- Tracks the last time each option/future symbol was loaded/viewed.
-- Used by retentionCleanup.js to determine stale option contracts
-- (delete if ≥2 trading days since last access) and expired futures
-- (delete immediately once the contract month has passed).
-- Underlying equity/index symbols are never inserted here — the 2-day
-- rule only applies to option (CE/PE) and future contract symbols.

CREATE TABLE IF NOT EXISTS symbol_access_log (
  symbol        TEXT        PRIMARY KEY,
  last_accessed TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_symbol_access_log_last_accessed
  ON symbol_access_log (last_accessed DESC);

-- ── validation_state ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS validation_state (
  symbol       TEXT        NOT NULL,
  resolution   INTEGER     NOT NULL DEFAULT 1,
  last_checked TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ok      TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'unknown',
  issue        TEXT,
  PRIMARY KEY (symbol, resolution)
);