/**
 * verify-fut-fix.js
 *
 * Standalone check for the Chunk 13 / Section 4m-4n fix — does NOT boot the
 * full server, does NOT touch the DB. Just calls the real, already-fixed
 * functions directly against live Fyers, for exactly the 3 flagged cases:
 *
 *   1. FINNIFTY futures — near-month (AUG) should succeed even though
 *      next-month (SEP) legitimately has 0 candles (that's expected, not
 *      a failure — the bug was one killing the other).
 *   2. BANKEX futures — same check.
 *   3. GOLDM options — option-chain lookup should now use the near-month
 *      FUTURES symbol, not the bare "MCX:GOLDM" root, and return real
 *      strikes.
 *
 * HOW TO RUN (on your machine, inside backend/, with a valid Fyers token
 * already saved — same requirement as running the server for real):
 *
 *   cp verify-fut-fix.js backend/src/scripts/verify-fut-fix.js
 *   cd backend
 *   node src/scripts/verify-fut-fix.js
 *
 * Delete it after use, same as diagnoseFourFlags.js/retestFlags.js were —
 * it's a one-off check, not part of the app.
 */

"use strict";

const { resolveFuturesSymbols, resolveChainLookupSymbol } = require("../derivatives/derivativesGapFill");
const { loadCuratedUnderlyings } = require("../derivatives/curatedUnderlyingsLoader");
const { fetchCandles, fetchOptionChain } = require("../fyers/client");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function checkFutures(entry) {
  console.log(`\n── ${entry.underlying} futures ──`);
  let symbols;
  try {
    symbols = resolveFuturesSymbols(entry);
  } catch (err) {
    console.log(`  ❌ resolveFuturesSymbols threw: ${err.message}`);
    return;
  }
  console.log(`  Resolved symbols: ${symbols.join(", ")}`);

  const results = [];
  for (const sym of symbols) {
    try {
      const candles = await fetchCandles(sym, 1440, 5); // daily, tiny count — just checking it resolves
      results.push({ sym, ok: true, count: candles.length });
      console.log(`  ✅ ${sym} — ${candles.length} candle(s)`);
    } catch (err) {
      results.push({ sym, ok: false, err: err.message });
      console.log(`  ⚠️  ${sym} — ${err.message}`);
    }
    await sleep(2000); // avoid Fyers rate-limit between calls, same reasoning as Chunk 14's 300ms delay
  }

  const anySuccess = results.some((r) => r.ok && r.count > 0);
  if (anySuccess) {
    console.log(`  RESULT: ✅ at least one month has real data — this underlying should NOT be counted "FAILED" any more`);
  } else {
    console.log(`  RESULT: ❌ every month failed/empty — still broken, or genuinely no live contract right now`);
  }
}

async function checkCommodityOptions(entry) {
  console.log(`\n── ${entry.underlying} options (commodity) ──`);
  let lookupSymbol;
  try {
    lookupSymbol = resolveChainLookupSymbol(entry);
  } catch (err) {
    console.log(`  ❌ resolveChainLookupSymbol threw: ${err.message}`);
    return;
  }
  console.log(`  Lookup symbol used: ${lookupSymbol} (should be a near-month FUT symbol, not the bare "${entry.spotSymbol}" root)`);

  const chain = await fetchOptionChain(lookupSymbol, { strikeCount: 10 });
  console.log(`  Expiries: ${chain.expiries.length}, Strikes: ${chain.strikes.length}`);
  if (chain.strikes.length > 0) {
    console.log(`  Sample strike: ${chain.strikes[0].symbol} (${chain.strikes[0].option_type})`);
    console.log(`  RESULT: ✅ real strikes returned`);
  } else {
    console.log(`  RESULT: ❌ 0 strikes — still broken`);
  }
}

async function main() {
  const { all } = loadCuratedUnderlyings();

  const finnifty = all.find((e) => e.underlying === "FINNIFTY");
  const bankex = all.find((e) => e.underlying === "BANKEX");
  const goldm = all.find((e) => e.underlying === "GOLDM");

  if (!finnifty) console.log("⚠️  FINNIFTY not found in curated underlyings — check symbols/index.json");
  if (!bankex) console.log("⚠️  BANKEX not found in curated underlyings — check symbols/index.json");
  if (!goldm) console.log("⚠️  GOLDM not found in curated underlyings — check symbols/commodity.json");

  // Run each section with a gap between them — Fyers rate-limits sustained
  // back-to-back calls, and running all 3 with zero delay (as this script
  // originally did) can throttle the LAST check even when its own code is
  // fine. Only argv[2] === "goldm" isolates just that one check, useful for
  // re-running after a full run got rate-limited on the last section.
  const only = process.argv[2];

  if ((!only || only === "finnifty") && finnifty) {
    await checkFutures(finnifty);
    await sleep(3000);
  }
  if ((!only || only === "bankex") && bankex) {
    await checkFutures(bankex);
    await sleep(3000);
  }
  if ((!only || only === "goldm") && goldm) {
    await checkCommodityOptions(goldm);
  }

  console.log("\n── Done. Paste this whole output back if anything shows ❌. ──");
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});