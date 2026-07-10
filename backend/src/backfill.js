/**
 * backfill.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-TIME script: fetches 1 year of 1m candles from Fyers for every curated
 * symbol and upserts into PostgreSQL.
 *
 * Run ONCE from terminal:
 *   cd backend
 *   node src/backfill.js
 *
 * Safe to re-run — upsertCandles is idempotent (ON CONFLICT DO UPDATE).
 * Already-stored candles are not duplicated, only new/updated ones are written.
 *
 * Rate limiting: Fyers allows 10 req/sec, 200 req/min, 100,000 req/day.
 * This script uses CONCURRENCY=3 and BATCH_DELAY_MS=2000 to stay well under.
 * ~207 symbols × ~5 chunks (90d each for 1yr) = ~1035 API calls total.
 * At this pace: ~15-25 minutes to complete.
 */

require("dotenv").config();

const path = require("path");
const { fetchCandles, loadToken } = require("./fyers/client");

// ── DB ────────────────────────────────────────────────────────────────────────
let db;
try {
  db = require("../../database/src/index");
} catch (err) {
  console.error("[Backfill] ❌ Cannot load database module:", err.message);
  process.exit(1);
}

// ── Curated symbols (mirrors isCuratedSymbol logic) ───────────────────────────
const SYMBOLS_JSON = path.join(__dirname, "../../frontend/src/symbols.json");
const MCX_EXCLUDED = [
  "CRUDEOIL26JUNFUT",
  "ALUMINIUM26MAYFUT",
  "NATGASMINI26MAYFUT",
  "SILVER26JULFUT",
  "GOLD26JUNFUT",
];

function loadCuratedSymbols() {
  const all = require(SYMBOLS_JSON);
  return all
    .map((s) => s.symbol)
    .filter((sym) => !MCX_EXCLUDED.some((ex) => sym.includes(ex)));
}

// ── Throttle config ───────────────────────────────────────────────────────────
const CONCURRENCY = 3;       // symbols processed in parallel
const BATCH_DELAY_MS = 2000; // wait between batches (ms)
const LOOKBACK_DAYS = 365;   // 1 year

// ── Progress tracking ─────────────────────────────────────────────────────────
let done = 0;
let failed = 0;
let total = 0;

async function backfillSymbol(symbol) {
  try {
    // fetchCandles with lookbackDaysOverride=365 fetches in 90d chunks internally
    const candles = await fetchCandles(symbol, 1, 999999, LOOKBACK_DAYS);

    if (!candles || candles.length === 0) {
      console.warn(`[Backfill] ⚠️  ${symbol} — no candles returned, skipping`);
      failed++;
      return;
    }

    const upserted = await db.upsertCandles(symbol, 1, candles);
    done++;
    console.log(`[Backfill] ✅ (${done}/${total}) ${symbol} — ${candles.length} fetched, ${upserted} upserted`);
  } catch (err) {
    failed++;
    console.error(`[Backfill] ❌ (${done + failed}/${total}) ${symbol} — ${err.message}`);
  }
}

async function runBackfill() {
  // Verify token exists
  const token = loadToken();
  if (!token) {
    console.error("[Backfill] ❌ No Fyers access token found. Run: node src/generate.js first.");
    process.exit(1);
  }

  // Verify DB connection
  try {
    const ok = await db.healthCheck();
    if (!ok) throw new Error("healthCheck returned false");
    console.log("[Backfill] ✅ DB connection healthy");
  } catch (err) {
    console.error("[Backfill] ❌ DB connection failed:", err.message);
    process.exit(1);
  }

  const symbols = loadCuratedSymbols();
  total = symbols.length;
  console.log(`\n[Backfill] Starting 1-year backfill for ${total} curated symbols`);
  console.log(`[Backfill] Concurrency=${CONCURRENCY}, BatchDelay=${BATCH_DELAY_MS}ms, Lookback=${LOOKBACK_DAYS}d`);
  console.log(`[Backfill] Estimated time: ${Math.ceil((total / CONCURRENCY) * (BATCH_DELAY_MS / 1000 + 5))} seconds\n`);

  const startTime = Date.now();

  // Process in batches of CONCURRENCY
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(backfillSymbol));

    // Delay between batches to respect Fyers rate limits
    if (i + CONCURRENCY < symbols.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[Backfill] ─────────────────────────────────────────`);
  console.log(`[Backfill] Done in ${elapsed}s`);
  console.log(`[Backfill] ✅ Success: ${done}/${total}`);
  console.log(`[Backfill] ❌ Failed : ${failed}/${total}`);
  console.log(`[Backfill] ─────────────────────────────────────────`);

  if (failed > 0) {
    console.log(`[Backfill] Re-run the script to retry failed symbols — it's safe and idempotent.`);
  }

  process.exit(0);
}

runBackfill().catch((err) => {
  console.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
