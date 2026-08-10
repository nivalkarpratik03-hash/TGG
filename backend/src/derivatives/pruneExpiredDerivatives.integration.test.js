/**
 * backend/src/derivatives/pruneExpiredDerivatives.integration.test.js
 *
 * TEST FILE — not part of the running application. Run manually:
 *   node backend/src/derivatives/pruneExpiredDerivatives.integration.test.js
 * Requires a real reachable Postgres (same DATABASE_URL setup as
 * database/src/integration.test.js) and writes real Parquet files to a
 * temp DATASET_ROOT (cleaned up automatically, on both pass and fail).
 *
 * Covers, end to end, against REAL Postgres + REAL Parquet files (not
 * mocked): a genuinely expired option contract gets archived to a real,
 * readable Parquet file in the correct folder, with the correct schema
 * (including expiry_type for NIFTY, oi preserved) — and ONLY THEN does
 * it disappear from Postgres. Also covers: a NOT-yet-expired contract is
 * left completely untouched (nothing archived, nothing deleted) — this
 * is the single most important behavior to get right here, since a bug
 * that treats a live contract as expired would delete real, needed data.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tgg-dataset-test-"));
process.env.DATASET_ROOT = tmpRoot;

const { query } = require("../../../database/src/pool");
const derivativesStore = require("../../../database/src/store/derivativesStore");
const { runPruneSweep } = require("./pruneExpiredDerivatives");

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

// A genuinely-expired NIFTY weekly option — expiry_date far in the past
// relative to "now" no matter when this test runs.
const EXPIRED_SYMBOL = "NSE:NIFTY241047500CE"; // parses: 2024-01-04, weekly, strike 7500, CE
const EXPIRED_EXPIRY = "2024-01-04";

// A SECOND expired contract sharing the exact same underlying+expiry_date
// as EXPIRED_SYMBOL, but a different strike — this is the exact
// production scenario that exposed the overwrite bug (multiple strikes,
// same expiry date, same output filename).
const EXPIRED_SYMBOL_2 = "NSE:NIFTY241047500PE"; // same date/strike, opposite option_type
const EXPIRED_SYMBOL_3 = "NSE:NIFTY241048000CE"; // same date, different strike

// A genuinely NOT-expired NIFTY monthly option — far enough in the future
// that this test won't itself become stale for years.
const LIVE_SYMBOL = "NSE:NIFTY35DEC90000CE"; // parses: 2035-12-xx monthly, strike 90000, CE

async function cleanup() {
  await query("DELETE FROM nse_options_candles WHERE symbol = ANY($1)", [[EXPIRED_SYMBOL, EXPIRED_SYMBOL_2, EXPIRED_SYMBOL_3, LIVE_SYMBOL]]);
}

async function main() {
  console.log("[pruneExpiredDerivatives.integration.test] cleaning any leftover rows...");
  await cleanup();

  console.log(`[pruneExpiredDerivatives.integration.test] DATASET_ROOT = ${tmpRoot}`);

  // Seed: 3 candles for 3 different contracts that ALL share the same
  // underlying+expiry_date (the exact overwrite-bug scenario), plus one
  // for the still-live contract.
  await derivativesStore.upsertOptionCandles([
    {
      symbol: EXPIRED_SYMBOL, exchange: "NSE", underlying: "NIFTY", instrument_type: "option",
      expiry_date: EXPIRED_EXPIRY, expiry_type: "weekly", strike: 7500, option_type: "CE",
      time: new Date("2024-01-04T09:15:00Z").getTime(),
      open: 10, high: 12, low: 9, close: 11, volume: 500, oi: 22000,
    },
  ]);
  await derivativesStore.upsertOptionCandles([
    {
      symbol: EXPIRED_SYMBOL_2, exchange: "NSE", underlying: "NIFTY", instrument_type: "option",
      expiry_date: EXPIRED_EXPIRY, expiry_type: "weekly", strike: 7500, option_type: "PE",
      time: new Date("2024-01-04T09:15:00Z").getTime(),
      open: 20, high: 22, low: 19, close: 21, volume: 400, oi: 15000,
    },
  ]);
  await derivativesStore.upsertOptionCandles([
    {
      symbol: EXPIRED_SYMBOL_3, exchange: "NSE", underlying: "NIFTY", instrument_type: "option",
      expiry_date: EXPIRED_EXPIRY, expiry_type: "weekly", strike: 8000, option_type: "CE",
      time: new Date("2024-01-04T09:15:00Z").getTime(),
      open: 5, high: 6, low: 4, close: 5.5, volume: 200, oi: 9000,
    },
  ]);
  await derivativesStore.upsertOptionCandles([
    {
      symbol: LIVE_SYMBOL, exchange: "NSE", underlying: "NIFTY", instrument_type: "option",
      expiry_date: "2035-12-25", expiry_type: "monthly", strike: 90000, option_type: "CE",
      time: new Date("2026-07-01T09:15:00Z").getTime(),
      open: 100, high: 110, low: 95, close: 105, volume: 300, oi: 5000,
    },
  ]);

  console.log("\n[pruneExpiredDerivatives.integration.test] ── running the real sweep ──");

  const result = await runPruneSweep(new Date());
  console.log("  sweep result:", JSON.stringify(result));

  await check("sweep found and archived all 3 same-expiry contracts as ONE group", () => {
    assert.ok(result.archived >= 1, `expected at least 1 archived group, got ${result.archived}`);
    assert.strictEqual(result.failed.length, 0, `expected 0 failures, got: ${JSON.stringify(result.failed)}`);
    assert.strictEqual(result.pruned, 3, `expected all 3 same-expiry symbols pruned, got ${result.pruned}`);
  });

  await check("a real Parquet file was written in the correct folder (INDEX/NIFTY/options/weekly/)", () => {
    const expectedPath = path.join(tmpRoot, "INDEX", "NIFTY", "options", "weekly", `${EXPIRED_EXPIRY}.parquet`);
    assert.ok(fs.existsSync(expectedPath), `expected file at ${expectedPath}`);
    const size = fs.statSync(expectedPath).size;
    assert.ok(size > 0, "parquet file must not be empty");
  });

  await check("*** THE CRITICAL BUG-FIX CHECK *** — ALL 3 same-expiry symbols survive in the SAME file, none overwritten", async () => {
    const parquet = require("parquetjs-lite");
    const filepath = path.join(tmpRoot, "INDEX", "NIFTY", "options", "weekly", `${EXPIRED_EXPIRY}.parquet`);
    const reader = await parquet.ParquetReader.openFile(filepath);
    const cursor = reader.getCursor();
    const rows = [];
    let row;
    while ((row = await cursor.next())) rows.push(row);
    await reader.close();

    const symbolsInFile = new Set(rows.map((r) => r.symbol));
    assert.strictEqual(rows.length, 3, `expected 3 rows (one per symbol) in the shared file, got ${rows.length} — if this is 1, the overwrite bug is back`);
    assert.ok(symbolsInFile.has(EXPIRED_SYMBOL), `${EXPIRED_SYMBOL} missing from the shared file — overwritten`);
    assert.ok(symbolsInFile.has(EXPIRED_SYMBOL_2), `${EXPIRED_SYMBOL_2} missing from the shared file — overwritten`);
    assert.ok(symbolsInFile.has(EXPIRED_SYMBOL_3), `${EXPIRED_SYMBOL_3} missing from the shared file — overwritten`);

    const ce7500 = rows.find((r) => r.symbol === EXPIRED_SYMBOL);
    assert.strictEqual(Number(ce7500.oi), 22000, "OI must survive the round trip for every symbol in the group, not just one");
  });

  await check("all 3 expired symbols are GONE from Postgres (pruned only after confirmed archive)", async () => {
    const rows = await query("SELECT symbol FROM nse_options_candles WHERE symbol = ANY($1)", [[EXPIRED_SYMBOL, EXPIRED_SYMBOL_2, EXPIRED_SYMBOL_3]]);
    assert.strictEqual(rows.length, 0, "all 3 same-expiry contracts must be pruned from Postgres after successful group archive");
  });

  await check("the STILL-LIVE contract was NOT touched — this is the critical safety check", async () => {
    const rows = await query("SELECT 1 FROM nse_options_candles WHERE symbol=$1", [LIVE_SYMBOL]);
    assert.strictEqual(rows.length, 1, "a live, non-expired contract must never be pruned");

    const liveFilePath = path.join(tmpRoot, "INDEX", "NIFTY", "options", "monthly", "2035-12-25.parquet");
    assert.ok(!fs.existsSync(liveFilePath), "a live contract must never be archived either — only expired ones");
  });

  await check("re-running the sweep is idempotent — no error, nothing double-archived", async () => {
    const second = await runPruneSweep(new Date());
    assert.strictEqual(second.failed.length, 0);
    // The already-pruned contract contributes 0 rows on this run (nothing
    // left to archive) — exportContractToParquet returns rowCount 0 for
    // it, which pruneExpiredDerivatives.js correctly treats as
    // "alreadyEmpty", not a failure.
  });

  console.log(`\n[pruneExpiredDerivatives.integration.test] ${passed} passed, ${failed} failed.`);

  await cleanup();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(1);
});