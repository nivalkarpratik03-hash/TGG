"use strict";
/**
 * candleFetch.js — the ONE shared candle-fetching strategy, used by both
 * scannerRunner.js and the Analytics module (backend/src/analytics/). No
 * independent copy of this logic exists anywhere else in the backend.
 *
 * WHY THIS FILE EXISTS: scannerRunner.js already had a proven DB-first
 * fetch (try Postgres, only call live Fyers if the DB has nothing) plus a
 * throttled batch loop (CONCURRENCY + BATCH_DELAY_MS) so it never hammers
 * Fyers. analyticsRouter.js's first version (Chunk 4/6) skipped BOTH of
 * those and called fetchCandles() directly per symbol with no DB check and
 * no throttle — which is exactly what caused the Fyers rate-limit storm
 * seen in the real backend log (repeated "Intraday chunk hit rate limit"
 * and chunked daily-candle fetches for every symbol, every run).
 *
 * `fetchCandlesDbFirst()` below is a DIRECT extraction of scannerRunner.js's
 * own per-symbol fetch block — same window (90 days default), same limit
 * (50000), same fallback count (5000) — verified byte-equivalent behavior
 * in sanity_candleFetch.js. scannerRunner.js has been refactored to CALL
 * this function instead of keeping its own copy (see scannerRunner.js's own
 * diff — the block is gone from there now, not duplicated).
 *
 * `fetchCandlesBatched()` is new — Analytics needs the same
 * CONCURRENCY/BATCH_DELAY_MS throttle scannerRunner.js's scan loop already
 * has, generalized here so both can import the SAME numbers rather than
 * each guessing their own.
 *
 * LOOKBACK (Scanner History filter, added later): `lookbackDays` is an
 * optional override on both functions, default DEFAULT_LOOKBACK_DAYS (90) —
 * every existing caller (scannerRunner.js's normal Scan Now, Analytics)
 * keeps the exact same 90-day behavior it always had. Only scannerRunner.js's
 * scoped "Scan this range" trigger passes a wider value. The DB path window
 * simply scales off it. The Fyers fallback passes it straight through as
 * fetchCandles()'s existing `lookbackDaysOverride` 4th argument — that
 * function ALREADY chunks intraday requests in 90-day windows internally
 * (see fyers/client.js), so a 365-day request is not a new capability being
 * built here, just this file finally passing through a parameter that
 * already existed and previously went unused (fetchCandlesDbFirst never
 * passed a 4th arg, so the Fyers-fallback path silently fell back to
 * fyers/client.js's own per-resolution default instead of matching the
 * DB path's 90 days — this fixes that mismatch as a side effect).
 */

let db = null;
let dbEnabled = false;
try {
  db = require("../../../database/src/index");
  dbEnabled = true;
} catch { /* DB optional — runs Fyers-only if not available, same as scannerRunner.js */ }

const { fetchCandles } = require("../fyers/client");
const { deriveTimeframe } = require("./candleBuilder");

// Same env vars scannerRunner.js already used (SCANNER_CONCURRENCY /
// SCANNER_BATCH_DELAY_MS) — kept as the SAME names and SAME default values
// (3 / 1000) so moving this constant here changes nothing about Scanner's
// real-world behavior. Analytics reads the identical constant, not a
// second independently-chosen number.
const CONCURRENCY = parseInt(process.env.SCANNER_CONCURRENCY || "3", 10);
const BATCH_DELAY_MS = parseInt(process.env.SCANNER_BATCH_DELAY_MS || "1000", 10);

// Single source of truth for the default candle window, both here and for
// any frontend/backend caller that needs to know what "not overridden"
// means. Scanner's History lookback filter imports this same number on the
// frontend side (frontend/src/features/scanner/HistoryLookbackFilter.js)
// instead of hardcoding "90" a second time.
const DEFAULT_LOOKBACK_DAYS = 90;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DB-first, single symbol. `logPrefix` lets a caller keep its own existing
// log text (scannerRunner.js passes "[Scanner]" so its logs read exactly
// as they did before this extraction) without forking the actual logic.
// `lookbackDays` — see file header. Defaults to DEFAULT_LOOKBACK_DAYS (90),
// identical to the previous hardcoded behavior when omitted.
async function fetchCandlesDbFirst(symbol, resolution, { logPrefix = "[CandleFetch]", lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  let candles = null;

  if (dbEnabled && db) {
    try {
      const windowMs = lookbackDays * 24 * 60 * 60 * 1000;
      const oneMin = await db.loadCandles(symbol, 1, {
        from: new Date(Date.now() - windowMs),
        to: new Date(),
        limit: 50000,
      });
      if (oneMin && oneMin.length > 0) {
        candles = resolution === 1 ? oneMin : deriveTimeframe(oneMin, resolution);
        if (!candles || candles.length === 0) candles = null;
      }
    } catch (dbErr) {
      console.warn(`${logPrefix} DB read failed for ${symbol}: ${dbErr.message} — trying Fyers`);
    }
  }

  if (!candles) {
    candles = await fetchCandles(symbol, resolution, 5000, lookbackDays);
  }

  return candles;
}

// Many symbols, DB-first per symbol, same CONCURRENCY/BATCH_DELAY_MS
// throttle scannerRunner.js's own scan loop uses — so a caller with many
// symbols (Analytics) never fires them all at once. A symbol whose fetch
// fails (DB miss AND Fyers error) is recorded under `errors`, not thrown —
// one bad symbol must never take the whole batch down, same principle
// runAnalytics.js already applies to a strategy's scan() throwing.
async function fetchCandlesBatched(symbols, resolution, { logPrefix = "[CandleFetch]", onProgress = null, concurrency = CONCURRENCY, batchDelayMs = BATCH_DELAY_MS, lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const list = Array.isArray(symbols) ? symbols : [];
  const candlesBySymbol = {};
  const errors = {};

  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
          candlesBySymbol[symbol] = await fetchCandlesDbFirst(symbol, resolution, { logPrefix, lookbackDays });
        } catch (e) {
          errors[symbol] = e.message;
        }
      })
    );
    if (onProgress) onProgress({ done: Math.min(i + concurrency, list.length), total: list.length });
    if (i + concurrency < list.length) await delay(batchDelayMs);
  }

  return { candlesBySymbol, errors };
}

module.exports = {
  fetchCandlesDbFirst,
  fetchCandlesBatched,
  CONCURRENCY,
  BATCH_DELAY_MS,
  DEFAULT_LOOKBACK_DAYS,
  dbEnabled,
};