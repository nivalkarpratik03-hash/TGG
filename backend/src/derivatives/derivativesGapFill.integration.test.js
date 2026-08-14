/**
 * backend/src/derivatives/derivativesGapFill.integration.test.js
 *
 * TEST FILE — not part of the running app. Run manually:
 *   node backend/src/derivatives/derivativesGapFill.integration.test.js
 * Requires real reachable Postgres (same setup as the other integration
 * tests in this project).
 *
 * fetchOptionChain/fetchCandles are MOCKED here (no live Fyers token
 * available in this environment) — but every write goes through the REAL
 * derivativesStore into REAL Postgres, and classifyMonthlyExpiry runs the
 * REAL date-classification logic against realistic mocked expiry lists.
 * The mocks are deliberately shaped to match fetchOptionChain/fetchCandles'
 * ACTUAL documented return shapes (see fyers/client.js), not invented ones.
 */

const assert = require("assert");
const { query } = require("../../../database/src/pool");
const derivativesStore = require("../../../database/src/store/derivativesStore");
const {
  runGapFillCheckpoint,
  discoverStrikes,
  classifyMonthlyExpiry,
  resolveChainLookupSymbol,
  resolveFuturesSymbols,
} = require("./derivativesGapFill");

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

const TEST_SYMBOLS = ["NSE:NIFTY26AUG24000CE", "NSE:NIFTY26AUG24050CE", "NSE:NIFTY260812345600CE", "NSE:RELIANCE26AUG3000CE", "MCX:CRUDEOILM26AUGFUT", "MCX:CRUDEOILM26SEPFUT"];
async function cleanup() {
  await query("DELETE FROM nse_options_candles WHERE symbol = ANY($1)", [TEST_SYMBOLS.filter((s) => s.startsWith("NSE:"))]);
  await query("DELETE FROM mcx_futures_candles WHERE symbol = ANY($1)", [TEST_SYMBOLS.filter((s) => s.startsWith("MCX:"))]);
}

async function main() {
  console.log("[derivativesGapFill.integration.test] cleaning any leftover rows...");
  await cleanup();

  console.log("\n[derivativesGapFill.integration.test] ── pure logic (no broker, no DB) ──");

  await check("classifyMonthlyExpiry correctly identifies the real last-Tuesday date among candidates (NSE)", () => {
    // 2026-08-25 is the last Tuesday of August 2026 (verified: Aug 2026 Tuesdays are 4,11,18,25)
    const dates = ["2026-08-04", "2026-08-11", "2026-08-18", "2026-08-25"];
    assert.strictEqual(classifyMonthlyExpiry(dates, "NSE"), "2026-08-25");
  });

  await check("classifyMonthlyExpiry correctly identifies the real last-Thursday date among candidates (BSE)", () => {
    // 2026-08-27 is the last Thursday of August 2026
    const dates = ["2026-08-06", "2026-08-13", "2026-08-20", "2026-08-27"];
    assert.strictEqual(classifyMonthlyExpiry(dates, "BSE"), "2026-08-27");
  });

  await check("classifyMonthlyExpiry returns null when no candidate matches (defensive — must not guess)", () => {
    const dates = ["2026-08-04", "2026-08-11"]; // neither is the real last Tuesday
    assert.strictEqual(classifyMonthlyExpiry(dates, "NSE"), null);
  });

  await check("resolveChainLookupSymbol returns the real spotSymbol for index/equity entries", () => {
    const entry = { spotSymbol: "NSE:NIFTY50-INDEX", assetClass: "INDEX" };
    assert.strictEqual(resolveChainLookupSymbol(entry), "NSE:NIFTY50-INDEX");
  });

  await check("resolveChainLookupSymbol returns the near-month FUTURES symbol for commodities (2026-08-07 fix)", () => {
    // ROOT-CAUSE FIX (2026-08-07): the bare-root format ("MCX:CRUDEOILM")
    // was live-confirmed BROKEN via retestFlags.js -- Fyers' option-chain
    // endpoint returned "Please provide a valid symbol" for all 4
    // commodities tested. The near-month futures symbol format is what
    // Fyers actually accepts (confirmed live, real strikes returned for
    // all 4). This test now asserts the corrected behavior.
    const entry = { spotSymbol: "MCX:CRUDEOILM", assetClass: "COMMODITY", exchange: "MCX", underlying: "CRUDEOILM" };
    const result = resolveChainLookupSymbol(entry);
    assert.ok(result.startsWith("MCX:CRUDEOILM"), `expected a CRUDEOILM futures symbol, got "${result}"`);
    assert.ok(result.endsWith("FUT"), `expected a futures symbol ending in FUT, got "${result}"`);
  });

  await check("resolveFuturesSymbols builds real current+next month symbols for an NSE index entry", () => {
    const entry = { exchange: "NSE", underlying: "NIFTY" };
    const symbols = resolveFuturesSymbols(entry);
    assert.strictEqual(symbols.length, 2);
    assert.ok(symbols[0].startsWith("NSE:NIFTY"));
    assert.ok(symbols[0].endsWith("FUT"));
    assert.notStrictEqual(symbols[0], symbols[1], "current and next month must differ");
  });

  await check("resolveFuturesSymbols builds real current+next month symbols for an MCX commodity entry", () => {
    const entry = { exchange: "MCX", underlying: "CRUDEOILM" };
    const symbols = resolveFuturesSymbols(entry);
    assert.strictEqual(symbols.length, 2);
    assert.ok(symbols[0].startsWith("MCX:CRUDEOILM"));
    assert.ok(symbols[0].endsWith("FUT"));
  });

  console.log("\n[derivativesGapFill.integration.test] ── discoverStrikes (mocked broker, real classification) ──");

  await check("discoverStrikes for a single-cycle underlying (BANKNIFTY-style) makes exactly 1 broker call", async () => {
    let callCount = 0;
    const mockChain = async (symbol, opts) => {
      callCount++;
      return {
        expiries: [{ date: "2026-08-25", expiry: "1787788800" }],
        strikes: [
          { symbol: "NSE:BANKNIFTY26AUG55000CE", strike_price: 55000, option_type: "CE", ltp: 100, oi: 1000 },
          { symbol: "NSE:BANKNIFTY26AUG55000PE", strike_price: 55000, option_type: "PE", ltp: 90, oi: 900 },
        ],
      };
    };
    const entry = { spotSymbol: "NSE:NIFTYBANK-INDEX", assetClass: "INDEX", exchange: "NSE", expiryTypes: ["monthly"] };
    const result = await discoverStrikes(entry, 4, { fetchOptionChain: mockChain });
    assert.strictEqual(callCount, 1, "single-cycle underlying must make exactly 1 chain call, not 2");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].expiryType, "monthly");
  });

  await check("discoverStrikes for a dual-cycle underlying (NIFTY-style) makes 2 broker calls when nearest isn't the monthly one", async () => {
    let calls = [];
    const mockChain = async (symbol, opts) => {
      calls.push(opts.timestamp || "nearest");
      if (!opts.timestamp) {
        // nearest call returns the WEEKLY expiry (soonest) as first in list
        return {
          expiries: [
            { date: "2026-08-04", expiry: "TS_WEEKLY" }, // not last Tuesday of Aug 2026 -> weekly
            { date: "2026-08-25", expiry: "TS_MONTHLY" }, // real last Tuesday of Aug 2026 -> monthly
          ],
          strikes: [{ symbol: "NSE:NIFTY26804 24000CE".replace(" ", ""), strike_price: 24000, option_type: "CE", ltp: 50, oi: 500 }],
        };
      }
      // second call, for the classified monthly timestamp
      return {
        expiries: [],
        strikes: [{ symbol: "NSE:NIFTY26AUG24000CE", strike_price: 24000, option_type: "CE", ltp: 60, oi: 600 }],
      };
    };
    const entry = { spotSymbol: "NSE:NIFTY50-INDEX", assetClass: "INDEX", exchange: "NSE", expiryTypes: ["weekly", "monthly"] };
    const result = await discoverStrikes(entry, 4, { fetchOptionChain: mockChain });
    assert.strictEqual(calls.length, 2, "dual-cycle underlying must make exactly 2 chain calls when nearest != monthly");
    assert.strictEqual(calls[1], "TS_MONTHLY", "the second call must use the REAL classified monthly timestamp, not a guessed one");
    const types = result.map((r) => r.expiryType).sort();
    assert.deepStrictEqual(types, ["monthly", "weekly"]);
  });

  console.log("\n[derivativesGapFill.integration.test] ── real Postgres writes (mocked broker, real DB) ──");

  await check("a brand-new option symbol triggers the RETROACTIVE (90-day) lookback, not the normal 5-day one", async () => {
    let capturedLookback = null;
    const mockCandles = async (symbol, resolution, count, lookbackDays) => {
      capturedLookback = lookbackDays;
      return [{ time: Date.now(), open: 10, high: 11, low: 9, close: 10.5, volume: 100, oi: 500 }];
    };
    const entry = { exchange: "NSE" };
    const { backfillOptionSymbol } = require("./derivativesGapFill");
    const r = await backfillOptionSymbol(entry, "NSE:NIFTY26AUG24000CE", { fetchCandles: mockCandles });
    assert.strictEqual(capturedLookback, 90, `brand-new symbol must use the 90-day retroactive lookback, got ${capturedLookback}`);
    assert.strictEqual(r.isNew, true);
    assert.strictEqual(r.stored, 1);

    const row = await query("SELECT oi FROM nse_options_candles WHERE symbol=$1", ["NSE:NIFTY26AUG24000CE"]);
    assert.strictEqual(row.length, 1, "the mocked candle must have actually landed in real Postgres");
    assert.strictEqual(Number(row[0].oi), 500);
  });

  await check("an ALREADY-TRACKED option symbol triggers the normal (5-day) lookback, not a full re-backfill", async () => {
    let capturedLookback = null;
    const mockCandles = async (symbol, resolution, count, lookbackDays) => {
      capturedLookback = lookbackDays;
      return [{ time: Date.now() + 60000, open: 10, high: 11, low: 9, close: 10.5, volume: 100, oi: 501 }];
    };
    const entry = { exchange: "NSE" };
    const { backfillOptionSymbol } = require("./derivativesGapFill");
    // symbol already has 1 row from the previous check — must NOT be treated as new this time
    const r = await backfillOptionSymbol(entry, "NSE:NIFTY26AUG24000CE", { fetchCandles: mockCandles });
    assert.strictEqual(capturedLookback, 5, `already-tracked symbol must use the normal 5-day lookback, got ${capturedLookback}`);
    assert.strictEqual(r.isNew, false);
  });

  await check("full checkpoint sweep, MCX-close label, discovers+backfills BOTH commodity options and futures now", async () => {
    const mockCandles = async (symbol) => [{ time: Date.now(), open: 100, high: 105, low: 98, close: 102, volume: 50, oi: 900 }];
    const mockChain = async (symbol, opts) => ({
      expiries: [{ date: "2026-08-19", expiry: "TS_CRUDEOILM_AUG" }],
      strikes: [
        { symbol: "MCX:CRUDEOILM26AUG8700CE", strike_price: 8700, option_type: "CE", ltp: 500, oi: 900 },
        { symbol: "MCX:CRUDEOILM26AUG8700PE", strike_price: 8700, option_type: "PE", ltp: 400, oi: 800 },
      ],
    });
    const result = await runGapFillCheckpoint("mcx_close", { fetchCandles: mockCandles, fetchOptionChain: mockChain, validateToken: async () => true });

    assert.strictEqual(result.skipped.length, 0, "nothing should be skipped now that the commodity lookup format is confirmed");
    assert.ok(result.failed.length === 0, `expected 0 real failures, got: ${JSON.stringify(result.failed)}`);
    assert.ok(result.optionsBackfilled > 0, "commodity OPTIONS must now actually be discovered and backfilled, not skipped");
    assert.ok(result.futuresBackfilled > 0, "commodity FUTURES must still be backfilled");

    const optRow = await query("SELECT * FROM mcx_options_candles WHERE symbol LIKE 'MCX:CRUDEOILM%'");
    assert.ok(optRow.length > 0, "a real CRUDEOILM option row must have actually landed in Postgres");
    const futRow = await query("SELECT * FROM mcx_futures_candles WHERE symbol LIKE 'MCX:CRUDEOILM%'");
    assert.ok(futRow.length > 0, "a real CRUDEOILM futures row must have actually landed in Postgres");

    await query("DELETE FROM mcx_options_candles WHERE symbol LIKE 'MCX:CRUDEOILM%'");
  });

  console.log(`\n[derivativesGapFill.integration.test] ${passed} passed, ${failed} failed.`);
  await cleanup();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});