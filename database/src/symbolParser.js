/**
 * database/src/symbolParser.js
 *
 * Pure function(s) — no DB access, no network — that turn a raw Fyers
 * symbol string into the structured fields the new derivatives tables
 * need: underlying, exchange, instrument_type, expiry_date, expiry_type,
 * strike, option_type.
 *
 * PARSING CONVENTIONS — this is the canonical parser. Two other places used
 * to duplicate this regex logic independently and are now kept in sync by
 * calling into this file instead (P3 #13):
 *   - database/src/candleStore.js  → extractContractExpiry()  (month/year
 *     only, used for expiry-based pruning — intentionally NOT delegated,
 *     see note on isContractExpired() for why pruning stays independent)
 *   - backend/src/server.js        → deriveUnderlyingSymbol() / isOptionSymbol()
 *     now call parseDerivativeSymbol() directly, falling back to their own
 *     inline regex only if this module can't be required at all (mirrors
 *     the "DB is optional" pattern used for db/recoveryEngine in server.js).
 *   - frontend/src/utils/optionsChain.js still has its own copy — browser
 *     code can't require() this Node module, so that one stays a separate,
 *     cross-referenced duplicate, same pattern as holidays.js/holidayCalendar.js.
 *
 * Recognized formats (ticker = symbol with "EXCH:" prefix already split off):
 *   Monthly future : ROOT + YY + MON(3-letter) + "FUT"           e.g. RELIANCE26JUNFUT
 *   Monthly option : ROOT + YY + MON(3-letter) + STRIKE + CE/PE   e.g. NIFTY26JUL24000CE
 *   Weekly option  : ROOT + YY + monthChar(1) + DD + STRIKE + CE/PE  e.g. NIFTY26712000CE
 *                    (weekly month char: 1-9=Jan-Sep, O=Oct, N=Nov, D=Dec —
 *                    weekly expiries only exist for NIFTY on this platform)
 *
 * Returns null for anything that isn't a dated NSE/MCX option or future —
 * spot indices/equities (-EQ, -INDEX), MCX continuous root tickers (-I),
 * and anything unrecognized all return null and should keep going into
 * the existing `candles` table untouched.
 *
 * EXPIRY-DATE CALCULATION — exact day, not just month:
 *   - NSE monthly: last Tuesday of the contract month (NSE circular
 *     111/2025), rolled back to the previous trading day if that Tuesday
 *     is a holiday. Mirrors nseNearMonthOffset() in
 *     backend/src/routes/symbolsRouter.js.
 *   - NSE weekly (NIFTY only): the exact year/month/day encoded in the
 *     symbol, rolled back to the previous trading day if it's a holiday.
 *   - MCX: per-commodity approximate expiry day-of-month (MCX_EXPIRY_DAY
 *     below — mirrors the table in symbolsRouter.js), rolled back to the
 *     previous trading day if that day is a holiday. MCX does not publish
 *     a fixed calendar rule the way NSE does — circulars vary month to
 *     month — so this is a best-effort approximation, same caveat that
 *     already exists everywhere else in this codebase that touches MCX
 *     expiry. Unknown MCX roots fall back to the last calendar day of the
 *     contract month (flagged via the `expiryApproximate` field).
 *
 * IMPORTANT: keep MCX_EXPIRY_DAY here in sync (in spirit) with the same
 * table in backend/src/routes/symbolsRouter.js if either is updated.
 */

const path = require("path");
const { previousTradingDay } = require(
  path.resolve(__dirname, "../../backend/src/data/holidays.js")
);

const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKLY_MONTH_CHARS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];

// Same approximations used in symbolsRouter.js for building forward-looking
// contract symbols; reused here in reverse to compute the expiry date of an
// already-known MCX symbol.
const MCX_EXPIRY_DAY = {
  CRUDEOIL: 19, CRUDEOILM: 19,
  NATURALGAS: 23, NATGASMINI: 23,
  COPPER: 22, ZINC: 22, ZINCMINI: 22,
  ALUMINIUM: 22, LEAD: 22, LEADMINI: 22, NICKEL: 22,
  GOLD: 5, GOLDM: 29, GOLDPETAL: 29,
  SILVER: 27, SILVERM: 27, SILVERMIC: 27,
  MENTHAOIL: 29,
  COTTON: 29, CASTORSEED: 29,
};

const FUT_RE = /^([A-Z0-9]+?)(\d{2})([A-Z]{3})FUT$/;
const OPT_MON_RE = /^([A-Z0-9]+?)(\d{2})([A-Z]{3})(\d+(?:\.\d+)?)(CE|PE)$/;
const OPT_WK_RE = /^([A-Z0-9]+?)(\d{2})([1-9OND])(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;

/** Last day of `month` (0-based) in `year`, at midnight local time. */
function lastCalendarDayOfMonth(year, month) {
  return new Date(year, month + 1, 0);
}

/** Last Tuesday of `month` (0-based) in `year`, at midnight local time. */
function lastTuesdayOfMonth(year, month) {
  const d = lastCalendarDayOfMonth(year, month);
  while (d.getDay() !== 2) d.setDate(d.getDate() - 1);
  return d;
}

function toDateOnly(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function toISODateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute the exact expiry_date for a monthly contract on a given exchange.
 * @returns {{date: Date, approximate: boolean}}
 */
function computeMonthlyExpiry(exchange, root, year, month) {
  if (exchange === "NSE") {
    const raw = lastTuesdayOfMonth(year, month);
    return { date: previousTradingDay(raw, "NSE"), approximate: false };
  }
  // MCX
  const approxDay = MCX_EXPIRY_DAY[root];
  if (approxDay) {
    const raw = new Date(year, month, Math.min(approxDay, lastCalendarDayOfMonth(year, month).getDate()));
    return { date: previousTradingDay(raw, "MCX"), approximate: false };
  }
  // Unknown MCX root — fall back to last calendar day of month, flagged.
  const raw = lastCalendarDayOfMonth(year, month);
  return { date: previousTradingDay(raw, "MCX"), approximate: true };
}

/**
 * Compute the exact expiry_date for a weekly (NIFTY-only) contract.
 * @returns {{date: Date, approximate: boolean}}
 */
function computeWeeklyExpiry(year, month, day) {
  const raw = toDateOnly(new Date(year, month, day));
  return { date: previousTradingDay(raw, "NSE"), approximate: false };
}

/**
 * Parse a raw Fyers symbol (with or without "EXCH:" prefix) into its
 * derivatives fields. Returns null for anything that isn't a recognized
 * dated NSE/MCX option or future.
 *
 * @param {string} fullSymbol  e.g. "NSE:BANKNIFTY26JUL55000CE", "MCX:CRUDEOILM26AUGFUT"
 * @returns {null | {
 *   symbol: string,
 *   exchange: 'NSE'|'MCX',
 *   underlying: string,
 *   instrument_type: 'option'|'future',
 *   expiry_date: string,          // 'YYYY-MM-DD'
 *   expiry_type: 'weekly'|'monthly'|null,  // null for futures
 *   strike: number|null,          // null for futures
 *   option_type: 'CE'|'PE'|null,  // null for futures
 *   expiryApproximate: boolean,   // true only for unrecognized MCX roots
 * }}
 */
function parseDerivativeSymbol(fullSymbol) {
  if (!fullSymbol || typeof fullSymbol !== "string") return null;

  const colonIdx = fullSymbol.indexOf(":");
  if (colonIdx < 0) return null;
  const exchange = fullSymbol.slice(0, colonIdx);
  const ticker = fullSymbol.slice(colonIdx + 1);

  if (exchange !== "NSE" && exchange !== "MCX") return null;

  // Spot tickers (equities/indices/continuous-root) never carry expiry —
  // let them fall straight through to the existing `candles` table.
  if (ticker.endsWith("-EQ") || ticker.endsWith("-INDEX") || ticker.endsWith("-I")) return null;

  // ── Futures ──────────────────────────────────────────────────────────
  let m = FUT_RE.exec(ticker);
  if (m) {
    const [, root, yy, mon] = m;
    const monthIdx = MONTH_CODES.indexOf(mon);
    if (monthIdx < 0) return null;
    const year = 2000 + parseInt(yy, 10);
    const { date, approximate } = computeMonthlyExpiry(exchange, root, year, monthIdx);
    return {
      symbol: fullSymbol,
      exchange,
      underlying: root,
      instrument_type: "future",
      expiry_date: toISODateString(date),
      expiry_type: null,
      strike: null,
      option_type: null,
      expiryApproximate: approximate,
    };
  }

  // ── Monthly options ─────────────────────────────────────────────────
  m = OPT_MON_RE.exec(ticker);
  if (m) {
    const [, root, yy, mon, strikeStr, optType] = m;
    const monthIdx = MONTH_CODES.indexOf(mon);
    if (monthIdx < 0) return null;
    const year = 2000 + parseInt(yy, 10);
    const { date, approximate } = computeMonthlyExpiry(exchange, root, year, monthIdx);
    return {
      symbol: fullSymbol,
      exchange,
      underlying: root,
      instrument_type: "option",
      expiry_date: toISODateString(date),
      expiry_type: "monthly",
      strike: parseFloat(strikeStr),
      option_type: optType,
      expiryApproximate: approximate,
    };
  }

  // ── Weekly options (NIFTY only, NSE only) ───────────────────────────
  // Weekly expiries only exist for NIFTY on this platform (see header) —
  // restricting the root here, not just relying on real-world data never
  // producing this shape for other underlyings, so the invariant is
  // actually enforced rather than assumed.
  if (exchange === "NSE") {
    m = OPT_WK_RE.exec(ticker);
    if (m && m[1] === "NIFTY") {
      const [, root, yy, monChar, ddStr, strikeStr, optType] = m;
      const monthIdx = WEEKLY_MONTH_CHARS.indexOf(monChar);
      const day = parseInt(ddStr, 10);
      if (monthIdx < 0 || day < 1 || day > 31) return null;
      const year = 2000 + parseInt(yy, 10);
      const { date, approximate } = computeWeeklyExpiry(year, monthIdx, day);
      return {
        symbol: fullSymbol,
        exchange,
        underlying: root,
        instrument_type: "option",
        expiry_date: toISODateString(date),
        expiry_type: "weekly",
        strike: parseFloat(strikeStr),
        option_type: optType,
        expiryApproximate: approximate,
      };
    }
  }

  return null;
}

module.exports = {
  parseDerivativeSymbol,
  // exported for unit tests / debugging only:
  computeMonthlyExpiry,
  computeWeeklyExpiry,
  MCX_EXPIRY_DAY,
};