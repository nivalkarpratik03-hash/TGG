/**
 * backend/src/scripts/fetchSpotCandles.js
 * ─────────────────────────────────────────────────────────────────────────
 * Fetches ONE equity/index spot symbol's candles directly from Fyers — no
 * DB read, no DB write — at ANY timeframe (1min/3min/5min/15min/1hr/1day),
 * from a given date through today, and writes them to a single .xlsx:
 * Symbol, Date, Time, Open, High, Low, Close, Volume.
 *
 * REFACTORED (2026-09): the actual timeframe-parsing / Fyers-fetch /
 * row-building / xlsx-buffer logic now lives in
 * ../services/candleExport.js — this script is a thin CLI wrapper around
 * it. This is the SAME logic the new Data Export web page's backend
 * endpoint (routes/dataExportRouter.js) calls, so the terminal script and
 * the browser download now share one implementation instead of two that
 * could silently drift apart. Nothing about this script's usage or output
 * changed.
 *
 * USAGE
 *   cd backend
 *   node src/scripts/fetchSpotCandles.js --symbol NSE:RELIANCE-EQ --from 2024-01-01 --timeframe 1hr
 *   node src/scripts/fetchSpotCandles.js --symbol NSE:RELIANCE-EQ --from 2024-01-01 --timeframe 1day
 *   node src/scripts/fetchSpotCandles.js --symbol NSE:RELIANCE-EQ --from 2026-01-01 --timeframe 15min --out reliance_15m.xlsx
 *
 * --timeframe accepts: 1min|1m, 3min|3m, 5min|5m, 15min|15m, 1hr|1h|60min, 1day|1D|D
 * --timeframe defaults to 1day if omitted.
 *
 * Requires a valid Fyers access token already generated via /admin in the
 * frontend, exactly like every other script in backend/src/scripts/.
 * ─────────────────────────────────────────────────────────────────────────
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config();
const { loadToken, validateToken } = require("../fyers/client");
const { fetchCandleRows, rowsToXlsxBuffer, safeFilenamePart } = require("../services/candleExport");

// ── CLI args — same parseArgs() shape as backtestOptionDataFetch.js ───────
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = (args[i] || "").replace(/^--/, "");
    out[key] = args[i + 1];
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const { symbol, from, out } = args;

  if (!symbol || !from) {
    console.error(
      "Usage: node src/scripts/fetchSpotCandles.js --symbol <NSE:XXX-EQ> --from <YYYY-MM-DD> [--timeframe 1min|3min|5min|15min|1hr|1day] [--out <file.xlsx>]"
    );
    process.exit(1);
  }

  const timeframeLabel = args.timeframe || "1day";

  // Token check — same pattern backfill.js uses before touching Fyers.
  const token = loadToken();
  if (!token) {
    console.error("[FetchSpotCandles] No Fyers access token found. Visit /admin in the frontend to connect to Fyers first.");
    process.exit(1);
  }
  try {
    await validateToken();
  } catch (e) {
    console.error(`[FetchSpotCandles] Token invalid/expired: ${e.message}. Re-generate at /admin.`);
    process.exit(1);
  }

  console.log(`[FetchSpotCandles] ${symbol} | ${timeframeLabel} | ${from} → today | direct Fyers, no DB`);

  let rows;
  try {
    ({ rows } = await fetchCandleRows(symbol, from, timeframeLabel));
  } catch (e) {
    console.error(`[FetchSpotCandles] ${e.message}`);
    process.exit(1);
  }

  const buffer = rowsToXlsxBuffer(rows);
  const safeSymbol = safeFilenamePart(symbol);
  const safeTf = safeFilenamePart(timeframeLabel);
  const outPath = out || path.join(process.cwd(), `${safeSymbol}_${safeTf}_${from}_to_today.xlsx`);
  fs.writeFileSync(outPath, buffer);

  console.log(`[FetchSpotCandles] ✅ ${rows.length} candles written → ${outPath}`);
  console.log(`[FetchSpotCandles] Range: ${rows[0]?.Date} ${rows[0]?.Time} → ${rows[rows.length - 1]?.Date} ${rows[rows.length - 1]?.Time}`);
}

main().catch((e) => {
  console.error(`[FetchSpotCandles] ❌ ${e.message}`);
  process.exit(1);
});