/**
 * database/src/storageFlags.js
 *
 * 7 env-driven ON/OFF switches for what actually gets WRITTEN to Postgres,
 * one per storage category — matching the real table names, not a coarser
 * "options vs futures" grouping:
 *
 *   STORE_SPOT           -> candles (equities + indices, 1m + 1D)
 *   STORE_NSE_OPTIONS     -> nse_options_candles
 *   STORE_BSE_OPTIONS     -> bse_options_candles
 *   STORE_MCX_OPTIONS     -> mcx_options_candles
 *   STORE_NSE_FUTURES     -> nse_futures_candles
 *   STORE_BSE_FUTURES     -> bse_futures_candles
 *   STORE_MCX_FUTURES     -> mcx_futures_candles
 *
 * Same true-by-default convention as CHECKPOINTS_ENABLED
 * (gapFillScheduler.js) — a flag is OFF only when explicitly set to the
 * string "false"; unset/anything else = ON. This means an existing
 * deployment with no .env changes keeps storing everything exactly as
 * before — nothing changes unless a flag is explicitly flipped off.
 *
 * WHY THIS IS THE ONLY PLACE THAT NEEDS TO CHECK THESE FLAGS: every write
 * path in the app funnels down to one of two functions —
 *   spot            -> candleStore.js: upsertCandles() / replaceDayCandles()
 *   option / future -> derivativesStore.js: upsertOptionCandles() /
 *                       upsertFutureCandles() / replaceDayCandlesBySymbol()
 * — regardless of whether the call originated from dataFetch.js's
 * per-chart-open write-through, derivativesGapFill.js's checkpoint
 * backfill, or recoveryEngine.js's periodicSync/repairDay. Gating at this
 * lowest layer means none of those callers need to know or care about
 * these flags — they keep calling upsert exactly as before; the write
 * just quietly becomes a no-op when the relevant flag is off.
 *
 * READS ARE NEVER GATED. Turning storage off for a category does not stop
 * that data from being fetched live from Fyers and shown on request — see
 * dataFetch.js's existing DB-first-then-Fyers-fallback logic, which
 * already handles "DB has nothing for this symbol" as a normal case
 * (empty table looks identical to "never fetched yet").
 */

function isOn(envVar) {
  return process.env[envVar] !== "false";
}

const STORE_SPOT = isOn("STORE_SPOT");
const STORE_NSE_OPTIONS = isOn("STORE_NSE_OPTIONS");
const STORE_BSE_OPTIONS = isOn("STORE_BSE_OPTIONS");
const STORE_MCX_OPTIONS = isOn("STORE_MCX_OPTIONS");
const STORE_NSE_FUTURES = isOn("STORE_NSE_FUTURES");
const STORE_BSE_FUTURES = isOn("STORE_BSE_FUTURES");
const STORE_MCX_FUTURES = isOn("STORE_MCX_FUTURES");

const DERIVATIVE_FLAGS = {
  option: { NSE: STORE_NSE_OPTIONS, BSE: STORE_BSE_OPTIONS, MCX: STORE_MCX_OPTIONS },
  future: { NSE: STORE_NSE_FUTURES, BSE: STORE_BSE_FUTURES, MCX: STORE_MCX_FUTURES },
};

/** True if spot (candles table) writes are enabled. */
function isSpotStorageEnabled() {
  return STORE_SPOT;
}

/**
 * True if writes are enabled for one of the 6 derivatives tables.
 * @param {"NSE"|"MCX"|"BSE"} exchange
 * @param {"option"|"future"} instrumentType
 */
function isDerivativeStorageEnabled(exchange, instrumentType) {
  const byType = DERIVATIVE_FLAGS[instrumentType];
  if (!byType) return true; // unknown instrumentType — fail open, never silently block an unrecognized write
  const flag = byType[exchange];
  return flag === undefined ? true : flag; // unknown exchange — same fail-open reasoning
}

module.exports = {
  isSpotStorageEnabled,
  isDerivativeStorageEnabled,
  // exposed for logging/diagnostics (e.g. a boot-time summary line)
  flags: {
    STORE_SPOT,
    STORE_NSE_OPTIONS,
    STORE_BSE_OPTIONS,
    STORE_MCX_OPTIONS,
    STORE_NSE_FUTURES,
    STORE_BSE_FUTURES,
    STORE_MCX_FUTURES,
  },
};
