/**
 * backend/src/services/candleExport.js
 * ─────────────────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for turning "symbol + timeframe + from-date" into
 * exportable candle rows and an .xlsx buffer.
 *
 * Extracted out of scripts/fetchSpotCandles.js (2026-09) so that the
 * terminal script AND the new Data Export HTTP endpoint
 * (routes/dataExportRouter.js) call the exact same code — one
 * implementation, not two copies that can silently drift apart. This is
 * the same "one source of truth" pattern already established elsewhere in
 * this repo (see fyers/client.js's dedupSortCandles() comment, and
 * timeframeAggregator.js).
 *
 * TIMEFRAME → MINUTES — same numeric convention already used everywhere
 * else in this repo (frontend/src/utils/formatResolution.js's
 * RESOLUTION_LABELS, and DAILY/WEEKLY/MONTHLY_RESOLUTION in
 * services/timeframeAggregator.js):
 *   1min→1, 3min→3, 5min→5, 15min→15, 1hr→60, 1day→1440
 *
 * Works identically for spot, future AND option symbols — fyers/client.js's
 * fetchCandles() takes any Fyers symbol string and doesn't care which kind
 * it is (see scripts/backtestOptionDataFetch.js, which already calls
 * fetchCandles() directly with option contract symbols — nothing special
 * needed here for options either).
 *
 * OI — fetchCandleRows()'s optional includeOI param sources this from
 * Fyers' own oi_flag on the /history endpoint (added 2026-09, see
 * oi-iv-data-export-handoff.md and test-oi-flag.js for the live
 * verification this was based on — real, per-candle OI, confirmed
 * non-zero for a live NIFTY option contract, works at every resolution
 * this file supports). Off by default — every existing caller keeps its
 * current 8-column row shape unless it explicitly opts in.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const XLSX = require("xlsx");
const { fetchCandles } = require("../fyers/client");

const TIMEFRAME_TO_MINUTES = {
  "1min": 1, "1m": 1,
  "3min": 3, "3m": 3,
  "5min": 5, "5m": 5,
  "15min": 15, "15m": 15,
  "1hr": 60, "1h": 60, "60min": 60, "60m": 60,
  "1day": 1440, "1d": 1440, "1D": 1440, "D": 1440,
};

function resolveTimeframe(input) {
  if (!input) return 1440; // default: 1day
  const minutes = TIMEFRAME_TO_MINUTES[input] ?? TIMEFRAME_TO_MINUTES[input.toLowerCase()];
  if (minutes == null) {
    const valid = [...new Set(Object.values(TIMEFRAME_TO_MINUTES))].join(", ");
    throw new Error(`Unknown timeframe "${input}". Use one of: 1min, 3min, 5min, 15min, 1hr, 1day (minutes: ${valid})`);
  }
  return minutes;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTDateTime(epochMs) {
  const dt = new Date(epochMs + IST_OFFSET_MS);
  return { date: dt.toISOString().slice(0, 10), time: dt.toISOString().slice(11, 19) };
}

/**
 * Fetches candles for `symbol` from `fromDateStr` (YYYY-MM-DD) through
 * today at the given timeframe label, and returns plain row objects ready
 * for XLSX.utils.json_to_sheet(): Symbol, Date, Time, Open, High, Low,
 * Close, Volume, and OI when includeOI is true. OI comes from Fyers'
 * oi_flag on the /history endpoint — confirmed working live for this
 * account via test-oi-flag.js (see oi-iv-data-export-handoff.md for the
 * full verification). Off by default so every existing caller of this
 * function keeps its exact current row shape.
 *
 * Throws with a clear message (never returns an empty/undefined result
 * silently) if the date is malformed or Fyers returns nothing — same
 * failure behavior fetchSpotCandles.js already had, now shared.
 *
 * @param {string} symbol          e.g. "NSE:RELIANCE-EQ", "NSE:BEML26NOVFUT", "NSE:BEML26NOV3200CE"
 * @param {string} fromDateStr     "YYYY-MM-DD"
 * @param {string} [timeframeLabel="1day"]  one of TIMEFRAME_TO_MINUTES' keys
 * @param {boolean} [includeOI=false]  add an OI column, sourced from Fyers' oi_flag
 * @returns {Promise<{rows: object[], resolution: number, timeframeLabel: string}>}
 */
async function fetchCandleRows(symbol, fromDateStr, timeframeLabel = "1day", includeOI = false) {
  if (!symbol) throw new Error("symbol is required");
  if (!fromDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(fromDateStr)) {
    throw new Error(`from date must be YYYY-MM-DD, got "${fromDateStr}"`);
  }

  const resolution = resolveTimeframe(timeframeLabel);

  const fromDate = new Date(`${fromDateStr}T00:00:00+05:30`);
  if (Number.isNaN(fromDate.getTime())) {
    throw new Error(`Could not parse from date "${fromDateStr}"`);
  }
  const lookbackDays = Math.max(1, Math.ceil((Date.now() - fromDate.getTime()) / 86400000));

  // ONE call for every timeframe — fetchCandles() branches internally to
  // the 360-day daily-chunk path or the 90-day intraday-chunk path (see
  // fyers/client.js's own header comment for exactly how).
  const candles = await fetchCandles(symbol, resolution, 999999, lookbackDays, includeOI);

  if (!candles || candles.length === 0) {
    throw new Error(`No candles returned for ${symbol} — check the symbol string and that the token is valid.`);
  }

  const fromMs = fromDate.getTime();
  const rows = candles
    .filter((c) => c.time >= fromMs)
    .map((c) => {
      const { date, time } = toISTDateTime(c.time);
      return {
        Symbol: symbol,
        Date: date,
        Time: time,
        Open: c.open,
        High: c.high,
        Low: c.low,
        Close: c.close,
        Volume: c.volume ?? 0,
        ...(includeOI ? { OI: c.oi ?? 0 } : {}),
      };
    });

  return { rows, resolution, timeframeLabel };
}

/** rows (array of plain objects) → a single-sheet .xlsx Buffer, ready to res.send(). */
function rowsToXlsxBuffer(rows, sheetName = "Candles") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
  // Same convention already established in analytics/etlExport.js's
  // toBuffer() — one way to turn a workbook into bytes in this repo.
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

/** A safe, cross-platform file/name fragment — same sanitizer fetchSpotCandles.js used. */
function safeFilenamePart(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "_");
}

module.exports = {
  TIMEFRAME_TO_MINUTES,
  resolveTimeframe,
  toISTDateTime,
  fetchCandleRows,
  rowsToXlsxBuffer,
  safeFilenamePart,
};