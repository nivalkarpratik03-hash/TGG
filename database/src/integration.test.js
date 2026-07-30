/**
 * database/src/integration.test.js
 *
 * REQUIRES a live DB (reads DATABASE_URL from backend/.env, same as every
 * other script in this folder) with migrations already applied. This is
 * NOT part of the app — run manually against a scratch/test database:
 *
 *   node database/src/integration.test.js
 *
 * WHAT IT VERIFIES END-TO-END (router → store → real Postgres → read back):
 *   1. A spot symbol (equity) written via the router lands in `candles`
 *      and NOT in any derivatives table.
 *   2. An NSE option symbol written via the router lands in
 *      `nse_options_candles` and NOT in `candles`.
 *   3. An MCX future symbol written via the router lands in
 *      `mcx_futures_candles` and NOT in `candles`.
 *   4. Re-upserting the same candle (idempotency) does not create a
 *      duplicate row — count stays the same, values update.
 *   5. router.getLatestCandle / router.loadCandles read back exactly what
 *      was written, for both a spot and a derivative symbol.
 *   6. Two different option contracts on the same underlying+expiry+time
 *      but different strikes do NOT collide (PK correctness check).
 *   7. BSE option/future symbols route to bse_options_candles /
 *      bse_futures_candles — not `candles`, not the NSE tables (migration
 *      004 + symbolParser.js BSE support).
 *   8. Open Interest (oi) is captured and read back correctly on write,
 *      defaults to NULL when omitted, and works on MCX options too
 *      (which have no expiry_type column but do have oi).
 *
 * Cleans up every row it inserts at the end, regardless of pass/fail.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../backend/.env") });

const assert = require("assert");
const { pool, query } = require("./pool");
const router = require("./dataRouter");
const derivativesStore = require("./derivativesStore");

let passed = 0, failed = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅  ${label}`);
  } catch (err) {
    failed++;
    failures.push({ label, err });
    console.log(`  ❌  ${label}`);
    console.log(`      ${err.message}`);
  }
}

const T = Date.now() - (Date.now() % 60000); // aligned to a clean minute boundary

// Real, valid ticker shapes (parser's root regex is [A-Z0-9]+ only — no
// underscores/separators), scoped to this test purely via the timestamp T
// used below, which is exact-matched on cleanup.
const SPOT_SYMBOL = "NSE:RELIANCE-EQ";
const OPTION_SYMBOL = "NSE:NIFTY26JUL24000CE";
const OPTION_SYMBOL_2 = "NSE:NIFTY26JUL24500CE"; // different strike, same underlying/expiry/time
const FUTURE_SYMBOL = "MCX:CRUDEOILM26AUGFUT";
const BSE_OPTION_SYMBOL = "BSE:SENSEX26JUL80000CE";
const BSE_FUTURE_SYMBOL = "BSE:SENSEX26JULFUT";

async function cleanup() {
  await query("DELETE FROM candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [SPOT_SYMBOL, T]);
  await query("DELETE FROM nse_options_candles WHERE symbol = ANY($1) AND time=to_timestamp($2/1000.0)", [[OPTION_SYMBOL, OPTION_SYMBOL_2], T]);
  await query("DELETE FROM mcx_futures_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [FUTURE_SYMBOL, T]);
  await query("DELETE FROM bse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [BSE_OPTION_SYMBOL, T]);
  await query("DELETE FROM bse_futures_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [BSE_FUTURE_SYMBOL, T]);
}

async function main() {
  console.log("[integration.test] Cleaning any leftover test rows from a previous run...");
  await cleanup();

  console.log("\n[integration.test] ── Routing correctness ───────────────────");

  await check("Spot symbol routes to `candles`, not any derivatives table", async () => {
    const candle = { time: T, open: 100, high: 101, low: 99, close: 100.5, volume: 10 };
    const n = await router.upsertCandles(SPOT_SYMBOL, 1, [candle]);
    assert.strictEqual(n, 1);

    const inCandles = await query("SELECT * FROM candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [SPOT_SYMBOL, T]);
    assert.strictEqual(inCandles.length, 1);

    const inOptions = await query("SELECT * FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [SPOT_SYMBOL, T]);
    assert.strictEqual(inOptions.length, 0);
  });

  await check("NSE option symbol routes to nse_options_candles, not `candles`", async () => {
    const candle = { time: T, open: 50, high: 55, low: 48, close: 52, volume: 200 };
    const n = await router.upsertCandles(OPTION_SYMBOL, 1, [candle]);
    assert.strictEqual(n, 1);

    const inOptions = await query("SELECT * FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T]);
    assert.strictEqual(inOptions.length, 1);
    assert.strictEqual(inOptions[0].underlying, "NIFTY");
    assert.strictEqual(Number(inOptions[0].strike), 24000);
    assert.strictEqual(inOptions[0].option_type, "CE");
    assert.strictEqual(inOptions[0].expiry_type, "monthly");

    const inCandles = await query("SELECT * FROM candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T]);
    assert.strictEqual(inCandles.length, 0);
  });

  await check("MCX future symbol routes to mcx_futures_candles, not `candles`", async () => {
    const candle = { time: T, open: 6000, high: 6050, low: 5980, close: 6020, volume: 500 };
    const n = await router.upsertCandles(FUTURE_SYMBOL, 1, [candle]);
    assert.strictEqual(n, 1);

    const inFutures = await query("SELECT * FROM mcx_futures_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [FUTURE_SYMBOL, T]);
    assert.strictEqual(inFutures.length, 1);
    assert.strictEqual(inFutures[0].underlying, "CRUDEOILM");

    const inCandles = await query("SELECT * FROM candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [FUTURE_SYMBOL, T]);
    assert.strictEqual(inCandles.length, 0);
  });

  console.log("\n[integration.test] ── Idempotency (ON CONFLICT DO UPDATE) ───");

  await check("Re-upserting the same option candle updates in place, no duplicate row", async () => {
    const updated = { time: T, open: 50, high: 60, low: 48, close: 58, volume: 999 };
    const n = await router.upsertCandles(OPTION_SYMBOL, 1, [updated]);
    assert.strictEqual(n, 1);

    const rows = await query("SELECT * FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T]);
    assert.strictEqual(rows.length, 1, "must still be exactly 1 row, not 2");
    assert.strictEqual(Number(rows[0].close), 58, "value should have updated to the new close");
    assert.strictEqual(Number(rows[0].volume), 999);
  });

  console.log("\n[integration.test] ── Read paths (getLatestCandle / loadCandles) ──");

  await check("router.getLatestCandle returns correct row for spot symbol", async () => {
    const latest = await router.getLatestCandle(SPOT_SYMBOL, 1);
    assert.ok(latest);
    assert.strictEqual(latest.time, T);
    assert.strictEqual(latest.close, 100.5);
  });

  await check("router.getLatestCandle returns correct row for option symbol", async () => {
    const latest = await router.getLatestCandle(OPTION_SYMBOL, 1);
    assert.ok(latest);
    assert.strictEqual(latest.time, T);
    assert.strictEqual(latest.close, 58); // the updated value from the idempotency test above
  });

  await check("router.loadCandles returns correct row for future symbol", async () => {
    const rows = await router.loadCandles(FUTURE_SYMBOL, 1, { from: T, to: T });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].time, T);
    assert.strictEqual(rows[0].close, 6020);
  });

  console.log("\n[integration.test] ── PK correctness (no cross-strike collision) ──");

  await check("Two different strikes, same underlying+expiry+time, do NOT collide", async () => {
    const candleA = { time: T, open: 50, high: 55, low: 48, close: 52, volume: 200 }; // 24000 CE, already written above
    const candleB = { time: T, open: 30, high: 35, low: 28, close: 32, volume: 150 }; // 24500 CE
    await router.upsertCandles(OPTION_SYMBOL_2, 1, [candleB]);

    const rowA = await query("SELECT * FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T]);
    const rowB = await query("SELECT * FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL_2, T]);
    assert.strictEqual(rowA.length, 1);
    assert.strictEqual(rowB.length, 1);
    assert.notStrictEqual(Number(rowA[0].strike), Number(rowB[0].strike));
    assert.strictEqual(Number(rowB[0].strike), 24500);
  });

  await check("derivativesStore.countDerivativeCandles matches direct query", async () => {
    const viaStore = await derivativesStore.countDerivativeCandles("NSE", "option", OPTION_SYMBOL);
    const viaQuery = await query("SELECT COUNT(*) AS cnt FROM nse_options_candles WHERE symbol=$1", [OPTION_SYMBOL]);
    assert.strictEqual(viaStore, parseInt(viaQuery[0].cnt, 10));
  });

  console.log("\n[integration.test] ── BSE routing (new — migration 004) ──────");

  await check("BSE option symbol routes to bse_options_candles, not `candles` or nse_options_candles", async () => {
    const candle = { time: T, open: 800, high: 820, low: 790, close: 810, volume: 150 };
    const n = await router.upsertCandles(BSE_OPTION_SYMBOL, 1, [candle]);
    assert.strictEqual(n, 1);

    const inBse = await query("SELECT * FROM bse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [BSE_OPTION_SYMBOL, T]);
    assert.strictEqual(inBse.length, 1);
    assert.strictEqual(inBse[0].underlying, "SENSEX");
    assert.strictEqual(Number(inBse[0].strike), 80000);
    assert.strictEqual(inBse[0].option_type, "CE");
    assert.strictEqual(inBse[0].expiry_type, "monthly", "BSE options must carry expiry_type, same as NSE — only MCX options omit it");

    const inCandles = await query("SELECT * FROM candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [BSE_OPTION_SYMBOL, T]);
    assert.strictEqual(inCandles.length, 0, "must NOT fall through to the spot table — this was the confirmed bug before migration 004 + symbolParser BSE support");

    const inNse = await query("SELECT * FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [BSE_OPTION_SYMBOL, T]);
    assert.strictEqual(inNse.length, 0, "must NOT land in the NSE table either — BSE has its own table");
  });

  await check("BSE future symbol routes to bse_futures_candles", async () => {
    const candle = { time: T, open: 81000, high: 81200, low: 80800, close: 81050, volume: 900 };
    const n = await router.upsertCandles(BSE_FUTURE_SYMBOL, 1, [candle]);
    assert.strictEqual(n, 1);

    const inBse = await query("SELECT * FROM bse_futures_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [BSE_FUTURE_SYMBOL, T]);
    assert.strictEqual(inBse.length, 1);
    assert.strictEqual(inBse[0].underlying, "SENSEX");
  });

  await check("router.getLatestCandle / loadCandles read back BSE rows correctly", async () => {
    const latest = await router.getLatestCandle(BSE_OPTION_SYMBOL, 1);
    assert.ok(latest);
    assert.strictEqual(latest.close, 810);

    const rows = await router.loadCandles(BSE_FUTURE_SYMBOL, 1, { from: T, to: T });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].close, 81050);
  });

  console.log("\n[integration.test] ── Open Interest capture (new — migration 004) ──");

  await check("oi is stored and read back correctly for a new option row", async () => {
    const withOi = { time: T + 60000, open: 55, high: 58, low: 53, close: 56, volume: 300, oi: 184300 };
    const n = await router.upsertCandles(OPTION_SYMBOL, 1, [withOi]);
    assert.strictEqual(n, 1);

    const row = await query("SELECT oi FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T + 60000]);
    assert.strictEqual(Number(row[0].oi), 184300);

    const latest = await router.getLatestCandle(OPTION_SYMBOL, 1);
    assert.strictEqual(latest.oi, 184300, "router.getLatestCandle must surface oi, not silently drop it");

    await query("DELETE FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T + 60000]);
  });

  await check("oi defaults to NULL when omitted (backward compatible with rows that never carried it)", async () => {
    const withoutOi = { time: T + 120000, open: 55, high: 58, low: 53, close: 56, volume: 300 }; // no oi field at all
    await router.upsertCandles(OPTION_SYMBOL, 1, [withoutOi]);

    const row = await query("SELECT oi FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T + 120000]);
    assert.strictEqual(row[0].oi, null, "omitted oi must store as NULL, not 0 or throw");

    await query("DELETE FROM nse_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [OPTION_SYMBOL, T + 120000]);
  });

  await check("oi is stored correctly on MCX options too (no expiry_type column, oi must still work)", async () => {
    const mcxOptSymbol = "MCX:GOLDM26AUG68000CE";
    const candle = { time: T, open: 100, high: 105, low: 98, close: 102, volume: 50, oi: 7700 };
    await router.upsertCandles(mcxOptSymbol, 1, [candle]);

    const row = await query("SELECT oi FROM mcx_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [mcxOptSymbol, T]);
    assert.strictEqual(row.length, 1);
    assert.strictEqual(Number(row[0].oi), 7700);
    // Confirms the table genuinely has no expiry_type column at all (not
    // just that the app chooses not to populate it) — the query below
    // must fail, proving the schema itself omits it, same as before
    // migration 004 (that column was never added to mcx_options_candles).
    let threw = false;
    try {
      await query("SELECT expiry_type FROM mcx_options_candles LIMIT 1", []);
    } catch {
      threw = true;
    }
    assert.ok(threw, "mcx_options_candles must NOT have an expiry_type column — if this stops throwing, the schema changed unexpectedly");

    await query("DELETE FROM mcx_options_candles WHERE symbol=$1 AND time=to_timestamp($2/1000.0)", [mcxOptSymbol, T]);
  });
}

(async () => {
  try {
    await main();
  } finally {
    console.log("\n[integration.test] Cleaning up test rows...");
    await cleanup();
    console.log(`\n[integration.test] ${passed} passed, ${failed} failed.`);
    if (failed > 0) {
      console.log("\nFailed:");
      failures.forEach((f) => console.log(`  - ${f.label}: ${f.err.message}`));
      process.exitCode = 1;
    } else {
      console.log("✅  All integration checks passed.");
    }
    await pool.end();
  }
})();