-- ============================================================
-- TGG Paper Trading — Global Paper Trading System
-- ============================================================
-- ONE trades table for the whole project. Every paper trade — however it
-- was opened (a strategy's auto-signal, a manual click from Charts/
-- Scanner/Watchlist/this dashboard) — is a row here, same shape, same
-- lifecycle. Nothing strategy-specific or feature-specific lives in a
-- separate table; `source` + `strategy_id` are just columns that say
-- WHO opened it, not a different code path.
--
-- SL/Target resolution runs off stored 1-minute candles (spot `candles`
-- table or the derivatives tables, via database/src/store/dataRouter.js
-- — same router every other part of the app already reads through), so
-- this migration adds no new candle storage of its own.
--
-- Safe to re-run (IF NOT EXISTS throughout, matches every prior migration
-- in this folder).
-- Run through the existing runner:
--   npm run db:migrate   (from backend/ or database/)
-- ============================================================

CREATE TABLE IF NOT EXISTS paper_trades (
  id             BIGSERIAL PRIMARY KEY,

  -- WHO opened it — 'auto' (strategy signal) or 'manual' (user-placed).
  -- strategy_id / strategy_name are NULL for manual trades.
  source         TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  strategy_id    TEXT,
  strategy_name  TEXT,

  symbol         TEXT NOT NULL,          -- full Fyers symbol string, e.g. NSE:RELIANCE-EQ
  side           TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  qty            NUMERIC NOT NULL DEFAULT 1,

  entry_time     TIMESTAMPTZ NOT NULL,
  entry_price    NUMERIC NOT NULL,
  sl_price       NUMERIC NOT NULL,
  target_price   NUMERIC NOT NULL,

  exit_time      TIMESTAMPTZ,
  exit_price     NUMERIC,
  exit_reason    TEXT CHECK (exit_reason IN ('SL', 'TARGET', 'MANUAL_CLOSE', 'EOD_SQUAREOFF') OR exit_reason IS NULL),

  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  pnl            NUMERIC,                -- signed, in price points * qty; NULL while OPEN

  trading_day    DATE NOT NULL,          -- IST trading day of entry_time — drives the EOD tradesheet grouping
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_status       ON paper_trades (status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_source_day   ON paper_trades (source, trading_day);
CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy_day ON paper_trades (strategy_id, trading_day);
CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol       ON paper_trades (symbol);

-- Per-strategy Auto Entry configuration. One row per strategy id (from
-- strategyRegistry.js). Fixed-points SL/Target per strategy, editable
-- later from the dashboard — enabled defaults to FALSE so nothing starts
-- auto-trading until the user turns it on for that strategy.
CREATE TABLE IF NOT EXISTS strategy_paper_config (
  strategy_id    TEXT PRIMARY KEY,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  sl_points      NUMERIC NOT NULL DEFAULT 20,
  target_points  NUMERIC NOT NULL DEFAULT 40,
  qty            NUMERIC NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);