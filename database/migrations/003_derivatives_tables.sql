-- ============================================================
-- TGG Candle Database — Derivatives Migration
-- Adds 4 dedicated 1-minute candle tables for NSE/MCX options
-- and futures. The existing `candles` table is NOT touched —
-- it keeps storing spot indices/equities exactly as before.
--
-- Run through the existing runner (applies in filename order,
-- safe to re-run — everything below is IF NOT EXISTS):
--   npm run db:migrate   (from backend/)
--   node database/src/migrate.js
-- ============================================================

-- ── nse_options_candles ─────────────────────────────────────
-- Every NSE option contract (index + stock), 1-min.
-- expiry_type distinguishes weekly vs monthly because NIFTY is
-- the only underlying with both live at once; BANKNIFTY/stocks
-- are monthly-only but still get a value here for consistency.
CREATE TABLE IF NOT EXISTS nse_options_candles (
  underlying   TEXT             NOT NULL,
  expiry_date  DATE             NOT NULL,
  expiry_type  TEXT             NOT NULL   CHECK (expiry_type IN ('weekly','monthly')),
  strike       DOUBLE PRECISION NOT NULL,
  option_type  TEXT             NOT NULL   CHECK (option_type IN ('CE','PE')),
  time         TIMESTAMPTZ      NOT NULL,
  open         DOUBLE PRECISION NOT NULL,
  high         DOUBLE PRECISION NOT NULL,
  low          DOUBLE PRECISION NOT NULL,
  close        DOUBLE PRECISION NOT NULL,
  volume       BIGINT           NOT NULL DEFAULT 0,
  symbol       TEXT             NOT NULL,
  inserted_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (underlying, expiry_date, strike, option_type, time)
);

CREATE INDEX IF NOT EXISTS idx_nse_options_symbol_time
  ON nse_options_candles (symbol, time DESC);

-- ── mcx_options_candles ─────────────────────────────────────
-- Same shape minus expiry_type — MCX has no weekly/monthly split,
-- every MCX option contract has exactly one expiry per cycle.
CREATE TABLE IF NOT EXISTS mcx_options_candles (
  underlying   TEXT             NOT NULL,
  expiry_date  DATE             NOT NULL,
  strike       DOUBLE PRECISION NOT NULL,
  option_type  TEXT             NOT NULL   CHECK (option_type IN ('CE','PE')),
  time         TIMESTAMPTZ      NOT NULL,
  open         DOUBLE PRECISION NOT NULL,
  high         DOUBLE PRECISION NOT NULL,
  low          DOUBLE PRECISION NOT NULL,
  close        DOUBLE PRECISION NOT NULL,
  volume       BIGINT           NOT NULL DEFAULT 0,
  symbol       TEXT             NOT NULL,
  inserted_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (underlying, expiry_date, strike, option_type, time)
);

CREATE INDEX IF NOT EXISTS idx_mcx_options_symbol_time
  ON mcx_options_candles (symbol, time DESC);

-- ── nse_futures_candles ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS nse_futures_candles (
  underlying   TEXT             NOT NULL,
  expiry_date  DATE             NOT NULL,
  time         TIMESTAMPTZ      NOT NULL,
  open         DOUBLE PRECISION NOT NULL,
  high         DOUBLE PRECISION NOT NULL,
  low          DOUBLE PRECISION NOT NULL,
  close        DOUBLE PRECISION NOT NULL,
  volume       BIGINT           NOT NULL DEFAULT 0,
  symbol       TEXT             NOT NULL,
  inserted_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (underlying, expiry_date, time)
);

CREATE INDEX IF NOT EXISTS idx_nse_futures_symbol_time
  ON nse_futures_candles (symbol, time DESC);

-- ── mcx_futures_candles ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS mcx_futures_candles (
  underlying   TEXT             NOT NULL,
  expiry_date  DATE             NOT NULL,
  time         TIMESTAMPTZ      NOT NULL,
  open         DOUBLE PRECISION NOT NULL,
  high         DOUBLE PRECISION NOT NULL,
  low          DOUBLE PRECISION NOT NULL,
  close        DOUBLE PRECISION NOT NULL,
  volume       BIGINT           NOT NULL DEFAULT 0,
  symbol       TEXT             NOT NULL,
  inserted_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (underlying, expiry_date, time)
);

CREATE INDEX IF NOT EXISTS idx_mcx_futures_symbol_time
  ON mcx_futures_candles (symbol, time DESC);
