/**
 * database/src/ohlcGuard.js
 *
 * OHLC SANITY GATE — validates every incoming 1m candle from Fyers against
 * the strict OHLC-bounds rule, per trading day, BEFORE it is stored.
 *
 * Rule (checkOHLC below):
 *   • open  must not be greater than high, or less than low.
 *   • close must not be greater than high, or less than low.
 *   • open/close MAY equal high or low exactly — only strictly outside the
 *     [low, high] range counts as invalid.
 *
 * If ANY candle in a trading day's incoming batch violates this rule:
 *   1. Log the trading day + the invalid candle(s) to the console.
 *   2. Record it in repair_log.
 *   3. Do NOT store that day's (invalid) batch. If the day already has data
 *      in the DB, delete it.
 *   4. Refetch the ENTIRE trading day fresh from Fyers.
 *   5. Re-validate the refetched data with the same rule.
 *   6. Store it ONLY if the refetched data passes validation completely —
 *      otherwise leave the day empty and log the final failure.
 *
 * This is a hard, all-or-nothing gate on OHLC correctness specifically —
 * deliberately stricter than (and separate from) recoveryEngine.js's
 * repairDay(), which treats broader issues (gaps/duplicates) as
 * informational and always stores whatever passes basic row sanity. Open/
 * close outside the high/low range is unambiguous corruption and is never
 * safe to store, so this gate never compromises on it the way repairDay
 * intentionally does for gap/duplicate flags.
 *
 * fetchDayCandles is injected (dependency injection), same pattern as
 * recoveryEngine.js's repairDay(fetchCandles) — this module stays
 * decoupled from the Fyers SDK; the backend passes its own
 * fyers/client.js#fetchDayCandles in.
 */

const { upsertCandles, replaceDayCandles } = require("./dataRouter");
const { logRepairStart, logRepairFinish } = require("./repairLog");

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * Check one candle against the strict OHLC-bounds rule.
 * @returns {string|null}  null if valid, otherwise a human-readable violation reason
 */
function checkOHLC(c) {
  if (!c) return "candle is null/undefined";
  const { open, high, low, close } = c;
  if (![open, high, low, close].every((v) => Number.isFinite(v))) {
    return `non-finite OHLC value (open=${open}, high=${high}, low=${low}, close=${close})`;
  }
  if (high < low) return `high(${high}) < low(${low})`;
  if (open > high) return `open(${open}) > high(${high})`;
  if (open < low) return `open(${open}) < low(${low})`;
  if (close > high) return `close(${close}) > high(${high})`;
  if (close < low) return `close(${close}) < low(${low})`;
  return null;
}

/** YYYY-MM-DD (IST) key for grouping a batch of candles by trading day. */
function istDayKey(timeMs) {
  const ist = new Date(timeMs + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

function groupByTradingDay(candles) {
  const map = new Map(); // dayKey -> candle[]
  for (const c of candles) {
    const key = istDayKey(c.time);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return map;
}

const MAX_LOGGED_VIOLATIONS_PER_DAY = 20; // cap console spam on a badly corrupt day

/**
 * Validate a batch of freshly-fetched 1m candles for `symbol` and store
 * them — quarantining (delete + refetch + re-validate) any trading day
 * that contains an OHLC violation, per the contract described above.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {Array<{time,open,high,low,close,volume}>} opts.candles  freshly fetched 1m candles from Fyers
 * @param {Function} opts.fetchDayCandles  (symbol, tradingDay) => Promise<candle[]>  — Fyers REST, ONE day only
 * @param {string} [opts.trigger]  'ingest'|'staleness_backfill'|'startup'|'chart_open' — for repair_log context
 * @returns {Promise<{stored:number, quarantinedDays:Array}>}
 */
async function validateAndStoreCandles({ symbol, candles, fetchDayCandles, trigger = "ingest" }) {
  if (!candles || candles.length === 0) return { stored: 0, quarantinedDays: [] };

  const byDay = groupByTradingDay(candles);
  let totalStored = 0;
  const quarantinedDays = [];

  for (const [dayKey, dayCandles] of byDay) {
    const violations = dayCandles
      .map((c) => ({ c, reason: checkOHLC(c) }))
      .filter((v) => v.reason);

    if (violations.length === 0) {
      // Clean day — store normally, no repair_log entry needed.
      totalStored += await upsertCandles(symbol, 1, dayCandles);
      continue;
    }

    // ── Invalid candle(s) found — quarantine this day ──────────────────────
    const tradingDay = new Date(dayCandles[0].time);

    console.error(`[OHLCGuard] ${symbol} ${dayKey}: ${violations.length} invalid candle(s) detected — quarantining day`);
    for (const v of violations.slice(0, MAX_LOGGED_VIOLATIONS_PER_DAY)) {
      console.error(
        `  [OHLCGuard] ${symbol} ${new Date(v.c.time).toISOString()}: ${v.reason} ` +
        `(O=${v.c.open} H=${v.c.high} L=${v.c.low} C=${v.c.close})`
      );
    }
    if (violations.length > MAX_LOGGED_VIOLATIONS_PER_DAY) {
      console.error(`  [OHLCGuard] ${symbol} ${dayKey}: ...and ${violations.length - MAX_LOGGED_VIOLATIONS_PER_DAY} more`);
    }

    const logId = await logRepairStart({
      symbol, resolution: 1, trigger: `ohlc_validation:${trigger}`, tradingDay,
    }).catch(() => null);

    // Never store the invalid incoming batch. If this day already has data
    // in the DB, delete it now (replaceDayCandles with an empty array = a
    // pure, transaction-safe delete — no insert).
    const { deleted } = await replaceDayCandles(symbol, 1, tradingDay, []);
    console.log(`[OHLCGuard] ${symbol} ${dayKey}: deleted ${deleted} existing candle(s) — refetching full day from Fyers...`);

    // Refetch the ENTIRE trading day from Fyers.
    let refetched;
    try {
      refetched = await fetchDayCandles(symbol, tradingDay);
    } catch (err) {
      console.error(`[OHLCGuard] ${symbol} ${dayKey}: refetch failed (${err.message}) — day left empty`);
      await logRepairFinish(logId, { status: "error", detail: `refetch failed: ${err.message}`, deleted, inserted: 0 }).catch(() => null);
      quarantinedDays.push({ day: dayKey, ok: false, reason: "refetch_failed" });
      continue;
    }

    const reViolations = (refetched || [])
      .map((c) => ({ c, reason: checkOHLC(c) }))
      .filter((v) => v.reason);

    if (!refetched || refetched.length === 0 || reViolations.length > 0) {
      const detail = !refetched || refetched.length === 0
        ? "refetch returned no candles"
        : `refetch still invalid: ${reViolations.length} violation(s) of ${refetched.length} candles`;
      console.error(`[OHLCGuard] ${symbol} ${dayKey}: ${detail} — NOT storing, day left empty`);
      await logRepairFinish(logId, { status: "error", detail, deleted, inserted: 0 }).catch(() => null);
      quarantinedDays.push({ day: dayKey, ok: false, reason: "refetch_still_invalid" });
      continue;
    }

    // Refetched data is fully valid — store it.
    const { inserted } = await replaceDayCandles(symbol, 1, tradingDay, refetched);
    totalStored += inserted;
    console.log(`[OHLCGuard] ${symbol} ${dayKey}: refetch validated clean — stored ${inserted} candle(s)`);
    await logRepairFinish(logId, { status: "ok", deleted, inserted }).catch(() => null);
    quarantinedDays.push({ day: dayKey, ok: true, inserted });
  }

  return { stored: totalStored, quarantinedDays };
}

module.exports = { checkOHLC, validateAndStoreCandles };