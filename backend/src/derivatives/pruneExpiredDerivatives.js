/**
 * backend/src/derivatives/pruneExpiredDerivatives.js
 *
 * The orchestrator for the expire → archive → prune lifecycle:
 *   1. expiryLifecycle.findAllExpiredContracts() — find every contract
 *      (one entry per exact symbol) whose expiry has definitely passed.
 *   2. GROUP those by (exchange, instrumentType, underlying, expiry_date)
 *      — e.g. every NIFTY weekly strike expiring on the same date is one
 *      group. This grouping is not optional — see the bug note below.
 *   3. For each group: parquetExport.exportContractGroupToParquet() —
 *      writes EVERY symbol in that group into ONE Parquet file, in ONE
 *      write session.
 *   4. ONLY if that export reports success does this delete each
 *      symbol's rows from Postgres — and only the symbols the export
 *      result confirms actually had rows written (perSymbol), not the
 *      whole group blindly.
 *
 * *** BUG FIX (see git history / chat log) ***
 * The original version of this file called a per-SYMBOL export
 * (exportContractToParquet) directly, one call per expired contract, with
 * no grouping. Confirmed in production: multiple strikes sharing the same
 * underlying+expiry_date all resolve to the same output filename
 * (options/weekly/{expiry_date}.parquet), and each per-symbol export
 * opened a fresh writer on that same path — which OVERWRITES rather than
 * appends. Only the last-processed strike for each date survived on disk;
 * every earlier one for that date was already deleted from Postgres by
 * the time it got overwritten. That already-lost data cannot be
 * recovered. Grouping BEFORE writing, and writing a whole group in one
 * session, is what actually fixes this — not a workaround, a structural
 * fix (there is no second openFile() on the same path anywhere in this
 * pipeline anymore).
 *
 * Does NOT push anything to GitHub — that stays manual, on your own
 * schedule, exactly as decided. This module's job ends at "safely on
 * local disk."
 */

const expiryLifecycle = require("../../../database/src/expiryLifecycle");
const derivativesStore = require("../../../database/src/derivativesStore");
const { exportContractGroupToParquet } = require("../archive/parquetExport");

function groupKey(c) {
  return `${c.exchange}::${c.instrumentType}::${c.underlying}::${c.expiry_date}`;
}

/**
 * Groups a flat list of expired contracts (one entry per symbol) into
 * groups of symbols that must be written to the same output file.
 */
function groupExpiredContracts(expired) {
  const groups = new Map();
  for (const c of expired) {
    const key = groupKey(c);
    if (!groups.has(key)) {
      groups.set(key, { exchange: c.exchange, instrumentType: c.instrumentType, underlying: c.underlying, expiry_date: c.expiry_date, symbols: [] });
    }
    groups.get(key).symbols.push(c.symbol);
  }
  return [...groups.values()];
}

/**
 * Runs one full sweep: find expired contracts, group them by output
 * file, archive each group as a single write, prune each symbol only on
 * confirmed archive success for that specific symbol.
 * @returns {Promise<{scanned:number, groups:number, archived:number, pruned:number, alreadyEmpty:number, failed:Array<{group:string, error:string}>}>}
 */
async function runPruneSweep(now = new Date()) {
  const expired = await expiryLifecycle.findAllExpiredContracts(now);
  const groups = groupExpiredContracts(expired);

  let archived = 0;
  let pruned = 0;
  let alreadyEmpty = 0;
  const failed = [];

  for (const group of groups) {
    const { exchange, instrumentType, underlying, expiry_date, symbols } = group;
    const label = groupKey(group);

    let exportResult;
    try {
      exportResult = await exportContractGroupToParquet({ exchange, instrumentType, underlying, expiry_date, symbols });
    } catch (err) {
      // Archive failed for the WHOLE group — do NOT delete ANY symbol in
      // it. Every symbol stays in Postgres, retried on the next sweep.
      failed.push({ group: label, error: err.message });
      continue;
    }

    if (exportResult.rowCount === 0) {
      // Nothing to archive for this whole group — already archived and
      // pruned in a prior run. Not a failure.
      alreadyEmpty++;
      continue;
    }

    archived++;

    // Only prune symbols the export actually confirmed had rows written
    // — perSymbol is the per-symbol row count from THIS successful
    // export, so this never deletes a symbol whose write we didn't just
    // verify.
    for (const symbol of symbols) {
      if ((exportResult.perSymbol[symbol] ?? 0) === 0) continue;
      const deleted = await derivativesStore.deleteCandlesBySymbol(exchange, instrumentType, symbol);
      if (deleted > 0) pruned++;
    }
  }

  return {
    scanned: expired.length,
    groups: groups.length,
    archived,
    pruned,
    alreadyEmpty,
    failed,
  };
}

module.exports = { runPruneSweep, groupExpiredContracts };