/**
 * scripts/diagnoseScanner.js
 * ─────────────────────────────────────────────────────────────────
 * Traces EXACTLY why a symbol produces (or doesn't produce) a signal,
 * mirroring scannerRunner.js's own _processSymbol() candle-fetch path
 * step by step, then reports:
 *
 *   1. How many 1m candles the DB actually has for this symbol/window.
 *   2. How many candles that derives to at the target resolution.
 *   3. How many wave segments computeSegments() finds in that history.
 *   4. Whether a Mother Wave forms at all (mwPeriods.length), and if
 *      not, how far short of the 50-completed-wave bootstrap threshold
 *      (MWDW_CFG.initialWaveCount) the symbol is.
 *   5. Whether a Driver Wave is currently active.
 *   6. What every registered strategy (s1s2s3, type-ref, type-e,
 *      type-r, type-f) actually returns for this symbol.
 *
 * USAGE:
 *   node backend/src/scripts/diagnoseScanner.js SYMBOL [resolution]
 *
 * Example:
 *   node backend/src/scripts/diagnoseScanner.js NSE:RELIANCE-EQ 15
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const symbol = process.argv[2];
const resolution = parseInt(process.argv[3] || "15");

if (!symbol) {
  console.error("Usage: node diagnoseScanner.js SYMBOL [resolution]");
  process.exit(1);
}

async function main() {
  console.log(`\n=== Diagnosing "${symbol}" @ ${resolution}m ===\n`);

  // ── 1. DB availability — same optional-require pattern as scannerRunner.js ──
  let db = null;
  let dbEnabled = false;
  try {
    db = require("../../../database/src/index");
    dbEnabled = true;
    console.log("[1] DB module loaded OK.");
  } catch (e) {
    console.log(`[1] DB module NOT available (${e.message}) — scannerRunner.js would fall back to Fyers here.`);
  }

  const { deriveTimeframe } = require("../services/candleBuilder");
  const { fetchCandles } = require("../fyers/client");

  // ── 2. Candle fetch — EXACT same logic as scannerRunner.js's _processSymbol ──
  let oneMin = null;
  let candles = null;
  let source = null;

  if (dbEnabled && db) {
    try {
      const windowMs = 90 * 24 * 60 * 60 * 1000;
      oneMin = await db.loadCandles(symbol, 1, {
        from: new Date(Date.now() - windowMs),
        to: new Date(),
        limit: 50000,
      });
      console.log(`[2] DB returned ${oneMin ? oneMin.length : 0} raw 1m candles for the last 90 days.`);
      if (oneMin && oneMin.length > 0) {
        candles = resolution === 1 ? oneMin : deriveTimeframe(oneMin, resolution);
        source = "db";
      }
    } catch (dbErr) {
      console.log(`[2] DB read FAILED: ${dbErr.message}`);
    }
  }

  if (!candles || candles.length === 0) {
    console.log("[2b] No usable DB candles — falling back to Fyers fetchCandles(symbol, resolution, 5000)...");
    try {
      candles = await fetchCandles(symbol, resolution, 5000);
      source = "fyers";
    } catch (fyersErr) {
      console.log(`[2b] Fyers fetch FAILED: ${fyersErr.message}`);
      candles = [];
    }
  }

  console.log(`[3] Final candle set: ${candles.length} candles @ ${resolution}m, source=${source || "none"}.`);
  if (candles.length > 0) {
    const first = candles[0], last = candles[candles.length - 1];
    console.log(`    Range: ${new Date(first.time).toISOString()} → ${new Date(last.time).toISOString()}`);
    console.log(`    Sample candle[0]:`, first);
  }
  if (candles.length < 20) {
    console.log("\n⚠ Fewer than 20 candles — every strategy bails out immediately (insufficient_data). Nothing downstream will work. Stop here and fix the candle fetch first.\n");
    return;
  }

  // ── 4. Wave / MW / DW breakdown — inspect the engine directly ──────────────
  const {
    detectMotherWaveForAPI,
    calcTrapZone,
    classifyZone,
    computeSegments,
    MWDW_CFG,
  } = require("../services/motherwave");

  const waves = computeSegments(candles);
  console.log(`\n[4] computeSegments() found ${waves.length} wave segments.`);
  console.log(`    Mother Wave bootstrap threshold (MWDW_CFG.initialWaveCount) = ${MWDW_CFG.initialWaveCount}.`);

  if (waves.length < MWDW_CFG.initialWaveCount) {
    console.log(
      `    ⚠ Only ${waves.length}/${MWDW_CFG.initialWaveCount} completed waves — the Mother Wave engine will NOT\n` +
      `      produce a result yet (this is a hard, one-shot gate — it only ever fires the\n` +
      `      moment the count reaches exactly ${MWDW_CFG.initialWaveCount}, on THIS candle set). detectMotherWaveForAPI()\n` +
      `      returns null, s1s2s3 bails immediately, and Type E/R/F's own internal replay\n` +
      `      (typeREF.js calls buildPerBarMwDwTimeline() with these same candles) hits the\n` +
      `      same gate — so dwWaveNoAfterBar stays all-null and no Type E/R/F event can ever\n` +
      `      trigger either. THIS IS LIKELY WHY YOU'RE SEEING ZERO SIGNALS.\n` +
      `      Fix options: widen the candle window/limit so more waves accumulate, lower\n` +
      `      MWDW_CFG.initialWaveCount, or ask me to add a provisional-MW fallback for the\n` +
      `      warm-up phase (mirrors the OLD algorithm's \"always have SOME MW\" behavior).`
    );
  } else {
    console.log(`    ✓ Enough waves for the Mother Wave engine to have initialized.`);
  }

  const mwResult = detectMotherWaveForAPI(candles);
  console.log(`\n[5] detectMotherWaveForAPI() → ${mwResult ? "produced a result" : "null"}.`);
  if (mwResult) {
    console.log(`    chain length: ${mwResult.chain.length}`);
    console.log(`    current MW: dir=${mwResult.wave.dir}, delta=${mwResult.wave.delta}, waveNum=${mwResult.wave.waveNum}`);
    console.log(`    Driver Wave active: ${mwResult.dw ? `yes (dir=${mwResult.dw.wave.dir}, invalidated=${mwResult.dw.invalidated})` : "no"}`);
    console.log(`    dwChain length: ${mwResult.dwChain.length}`);
  }

  // ── 6. Run every registered strategy exactly like scannerRunner.js does ────
  const strategies = require("../strategies/strategyRegistry");
  const trapZone = mwResult ? calcTrapZone(mwResult) : null;
  const lastCandle = candles[candles.length - 1];
  const zone = mwResult && lastCandle ? classifyZone(mwResult, lastCandle.close) : "trap";
  const context = { motherwave: mwResult, trapZone, zone, lastCandle };

  console.log(`\n[6] Strategy results:`);
  for (const strat of strategies) {
    try {
      const result = strat.scan(symbol, candles, context);
      const extra = result.events ? `events=${result.events.length}` : "";
      console.log(`    ${strat.id.padEnd(10)} found=${String(result.found).padEnd(6)} stage=${(result.patternStage || "").padEnd(14)} ${extra} error=${result.error || "none"}`);
    } catch (err) {
      console.log(`    ${strat.id.padEnd(10)} THREW: ${err.message}`);
    }
  }

  console.log("\n=== Done ===\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("Diagnostic script crashed:", err);
  process.exit(1);
});