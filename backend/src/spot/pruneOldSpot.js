/**
 * backend/src/spot/pruneOldSpot.js
 *
 * The spot equivalent of pruneExpiredDerivatives.js's export → confirm →
 * delete lifecycle — for `candles` (equities + indices), which has no
 * expiry_date to key off, so the trigger is age-based instead:
 *
 *   ROLLING MODE (default): a symbol is only touched once its EARLIEST
 *   stored row is older than ROLL_TRIGGER_DAYS (180 = ~6 months). When
 *   triggered, everything older than KEEP_DAYS (CHART_DB_WINDOW_DAYS, 90 =
 *   ~3 months) is archived and deleted, leaving the newest ~3 months in
 *   place. Symbols under the 180-day trigger are left completely alone —
 *   this is a no-op for most symbols today, since real spot data only
 *   goes back to 2026-04-01 (confirmed via direct query, not assumed).
 *
 *   INITIAL MODE (initial: true): bypasses the 180-day gate entirely and
 *   archives anything older than KEEP_DAYS right now, for every symbol —
 *   used once, deliberately, to get immediate disk relief from the
 *   current ~4.5-month backlog rather than waiting for it to reach 6
 *   months naturally. After this runs once, rolling mode is what keeps
 *   running from then on.
 *
 * Same safety rule as every other prune path in this codebase: archive
 * write is confirmed (non-empty file on disk) BEFORE any DELETE runs.
 * Never the reverse.
 *
 * This reopens parquetExport.js's documented "spot is never pruned"
 * decision — a conscious choice made with the user this session, not a
 * silent override.
 */

const fs = require("fs");
const candleStore = require("../../../database/src/store/candleStore");
const { loadIndexSpotSymbols, loadStockSpotSymbols } = require("../derivatives/curatedUnderlyingsLoader");
const { exportSpotSymbolToParquet } = require("../archive/spotParquetExport");

const KEEP_DAYS = parseInt(process.env.CHART_DB_WINDOW_DAYS || "90", 10);
const ROLL_TRIGGER_DAYS = KEEP_DAYS * 2; // 180 days by default — the "6 months" gate

function daysAgo(n, now = new Date()) {
  return new Date(now.getTime() - n * 86400 * 1000);
}

/**
 * Every curated spot symbol with its clean name and asset class, sourced
 * live from the same curated lists everything else in this codebase uses
 * (symbols/equity.json, symbols/index.json) — never a separate hardcoded
 * copy.
 */
function curatedSpotSymbols() {
  const indexes = loadIndexSpotSymbols().map((e) => ({ ...e, assetClass: "INDEX" }));
  const equities = loadStockSpotSymbols().map((e) => ({ ...e, assetClass: "EQUITY" }));
  return [...indexes, ...equities];
}

/**
 * Runs one full sweep across every curated spot symbol.
 * @param {object} [opts]
 * @param {boolean} [opts.initial=false]  bypass the 180-day gate for this run
 * @param {boolean} [opts.dryRun=false]   report what would happen, write/delete nothing
 * @param {Date} [opts.now=new Date()]
 * @returns {Promise<{scanned:number, skippedUnderGate:number, archived:number, pruned:number, failed:Array}>}
 */
async function runSpotPruneSweep({ initial = false, dryRun = false, now = new Date() } = {}) {
  const symbols = curatedSpotSymbols();
  const keepCutoff = daysAgo(KEEP_DAYS, now);
  const triggerCutoff = daysAgo(ROLL_TRIGGER_DAYS, now);

  let scanned = 0;
  let skippedUnderGate = 0;
  let archived = 0;
  let pruned = 0;
  const failed = [];

  for (const { name, symbol, assetClass } of symbols) {
    scanned++;
    try {
      // Earliest stored row for this symbol — loadCandles() already
      // orders ASC, so limit:1 gives exactly the oldest row without a
      // separate query shape.
      const [earliest] = await candleStore.loadCandles(symbol, 1, { limit: 1 });
      if (!earliest) continue; // nothing stored for this symbol at all

      if (!initial && new Date(earliest.time) >= triggerCutoff) {
        skippedUnderGate++;
        continue; // under the 6-month gate — leave completely alone
      }

      const rows = await candleStore.loadCandlesBefore(symbol, 1, keepCutoff);
      if (rows.length === 0) continue; // nothing older than the keep window yet

      if (dryRun) {
        archived++;
        console.log(`[SpotPrune][DRY-RUN] ${symbol} — would archive ${rows.length} row(s) older than ${keepCutoff.toISOString().slice(0, 10)} and delete them from candles.`);
        continue;
      }

      const exportResult = await exportSpotSymbolToParquet({ symbol, name, assetClass, rows });

      if (!exportResult.filepath) continue; // exporter itself found nothing (race-safe no-op)

      // Confirm the file genuinely landed on disk with real bytes before
      // deleting anything — same rule as every other prune path here.
      const stat = fs.statSync(exportResult.filepath);
      if (!stat.size) {
        throw new Error(`archive write produced an empty file at ${exportResult.filepath} — refusing to delete`);
      }

      archived++;
      const deleted = await candleStore.deleteCandlesBefore(symbol, 1, keepCutoff);
      if (deleted > 0) pruned++;

      console.log(`[SpotPrune] ${symbol} — archived ${exportResult.rowCount} row(s) to ${exportResult.filepath}, deleted ${deleted} row(s) older than ${keepCutoff.toISOString().slice(0, 10)}.`);
    } catch (err) {
      failed.push({ symbol, error: err.message });
      console.error(`[SpotPrune] FAILED ${symbol}: ${err.message} — left untouched.`);
    }
  }

  return { scanned, skippedUnderGate, archived, pruned, failed };
}

module.exports = { runSpotPruneSweep, curatedSpotSymbols, KEEP_DAYS, ROLL_TRIGGER_DAYS };
