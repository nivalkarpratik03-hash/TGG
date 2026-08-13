/**
 * backend/src/scripts/diagnoseFourFlags.js
 * ─────────────────────────────────────────────────────────────────────────
 * ONE-TIME diagnostic for the 4 flagged anomalies from the 2026-08-07
 * pipeline check. Does NOT fix anything and does NOT change any pipeline
 * behavior — it only calls the SAME functions the real pipeline already
 * uses (fetchCandles, fetchOptionChain, symbolsRouter's month resolvers)
 * and prints the RAW response for each, so the next fix is based on live
 * proof instead of a guess.
 *
 * Covers:
 *   1. NSE:FINNIFTY26SEPFUT  — "no candles" flag. Symbol confirmed valid
 *      via Fyers symbol search (screenshot). This checks whether the
 *      broker actually has candle history behind it yet.
 *   2. BSE:BANKEX26SEPFUT    — same check, same reason.
 *   3. GOLDM futures         — prints exactly which future symbol(s) our
 *      own resolveFuturesSymbols()-equivalent logic (mcxNearMonthOffset +
 *      nextValidMonthCodes, both real symbolsRouter.js functions) would
 *      generate TODAY, then live-checks each one. Symbol search already
 *      showed Fyers has no AUG GOLDM future listed (only SEP onward) —
 *      this confirms whether our code is still trying to build the dead
 *      AUG contract.
 *   4. CRUDEOILM / NATGASMINI / SILVERM / GOLDM option chains — calls
 *      fetchOptionChain() with the CURRENT lookup symbol exactly as
 *      resolveChainLookupSymbol() builds it today (bare "MCX:<root>"),
 *      AND, separately, with each root's live near-month futures symbol
 *      as the underlying — since Fyers' MCX option-chain endpoint may
 *      expect a real futures contract symbol rather than a bare root.
 *      Both raw responses are printed side by side. No assumption is
 *      baked in — whichever one actually returns real strikes is the
 *      answer, read from Fyers, not guessed.
 *
 * USAGE
 *   node src/scripts/diagnoseFourFlags.js
 *
 *   Requires a valid Fyers access token already generated via generate.js,
 *   exactly like every other script in backend/src — this file makes no
 *   network calls of its own, it only calls fetchCandles/fetchOptionChain
 *   from fyers/client.js.
 *
 * DELETE THIS FILE after the run + review — one-time diagnostic only, not
 * wired into the server or any scheduler, same lifecycle as
 * verifyEquityFoEligibility.js / backtestOptionDataFetch.js.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { fetchCandles, fetchOptionChain } = require("../fyers/client");
const symbolsRouter = require("../routes/symbolsRouter");

const RESOLUTION = "1"; // matches derivativesGapFill.js's own RESOLUTION constant
const LOOKBACK_DAYS = 5; // matches OPTION_LOOKBACK_DAYS_DEFAULT — just checking recent data exists

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function printHeader(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

// ── Checks 1 & 2 — FINNIFTY / BANKEX SEP futures "no candles" ──────────────
async function checkFuturesCandles(label, symbol) {
  printHeader(`[Check] ${label}: ${symbol}`);
  try {
    const candles = await fetchCandles(symbol, RESOLUTION, 200000, LOOKBACK_DAYS);
    console.log(`  candles returned: ${candles ? candles.length : 0}`);
    if (candles && candles.length > 0) {
      console.log(`  first candle: ${JSON.stringify(candles[0])}`);
      console.log(`  last candle:  ${JSON.stringify(candles[candles.length - 1])}`);
      console.log(`  VERDICT: real candle data exists — earlier "no candles" was likely a transient/timing issue, not a symbol bug.`);
    } else {
      console.log(`  VERDICT: broker genuinely returned zero candles for this symbol right now.`);
      console.log(`  This does NOT yet prove a bug — a brand-new far-month contract can legitimately have no trades yet. Re-run this script closer to/after market hours to confirm.`);
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
  }
}

// ── Check 3 — GOLDM futures: what would our own code build today? ──────────
async function checkGoldmFutures() {
  printHeader("[Check] GOLDM futures — symbol our own resolver builds today");
  const offset = symbolsRouter.mcxNearMonthOffset("GOLDM");
  const fromMonth = new Date();
  fromMonth.setMonth(fromMonth.getMonth() + offset);
  const codes = symbolsRouter.nextValidMonthCodes("GOLDM", 2, fromMonth);
  const symbols = codes.map((code) => `MCX:GOLDM${code}FUT`);
  console.log(`  mcxNearMonthOffset("GOLDM") today = ${offset}`);
  console.log(`  symbols our resolver would generate: ${symbols.join(", ")}`);

  for (const sym of symbols) {
    try {
      const candles = await fetchCandles(sym, RESOLUTION, 200000, LOOKBACK_DAYS);
      console.log(`  ${sym}: ${candles ? candles.length : 0} candle(s)`);
    } catch (err) {
      console.log(`  ${sym}: ERROR — ${err.message}`);
    }
    await delay(500);
  }
  console.log(`  VERDICT: compare the symbols above against what Fyers symbol search actually lists for GOLDM futures. If our resolver generated a symbol Fyers doesn't list (e.g. AUG), that confirms the near-month offset/day estimate is wrong for this contract right now — read from the errors above, not assumed.`);
}

// ── Check 4 — MCX option-chain 0-strikes for the 4 flagged commodities ─────
async function checkCommodityOptionChain(root) {
  printHeader(`[Check] ${root} option chain — current lookup symbol vs near-month futures symbol`);

  // (a) exactly what resolveChainLookupSymbol() builds today for a commodity
  //     entry with a spotSymbol set (symbols/commodity.json's "symbol" field
  //     IS the spotSymbol after curatedUnderlyingsLoader's merge) — bare root.
  const bareSymbol = `MCX:${root}`;
  console.log(`  (a) current lookup symbol: ${bareSymbol}`);
  try {
    const res = await fetchOptionChain(bareSymbol, { strikeCount: 20 });
    console.log(`      expiries: ${res.expiries.length}, strikes: ${res.strikes.length}`);
    if (res.strikes.length > 0) console.log(`      sample strike: ${JSON.stringify(res.strikes[0])}`);
  } catch (err) {
    console.log(`      ERROR: ${err.message}`);
  }
  await delay(500);

  // (b) same call, but using the live near-month FUTURES symbol as the
  //     underlying instead — diagnostic only, not assumed correct.
  const offset = symbolsRouter.mcxNearMonthOffset(root);
  const fromMonth = new Date();
  fromMonth.setMonth(fromMonth.getMonth() + offset);
  const [nearCode] = symbolsRouter.nextValidMonthCodes(root, 1, fromMonth);
  const futSymbol = `MCX:${root}${nearCode}FUT`;
  console.log(`  (b) near-month futures symbol: ${futSymbol}`);
  try {
    const res = await fetchOptionChain(futSymbol, { strikeCount: 20 });
    console.log(`      expiries: ${res.expiries.length}, strikes: ${res.strikes.length}`);
    if (res.strikes.length > 0) console.log(`      sample strike: ${JSON.stringify(res.strikes[0])}`);
  } catch (err) {
    console.log(`      ERROR: ${err.message}`);
  }

  console.log(`  VERDICT: whichever of (a)/(b) actually returned real strikes above is the correct lookup-symbol shape for ${root} — read directly from Fyers' response, not guessed.`);
}

async function main() {
  console.log("[diagnoseFourFlags] Starting — live Fyers checks for the 4 flagged anomalies. This script changes nothing, only reads.");

  await checkFuturesCandles("FINNIFTY SEP future", "NSE:FINNIFTY26SEPFUT");
  await delay(500);
  await checkFuturesCandles("BANKEX SEP future", "BSE:BANKEX26SEPFUT");
  await delay(500);

  await checkGoldmFutures();
  await delay(500);

  for (const root of ["GOLDM", "CRUDEOILM", "NATGASMINI", "SILVERM"]) {
    await checkCommodityOptionChain(root);
    await delay(500);
  }

  console.log("\n[diagnoseFourFlags] Done. Review the 4 VERDICT lines above, then decide the real fix for each — this script itself makes no changes and should be deleted once reviewed.");
}

main().catch((err) => {
  console.error("[diagnoseFourFlags] Fatal error:", err);
  process.exit(1);
});
