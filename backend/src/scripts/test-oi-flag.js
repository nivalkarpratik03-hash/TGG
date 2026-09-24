/**
 * test-oi-flag.js
 *
 * ONE-OFF DIAGNOSTIC — does NOT boot the full server, does NOT touch the DB,
 * does NOT modify fyers/client.js. Calls fyers.getHistory() directly with
 * oi_flag added, for ONE real NIFTY option symbol, to answer exactly one
 * question: does Fyers actually return non-zero historical OI per candle
 * when oi_flag is set, on THIS account, for THIS kind of symbol?
 *
 * WHY THIS EXISTS: oi_flag is a documented parameter on Fyers' /history
 * endpoint (confirmed across multiple independent Fyers API client
 * libraries — Python, JS, Rust — and explicitly shown working together
 * with 1-minute resolution in Fyers' own official example). BUT there are
 * real user reports on Fyers' own community forum of oi_flag returning 0
 * for some option/future symbols even though the parameter is accepted
 * without error. This script settles that for this specific account
 * before any production code gets written around it — don't build the
 * feature on an assumption, confirm it first.
 *
 * HOW TO RUN (on your machine, inside backend/, with a valid Fyers token
 * already saved — same requirement as running the server for real):
 *
 *   cp test-oi-flag.js backend/src/scripts/test-oi-flag.js
 *   cd backend
 *   node src/scripts/test-oi-flag.js
 *
 * Delete it after use, same as verify-fut-fix.js/diagnoseFourFlags.js were
 * — it's a one-off check, not part of the app.
 *
 * WHAT TO DO WITH THE RESULT:
 *   - If real non-zero OI numbers print for most/all candles → oi_flag
 *     works for this account. Proceed to wire it into fyers/client.js's
 *     fetchCandles() properly (see kronos-and-oi-iv-handoff.md for the
 *     exact plan).
 *   - If OI prints as 0 for every candle → oi_flag is accepted by the API
 *     but doesn't actually populate for this symbol/segment on this
 *     account. Historical per-candle OI is a dead end — fall back to
 *     Depth API (live snapshot only, not historical) or drop the OI
 *     column idea entirely. Report back before building anything further.
 */

"use strict";

// server.js loads dotenv at the app's real entry point — standalone scripts
// in this scripts/ folder don't get that for free, so this needs its own
// require here or APP_ID (and anything else from .env) stays undefined.
require("dotenv").config();

const { loadToken, getRedirectUri } = require("../fyers/client");
const { fyersModel } = require("fyers-api-v3");

// CHANGE THIS to any real, currently-live NIFTY option symbol you have —
// same format the rest of the app already uses (e.g. from a recent
// bulkOptionFetch.js run or the Data Export page's own output).
// Example format: "NSE:NIFTY26SEP23500CE"
const TEST_SYMBOL = "NSE:NIFTY26SEP23500CE"; // ← EDIT THIS to a real live contract before running

async function main() {
  const token = loadToken(); // returns a plain string, or null — see fyers/client.js's loadToken()
  if (!token) {
    console.error("No saved Fyers token found. Log in via the app's /admin page first (same as any other script here).");
    process.exit(1);
  }
  const appId = process.env.APP_ID;
  if (!appId) {
    console.error("APP_ID missing in .env (same requirement as fyers/client.js's getFyersClient()).");
    process.exit(1);
  }

  const fyers = new fyersModel({ path: "", enableLogging: false });
  fyers.setAppId(appId);
  fyers.setRedirectUrl(getRedirectUri());
  fyers.setAccessToken(token);

  const now = Math.floor(Date.now() / 1000);
  const from = now - 3 * 86400; // last 3 days, 1-min candles — small, fast test

  console.log(`\nTesting oi_flag on: ${TEST_SYMBOL}`);
  console.log(`Range: last 3 days, resolution: 1 (1-minute)\n`);

  let res;
  try {
    res = await fyers.getHistory({
      symbol: TEST_SYMBOL,
      resolution: "1",
      date_format: "0",
      range_from: String(from),
      range_to: String(now),
      cont_flag: "1",
      oi_flag: "1", // ← the parameter being tested
    });
  } catch (err) {
    console.error("Request failed:", err.message);
    process.exit(1);
  }

  if (!res || res.s !== "ok") {
    console.error("Fyers returned an error response:", JSON.stringify(res, null, 2));
    process.exit(1);
  }

  const candles = res.candles || [];
  console.log(`Received ${candles.length} candles.\n`);

  if (candles.length === 0) {
    console.log("No candles returned at all — check TEST_SYMBOL is a real, currently-live contract.");
    process.exit(0);
  }

  // Fyers candle array shape with oi_flag=1 is documented as:
  // [ timestamp, open, high, low, close, volume, oi ]  ← 7 elements, oi is index 6
  const sample = candles.slice(0, 10);
  console.log("First 10 candles — raw arrays (checking index [6] for OI):\n");
  sample.forEach((c) => {
    const ts = new Date(c[0] * 1000).toISOString();
    const oi = c[6];
    console.log(`  ${ts} | O:${c[1]} H:${c[2]} L:${c[3]} C:${c[4]} V:${c[5]} | OI:${oi !== undefined ? oi : "MISSING (no index 6 at all)"}`);
  });

  const nonZeroOiCount = candles.filter((c) => c[6] !== undefined && c[6] !== 0).length;
  const missingIndexCount = candles.filter((c) => c[6] === undefined).length;

  console.log(`\n── RESULT ──`);
  console.log(`Total candles: ${candles.length}`);
  console.log(`Candles with a real non-zero OI value: ${nonZeroOiCount}`);
  console.log(`Candles with NO index [6] at all (array only has 6 elements): ${missingIndexCount}`);

  if (missingIndexCount === candles.length) {
    console.log(`\n→ VERDICT: oi_flag is being ignored entirely — response arrays are plain OHLCV, no 7th element.`);
  } else if (nonZeroOiCount === 0) {
    console.log(`\n→ VERDICT: oi_flag is accepted, arrays have a 7th element, but it's always 0. Matches the known community report — historical OI is NOT usable for this account/symbol type.`);
  } else if (nonZeroOiCount === candles.length) {
    console.log(`\n→ VERDICT: oi_flag WORKS — every candle has real OI. Safe to build the production feature on this.`);
  } else {
    console.log(`\n→ VERDICT: PARTIAL — some candles have real OI, some don't. Needs a closer look before building on it (maybe pre-market candles are always 0, which would be expected/fine).`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});