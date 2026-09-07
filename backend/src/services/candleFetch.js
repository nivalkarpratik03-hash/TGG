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
 * own per-symbol fetch block — same window (90 days), same limit (50000),
 * same fallback count (5000) — verified byte-equivalent behavior in
 * sanity_candleFetch.js. scannerRunner.js has been refactored to CALL this
 * function instead of keeping its own copy (see scannerRunner.js's own
 * diff — the block is gone from there now, not duplicated).
 *
 * `fetchCandlesBatched()` is new — Analytics needs the same
 * CONCURRENCY/BATCH_DELAY_MS throttle scannerRunner.js's scan loop already
 * has, generalized here so both can import the SAME numbers rather than
 * each guessing their own.
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DB-first, single symbol. `logPrefix` lets a caller keep its own existing
// log text (scannerRunner.js passes "[Scanner]" so its logs read exactly
// as they did before this extraction) without forking the actual logic.
async function fetchCandlesDbFirst(symbol, resolution, { logPrefix = "[CandleFetch]" } = {}) {
  let candles = null;

  if (dbEnabled && db) {
    try {
      const windowMs = 90 * 24 * 60 * 60 * 1000;
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
    candles = await fetchCandles(symbol, resolution, 5000);
  }

  return candles;
}

// Many symbols, DB-first per symbol, same CONCURRENCY/BATCH_DELAY_MS
// throttle scannerRunner.js's own scan loop uses — so a caller with many
// symbols (Analytics) never fires them all at once. A symbol whose fetch
// fails (DB miss AND Fyers error) is recorded under `errors`, not thrown —
// one bad symbol must never take the whole batch down, same principle
// runAnalytics.js already applies to a strategy's scan() throwing.
async function fetchCandlesBatched(symbols, resolution, { logPrefix = "[CandleFetch]", onProgress = null, concurrency = CONCURRENCY, batchDelayMs = BATCH_DELAY_MS } = {}) {
  const list = Array.isArray(symbols) ? symbols : [];
  const candlesBySymbol = {};
  const errors = {};

  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
          candlesBySymbol[symbol] = await fetchCandlesDbFirst(symbol, resolution, { logPrefix });
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
  dbEnabled,
};
