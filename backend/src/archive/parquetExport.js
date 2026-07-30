/**
 * backend/src/archive/parquetExport.js
 *
 * Exports one contract's finalized candle rows to a local Parquet file,
 * into the folder structure agreed during design:
 *   {DATASET_ROOT}/{ASSET_CLASS}/{UNDERLYING}/futures/{expiry_date}.parquet
 *   {DATASET_ROOT}/{ASSET_CLASS}/{UNDERLYING}/options/{expiry_date}.parquet            (single-cycle: MCX, stocks, BANKNIFTY/FINNIFTY/MIDCPNIFTY)
 *   {DATASET_ROOT}/{ASSET_CLASS}/{UNDERLYING}/options/weekly/{expiry_date}.parquet     (NIFTY, SENSEX only)
 *   {DATASET_ROOT}/{ASSET_CLASS}/{UNDERLYING}/options/monthly/{expiry_date}.parquet    (NIFTY, SENSEX only)
 *
 * DATASET_ROOT resolves this open decision from the build spec: it comes
 * from the DATASET_ROOT env var, defaulting to "./dataset" (relative to
 * wherever the backend process runs) if unset. This was flagged as an
 * open item because "Desktop/dataset" only makes sense if the backend
 * runs on the same machine as that Desktop — if it runs on a server/VM,
 * DATASET_ROOT must be set explicitly to a real path there, and synced to
 * a Desktop separately. Not resolved further here, just made
 * configurable instead of hardcoded.
 *
 * Filename convention (also previously open, resolved here): one file per
 * expiry_date, named "{expiry_date}.parquet" (e.g. "2025-07-17.parquet").
 * Deterministic and sorts naturally within a folder.
 *
 * This module ONLY covers options/futures archival (the expire→archive→
 * prune pipeline). Curated no-expiry spot data is intentionally never
 * archived or pruned by this pipeline — it stays in Postgres forever, per
 * the earlier design decision — so there is no "no-expiry" export path
 * here.
 *
 * Asset-class detection deliberately does NOT require a maintained list
 * of ~200+ equity symbols: MCX underlyings are always COMMODITY; a short,
 * stable allowlist of known index roots covers INDEX; everything else on
 * NSE/BSE is EQUITY by elimination. This avoids needing
 * curatedUnderlyings.json (still a real open item for OTHER purposes —
 * e.g. deciding which underlyings get ATM tracking at all — just not
 * needed for this specific classification).
 */

const fs = require("fs");
const path = require("path");
const parquet = require("parquetjs-lite");
const derivativesStore = require("../../../database/src/derivativesStore");
const { parseDerivativeSymbol } = require("../../../database/src/symbolParser");

// Short, stable — index roots don't change often, unlike equity lists.
const INDEX_ROOTS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX", "BANKEX"]);

function assetClassFor(exchange, underlying) {
  if (exchange === "MCX") return "COMMODITY";
  if (INDEX_ROOTS.has(underlying)) return "INDEX";
  return "EQUITY";
}

// NIFTY/SENSEX are the only underlyings that can have weekly+monthly
// alive at once (see symbolParser.js/derivativesStore.js) — everything
// else gets a flat options/ folder, no weekly/monthly split.
const DUAL_EXPIRY_ROOTS = new Set(["NIFTY", "SENSEX"]);

function datasetRoot() {
  return process.env.DATASET_ROOT || path.join(process.cwd(), "dataset");
}

function folderFor({ exchange, instrumentType, underlying, expiry_type }) {
  const root = datasetRoot();
  const assetClass = assetClassFor(exchange, underlying);
  const parts = [root, assetClass, underlying];
  if (instrumentType === "future") {
    parts.push("futures");
  } else if (DUAL_EXPIRY_ROOTS.has(underlying) && expiry_type) {
    parts.push("options", expiry_type); // "weekly" | "monthly"
  } else {
    parts.push("options");
  }
  return path.join(...parts);
}

const OPTION_SCHEMA_WITH_EXPIRY_TYPE = new parquet.ParquetSchema({
  underlying: { type: "UTF8" },
  expiry_date: { type: "UTF8" },
  expiry_type: { type: "UTF8" },
  strike: { type: "DOUBLE" },
  option_type: { type: "UTF8" },
  time: { type: "INT64" },
  open: { type: "DOUBLE" },
  high: { type: "DOUBLE" },
  low: { type: "DOUBLE" },
  close: { type: "DOUBLE" },
  volume: { type: "INT64" },
  oi: { type: "INT64", optional: true },
  symbol: { type: "UTF8" },
});

const OPTION_SCHEMA_NO_EXPIRY_TYPE = new parquet.ParquetSchema({
  underlying: { type: "UTF8" },
  expiry_date: { type: "UTF8" },
  strike: { type: "DOUBLE" },
  option_type: { type: "UTF8" },
  time: { type: "INT64" },
  open: { type: "DOUBLE" },
  high: { type: "DOUBLE" },
  low: { type: "DOUBLE" },
  close: { type: "DOUBLE" },
  volume: { type: "INT64" },
  oi: { type: "INT64", optional: true },
  symbol: { type: "UTF8" },
});

const FUTURE_SCHEMA = new parquet.ParquetSchema({
  underlying: { type: "UTF8" },
  expiry_date: { type: "UTF8" },
  time: { type: "INT64" },
  open: { type: "DOUBLE" },
  high: { type: "DOUBLE" },
  low: { type: "DOUBLE" },
  close: { type: "DOUBLE" },
  volume: { type: "INT64" },
  oi: { type: "INT64", optional: true },
  symbol: { type: "UTF8" },
});

/**
 * Exports a GROUP of contracts — all strikes that share the same
 * (exchange, instrumentType, underlying, expiry_date, folder) — into a
 * SINGLE Parquet file, written in one open/write/close session.
 *
 * *** THIS REPLACES THE OLD PER-SYMBOL exportContractToParquet(). ***
 * That version opened a fresh ParquetWriter on the same filepath once per
 * symbol — confirmed (via direct test) to silently OVERWRITE the file
 * each time, not append. In production this meant: NIFTY weekly options
 * expiring the same date all mapped to the same filename
 * (options/weekly/{expiry_date}.parquet), and each strike's export
 * clobbered the previous one — only the LAST strike processed for that
 * date survived on disk, even though every strike had already been
 * correctly deleted from Postgres by that point. That data is gone for
 * contracts already pruned before this fix — it cannot be recovered.
 * Grouping by expiry_date BEFORE writing, and writing every symbol in
 * that group into one file in one session, makes this structurally
 * impossible going forward — there is no second open() on the same path.
 *
 * @param {object} group
 * @param {string} group.exchange
 * @param {string} group.instrumentType  "option" | "future"
 * @param {string} group.underlying
 * @param {string} group.expiry_date
 * @param {string[]} group.symbols  every symbol sharing this exact
 *   (exchange, instrumentType, underlying, expiry_date) combination —
 *   e.g. every NIFTY weekly strike/CE+PE expiring on the same date.
 *
 * @returns {Promise<{filepath: string|null, rowCount: number, perSymbol: Record<string,number>}>}
 *   rowCount: 0 with filepath: null means nothing to archive for the
 *   WHOLE group (already archived+pruned in an earlier run) — not an
 *   error. perSymbol lets the caller know exactly which symbols in the
 *   group actually had rows (so it knows which ones are now safe to
 *   prune — see pruneExpiredDerivatives.js).
 */
async function exportContractGroupToParquet({ exchange, instrumentType, underlying, expiry_date, symbols }) {
  if (!symbols || symbols.length === 0) {
    return { filepath: null, rowCount: 0, perSymbol: {} };
  }

  // Per-symbol strike/option_type/expiry_type — decoded from each symbol
  // itself (the single source of truth), same reasoning as before: these
  // are contract-level facts, not columns loadCandlesBySymbol() returns.
  const parsedBySymbol = {};
  let resolvedExpiryType;
  if (instrumentType === "option") {
    for (const symbol of symbols) {
      const parsed = parseDerivativeSymbol(symbol);
      if (!parsed) {
        throw new Error(`exportContractGroupToParquet: symbol "${symbol}" no longer parses as a derivative — refusing to archive with unknown strike/option_type`);
      }
      parsedBySymbol[symbol] = parsed;
      resolvedExpiryType = parsed.expiry_type; // same for every symbol in a correctly-formed group
    }
  }

  // Load every symbol's rows FIRST, so a failure partway through never
  // leaves a half-written file behind (the writer only opens once we
  // know there's at least one real row across the whole group).
  const rowsBySymbol = {};
  let totalRows = 0;
  for (const symbol of symbols) {
    const rows = await derivativesStore.loadCandlesBySymbol(exchange, instrumentType, symbol, { limit: 1_000_000 });
    rowsBySymbol[symbol] = rows;
    totalRows += rows.length;
  }

  const perSymbol = Object.fromEntries(symbols.map((s) => [s, rowsBySymbol[s].length]));

  if (totalRows === 0) {
    return { filepath: null, rowCount: 0, perSymbol };
  }

  const dir = folderFor({ exchange, instrumentType, underlying, expiry_type: resolvedExpiryType });
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `${expiry_date}.parquet`);

  let schema;
  if (instrumentType === "future") {
    schema = FUTURE_SCHEMA;
  } else {
    schema = resolvedExpiryType ? OPTION_SCHEMA_WITH_EXPIRY_TYPE : OPTION_SCHEMA_NO_EXPIRY_TYPE;
  }

  // ONE writer, ONE open(), for every symbol in the group — this is the
  // actual fix. No second openFile() on this path happens anywhere else
  // in this function.
  const writer = await parquet.ParquetWriter.openFile(schema, filepath);
  try {
    for (const symbol of symbols) {
      const rows = rowsBySymbol[symbol];
      if (rows.length === 0) continue; // already archived+pruned earlier; nothing left for this one symbol
      const parsed = parsedBySymbol[symbol];
      for (const r of rows) {
        const row = {
          underlying,
          expiry_date,
          time: BigInt(r.time),
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: BigInt(r.volume ?? 0),
          oi: r.oi == null ? null : BigInt(r.oi),
          symbol,
        };
        if (instrumentType === "option") {
          row.strike = parsed.strike;
          row.option_type = parsed.option_type;
          if (resolvedExpiryType) row.expiry_type = resolvedExpiryType;
        }
        await writer.appendRow(row);
      }
    }
  } finally {
    await writer.close();
  }

  return { filepath, rowCount: totalRows, perSymbol };
}

module.exports = {
  exportContractGroupToParquet,
  assetClassFor,
  folderFor,
  datasetRoot,
};