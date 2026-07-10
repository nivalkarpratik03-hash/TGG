/**
 * database/src/backfillDerivatives.js
 *
 * ONE-TIME script — run once, not part of the live app:
 *   node database/src/backfillDerivatives.js
 *   (or: cd database && npm run backfill:derivatives)
 *
 * WHAT IT DOES
 *   1. Finds every DISTINCT symbol already sitting in `candles`.
 *   2. Runs each through parseDerivativeSymbol() — symbols that parse as
 *      a dated NSE/MCX option or future are candidates; everything else
 *      (equities, indices) is left completely untouched in `candles`.
 *   3. For each derivative symbol, reads all its resolution=1 rows from
 *      `candles` and upserts them into the correct one of the 4 new
 *      tables (nse_options_candles / mcx_options_candles /
 *      nse_futures_candles / mcx_futures_candles).
 *   4. Prints a per-symbol and total summary, plus a parse-failure list
 *      (derivative-looking symbols that didn't parse cleanly — nothing
 *      is written for these; investigate before re-running).
 *
 * SAFE TO RE-RUN — every write is INSERT ... ON CONFLICT DO UPDATE
 * (idempotent), same as the rest of this codebase.
 *
 * DOES NOT DELETE ANYTHING from `candles`. The original rows stay there
 * as an audit trail / rollback path. Once you've verified the new tables
 * (row counts, spot-checked symbols) you can optionally purge the
 * now-duplicated option/future rows out of `candles` — that is a
 * separate, deliberate step, not part of this script.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../backend/.env") });

const { pool, query } = require("./pool");
const { parseDerivativeSymbol } = require("./symbolParser");
const { upsertOptionCandles, upsertFutureCandles } = require("./derivativesStore");

const BATCH_SIZE = 2000; // rows read from `candles` per symbol chunk

async function fetchAllRowsForSymbol(symbol) {
  const rows = await query(
    `SELECT extract(epoch from time)*1000 AS time, open, high, low, close, volume
     FROM candles
     WHERE symbol=$1 AND resolution=1
     ORDER BY time ASC`,
    [symbol]
  );
  return rows.map((r) => ({
    time: Math.round(Number(r.time)),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

async function runBackfill() {
  console.log("[BackfillDerivatives] Scanning `candles` for distinct symbols...");
  const symbolRows = await query("SELECT DISTINCT symbol FROM candles ORDER BY symbol", []);
  console.log(`[BackfillDerivatives] ${symbolRows.length} distinct symbols found in candles.`);

  const candidates = [];
  const parseFailures = [];

  for (const { symbol } of symbolRows) {
    const info = parseDerivativeSymbol(symbol);
    if (info) {
      candidates.push({ symbol, info });
    } else if (looksLikeDerivativeButDidntParse(symbol)) {
      parseFailures.push(symbol);
    }
  }

  console.log(`[BackfillDerivatives] ${candidates.length} symbols recognized as NSE/MCX options or futures.`);
  if (parseFailures.length) {
    console.warn(`[BackfillDerivatives] ⚠️  ${parseFailures.length} symbol(s) LOOK like derivatives but did not parse — nothing written for these, investigate:`);
    parseFailures.forEach((s) => console.warn(`    ${s}`));
  }

  let totalRead = 0;
  let totalWritten = 0;
  let symbolsDone = 0;
  const perTable = {
    nse_options_candles: 0, mcx_options_candles: 0,
    nse_futures_candles: 0, mcx_futures_candles: 0,
  };

  for (const { symbol, info } of candidates) {
    try {
      const rows = await fetchAllRowsForSymbol(symbol);
      if (rows.length === 0) { symbolsDone++; continue; }
      totalRead += rows.length;

      const fullRows = rows.map((c) => ({ ...info, ...c }));
      const written = info.instrument_type === "option"
        ? await upsertOptionCandles(fullRows)
        : await upsertFutureCandles(fullRows);

      totalWritten += written;
      symbolsDone++;

      const tableKey = `${info.exchange.toLowerCase()}_${info.instrument_type === "option" ? "options" : "futures"}_candles`;
      perTable[tableKey] += written;

      const approxFlag = info.expiryApproximate ? " (approx expiry — unknown MCX root)" : "";
      console.log(`[BackfillDerivatives] (${symbolsDone}/${candidates.length}) ${symbol} → ${tableKey}: ${written} row(s)${approxFlag}`);
    } catch (err) {
      console.error(`[BackfillDerivatives] ❌ ${symbol}: ${err.message}`);
    }
  }

  console.log("\n[BackfillDerivatives] ── Summary ──────────────────────────");
  console.log(`  Symbols processed : ${symbolsDone}/${candidates.length}`);
  console.log(`  Rows read (candles): ${totalRead}`);
  console.log(`  Rows written total : ${totalWritten}`);
  for (const [table, count] of Object.entries(perTable)) {
    console.log(`    ${table.padEnd(22)} : ${count}`);
  }
  if (parseFailures.length) {
    console.log(`  Unparsed derivative-looking symbols: ${parseFailures.length} (see warnings above)`);
  }
  console.log("[BackfillDerivatives] Done. `candles` table left untouched — nothing deleted.");
}

// Heuristic used ONLY to flag symbols worth a human look after a parse
// miss — a raw ticker that has NSE/MCX prefix, no -EQ/-INDEX/-I suffix,
// and ends in CE/PE/FUT but still returned null from parseDerivativeSymbol
// (e.g. an unexpected format). Not used for anything except the warning list.
function looksLikeDerivativeButDidntParse(symbol) {
  const colonIdx = symbol.indexOf(":");
  if (colonIdx < 0) return false;
  const exchange = symbol.slice(0, colonIdx);
  const ticker = symbol.slice(colonIdx + 1);
  if (exchange !== "NSE" && exchange !== "MCX") return false;
  if (ticker.endsWith("-EQ") || ticker.endsWith("-INDEX") || ticker.endsWith("-I")) return false;
  return /(CE|PE|FUT)$/.test(ticker);
}

(async () => {
  try {
    await runBackfill();
  } catch (err) {
    console.error("[BackfillDerivatives] ❌ Fatal error:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
