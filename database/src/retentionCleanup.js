/**
 * database/src/retentionCleanup.js
 *
 * CONTRACT RETENTION / LIFECYCLE CLEANUP
 *
 * Deletes candle data for expired or stale option/future contract symbols.
 * Runs on every backend startup (and catches up even after a week offline).
 * Underlying equity/index symbols are NEVER touched by this module.
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *
 *  OPTIONS (CE / PE):
 *    Delete if it has been ≥2 trading days since the symbol was last
 *    viewed/loaded (tracked via symbol_access_log). "Trading days" counts
 *    Mon–Fri only (no holiday calendar needed for this approximation).
 *
 *  FUTURES ({YY}{MON}FUT):
 *    Delete immediately (0-day grace) once we are in a LATER calendar month
 *    than the contract's expiry month. A 26JUNFUT contract is considered
 *    expired starting July 1 00:00 IST, regardless of which exact Thursday
 *    or Tuesday it settled on. This avoids needing an NSE/BSE holiday
 *    calendar to compute the exact last-trading day.
 *
 *  UNDERLYINGS (NIFTY, SENSEX, RELIANCE-EQ, etc.):
 *    NEVER touched. The 90-day rolling prune in pruneOldCandles() already
 *    handles their long-term storage.
 *
 * ── Symbol classification regex ──────────────────────────────────────────────
 *
 *  Options (both monthly and weekly Fyers formats):
 *    Monthly: NSE:NIFTY26JUN24000CE   → \d{2}[A-Z]{3}\d+(CE|PE)$
 *    Weekly:  NSE:NIFTY265P24000CE    → \d{2}\d[A-Z0-9]\d{2}\d+(CE|PE)$
 *  Combined: /\d{2}(?:[A-Z]{3}|[0-9][A-Z0-9]\d{2})\d+(CE|PE)$/
 *
 *  Futures:
 *    NSE:RELIANCE26JUNFUT / MCX:CRUDEOIL26JULFUT → /\d{2}[A-Z]{3}FUT$/
 */

"use strict";

const { listSymbols, deleteAllCandles, deleteSymbolAccess, getSymbolAccessMap } = require("./candleStore");

// ── IST offset ────────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

// ── Month-code → 0-based month index ─────────────────────────────────────────
const MONTH_INDEX = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

// ── Symbol classification ────────────────────────────────────────────────────

/**
 * Combined option regex covering both Fyers monthly and weekly strike formats.
 *
 * Monthly: ...26JUN24000CE   (YY + 3-letter month + strike + CE/PE)
 * Weekly:  ...265P24000CE    (YY + single digit + alpha-char + 2-digit day + strike + CE/PE)
 *
 * We strip the exchange prefix (NSE:, BSE:, MCX:) before testing.
 */
const OPTION_RE = /\d{2}(?:[A-Z]{3}|[0-9][A-Z0-9]\d{2})\d+(CE|PE)$/;

/**
 * Future regex: ends with {YY}{3-letter-month}FUT
 * e.g. RELIANCE26JUNFUT, CRUDEOIL26JULFUT
 */
const FUTURE_RE = /\d{2}[A-Z]{3}FUT$/;

function stripExchange(symbol) {
  // Remove "NSE:", "BSE:", "MCX:" etc.
  const colon = symbol.indexOf(":");
  return colon >= 0 ? symbol.slice(colon + 1).toUpperCase() : symbol.toUpperCase();
}

/**
 * @returns {"option"|"future"|"underlying"}
 */
function classifySymbol(symbol) {
  const s = stripExchange(symbol);
  if (OPTION_RE.test(s))  return "option";
  if (FUTURE_RE.test(s))  return "future";
  return "underlying";
}

// ── Future expiry detection ──────────────────────────────────────────────────

/**
 * Parse the contract month from a future symbol suffix.
 * Returns { year: 2026, month: 5 } (0-based month) for "26JUNFUT", or null on failure.
 */
function parseFutureExpiry(symbol) {
  const s = stripExchange(symbol);
  const m = s.match(/(\d{2})([A-Z]{3})FUT$/);
  if (!m) return null;
  const year  = 2000 + parseInt(m[1], 10);
  const month = MONTH_INDEX[m[2]];
  if (month === undefined) return null;
  return { year, month };
}

/**
 * Returns true if the future contract's expiry month is in the past
 * (i.e. we are now in a strictly LATER calendar month than the contract month).
 *
 * Safe rule: a 26JUN contract is only deleted from July 1st onward, so we
 * never delete a still-trading contract regardless of the exact exchange
 * expiry date within June.
 *
 * Uses IST (UTC+5:30) for "today" so Indian-market midnight is honoured.
 */
function isFutureExpired(symbol) {
  const expiry = parseFutureExpiry(symbol);
  if (!expiry) return false; // can't parse → don't delete

  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const currentYear  = nowIst.getUTCFullYear();
  const currentMonth = nowIst.getUTCMonth(); // 0-based

  // Expired if: current year > expiry year,
  //          or: same year and current month > expiry month
  return (
    currentYear > expiry.year ||
    (currentYear === expiry.year && currentMonth > expiry.month)
  );
}

// ── Option staleness detection (2-trading-day rule) ───────────────────────────

/**
 * Count weekday (Mon–Fri) days between two Dates.
 * Approximation: no holiday calendar — just skips Sat/Sun.
 */
function tradingDaysBetween(from, to) {
  let count = 0;
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  const toDay = new Date(to);
  toDay.setUTCHours(0, 0, 0, 0);

  while (d < toDay) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/**
 * Returns true if the option has not been accessed for ≥2 trading days.
 *
 * @param {string} symbol
 * @param {Map<string, Date>} accessMap  symbol → last_accessed Date
 */
function isOptionStale(symbol, accessMap) {
  const lastAccessed = accessMap.get(symbol);
  if (!lastAccessed) {
    // Never recorded in the access log — treat as stale immediately.
    // (This can happen for option data loaded before this feature was added.)
    return true;
  }
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const elapsed = tradingDaysBetween(lastAccessed, nowIst);
  return elapsed >= 2;
}

// ── Main cleanup function ────────────────────────────────────────────────────

/**
 * Scan every symbol in the candles table, classify it, then delete
 * candle data + access-log rows for:
 *   - Futures whose contract month has passed (immediate, 0-day grace)
 *   - Options not accessed in ≥2 trading days
 *
 * Safe to call at any time — underlying equity/index symbols are untouched.
 *
 * @returns {Promise<{ deletedFutures: string[], deletedOptions: string[] }>}
 */
async function runRetentionCleanup() {
  const symbols    = await listSymbols();
  const accessMap  = await getSymbolAccessMap();

  const deletedFutures = [];
  const deletedOptions = [];

  for (const sym of symbols) {
    const kind = classifySymbol(sym);

    if (kind === "underlying") continue; // never touch

    if (kind === "future") {
      if (isFutureExpired(sym)) {
        console.log(`[Retention] 🗑  Future expired — deleting candles: ${sym}`);
        try {
          const deleted = await deleteAllCandles(sym);
          await deleteSymbolAccess(sym).catch(() => {}); // best-effort
          console.log(`[Retention] ✅  ${sym}: ${deleted} candles removed`);
          deletedFutures.push(sym);
        } catch (err) {
          console.error(`[Retention] ❌  Failed to delete future ${sym}:`, err.message);
        }
      }
      continue;
    }

    if (kind === "option") {
      if (isOptionStale(sym, accessMap)) {
        console.log(`[Retention] 🗑  Option stale (≥2 trading days since last view) — deleting candles: ${sym}`);
        try {
          const deleted = await deleteAllCandles(sym);
          await deleteSymbolAccess(sym).catch(() => {}); // best-effort
          console.log(`[Retention] ✅  ${sym}: ${deleted} candles removed`);
          deletedOptions.push(sym);
        } catch (err) {
          console.error(`[Retention] ❌  Failed to delete option ${sym}:`, err.message);
        }
      }
      continue;
    }
  }

  const total = deletedFutures.length + deletedOptions.length;
  if (total === 0) {
    console.log("[Retention] ✅  No expired/stale contracts to clean up");
  } else {
    console.log(
      `[Retention] ✅  Cleanup complete — removed ${deletedFutures.length} expired future(s), ` +
      `${deletedOptions.length} stale option(s)`
    );
  }

  return { deletedFutures, deletedOptions };
}

module.exports = {
  runRetentionCleanup,
  classifySymbol,        // exported for testing
  isFutureExpired,       // exported for testing
  isOptionStale,         // exported for testing
  tradingDaysBetween,    // exported for testing
};