/**
 * database/src/expiryLifecycle.js
 *
 * Finds contracts whose expiry has DEFINITELY passed, across all 6
 * derivatives tables (nse/mcx/bse × options/futures). Read-only — this
 * module never deletes or writes anything. archive/parquetExport.js +
 * derivatives/pruneExpiredDerivatives.js act on what this returns.
 *
 * Why this doesn't reuse candleStore.js's isContractExpired() directly:
 * that function derives a contract's expiry by regex-parsing the symbol
 * string, because the legacy `candles` table has no expiry_date column at
 * all. Every derivatives table here already stores expiry_date as a real
 * DATE column (that's the whole point of parseDerivativeSymbol() computing
 * it up front) — so re-deriving it from the symbol string a second time
 * would be redundant work AND a second, independently-maintained copy of
 * the same date-parsing logic to keep in sync. Comparing the stored column
 * directly is simpler and strictly more reliable.
 *
 * What IS reused: the exact same conservative safety principle as
 * isContractExpired() — a contract is only ever treated as expired
 * starting the NEXT calendar day after its expiry_date, never on the
 * expiry day itself (which may still be its final live trading day).
 * See isExpired() below — this is the one piece of logic intentionally
 * kept in lockstep with candleStore.js's rule, restated here (not
 * imported) because the input shape is different (a date, not a
 * regex-parsed {kind,year,month,day} object) and duplicating a ~4-line
 * comparison is clearer than exporting/importing across an unrelated
 * calling convention.
 */

const derivativesStore = require("./store/derivativesStore");

const EXCHANGES = ["NSE", "MCX", "BSE"];
const INSTRUMENT_TYPES = ["option", "future"];

/**
 * True if `expiryDateStr` (YYYY-MM-DD) is guaranteed to have passed as of
 * `now` — i.e. `now` is on or after the calendar day AFTER expiry_date.
 * Same safety margin as candleStore.js's isContractExpired(): a contract
 * is never treated as expired on its own expiry day, only starting the
 * next calendar day.
 */
function isExpired(expiryDateStr, now = new Date()) {
  if (!expiryDateStr) return false;
  const [y, m, d] = expiryDateStr.split("-").map((n) => parseInt(n, 10));
  const expiryDayStart = new Date(y, m - 1, d);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return expiryDayStart < todayStart;
}

/**
 * Scans one (exchange, instrumentType) table and returns every contract
 * whose expiry has definitely passed.
 * @returns {Promise<Array<{exchange, instrumentType, symbol, underlying, expiry_date}>>}
 */
async function findExpiredContracts(exchange, instrumentType, now = new Date()) {
  const contracts = await derivativesStore.listDistinctContracts(exchange, instrumentType);
  return contracts
    .filter((c) => isExpired(c.expiry_date, now))
    .map((c) => ({ exchange, instrumentType, symbol: c.symbol, underlying: c.underlying, expiry_date: c.expiry_date }));
}

/**
 * Scans all 6 derivatives tables and returns every expired contract found,
 * across every exchange and instrument type. This is the entry point
 * pruneExpiredDerivatives.js calls.
 */
async function findAllExpiredContracts(now = new Date()) {
  const results = [];
  for (const exchange of EXCHANGES) {
    for (const instrumentType of INSTRUMENT_TYPES) {
      const found = await findExpiredContracts(exchange, instrumentType, now);
      results.push(...found);
    }
  }
  return results;
}

module.exports = {
  isExpired,
  findExpiredContracts,
  findAllExpiredContracts,
};
