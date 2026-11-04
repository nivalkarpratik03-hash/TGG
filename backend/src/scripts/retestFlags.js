/**
 * backend/src/scripts/retestFlags.js
 * ─────────────────────────────────────────────────────────────────────────
 * FOLLOW-UP to diagnoseFourFlags.js's first run. Two things came out of
 * that run that need a proper retest before any code is touched:
 *
 *   1. FINNIFTY/BANKEX "SEP future no candles" — that first run tested
 *      NSE:FINNIFTY26SEPFUT / BSE:BANKEX26SEPFUT directly (the exact
 *      symbols named in the original terminal log). It did NOT go through
 *      the real resolver (nseNearMonthOffset/bseNearMonthOffset +
 *      monthCodesFromOffset — the same functions resolveFuturesSymbols()
 *      in derivativesGapFill.js actually calls). This run computes the
 *      REAL near-month symbol for FINNIFTY/BANKEX as of today and tests
 *      that, alongside SEP, so we know which one the pipeline actually
 *      needs and whether AUG has candles where SEP didn't.
 *
 *   2. GOLDM option chain — the first run's "(b) near-month futures
 *      symbol" test used MCX:GOLDM26AUGFUT, which the SAME run already
 *      proved is a dead symbol (Invalid symbol provided) — not a fair
 *      test. This retests GOLDM's option chain against
 *      MCX:GOLDM26SEPFUT, the symbol that same run confirmed IS live
 *      (3741 candles returned).
 *
 * Still pure diagnostic — no writes, no pipeline changes. Uses only real
 * exported functions (fetchCandles, fetchOptionChain, nseNearMonthOffset,
 * bseNearMonthOffset, monthCodesFromOffset) — nothing reimplemented.
 *
 * USAGE
 *   node src/scripts/retestFlags.js
 *
 * DELETE after review, same as diagnoseFourFlags.js.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { fetchCandles, fetchOptionChain } = require("../fyers/client");
const symbolsRouter = require("../routes/symbolsRouter");

const RESOLUTION = "1";
const LOOKBACK_DAYS = 5;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printHeader(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

async function testFuturesSymbol(symbol) {
  try {
    const candles = await fetchCandles(symbol, RESOLUTION, 200000, LOOKBACK_DAYS);
    console.log(`  ${symbol}: ${candles ? candles.length : 0} candle(s)`);
    return candles ? candles.length : 0;
  } catch (err) {
    console.log(`  ${symbol}: ERROR — ${err.message}`);
    return 0;
  }
}

// ── FINNIFTY (NSE) — real near-month resolver, not a hardcoded guess ───────
async function retestFinnifty() {
  printHeader("[Retest] FINNIFTY futures — real resolver output");
  const offset = symbolsRouter.nseNearMonthOffset();
  const codes = symbolsRouter.monthCodesFromOffset(2, offset);
  const symbols = codes.map((code) => `NSE:FINNIFTY${code}FUT`);
  console.log(`  nseNearMonthOffset() today = ${offset}`);
  console.log(`  real near-month symbols: ${symbols.join(", ")}`);
  for (const sym of symbols) {
    await testFuturesSymbol(sym);
    await delay(500);
  }
}

// ── BANKEX (BSE) — real near-month resolver, not a hardcoded guess ─────────
async function retestBankex() {
  printHeader("[Retest] BANKEX futures — real resolver output");
  const offset = symbolsRouter.bseNearMonthOffset();
  const codes = symbolsRouter.monthCodesFromOffset(2, offset);
  const symbols = codes.map((code) => `BSE:BANKEX${code}FUT`);
  console.log(`  bseNearMonthOffset() today = ${offset}`);
  console.log(`  real near-month symbols: ${symbols.join(", ")}`);
  for (const sym of symbols) {
    await testFuturesSymbol(sym);
    await delay(500);
  }
}

// ── GOLDM option chain — retest against the CONFIRMED-live SEP future ──────
async function retestGoldmOptions() {
  printHeader("[Retest] GOLDM option chain — MCX:GOLDM26SEPFUT (confirmed live)");
  const sym = "MCX:GOLDM26SEPFUT";
  try {
    const res = await fetchOptionChain(sym, { strikeCount: 20 });
    console.log(`  ${sym}: expiries=${res.expiries.length}, strikes=${res.strikes.length}`);
    if (res.strikes.length > 0) console.log(`  sample strike: ${JSON.stringify(res.strikes[0])}`);
    console.log(`  VERDICT: if strikes > 0, GOLDM follows the exact same pattern as CRUDEOILM/NATGASMINI/SILVERM (needs the near-month FUTURES symbol, not the bare root) — confirmed, not guessed.`);
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }
}

async function main() {
  console.log("[retestFlags] Starting — read-only, no changes.");
  await retestFinnifty();
  await delay(500);
  await retestBankex();
  await delay(500);
  await retestGoldmOptions();
  console.log("\n[retestFlags] Done. Paste this output back for the real fix.");
}

main().catch((err) => {
  console.error("[retestFlags] Fatal error:", err);
  process.exit(1);
});
