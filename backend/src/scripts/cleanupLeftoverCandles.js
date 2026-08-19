/**
 * backend/src/scripts/cleanupLeftoverCandles.js
 *
 * ONE-OFF CLEANUP: `candles` is supposed to hold spot only (equities +
 * indices). database/src/scripts/backfillDerivatives.js — the migration
 * that originally moved option/future rows out of `candles` into the 6
 * derivatives tables — explicitly never deleted the original rows from
 * `candles` (see that file's own header: kept as an audit trail). Those
 * rows were never cleaned up afterward and are still sitting there today,
 * confirmed via direct query (31 symbols, 199,998 rows as of 2026-08-13).
 *
 * This script re-derives that leftover set LIVE from the DB every run
 * (never a hardcoded symbol list) via parseDerivativeSymbol() — any symbol
 * in `candles` that parses as a dated option/future doesn't belong there.
 *
 * For each leftover symbol, one of two safe paths, NEVER a blind delete:
 *
 *   1. LIVE ELSEWHERE — a real copy already exists in the correct
 *      derivatives table (nse_options_candles, mcx_futures_candles, etc).
 *      No export needed — that table is the real, correct home for this
 *      data already. Just delete the stale `candles` copy.
 *
 *   2. NOT LIVE ELSEWHERE — no copy exists in the derivatives tables
 *      (already expired-and-pruned by pruneExpiredDerivatives.js, or the
 *      archive write failed during the disk-full crisis — either way,
 *      `candles`' copy may be the only one left). Export `candles`' own
 *      rows for that symbol to a dedicated backup folder FIRST, confirm
 *      the write actually landed on disk, and only then delete.
 *
 * Backup folder is intentionally SEPARATE from the main archive
 * (`{DATASET_ROOT}/CANDLES_LEFTOVER_BACKUP/...`, one file per symbol) —
 * never writes into the same path parquetExport.js's main archive uses,
 * so there is no risk of overwriting an existing, complete archive file.
 *
 * Dry-run by default. Nothing is deleted or written to disk unless run
 * with --confirm.
 *
 *   node backend/src/scripts/cleanupLeftoverCandles.js            (dry run)
 *   node backend/src/scripts/cleanupLeftoverCandles.js --confirm  (live run)
 */

const path = require("path");
const fs = require("fs");
const parquet = require("parquetjs-lite");
const candleStore = require("../../../database/src/store/candleStore");
const derivativesStore = require("../../../database/src/store/derivativesStore");
const { parseDerivativeSymbol } = require("../../../database/src/parsing/symbolParser");
const { datasetRoot, assetClassFor } = require("../archive/parquetExport");

const DRY_RUN = !process.argv.includes("--confirm");

const LEFTOVER_SCHEMA = new parquet.ParquetSchema({
  symbol: { type: "UTF8" },
  underlying: { type: "UTF8" },
  instrument_type: { type: "UTF8" },
  expiry_date: { type: "UTF8" },
  expiry_type: { type: "UTF8", optional: true },
  strike: { type: "DOUBLE", optional: true },
  option_type: { type: "UTF8", optional: true },
  time: { type: "INT64" },
  open: { type: "DOUBLE" },
  high: { type: "DOUBLE" },
  low: { type: "DOUBLE" },
  close: { type: "DOUBLE" },
  volume: { type: "INT64" },
});

function backupFilepath(parsed) {
  const assetClass = assetClassFor(parsed.exchange, parsed.underlying);
  const dir = path.join(datasetRoot(), "CANDLES_LEFTOVER_BACKUP", assetClass, parsed.underlying);
  // Windows path safety: raw symbols contain ":" (e.g. "NSE:360ONE26JUL1160CE"),
  // which is illegal inside a Windows filename outside the drive letter.
  const safeName = parsed.symbol.replace(/:/g, "_");
  return { dir, filepath: path.join(dir, `${safeName}.parquet`) };
}

async function run() {
  console.log(DRY_RUN
    ? "=== DRY RUN — nothing will be written or deleted. Pass --confirm to apply. ==="
    : "=== LIVE RUN — will export and delete rows. ===");

  const allSymbols = await candleStore.listSpotSymbols();
  const leftovers = allSymbols
    .map((symbol) => ({ symbol, parsed: parseDerivativeSymbol(symbol) }))
    .filter((x) => x.parsed !== null);

  console.log(`candles currently holds ${allSymbols.length} distinct symbols; ${leftovers.length} of those parse as option/future and don't belong there.\n`);

  const deletedLive = [];
  const archivedAndDeleted = [];
  const failed = [];

  for (const { symbol, parsed } of leftovers) {
    try {
      // Path 1 — real copy already lives in the correct derivatives table.
      const liveRows = await derivativesStore.loadCandlesBySymbol(
        parsed.exchange, parsed.instrument_type, symbol, { limit: 1 }
      );

      if (liveRows.length > 0) {
        if (!DRY_RUN) await candleStore.deleteAllCandles(symbol);
        deletedLive.push(symbol);
        console.log(`[LIVE-ELSEWHERE] ${symbol} — confirmed live copy exists; ${DRY_RUN ? "would delete" : "deleted"} stale candles row(s).`);
        continue;
      }

      // Path 2 — no live copy anywhere else. Must archive candles' own
      // rows before deleting anything.
      const rows = await candleStore.loadCandles(symbol, 1, { limit: 1_000_000 });
      if (rows.length === 0) {
        console.log(`[EMPTY] ${symbol} — 0 rows in candles, nothing to do.`);
        continue;
      }

      const { dir, filepath } = backupFilepath(parsed);
      if (!DRY_RUN) {
        fs.mkdirSync(dir, { recursive: true });
        const writer = await parquet.ParquetWriter.openFile(LEFTOVER_SCHEMA, filepath);
        try {
          for (const r of rows) {
            await writer.appendRow({
              symbol,
              underlying: parsed.underlying,
              instrument_type: parsed.instrument_type,
              expiry_date: parsed.expiry_date,
              expiry_type: parsed.expiry_type,
              strike: parsed.strike,
              option_type: parsed.option_type,
              time: BigInt(r.time),
              open: r.open,
              high: r.high,
              low: r.low,
              close: r.close,
              volume: BigInt(r.volume ?? 0),
            });
          }
        } finally {
          await writer.close();
        }

        // Confirm the write actually landed before deleting anything.
        const stat = fs.statSync(filepath);
        if (!stat.size) {
          throw new Error(`archive write produced an empty file at ${filepath} — refusing to delete`);
        }
        await candleStore.deleteAllCandles(symbol);
      }
      archivedAndDeleted.push({ symbol, rows: rows.length, filepath });
      console.log(`[ARCHIVED] ${symbol} — ${rows.length} row(s) ${DRY_RUN ? "would be exported" : "exported"} to ${filepath}${DRY_RUN ? "" : " and deleted from candles"}.`);
    } catch (err) {
      failed.push({ symbol, error: err.message });
      console.error(`[FAILED] ${symbol}: ${err.message} — left untouched, nothing deleted for this symbol.`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Deleted (real copy already live elsewhere): ${deletedLive.length}`);
  console.log(`Archived to backup + deleted: ${archivedAndDeleted.length}`);
  console.log(`Failed (left untouched): ${failed.length}`);
  if (failed.length) console.log(failed);
  if (DRY_RUN) console.log("\nThis was a DRY RUN — nothing was changed. Re-run with --confirm to apply for real.");
}

run()
  .then(() => process.exit(0))
  .catch((err) => { console.error("cleanupLeftoverCandles failed:", err); process.exit(1); });
