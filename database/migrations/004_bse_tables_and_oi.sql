-- ============================================================
-- TGG Candle Database — BSE tables + Open Interest migration
--
-- Two changes:
--   1. Adds an `oi` column to all 4 existing derivatives tables
--      (nse_options_candles, mcx_options_candles,
--      nse_futures_candles, mcx_futures_candles). Fyers already
--      returns OI in fetchOptionChain() responses — this was
--      simply never being captured. Existing rows get oi = NULL
--      (unknown for anything already stored before this ran).
--   2. Creates bse_options_candles and bse_futures_candles —
--      SENSEX (BSE) derivatives previously had no dedicated
--      table at all and would silently fall through to the
--      plain `candles` (spot) table via dataRouter.js's default
--      path. bse_options_candles mirrors nse_options_candles
--      exactly (SENSEX has both weekly + monthly expiries, same
--      as NIFTY) — expiry_type included.
--
-- Safe to re-run — IF NOT EXISTS / IF NOT EXISTS-guarded ADD
-- COLUMN throughout.
-- ============================================================

-- ── add oi to existing derivatives tables ───────────────────
ALTER TABLE nse_options_candles ADD COLUMN IF NOT EXISTS oi BIGINT;
ALTER TABLE mcx_options_candles ADD COLUMN IF NOT EXISTS oi BIGINT;
ALTER TABLE nse_futures_candles ADD COLUMN IF NOT EXISTS oi BIGINT;
ALTER TABLE mcx_futures_candles ADD COLUMN IF NOT EXISTS oi BIGINT;

-- ── bse_options_candles ──────────────────────────────────────
-- Same shape as nse_options_candles, including expiry_type —
-- SENSEX runs weekly (Thursday) + monthly (last Thursday)
-- simultaneously, same two-list situation as NIFTY.
CREATE TABLE IF NOT EXISTS bse_options_candles (
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
  oi           BIGINT,
  symbol       TEXT             NOT NULL,
  inserted_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (underlying, expiry_date, strike, option_type, time)
);

CREATE INDEX IF NOT EXISTS idx_bse_options_symbol_time
  ON bse_options_candles (symbol, time DESC);

-- ── bse_futures_candles ──────────────────────────────────────
-- Same shape as nse_futures_candles.
CREATE TABLE IF NOT EXISTS bse_futures_candles (
  underlying   TEXT             NOT NULL,
  expiry_date  DATE             NOT NULL,
  time         TIMESTAMPTZ      NOT NULL,
  open         DOUBLE PRECISION NOT NULL,
  high         DOUBLE PRECISION NOT NULL,
  low          DOUBLE PRECISION NOT NULL,
  close        DOUBLE PRECISION NOT NULL,
  volume       BIGINT           NOT NULL DEFAULT 0,
  oi           BIGINT,
  symbol       TEXT             NOT NULL,
  inserted_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (underlying, expiry_date, time)
);

CREATE INDEX IF NOT EXISTS idx_bse_futures_symbol_time
  ON bse_futures_candles (symbol, time DESC);
