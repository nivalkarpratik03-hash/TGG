/**
 * backend/src/services/ivEnrichment.js
 *
 * Shared by BOTH bulkOptionFetch.js and dataExportRouter.js's single-
 * symbol route — written once here instead of twice, per the explicit
 * "don't use independent logic, make it global" instruction this
 * feature was built under (same as OI's fetchCandleRows()/fetchCandles()
 * reuse).
 *
 * WHY THIS EXISTS: Fyers gives OI directly, but not IV — IV has to be
 * computed (see blackScholes.js's header for why that's not a "lesser"
 * number than any other IV shown anywhere). Computing it needs the
 * underlying's spot price at the SAME moment as each option candle,
 * which nothing in this codebase fetched before this feature — see
 * oi-iv-data-export-handoff.md, Section 3c.
 */

"use strict";

const { fetchCandleRows, toISTDateTime } = require("./candleExport");
const { impliedVolatility, RISK_FREE_RATE_DEFAULT } = require("./blackScholes");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// NSE F&O contracts expire at market close, 15:30 IST — the real,
// documented close time, not a guess. Used only as a fallback when the
// caller has just a plain expiry DATE string (no exact epoch moment) —
// see fetchOptionChain()'s .expiry epoch, which is used directly instead
// whenever it's available (bulk mode always has it).
const NSE_EXPIRY_CLOSE_IST = { hour: 15, minute: 30 };

/**
 * Fetches the underlying's own historical candles ONCE for the given
 * date range/timeframe, and returns a Map<epochMs, closePrice> for O(1)
 * lookup per option row — deliberately fetched once per request, not
 * once per strike, since bulk mode's strikes/expiries all share the same
 * underlying.
 *
 * @param {string} spotSymbol   e.g. "NSE:NIFTY50-INDEX" — from
 *                              resolveChainLookupSymbol(entry), same
 *                              symbol already used for option-chain
 *                              lookups elsewhere in this codebase
 * @param {string} fromDateStr  "YYYY-MM-DD"
 * @param {string} timeframeLabel
 * @returns {Promise<Map<number, number>>}
 */
async function fetchUnderlyingSpotMap(spotSymbol, fromDateStr, timeframeLabel) {
  const { rows } = await fetchCandleRows(spotSymbol, fromDateStr, timeframeLabel, false);
  const map = new Map();
  for (const r of rows) {
    // Rebuild the same epochMs toISTDateTime() derived Date/Time from,
    // so lookups below (which do the same rebuild for each option row)
    // land on identical keys.
    const epochMs = Date.parse(`${r.Date}T${r.Time}+05:30`);
    if (!Number.isNaN(epochMs)) map.set(epochMs, r.Close);
  }
  return map;
}

/** Nearest spot price at or before `epochMs`, within a `maxGapMs` tolerance
 * (default 15 minutes — generous enough for a missing/thin candle here or
 * there, tight enough that a real gap correctly yields "no match" rather
 * than a stale, misleading price). Returns null if nothing usable is found.
 * A plain exact-match lookup would fail on the smallest data gap between
 * the option and underlying series, which is common — real markets don't
 * guarantee both print a candle at every identical minute. */
function nearestSpot(spotMap, epochMs, maxGapMs = 15 * 60 * 1000) {
  if (spotMap.has(epochMs)) return spotMap.get(epochMs);
  let best = null, bestGap = Infinity;
  for (const [t, price] of spotMap) {
    const gap = epochMs - t;
    if (gap >= 0 && gap < bestGap && gap <= maxGapMs) { best = price; bestGap = gap; }
  }
  return best;
}

/**
 * Computes time-to-expiry in years from a row's own Date/Time to the
 * contract's expiry moment.
 * @param {string} rowDate  "YYYY-MM-DD"
 * @param {string} rowTime  "HH:MM:SS"
 * @param {{expiryEpochSeconds?: number, expiryDateStr?: string}} expiry
 *   Pass expiryEpochSeconds when available (bulk mode always has this,
 *   from fetchOptionChain()'s own .expiry — exact, no assumption needed).
 *   Falls back to expiryDateStr + the documented 15:30 IST close only
 *   when no epoch is available (single-symbol mode, see this file's
 *   header).
 */
function timeToExpiryYears(rowDate, rowTime, expiry) {
  const rowEpochMs = Date.parse(`${rowDate}T${rowTime}+05:30`);
  let expiryEpochMs;
  if (expiry.expiryEpochSeconds) {
    expiryEpochMs = expiry.expiryEpochSeconds * 1000;
  } else if (expiry.expiryDateStr) {
    const hh = String(NSE_EXPIRY_CLOSE_IST.hour).padStart(2, "0");
    const mm = String(NSE_EXPIRY_CLOSE_IST.minute).padStart(2, "0");
    expiryEpochMs = Date.parse(`${expiry.expiryDateStr}T${hh}:${mm}:00+05:30`);
  } else {
    return null;
  }
  if (Number.isNaN(rowEpochMs) || Number.isNaN(expiryEpochMs)) return null;
  const msPerYear = 365 * 24 * 60 * 60 * 1000;
  return (expiryEpochMs - rowEpochMs) / msPerYear;
}

/**
 * Mutates nothing — returns a NEW array of rows, each with an `IV` key
 * added (a decimal like 0.18, or null when unsolvable — see
 * blackScholes.js's impliedVolatility() for exactly when that happens;
 * null is written as "" in the final Excel cell via the same
 * XLSX.utils.json_to_sheet() call already used everywhere else, not
 * something new).
 *
 * @param {object[]} rows       from fetchCandleRows() — needs .Date, .Time, .Close on each
 * @param {Map<number,number>} spotMap  from fetchUnderlyingSpotMap()
 * @param {{strike:number, optionType:"CE"|"PE", expiryEpochSeconds?:number, expiryDateStr?:string, riskFreeRate?:number}} opts
 */
function attachIV(rows, spotMap, opts) {
  const { strike, optionType, expiryEpochSeconds, expiryDateStr, riskFreeRate = RISK_FREE_RATE_DEFAULT } = opts;
  return rows.map((r) => {
    const rowEpochMs = Date.parse(`${r.Date}T${r.Time}+05:30`);
    const spot = nearestSpot(spotMap, rowEpochMs);
    const T = timeToExpiryYears(r.Date, r.Time, { expiryEpochSeconds, expiryDateStr });
    const iv = spot != null && T != null
      ? impliedVolatility(r.Close, spot, strike, T, optionType, riskFreeRate)
      : null;
    return { ...r, IV: iv };
  });
}

module.exports = { fetchUnderlyingSpotMap, attachIV, timeToExpiryYears, nearestSpot };
