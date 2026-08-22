-- ============================================================
-- TGG Candle Database — Daily Candle Storage Migration
-- Widens the `candles` table's resolution CHECK constraint from
-- "1 only" to "1 or 1440", so complete historical 1-Day (1D)
-- candles can be persisted for spot symbols (equities, indices,
-- MCX continuous roots — anything NOT a dated option/future,
-- which routes through database/src/store/dataRouter.js to the
-- separate derivatives tables and is untouched by this migration).
--
-- WHY 1440 lives in the SAME table as 1m instead of a new table:
--   - Same (symbol, resolution, time) primary key shape already
--     supports an arbitrary resolution value — only the CHECK
--     constraint was artificially pinned to 1.
--   - upsertCandles / loadCandles / getLatestCandle / replaceDayCandles
--     in candleStore.js are already resolution-generic (no code
--     changes needed there) — this migration is the ONLY schema
--     change required to start storing 1D bars.
--   - Weekly/Monthly (10080/43200/...) are still NEVER stored —
--     they continue to be derived in-memory, now from the stored
--     1D rows instead of from 1m (see backend/src/services/
--     timeframeAggregator.js), exactly like 1D used to be derived
--     from 1m before this migration.
--
-- Safe to re-run (guarded by a catalog check before the ALTER).
-- Run through the existing runner:
--   npm run db:migrate   (from backend/ or database/)
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'candles_resolution_check'
  ) THEN
    ALTER TABLE candles DROP CONSTRAINT candles_resolution_check;
  END IF;

  ALTER TABLE candles ADD CONSTRAINT candles_resolution_check
    CHECK (resolution IN (1, 1440));
END $$;

-- The existing composite index (symbol, resolution, time DESC) already
-- serves 1440 lookups efficiently — no new index needed, resolution is
-- the second column of the existing idx_candles_symbol_res_time index.