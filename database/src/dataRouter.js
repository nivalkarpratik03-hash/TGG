/**
 * database/src/dataRouter.js
 *
 * Drop-in, signature-compatible replacements for candleStore.js's
 * upsertCandles / getLatestCandle / loadCandles. Each function here parses
 * the symbol first:
 *   - not a dated NSE/MCX option or future (equities, indices, MCX
 *     continuous roots, anything unrecognized) → delegates straight to
 *     candleStore.js, UNCHANGED behavior.
 *   - a dated NSE/MCX option or future → delegates to derivativesStore.js,
 *     writing/reading the correct one of the 4 new tables instead.
 *
 * database/src/index.js spreads this module's exports LAST, so these
 * names override candleStore.js's versions app-wide. Every existing
 * caller (server.js, backfill.js, scannerRunner.js, backtestRunner.js —
 * all of which call db.upsertCandles / db.getLatestCandle / db.loadCandles
 * through the shared `db` object) becomes derivatives-aware with ZERO
 * changes to any of those files.
 *
 * CORRECTED (was previously wrong): recoveryEngine.js and
 * validationEngine.js's checkPeriodicSync DO need to go through this
 * router too, and now do. The earlier assumption — "those only ever run
 * against curated no-expiry symbols" — was true for runCuratedSymbolCatchUp
 * (which does load its symbol list from noExpirySymbols.json) but false for
 * the 5-minute periodicSync loop in server.js, which pulls its symbol list
 * from getLiveBroadcastSymbols() — i.e. whatever any connected client
 * currently has open, option/future contracts included. Left ungated, that
 * loop was silently writing/reading option candles against the plain
 * `candles` table instead of the correct derivatives table.
 *
 * recoveryEngine.js now imports upsertCandles/replaceDayCandles from HERE
 * instead of candleStore.js directly. validationEngine.js now imports
 * getLatestCandle from HERE (its other exports — loadCandles, countCandles,
 * upsertValidationState — stay on candleStore.js directly, since those are
 * only ever called by validateHistorical/validateCurrentDay, which really
 * are curated-symbol-only, via runCuratedSymbolCatchUp).
 */

const candleStore = require("./candleStore");
const derivativesStore = require("./derivativesStore");
const { parseDerivativeSymbol } = require("./symbolParser");

/**
 * Upsert a batch of finalized 1m candles for `symbol`. Same signature as
 * candleStore.upsertCandles(symbol, resolution, candles).
 */
async function upsertCandles(symbol, resolution, candles) {
  const info = parseDerivativeSymbol(symbol);
  if (!info) return candleStore.upsertCandles(symbol, resolution, candles);

  if (resolution !== 1) {
    console.warn(`[DataRouter] ${symbol}: derivatives tables only store resolution=1, got ${resolution} — ignoring write`);
    return 0;
  }

  const rows = (candles || []).map((c) => ({ ...info, ...c }));
  return info.instrument_type === "option"
    ? derivativesStore.upsertOptionCandles(rows)
    : derivativesStore.upsertFutureCandles(rows);
}

/**
 * Load candles for `symbol`. Same signature as
 * candleStore.loadCandles(symbol, resolution, opts).
 */
async function loadCandles(symbol, resolution, opts = {}) {
  const info = parseDerivativeSymbol(symbol);
  if (!info) return candleStore.loadCandles(symbol, resolution, opts);

  return derivativesStore.loadCandlesBySymbol(info.exchange, info.instrument_type, symbol, opts);
}

/**
 * Most recent candle for `symbol`. Same signature as
 * candleStore.getLatestCandle(symbol, resolution).
 */
async function getLatestCandle(symbol, resolution) {
  const info = parseDerivativeSymbol(symbol);
  if (!info) return candleStore.getLatestCandle(symbol, resolution);

  return derivativesStore.getLatestCandleBySymbol(info.exchange, info.instrument_type, symbol);
}

/**
 * Atomically replace one symbol's candles for a single trading day. Same
 * signature as candleStore.replaceDayCandles(symbol, resolution, tradingDay,
 * candles) — used by recoveryEngine.js's repairDay() for both the
 * curated-symbol gap scan (always non-derivative, routes to candleStore
 * unchanged) and periodicSync's fallback full-day repair (can be a
 * derivative symbol if that's what's open in a chart — routes to
 * derivativesStore instead, atomically, same delete+insert-in-one-
 * transaction guarantee as the candleStore.js version).
 */
async function replaceDayCandles(symbol, resolution, tradingDay, candles) {
  const info = parseDerivativeSymbol(symbol);
  if (!info) return candleStore.replaceDayCandles(symbol, resolution, tradingDay, candles);

  if (resolution !== 1) {
    console.warn(`[DataRouter] ${symbol}: derivatives tables only store resolution=1, got ${resolution} — ignoring day-replace`);
    return { deleted: 0, inserted: 0 };
  }

  const rows = (candles || []).map((c) => ({ ...info, ...c }));
  return derivativesStore.replaceDayCandlesBySymbol(info.exchange, info.instrument_type, symbol, tradingDay, rows);
}

module.exports = {
  upsertCandles,
  loadCandles,
  getLatestCandle,
  replaceDayCandles,
};