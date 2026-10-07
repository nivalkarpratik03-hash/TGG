/**
 * backend/src/scripts/test-corporate-actions.js
 * ─────────────────────────────────────────────────────────────────────────
 * ONE-OFF DIAGNOSTIC — read-only, same pattern as test-oi-flag.js and
 * test-dynamic-atm.js. Does not modify anything. Answers, with real Fyers
 * data, whether historical daily candles are adjusted for two DIFFERENT
 * kinds of corporate action:
 *
 *   TEST 1 — A PLAIN SPLIT: Coforge (NSE:COFORGE-EQ), 1:5 split,
 *            ex-date 4-June-2025. If Fyers adjusts history, the close on
 *            3-June-2025 should be roughly 5x the close on 4-June-2025's
 *            pre-split-equivalent level (i.e. no ~5x cliff in the raw
 *            numbers). If unadjusted, there's a ~5x overnight "crash".
 *
 *   TEST 2 — A RENAME/DEMERGER: Tata Motors was renamed TATAMOTORS -> TMPV
 *            on 24-Oct-2025 (the passenger-vehicle business kept the old
 *            company's legal history under a NEW symbol), then the
 *            commercial-vehicle arm was demerged and separately listed
 *            under the OLD "TATAMOTORS" symbol on 12-Nov-2025 (record
 *            date 14-Oct-2025, ~40% of value moved out). This is a
 *            DIFFERENT risk than a split: does TMPV's candle history in
 *            Fyers carry forward from before 24-Oct-2025 (the old
 *            TATAMOTORS data), or does it start blank at the rename? A
 *            genuine value drop around the 14-Oct record date is EXPECTED
 *            and correct here (real value left the company) — this test
 *            is checking symbol continuity, not price adjustment.
 *
 * Both symbols are already in this app's own symbols/equity.json —
 * nothing new to configure. Uses this app's own fetchCandles(), same as
 * every other script in this folder — no separate Fyers call invented.
 *
 * API CALLS: 2 (one daily-candle fetch per symbol). No rate-limit risk.
 *
 * HOW TO RUN (inside backend/, valid Fyers token already saved via /admin):
 *   cd backend
 *   node src/scripts/test-corporate-actions.js
 *
 * Delete after use — it's a one-off check, not part of the app.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

require("dotenv").config();

const { validateToken, fetchCandles } = require("../fyers/client");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDate(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function pctChange(a, b) {
  return a ? (((b - a) / a) * 100).toFixed(1) + "%" : "n/a";
}

async function dailyCandlesSince(symbol, fromDateStr) {
  const fromMs = new Date(`${fromDateStr}T00:00:00+05:30`).getTime();
  const lookbackDays = Math.max(1, Math.ceil((Date.now() - fromMs) / 86400000)) + 5;
  const all = await fetchCandles(symbol, "D", 10000, lookbackDays, false);
  return all.filter((c) => c.time >= fromMs).sort((a, b) => a.time - b.time);
}

function printAround(candles, targetDateStr, label) {
  const idx = candles.findIndex((c) => istDate(c.time) >= targetDateStr);
  const start = Math.max(0, idx - 3);
  const end = Math.min(candles.length, idx + 4);
  console.log(`  ${label} — candles around ${targetDateStr}:`);
  for (let i = start; i < end; i++) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    const marker = istDate(c.time) === targetDateStr ? "  <== target date" : "";
    const chg = prev ? `  (vs prev close: ${pctChange(prev.close, c.close)})` : "";
    console.log(`    ${istDate(c.time)}  O:${c.open}  H:${c.high}  L:${c.low}  C:${c.close}${chg}${marker}`);
  }
  return idx;
}

async function main() {
  console.log(`\n=== Corporate-actions diagnostic ===\n`);

  if (!(await validateToken())) {
    console.error("Fyers token missing/invalid/expired. Regenerate it from the app's /admin page, then re-run.");
    process.exit(1);
  }
  console.log("Token OK.\n");

  // ── TEST 1: Coforge — plain 1:5 split, ex-date 4-June-2025 ──────────────
  console.log("── TEST 1: Coforge — 1:5 split, ex-date 2025-06-04 ──");
  let coforgeOk = null;
  try {
    const candles = await dailyCandlesSince("NSE:COFORGE-EQ", "2025-05-01");
    if (candles.length === 0) {
      console.log("  No candles returned at all — cannot judge.");
    } else {
      const idx = printAround(candles, "2025-06-04", "COFORGE");
      if (idx > 0 && idx < candles.length) {
        const before = candles[idx - 1].close;
        const onDate = candles[idx].close;
        const ratio = before / onDate;
        console.log(`  close before / close on target date = ${ratio.toFixed(2)}`);
        // Unadjusted: ratio should be ~5 (a real ~5x cliff). Adjusted: ratio ~1 (continuous).
        coforgeOk = ratio < 2; // clearly NOT a ~5x cliff => looks adjusted
        console.log(`  => ${coforgeOk ? "Looks ADJUSTED (no ~5x cliff)" : "Looks UNADJUSTED (a ~5x cliff is present)"}`);
      } else {
        console.log("  Target date not found inside the returned range — widen the date window and re-check manually.");
      }
    }
  } catch (err) {
    console.log(`  FETCH FAILED: ${err.message}`);
  }

  console.log("");

  // ── TEST 2: TMPV — renamed from TATAMOTORS on 2025-10-24 ────────────────
  // Window starts 2025-09-01, well before both the 1-Oct-2025 demerger
  // EFFECTIVE date and the 14-Oct-2025 RECORD date, so the real repricing
  // day (whichever of those it actually lands on) is inside the window
  // instead of assumed.
  console.log("── TEST 2: TMPV — renamed from TATAMOTORS 2025-10-24 (symbol continuity, not adjustment) ──");
  let tmpvHasPreRenameHistory = null;
  try {
    const candles = await dailyCandlesSince("NSE:TMPV-EQ", "2025-09-01");
    if (candles.length === 0) {
      console.log("  No candles returned at all under NSE:TMPV-EQ.");
    } else {
      const firstDate = istDate(candles[0].time);
      console.log(`  Earliest candle returned under NSE:TMPV-EQ: ${firstDate}`);
      tmpvHasPreRenameHistory = firstDate < "2025-10-24";
      console.log(`  => ${tmpvHasPreRenameHistory ? "History DOES carry forward from before the 24-Oct rename (old TATAMOTORS data reachable via TMPV)." : "History does NOT reach before 24-Oct — anything stored under the old TATAMOTORS symbol before the rename may not be reachable via TMPV."}`);

      // Print the raw early-window candles unconditionally — need to SEE
      // the actual September price level, not infer it from the drop scan.
      console.log(`  First 12 candles of the window (raw, to see the actual price level before the demerger):`);
      for (const c of candles.slice(0, 12)) {
        console.log(`    ${istDate(c.time)}  O:${c.open}  H:${c.high}  L:${c.low}  C:${c.close}`);
      }

      // Scan close-to-close for every day in the window and rank the
      // biggest single-day drops, instead of assuming which date the
      // real demerger repricing landed on.
      const drops = [];
      for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1].close, cur = candles[i].close;
        if (prev > 0) drops.push({ date: istDate(candles[i].time), prevClose: prev, close: cur, pct: ((cur - prev) / prev) * 100 });
      }
      drops.sort((a, b) => a.pct - b.pct); // most negative first
      console.log("  Biggest single-day drops in the window (most negative first):");
      for (const d of drops.slice(0, 5)) {
        console.log(`    ${d.date}: ${d.prevClose} -> ${d.close}  (${d.pct.toFixed(1)}%)`);
      }
      const biggest = drops[0];
      if (biggest) {
        console.log(`  => Largest drop is ${biggest.pct.toFixed(1)}% on ${biggest.date}.`);
        console.log(`     Demerger EFFECTIVE date was 2025-10-01, RECORD date was 2025-10-14 — compare ${biggest.date} against those, not an assumed date.`);
      }
      printAround(candles, biggest ? biggest.date : "2025-10-14", "TMPV (candles around the largest drop found)");
    }
  } catch (err) {
    console.log(`  FETCH FAILED: ${err.message}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=== RESULT ===");
  console.log(`TEST 1 (Coforge split adjustment): ${coforgeOk === null ? "COULD NOT DETERMINE" : coforgeOk ? "ADJUSTED" : "NOT ADJUSTED — a fake cliff is present in raw candles"}`);
  console.log(`TEST 2 (TMPV symbol continuity):   ${tmpvHasPreRenameHistory === null ? "COULD NOT DETERMINE" : tmpvHasPreRenameHistory ? "CONTINUOUS across the rename" : "BREAKS at the rename — pre-24-Oct data not reachable via TMPV"}`);
  console.log(`\nPaste this whole output back and we decide what (if anything) needs handling in the export code.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});