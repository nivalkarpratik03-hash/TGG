/**
 * backend/src/scripts/fetchSpotCandles.js
 * ─────────────────────────────────────────────────────────────────────────
 * Fetches ONE equity/index spot symbol's candles directly from Fyers — no
 * DB read, no DB write — at ANY timeframe (1min/3min/5min/15min/1hr/1day),
 * from a given date through today, and writes them to a single .xlsx:
 * Symbol, Date, Time, Open, High, Low, Close, Volume. Same 6 OHLCV fields
 * every candle object in this backend already has — nothing invented, no
 * OI column (that only applies to futures/options, not spot).
 *
 * TIMEFRAME → MINUTES — same numeric convention already used everywhere
 * else in this repo (frontend/src/utils/formatResolution.js's
 * RESOLUTION_LABELS, and DAILY/WEEKLY/MONTHLY_RESOLUTION in
 * backend/src/services/timeframeAggregator.js) — not invented here:
 *   1min→1, 3min→3, 5min→5, 15min→15, 1hr→60, 1day→1440
 *
 * ONE FETCH FUNCTION FOR EVERY TIMEFRAME — fyers/client.js's general
 * `fetchCandles(symbol, resolution, count, lookbackDaysOverride)` already
 * branches internally by resolution:
 *   - resolution 1440 ("D")  → calls fetchDailyCandles(), 360-day chunks
 *     (Fyers' real limit is 365 days/request)
 *   - anything else (intraday) → its own 90-day-chunk path, WITH a
 *     built-in retry-on-rate-limit per chunk ("Intraday chunk hit rate
 *     limit — retrying once in 1.5s")
 * Both paths already skip a failed chunk instead of dying. That chunking
 * + retry IS the existing "don't hit the limit" logic already in this
 * repo — this script just calls it, nothing reimplemented.
 *
 * Single symbol only, so no CONCURRENCY/BATCH_DELAY_MS needed (that
 * pattern in backfill.js only guards against MANY symbols running
 * concurrently — irrelevant here). If this is ever turned into a
 * multi-symbol loop, reuse backfill.js's exact CONCURRENCY=3 /
 * BATCH_DELAY_MS=2000 constants rather than picking new numbers.
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
// Same call server.js itself uses (no explicit path — relies on dotenv's
// default cwd-relative lookup). Using the exact same call proven to work
// on this machine, instead of the path.resolve() other scripts use, which
// depends on assumptions about where .env actually sits.
require("dotenv").config();
const XLSX = require("xlsx");
const { fetchCandles, loadToken, validateToken } = require("../fyers/client");

// Same minutes convention as frontend/src/utils/formatResolution.js's
// RESOLUTION_LABELS and timeframeAggregator.js's DAILY/WEEKLY/MONTHLY_RESOLUTION.
const TIMEFRAME_TO_MINUTES = {
  "1min": 1, "1m": 1,
  "3min": 3, "3m": 3,
  "5min": 5, "5m": 5,
  "15min": 15, "15m": 15,
  "1hr": 60, "1h": 60, "60min": 60, "60m": 60,
  "1day": 1440, "1d": 1440, "1D": 1440, "D": 1440,
};

function resolveTimeframe(input) {
  if (!input) return 1440; // default: 1day
  const minutes = TIMEFRAME_TO_MINUTES[input] ?? TIMEFRAME_TO_MINUTES[input.toLowerCase()];
  if (minutes == null) {
    const valid = [...new Set(Object.values(TIMEFRAME_TO_MINUTES))].join(", ");
    throw new Error(`Unknown --timeframe "${input}". Use one of: 1min, 3min, 5min, 15min, 1hr, 1day (minutes: ${valid})`);
  }
  return minutes;
}

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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTDateTime(epochMs) {
  const dt = new Date(epochMs + IST_OFFSET_MS);
  return { date: dt.toISOString().slice(0, 10), time: dt.toISOString().slice(11, 19) };
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    console.error(`[FetchSpotCandles] --from must be YYYY-MM-DD, got "${from}"`);
    process.exit(1);
  }

  let resolution, timeframeLabel;
  try {
    timeframeLabel = args.timeframe || "1day";
    resolution = resolveTimeframe(args.timeframe);
  } catch (e) {
    console.error(`[FetchSpotCandles] ${e.message}`);
    process.exit(1);
  }

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

  const fromDate = new Date(`${from}T00:00:00+05:30`);
  if (Number.isNaN(fromDate.getTime())) {
    console.error(`[FetchSpotCandles] Could not parse --from "${from}"`);
    process.exit(1);
  }
  const lookbackDays = Math.max(1, Math.ceil((Date.now() - fromDate.getTime()) / 86400000));

  console.log(`[FetchSpotCandles] ${symbol} | ${timeframeLabel} (resolution=${resolution}) | ${from} → today (${lookbackDays} days back) | direct Fyers, no DB`);

  // ONE call for every timeframe — fetchCandles() branches internally to
  // the 360-day daily-chunk path or the 90-day intraday-chunk path based
  // on `resolution` (see header comment above).
  const candles = await fetchCandles(symbol, resolution, 999999, lookbackDays);

  if (!candles || candles.length === 0) {
    console.error(`[FetchSpotCandles] No candles returned for ${symbol} — check the symbol string and that the token is valid.`);
    process.exit(1);
  }

  // Trim to exactly >= the requested --from date (chunk-boundary math can
  // return a little earlier than asked).
  const fromMs = fromDate.getTime();
  const rows = candles
    .filter((c) => c.time >= fromMs)
    .map((c) => {
      const { date, time } = toISTDateTime(c.time);
      return {
        Symbol: symbol,
        Date: date,
        Time: time,
        Open: c.open,
        High: c.high,
        Low: c.low,
        Close: c.close,
        Volume: c.volume ?? 0,
      };
    });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Candles");

  const safeSymbol = symbol.replace(/[^A-Za-z0-9_-]/g, "_");
  const safeTf = timeframeLabel.replace(/[^A-Za-z0-9_-]/g, "_");
  const outPath = out || path.join(process.cwd(), `${safeSymbol}_${safeTf}_${from}_to_today.xlsx`);
  XLSX.writeFile(wb, outPath);

  console.log(`[FetchSpotCandles] ✅ ${rows.length} candles written → ${outPath}`);
  console.log(`[FetchSpotCandles] Range: ${rows[0]?.Date} ${rows[0]?.Time} → ${rows[rows.length - 1]?.Date} ${rows[rows.length - 1]?.Time}`);
}

main().catch((e) => {
  console.error(`[FetchSpotCandles] ❌ ${e.message}`);
  process.exit(1);
});