-- ============================================================
-- TGG Candle Database — Migration 002
-- Adds day-level tracking to repair_log so the startup gap scan
-- can recognize "I already repaired this exact symbol+day before"
-- and stop re-fetching the same day from the broker on every restart.
--
-- ROOT CAUSE this fixes:
--   NSE:NIFTY50-INDEX (and others) were being "repaired" on every
--   single server boot for the same trading day, forever, because
--   repair_log had no day granularity — there was no way to tell
--   "this day was already repaired and the underlying broker data
--   is just naturally short" from "this is a brand-new gap".
--
-- Safe to run on an existing database: ADD COLUMN IF NOT EXISTS,
-- backfilled NULL for old rows (NULL just means "unknown day",
-- those old rows are simply ignored by the new lookup — no data
-- loss, nothing else changes behavior).
-- ============================================================

ALTER TABLE repair_log
  ADD COLUMN IF NOT EXISTS trading_day DATE;

CREATE INDEX IF NOT EXISTS idx_repair_log_symbol_day
  ON repair_log (symbol, trading_day, started_at DESC);
