/**
 * backend/src/archive/spotParquetExport.js
 *
 * Exports one spot (equity/index) symbol's old 1m candle rows to a local
 * Parquet file, sibling to parquetExport.js (which covers options/futures)
 * — this covers `candles` only, which parquetExport.js's own header
 * explicitly excludes ("Curated no-expiry spot data is intentionally never
 * archived or pruned by this pipeline"). Reopening that decision here is a
 * conscious choice, agreed with the user, not a silent override.
 *
 * Folder: {DATASET_ROOT}/SPOT/{INDEX|EQUITY}/{name}/{name}_{fromDate}_{toDate}.parquet
 *
 * Uses the clean curated `name` (e.g. "RELIANCE", "NIFTY") from
 * symbols/equity.json / symbols/index.json — NOT the raw broker symbol
 * string (e.g. "NSE:RELIANCE-EQ"). The raw string contains a colon, which
 * is illegal in a Windows path outside the drive letter, and this backend
 * runs on Windows.
 */

const fs = require("fs");
const path = require("path");
const parquet = require("parquetjs-lite");
const { datasetRoot } = require("./parquetExport");

const SPOT_SCHEMA = new parquet.ParquetSchema({
  symbol: { type: "UTF8" },
  time: { type: "INT64" },
  open: { type: "DOUBLE" },
  high: { type: "DOUBLE" },
  low: { type: "DOUBLE" },
  close: { type: "DOUBLE" },
  volume: { type: "INT64" },
});

function isoDate(msOrIso) {
  return new Date(msOrIso).toISOString().slice(0, 10);
}

function spotFolderFor(assetClass, name) {
  return path.join(datasetRoot(), "SPOT", assetClass, name);
}

/**
 * Writes ONE file for ONE symbol's given rows, in ONE open/write/close
 * session — same "no second openFile() on the same path" discipline as
 * exportContractGroupToParquet(), even though a symbol-keyed filename here
 * makes collision far less likely than the derivatives case (still: one
 * writer, one file, no exceptions).
 *
 * @param {object} args
 * @param {string} args.symbol      real DB symbol, e.g. "NSE:RELIANCE-EQ"
 * @param {string} args.name        clean curated name, e.g. "RELIANCE"
 * @param {"INDEX"|"EQUITY"} args.assetClass
 * @param {Array<{time,open,high,low,close,volume}>} args.rows  oldest-first
 * @returns {Promise<{filepath: string|null, rowCount: number}>}
 */
async function exportSpotSymbolToParquet({ symbol, name, assetClass, rows }) {
  if (!rows || rows.length === 0) {
    return { filepath: null, rowCount: 0 };
  }

  const fromDate = isoDate(rows[0].time);
  const toDate = isoDate(rows[rows.length - 1].time);

  const dir = spotFolderFor(assetClass, name);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `${name}_${fromDate}_${toDate}.parquet`);

  const writer = await parquet.ParquetWriter.openFile(SPOT_SCHEMA, filepath);
  try {
    for (const r of rows) {
      await writer.appendRow({
        symbol,
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

  return { filepath, rowCount: rows.length };
}

module.exports = { exportSpotSymbolToParquet, spotFolderFor };
