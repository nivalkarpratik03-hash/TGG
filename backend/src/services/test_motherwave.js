/**
 * test_motherwave.js
 *
 * HOW TO RUN:
 *   node test_motherwave.js
 *
 * 2026-08-13 — REWRITTEN. The previous version of this file tested
 * findDisplacingWave(), which belonged to the OLD "last-50-waves /
 * fib-breach-or-size-promotion" Mother Wave algorithm. That function no
 * longer exists — services/motherwave.js was replaced with the
 * full-history, succession-rule (S1/S2/S3) + Driver Wave engine (see that
 * file's header). This file now tests the function that actually decides
 * MW succession today: mwSuccession(), plus the Driver Wave qualification
 * helpers (qualifiesAsDriverSize / qualifiesAsForwardDriver).
 *
 * WHAT THIS TESTS:
 *   Section 1 — S1 (candidate strictly larger than current MW) → promotes
 *               immediately, no qualifying cut required.
 *   Section 2 — S2 (same direction, >= 0.5x MW size, qualifying cut beyond
 *               MW's -0.618 fib) → promotes only when the cut is present.
 *   Section 3 — S3 (opposite direction, >= 0.5x MW size, qualifying cut
 *               beyond MW's 1.234 fib) → promotes only when the cut is
 *               present.
 *   Section 4 — Waves below the 0.5x MW-size floor never promote (rule stays
 *               null), regardless of any cut.
 *   Section 5 — Driver Wave qualification (qualifiesAsDriverSize /
 *               qualifiesAsForwardDriver): size floor (0.3x MW), temporal
 *               eligibility, and the invalidated-wave exclusion.
 */

"use strict";

const {
  mwSuccession,
  qualifiesAsDriverSize,
  qualifiesAsForwardDriver,
  MWDW_CFG,
} = require("./motherwave");

// ─── Synthetic wave/candle builders ────────────────────────────────────────
// mwSuccession/qualifiesAs* read the engine's RAW wave record shape (see
// motherwave.js's computeSegments): waveNo, direction, originBarIndex,
// originPrice, tipBarIndex, tipPrice, tipConfirmationBarIndex, size,
// toSide — NOT the buildWaveObj()-shaped public wave.
function makeWave({ waveNo, direction, originBarIndex, originPrice, tipBarIndex, tipPrice, tipConfirmationBarIndex }) {
  return {
    waveNo,
    direction,
    originBarIndex, originPrice, originTime: originBarIndex * 60,
    tipBarIndex, tipPrice, tipTime: tipBarIndex * 60,
    tipConfirmationBarIndex: tipConfirmationBarIndex ?? tipBarIndex,
    tipConfirmationTime: (tipConfirmationBarIndex ?? tipBarIndex) * 60,
    size: Math.abs(tipPrice - originPrice),
    toSide: direction === "bull" ? "high" : "low",
    prevWaveType: "LL", currWaveType: "HL",
  };
}

// Flat, low-volatility candles by default (body ~= 0), except at
// `cutBarIndex` (if given) where a strong body candle closes at `cutClose`
// — engineered to pass evaluateQualifyingCut's body >= 0.6x ATR14-exclusive
// AND close-beyond-level checks. atr[] is supplied directly (not derived
// via wilderATR) so the test controls the qualifying-cut threshold exactly.
function makeCandlesWithOptionalCut(n, { cutBarIndex, cutClose, cutOpen } = {}) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    if (cutBarIndex != null && i === cutBarIndex) {
      candles.push({ time: i * 60, open: cutOpen, high: Math.max(cutOpen, cutClose), low: Math.min(cutOpen, cutClose), close: cutClose });
    } else {
      candles.push({ time: i * 60, open: 100, high: 100.1, low: 99.9, close: 100 });
    }
  }
  return candles;
}

// Constant, small ATR so a body of ~5-10 points easily clears
// 0.6x ATR14-exclusive at every bar.
function flatAtr(n, value = 1) {
  return new Array(n).fill(value);
}

// ─── Test runner ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705  PASS \u2014 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u274c  FAIL \u2014 ${name}`);
    console.log(`         \u2192 ${e.message}`);
    failed++;
  }
}

function expect(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`Expected "${expected}" but got "${actual}"  ${msg || ""}`);
  }
}

console.log("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
console.log("   MOTHER WAVE / DRIVER WAVE \u2014 SUCCESSION ENGINE TESTS");
console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");

// ─── SECTION 1 \u2014 S1: strictly larger candidate promotes immediately ────────
console.log("\u2500\u2500 SECTION 1: S1 (candidate.size > MW.size) \u2500\u2500\n");

test("S1 \u2014 candidate larger than MW \u2192 promotes, no cut needed", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 }); // size 100
  const candidate = makeWave({ waveNo: 2, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 320 }); // size 120 > 100
  const candles = makeCandlesWithOptionalCut(40); // flat — no qualifying cut anywhere
  const atr = flatAtr(40, 1);
  const { rule } = mwSuccession(candidate, mwWave, candles, atr, "intraday", MWDW_CFG);
  expect(rule, "S1_LARGER_WAVE", "strictly larger candidate must promote via S1 regardless of cuts");
});

// ─── SECTION 2 \u2014 S2: same-direction, >= 0.5x MW size, needs a qualifying cut ─
console.log("\n\u2500\u2500 SECTION 2: S2 (same direction, >= 0.5x MW size + cut beyond -0.618) \u2500\u2500\n");

test("S2 \u2014 same-direction 0.5x wave WITH a qualifying cut beyond -0.618 \u2192 promotes", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 }); // size 100, -0.618 fib = 261.8
  const candidate = makeWave({ waveNo: 2, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 250 }); // size 50 = 0.5x MW
  // Strong bull-direction cut candle inside (originBarIndex+1 .. tipBarIndex) closing beyond 261.8
  const candles = makeCandlesWithOptionalCut(40, { cutBarIndex: 25, cutOpen: 255, cutClose: 265 }); // body=10 >= 0.6*1
  const atr = flatAtr(40, 1);
  const { rule } = mwSuccession(candidate, mwWave, candles, atr, "intraday", MWDW_CFG);
  expect(rule, "S2_CUT_BEYOND_MW_NEG_0618", "0.5x same-direction wave with a real cut beyond -0.618 must promote via S2");
});

test("S2 \u2014 same-direction 0.5x wave with NO qualifying cut \u2192 does not promote", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 });
  const candidate = makeWave({ waveNo: 2, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 250 }); // size 50 = 0.5x MW
  const candles = makeCandlesWithOptionalCut(40); // flat — no cut anywhere
  const atr = flatAtr(40, 1);
  const { rule } = mwSuccession(candidate, mwWave, candles, atr, "intraday", MWDW_CFG);
  expect(rule, null, "no qualifying cut in the candidate's span \u2192 no promotion");
});

// ─── SECTION 3 \u2014 S3: opposite direction, needs a cut beyond 1.234 ───────────
console.log("\n\u2500\u2500 SECTION 3: S3 (opposite direction, >= 0.5x MW size + cut beyond 1.234) \u2500\u2500\n");

test("S3 \u2014 opposite-direction 0.5x wave WITH a qualifying cut beyond 1.234 \u2192 promotes", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 }); // 1.234 fib = 100 - 0.234*100 = 76.6
  const candidate = makeWave({ waveNo: 2, direction: "bear", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 150 }); // size 50 = 0.5x MW, opposite direction
  // Bear-direction cut candle closing beyond (below) 76.6
  const candles = makeCandlesWithOptionalCut(40, { cutBarIndex: 25, cutOpen: 80, cutClose: 70 }); // body=10 >= 0.6*1
  const atr = flatAtr(40, 1);
  const { rule } = mwSuccession(candidate, mwWave, candles, atr, "intraday", MWDW_CFG);
  expect(rule, "S3_CUT_BEYOND_MW_1_234", "0.5x opposite-direction wave with a real cut beyond 1.234 must promote via S3");
});

test("S3 \u2014 opposite-direction 0.5x wave with NO qualifying cut \u2192 does not promote", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 });
  const candidate = makeWave({ waveNo: 2, direction: "bear", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 150 });
  const candles = makeCandlesWithOptionalCut(40); // flat
  const atr = flatAtr(40, 1);
  const { rule } = mwSuccession(candidate, mwWave, candles, atr, "intraday", MWDW_CFG);
  expect(rule, null, "no qualifying cut \u2192 no promotion even though size/direction conditions are met");
});

// ─── SECTION 4 \u2014 below the 0.5x floor never promotes ────────────────────────
console.log("\n\u2500\u2500 SECTION 4: below 0.5x MW size \u2500\u2500\n");

test("Wave below 0.5x MW size \u2192 never promotes, even with a strong cut", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 }); // size 100
  const candidate = makeWave({ waveNo: 2, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 240 }); // size 40 < 0.5x100=50
  const candles = makeCandlesWithOptionalCut(40, { cutBarIndex: 25, cutOpen: 255, cutClose: 265 }); // would qualify for S2 if size were sufficient
  const atr = flatAtr(40, 1);
  const { rule } = mwSuccession(candidate, mwWave, candles, atr, "intraday", MWDW_CFG);
  expect(rule, null, "below the 0.5x size floor, S2/S3 never even get checked");
});

// ─── SECTION 5 \u2014 Driver Wave qualification ──────────────────────────────────
console.log("\n\u2500\u2500 SECTION 5: Driver Wave qualification \u2500\u2500\n");

test("qualifiesAsDriverSize \u2014 wave >= 0.3x MW size qualifies", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 }); // size 100
  const candidate = makeWave({ waveNo: 2, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 232 }); // size 32 >= 30
  expect(qualifiesAsDriverSize(candidate, mwWave, MWDW_CFG), true, "0.32x MW size should clear the 0.3x Driver Wave floor");
});

test("qualifiesAsDriverSize \u2014 wave below 0.3x MW size does not qualify", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 }); // size 100
  const candidate = makeWave({ waveNo: 2, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 220 }); // size 20 < 30
  expect(qualifiesAsDriverSize(candidate, mwWave, MWDW_CFG), false, "0.2x MW size is below the 0.3x Driver Wave floor");
});

test("qualifiesAsForwardDriver \u2014 rejects a wave that started before the MW's own origin", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 300 }); // size 100
  // Candidate ORIGINATES before the MW's origin bar \u2014 not temporally eligible
  const candidate = makeWave({ waveNo: 2, direction: "bull", originBarIndex: 5, originPrice: 150, tipBarIndex: 15, tipPrice: 200 }); // size 50 >= 30
  const invalidated = new Set();
  const ok = qualifiesAsForwardDriver(candidate, mwWave, /* mwActivatedAtBar */ 30, invalidated, MWDW_CFG);
  expect(ok, false, "a wave that originated before the MW's own origin bar is not a forward Driver Wave");
});

test("qualifiesAsForwardDriver \u2014 rejects a wave already in the invalidated set", () => {
  const mwWave = makeWave({ waveNo: 1, direction: "bull", originBarIndex: 0, originPrice: 100, tipBarIndex: 10, tipPrice: 200 }); // size 100
  const candidate = makeWave({ waveNo: 5, direction: "bull", originBarIndex: 20, originPrice: 200, tipBarIndex: 30, tipPrice: 250, tipConfirmationBarIndex: 31 }); // size 50, temporally fine
  const invalidated = new Set([5]); // waveNo 5 already invalidated
  const ok = qualifiesAsForwardDriver(candidate, mwWave, /* mwActivatedAtBar */ 10, invalidated, MWDW_CFG);
  expect(ok, false, "a previously-invalidated wave cannot re-qualify as the Driver Wave");
});

// ─── FINAL SUMMARY ──────────────────────────────────────────────────────────
console.log("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
console.log(`  RESULTS: ${passed} passed  |  ${failed} failed`);
console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n");

if (failed === 0) {
  console.log("  \ud83c\udf89  ALL TESTS PASSED!");
  console.log("  \u2714  S1 (strictly larger \u2192 promote) is working correctly");
  console.log("  \u2714  S2 (same direction + qualifying cut beyond -0.618) is working correctly");
  console.log("  \u2714  S3 (opposite direction + qualifying cut beyond 1.234) is working correctly");
  console.log("  \u2714  The 0.5x MW-size floor is enforced before S2/S3 even run");
  console.log("  \u2714  Driver Wave size/temporal/invalidation qualification is working correctly\n");
  process.exitCode = 0;
} else {
  console.log("  \u26a0\ufe0f  SOME TESTS FAILED \u2014 check the errors above\n");
  process.exitCode = 1;
}