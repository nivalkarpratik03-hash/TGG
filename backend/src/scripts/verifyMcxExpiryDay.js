/**
 * backend/src/scripts/verifyMcxExpiryDay.js
 * ─────────────────────────────────────────────────────────────────────────
 * Live-verification script for the "commodity early-cutoff" item (Remaining
 * #4 in GapFill-checkpoint-redesign.md): CRUDEOIL/COPPER/SILVER/MENTHAOIL/
 * GOLDPETAL/NATURALGAS all show the same 18-27-day-early-cutoff signature
 * that GOLDM had before its expiry-day fix. Same standard required before
 * touching MCX_EXPIRY_DAY for any of them: a real, live-confirmed Fyers
 * result, not a guess.
 *
 * SCOPE FINDING (checked before writing this, not assumed):
 *   MCX_EXPIRY_DAY (backend/src/routes/symbolsRouter.js) has TWO kinds of
 *   keys — the suffixed roots this app actually tracks via
 *   symbols/commodity.json (CRUDEOILM, NATGASMINI, SILVERM, GOLDM,
 *   SILVERMIC), and a second set of bare/full-size roots (CRUDEOIL,
 *   NATURALGAS, COPPER, SILVER, MENTHAOIL, plus others like ZINC/
 *   ALUMINIUM/COTTON) that are NOT in commodity.json's tracked 6.
 *   buildFutures() in symbolsRouter.js only ever loops over
 *   commodity.json's roots, so the bare-name entries look unreachable from
 *   this app's current pipeline — leftover from the pre-2026-07-31 broader
 *   mcx.json system. That bare-name set is exactly what the Parquet gap
 *   analysis flagged. This script does NOT assume which system produced
 *   the Parquet data; it tests BOTH forms live so the real answer (live
 *   symbol or dead symbol) comes from Fyers, not from guessing which code
 *   path made the file.
 *
 * METHOD — for each root pair below:
 *   1. mcxNearMonthOffset(root) + nextValidMonthCodes(root, 3, fromMonth)
 *      — REUSED verbatim from symbolsRouter.js (both already exported),
 *      not reimplemented — to compute the real near/next/far month codes
 *      exactly the way this app's own symbol search already does.
 *   2. fetchCandles() on each resulting MCX:{root}{code}FUT symbol — real
 *      candles present = live/tradable symbol; 0 candles or an error =
 *      not live under this name.
 *   3. fetchOptionChain() on the near-month symbol — Fyers' own live
 *      expiries[] array is the ground truth for "when does this contract
 *      actually expire," directly comparable against MCX_EXPIRY_DAY's
 *      static day-of-month approximation (carried below as REFERENCE data
 *      only, copied verbatim from symbolsRouter.js on 2026-08-11 for this
 *      report — MCX_EXPIRY_DAY itself is not exported, so it can't be
 *      imported directly; if it's ever exported later, replace this copy
 *      with a real import instead of maintaining two copies).
 *
 * GOLDM is included as a KNOWN-GOOD CONTROL (already confirmed fixed
 * 2026-08-10, live-verified ~4th-5th) — same spirit as
 * verifyEquityFoEligibility.js's known-answer set: if this script's method
 * disagrees with GOLDM's already-confirmed answer, that's evidence the
 * METHOD is wrong, not that GOLDM's answer was wrong.
 *
 * This is READ-ONLY — no writes to MCX_EXPIRY_DAY, symbolsRouter.js, or
 * any config. Writes a REPORT file only. Review the report, confirm each
 * finding against a real Fyers app screenshot (same bar as GOLDM's fix),
 * THEN edit MCX_EXPIRY_DAY by hand.
 *
 * USAGE
 *   node src/scripts/verifyMcxExpiryDay.js [--out <path>]
 *
 *   Requires a valid Fyers access token already generated via generate.js,
 *   exactly like every other script in backend/src/scripts.
 *
 * DELETE THIS FILE after the run + review — one-time verification tool,
 * same lifecycle as verifyEquityFoEligibility.js / retestFlags.js.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { fetchCandles, fetchOptionChain } = require("../fyers/client");
const { mcxNearMonthOffset, nextValidMonthCodes } = require("../routes/symbolsRouter");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const DEFAULT_REPORT_PATH = path.resolve(__dirname, "../../../symbols/mcx-expiry-day-verification-report.json");

// Same spirit as verifyEquityFoEligibility.js / retestFlags.js's per-symbol
// polite delay — reused value (500ms), not a new number.
const CHAIN_POLITE_DELAY_MS = 500;
const CANDLE_LOOKBACK_DAYS = 5;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = (args[i] || "").replace(/^--/, "");
    out[key] = args[i + 1];
  }
  return out;
}

// REFERENCE COPY ONLY — read directly from symbolsRouter.js on 2026-08-11.
// Not imported (MCX_EXPIRY_DAY is not exported from that file) — carried
// here only so this report can show "approx says X" next to "Fyers says Y"
// in one place. If MCX_EXPIRY_DAY is exported later, replace this with a
// real import so there's one source of truth, not two.
const ROOTS_TO_CHECK = [
  { root: "CRUDEOIL", approxExpiryDay: 19, tracked: false, note: "Bare/full-size root — NOT in symbols/commodity.json's tracked 6. Testing whether this is even a live Fyers symbol under this codebase's own month-code logic." },
  { root: "CRUDEOILM", approxExpiryDay: 19, tracked: true, note: "Tracked root (symbols/commodity.json) — control/cross-check against CRUDEOIL above." },
  { root: "NATURALGAS", approxExpiryDay: 23, tracked: false, note: "Bare/full-size root — NOT tracked." },
  { root: "NATGASMINI", approxExpiryDay: 23, tracked: true, note: "Tracked root — control/cross-check against NATURALGAS above." },
  { root: "COPPER", approxExpiryDay: 22, tracked: false, note: "Bare root — NOT tracked, no suffixed counterpart exists in MCX_EXPIRY_DAY at all." },
  { root: "SILVER", approxExpiryDay: 27, tracked: false, note: "Bare/full-size root — NOT tracked. Subject to RESTRICTED_MONTH_CYCLE (Feb/Apr/Jun/Aug/Nov/Dec only) via nextValidMonthCodes()." },
  { root: "SILVERM", approxExpiryDay: 27, tracked: true, note: "Tracked root — control/cross-check against SILVER above. Also RESTRICTED_MONTH_CYCLE." },
  { root: "MENTHAOIL", approxExpiryDay: 29, tracked: false, note: "Bare root — NOT tracked, no suffixed counterpart exists in MCX_EXPIRY_DAY at all." },
  { root: "GOLDPETAL", approxExpiryDay: 29, tracked: true, note: "Tracked root, FUTURES-ONLY (no listed options per derivatives-config.json). Flagged UNCONFIRMED directly in symbolsRouter.js's own MCX_EXPIRY_DAY comment — the one item explicitly still open." },
  { root: "GOLDM", approxExpiryDay: 5, tracked: true, note: "KNOWN-GOOD CONTROL — already confirmed fixed 2026-08-10, live-verified ~4th-5th. Included to sanity-check this script's own method, same spirit as verifyEquityFoEligibility.js's known-answer set." },
];

// Fyers returns expiry dates as "DD-MM-YYYY" strings (confirmed from the
// real 2026-08-11 run's log output, e.g. "17-08-2026") — NOT something
// new Date() parses reliably (it silently produces Invalid Date / NaN for
// this format, which is exactly the bug found in this script's first run).
// Parsed directly from the string, no Date object involved.
function parseFyersExpiryDate(dateStr) {
  const [dd, mm, yyyy] = dateStr.split("-").map((s) => parseInt(s, 10));
  return { day: dd, month: mm, year: yyyy };
}

// Not exported from symbolsRouter.js (only mcxNearMonthOffset/
// nextValidMonthCodes/etc are) — this is the same static month-abbreviation
// list already used there (MONTH_CODES), duplicated here only because it
// isn't reachable any other way. If it's ever exported, replace this with
// a real import instead of keeping two copies.
const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// A chain query for one dated FUT symbol can come back with expiries
// spanning SEVERAL months (confirmed from the real run — querying
// MCX:GOLDM26SEPFUT returned Aug/Sep/Oct expiries together, not just
// September's). Index 0 is NOT reliably "this symbol's own expiry" — it's
// whichever expiry is soonest overall. This finds the entry whose
// month+year actually matches the queried code (e.g. "26SEP" -> Sep 2026).
function findMatchingExpiry(expiryDates, code) {
  const mmm = code.slice(2); // "26SEP" -> "SEP"
  const yy = parseInt(code.slice(0, 2), 10); // "26SEP" -> 26
  const monthNum = MONTH_ABBR.indexOf(mmm) + 1; // 1-based, matches parseFyersExpiryDate's .month
  const fullYear = 2000 + yy;
  for (const dateStr of expiryDates) {
    const { month, year } = parseFyersExpiryDate(dateStr);
    if (month === monthNum && year === fullYear) return dateStr;
  }
  return null; // no expiry in the returned list matches the queried month at all
}

async function checkRoot(entry) {
  const { root, approxExpiryDay, tracked, note } = entry;
  const result = {
    root,
    tracked,
    approxExpiryDayFromCode: approxExpiryDay,
    note,
    nearMonthOffset: null,
    monthCodesChecked: [],
    futuresLive: [],
    liveOptionChain: null,
    matchedExpiryDate: null,
    approxVsLiveVerdict: null,
    error: null,
  };

  try {
    // REUSED verbatim — real functions, not reimplemented.
    const offset = mcxNearMonthOffset(root);
    result.nearMonthOffset = offset;
    const fromMonth = new Date();
    fromMonth.setMonth(fromMonth.getMonth() + offset);
    const codes = nextValidMonthCodes(root, 3, fromMonth);
    result.monthCodesChecked = codes;

    for (const code of codes) {
      const symbol = `MCX:${root}${code}FUT`;
      try {
        const candles = await fetchCandles(symbol, "1", 200000, CANDLE_LOOKBACK_DAYS);
        const count = candles ? candles.length : 0;
        result.futuresLive.push({ symbol, candleCount: count, live: count > 0 });
        console.log(`[verifyMcxExpiryDay] ${symbol}: ${count} candle(s)`);
      } catch (err) {
        result.futuresLive.push({ symbol, candleCount: 0, live: false, error: err.message });
        console.log(`[verifyMcxExpiryDay] ${symbol}: ERROR — ${err.message}`);
      }
      await delay(CHAIN_POLITE_DELAY_MS);
    }

    // Real listed expiries, straight from Fyers, off the near-month symbol
    // — this IS the ground truth MCX_EXPIRY_DAY's static day-of-month value
    // is only ever approximating.
    const nearSymbol = `MCX:${root}${codes[0]}FUT`;
    try {
      const chain = await fetchOptionChain(nearSymbol, { strikeCount: 5 });
      const expiryDates = (chain.expiries || []).map((e) => e.date);
      result.liveOptionChain = {
        symbol: nearSymbol,
        expiryCount: expiryDates.length,
        expiryDates,
      };
      console.log(`[verifyMcxExpiryDay] ${nearSymbol} option chain: ${expiryDates.length} real expiry date(s) — ${expiryDates.join(", ") || "(none)"}`);

      if (expiryDates.length > 0) {
        const matched = findMatchingExpiry(expiryDates, codes[0]);
        if (!matched) {
          result.approxVsLiveVerdict = `NO MATCHING-MONTH EXPIRY FOUND — chain returned ${expiryDates.join(", ")} but none is in ${codes[0].slice(2)} ${2000 + parseInt(codes[0].slice(0, 2), 10)} (the month actually queried). Either the chain lists a different set of months than expected, or the near-month offset logic and the live chain disagree — review by hand.`;
        } else {
          const { day: liveExpiryDay } = parseFyersExpiryDate(matched);
          result.matchedExpiryDate = matched;
          const diff = liveExpiryDay - approxExpiryDay;
          result.approxVsLiveVerdict = Math.abs(diff) <= 2
            ? `CLOSE — approx day ${approxExpiryDay} vs live expiry day ${liveExpiryDay} (${matched}, diff ${diff}), within normal MCX circular drift`
            : `MISMATCH — approx day ${approxExpiryDay} vs live expiry day ${liveExpiryDay} (${matched}, diff ${diff}). This is the pattern GOLDM had before its fix — review before touching MCX_EXPIRY_DAY[${root}].`;
        }
      } else {
        result.approxVsLiveVerdict = "NO LIVE EXPIRIES RETURNED — cannot compare against approx day. Either this root/month has no listed options, or the symbol itself isn't live (see futuresLive above).";
      }
    } catch (err) {
      result.liveOptionChain = { symbol: nearSymbol, error: err.message };
      result.approxVsLiveVerdict = `COULD NOT CHECK — option chain call failed: ${err.message}`;
      console.log(`[verifyMcxExpiryDay] ${nearSymbol} option chain: ERROR — ${err.message}`);
    }
  } catch (err) {
    result.error = err.message;
    console.log(`[verifyMcxExpiryDay] ${root}: FAILED before any live call — ${err.message}`);
  }

  return result;
}

async function main() {
  const args = parseArgs();
  const outPath = args.out ? path.resolve(args.out) : DEFAULT_REPORT_PATH;

  console.log(`[verifyMcxExpiryDay] Checking ${ROOTS_TO_CHECK.length} root(s) — both bare and tracked forms, plus GOLDM as a known-good control. Read-only, no config changes.`);

  const results = [];
  for (let i = 0; i < ROOTS_TO_CHECK.length; i++) {
    console.log(`\n[verifyMcxExpiryDay] (${i + 1}/${ROOTS_TO_CHECK.length}) ${ROOTS_TO_CHECK[i].root} ${ROOTS_TO_CHECK[i].tracked ? "(tracked)" : "(bare/untracked)"}`);
    const r = await checkRoot(ROOTS_TO_CHECK[i]);
    results.push(r);
    if (i < ROOTS_TO_CHECK.length - 1) await delay(CHAIN_POLITE_DELAY_MS);
  }

  const mismatches = results.filter((r) => r.approxVsLiveVerdict && r.approxVsLiveVerdict.startsWith("MISMATCH"));
  const unreachable = results.filter((r) => r.futuresLive.every((f) => !f.live));
  const goldmControl = results.find((r) => r.root === "GOLDM");

  const output = {
    _readme: "Verification REPORT from backend/src/scripts/verifyMcxExpiryDay.js — NOT a drop-in replacement for MCX_EXPIRY_DAY in symbolsRouter.js. Review controlCheck and mismatches[] first, confirm each against a real Fyers app screenshot (same bar GOLDM's fix used), then edit MCX_EXPIRY_DAY by hand.",
    runDate: new Date().toISOString().slice(0, 10),
    controlCheck: goldmControl
      ? { root: "GOLDM", verdict: goldmControl.approxVsLiveVerdict, note: "If this doesn't say CLOSE, treat this script's method as unverified before trusting any other row." }
      : { note: "GOLDM control missing from results — something went wrong before this ran." },
    summary: {
      totalChecked: results.length,
      mismatches: mismatches.length,
      unreachableUnderTestedName: unreachable.map((r) => r.root),
    },
    results,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(`\n[verifyMcxExpiryDay] Done. ${mismatches.length} MISMATCH(es) found, ${unreachable.length} root(s) not live under the tested name.`);
  console.log(`[verifyMcxExpiryDay] Control check (GOLDM): ${goldmControl ? goldmControl.approxVsLiveVerdict : "MISSING"}`);
  console.log(`[verifyMcxExpiryDay] Report written to ${outPath}. Review before touching MCX_EXPIRY_DAY.`);
}

main().catch((err) => {
  console.error("[verifyMcxExpiryDay] FAILED:", err);
  process.exit(1);
});