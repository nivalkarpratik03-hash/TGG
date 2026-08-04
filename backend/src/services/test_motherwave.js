/**
 * test_motherwave.js
 *
 * HOW TO RUN:
 *   node test_motherwave.js
 *
 * WHAT THIS TESTS:
 *   Test 1 — Rule 3: A new wave EQUAL in size to MW → should promote
 *   Test 2 — Rule 3: A new wave LARGER than MW → should promote
 *   Test 3 — Rule 4: A new wave INSIDE fib levels but LARGER → should still promote
 *   Test 4 — Fib Breach (old logic): Wave breaks -0.618 → should fib_breach
 *   Test 5 — Normal case: No promotion, no breach → MW stays as-is
 */

"use strict";

const { detectMotherWaveForAPI, findDisplacingWave } = require("./motherwave");
const { buildFibLevels } = require("./fibMath");

// ─── Candle builder helper ────────────────────────────────────────────────────
// Makes fake candles that force the wave system to produce a specific wave shape
// price = array of price values, each candle goes: open=prev, close=current
// We exaggerate high/low so EMA touches trigger properly

function makeCandlesFromPrices(prices) {
  return prices.map((p, i) => {
    const prev = i === 0 ? p : prices[i - 1];
    const open = prev;
    const close = p;
    const isUp = close >= open;
    return {
      time: (1000000 + i) * 1000,   // fake timestamp
      open,
      close,
      high: isUp ? close * 1.005 : open * 1.005,   // slightly above
      low: isUp ? open * 0.995 : close * 0.995,   // slightly below
    };
  });
}

// ─── Direct wave injection ────────────────────────────────────────────────────
// Instead of relying on EMA detection (unreliable for small test data),
// we directly test findDisplacingWave logic by building synthetic segments
// This tests the EXACT logic that was changed

function makeSeg(fromPrice, toPrice, timeOffset, side) {
  return {
    fromPrice,
    toPrice,
    toSide: side || (toPrice > fromPrice ? "high" : "low"),
    fromTime: (1000 + timeOffset) * 1000,
    toTime: (1010 + timeOffset) * 1000,
    fromBarIndex: timeOffset,
    toBarIndex: timeOffset + 10,
    prevWaveType: "LL",
    currWaveType: "HL",
    _waveNum: -timeOffset,
  };
}

// Pull out internals for direct testing
// (Chunk 10, 2026-08-04): buildFibLevels/findDisplacingWave used to be hand-duplicated
// here — now imported from fibMath.js / motherwave.js above. `sp`/`bull` are kept:
// they're still called directly at 2 console.log lines further down (search "size=").
const sp = s => Math.abs(s.toPrice - s.fromPrice);
const bull = s => s.toSide === "high";

// ─── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  PASS — ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌  FAIL — ${name}`);
    console.log(`         → ${e.message}`);
    failed++;
  }
}

function expect(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`Expected "${expected}" but got "${actual}"  ${msg || ""}`);
  }
}

function expectNotNull(val, msg) {
  if (val == null) throw new Error(`Expected a value but got null/undefined  ${msg || ""}`);
}

// ─── DIRECT UNIT TESTS (test the exact changed function) ──────────────────────

console.log("\n═══════════════════════════════════════════════════");
console.log("   MOTHER WAVE — RULE 3 & RULE 4 TESTS");
console.log("═══════════════════════════════════════════════════\n");

console.log("── SECTION 1: Direct logic tests (findDisplacingWave) ──\n");

// ──────────────────────────────────────────────────────────────────────────────
test("Rule 3 — New wave EQUAL in size → size_promotion", () => {
  // MW: Bull wave from 100 → 200 (size = 100)
  const mwSeg = makeSeg(100, 200, 0, "high");
  const fibs = buildFibLevels(mwSeg);

  // Later wave: also 100 in size (200 → 300) — equal size, inside fibs
  const laterWave = makeSeg(200, 300, 20, "high");

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should find a displacing wave");
  expect(result.reason, "size_promotion", "should be size_promotion not fib_breach");
});

// ──────────────────────────────────────────────────────────────────────────────
test("Rule 3 — New wave LARGER in size → size_promotion", () => {
  // MW: Bull wave from 100 → 200 (size = 100)
  const mwSeg = makeSeg(100, 200, 0, "high");
  const fibs = buildFibLevels(mwSeg);

  // Later wave: size = 150 (bigger than MW) — clearly larger
  const laterWave = makeSeg(200, 350, 20, "high");

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should find a displacing wave");
  expect(result.reason, "size_promotion", "bigger wave must promote");
});

// ──────────────────────────────────────────────────────────────────────────────
test("Rule 4 — Wave INSIDE fib levels but LARGER → size_promotion", () => {
  // MW: Bull wave from 100 → 200 (size = 100)
  // Fib levels for bull: 1.0 = 100 (origin), -0.618 = 261.8 (extension)
  const mwSeg = makeSeg(100, 200, 0, "high");
  const fibs = buildFibLevels(mwSeg);

  console.log(`       MW fib levels: 1.0=${fibs["1.0"].toFixed(1)}  -0.618=${fibs["-0.618"].toFixed(1)}`);

  // Later wave: stays INSIDE fib range (doesn't go above 261.8 or below 100)
  // but size = 110 > MW size of 100
  // Wave goes from 145 to 255 (inside fib range, size=110)
  const laterWave = makeSeg(145, 255, 20, "high");
  console.log(`       Later wave: ${laterWave.fromPrice} → ${laterWave.toPrice}  size=${sp(laterWave)}`);
  console.log(`       Is inside fibs? high=${laterWave.toPrice} < -0.618 fib (${fibs["-0.618"].toFixed(1)})? ${laterWave.toPrice < fibs["-0.618"]}`);

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should find displacing wave");
  expect(result.reason, "size_promotion",
    "RULE 4: even inside fib bounds, if larger → must promote");
});

// ──────────────────────────────────────────────────────────────────────────────
test("Small wave inside fibs → NO promotion (MW stays)", () => {
  // MW: Bull wave 100 → 200 (size = 100)
  const mwSeg = makeSeg(100, 200, 0, "high");
  const fibs = buildFibLevels(mwSeg);

  // Later wave: size = 30 (smaller), inside fibs — should not trigger anything
  const laterWave = makeSeg(180, 150, 20, "low");   // bear wave, size=30, inside fibs

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  if (result !== null) {
    throw new Error(`Expected no displacement but got reason="${result.reason}"`);
  }
  // passing means result is null — MW is still valid
});

// ──────────────────────────────────────────────────────────────────────────────
test("Fib breach — bull wave exceeds -0.618 extension → fib_breach", () => {
  // MW: Bull wave 100 → 200 (size=100), -0.618 fib = 261.8
  const mwSeg = makeSeg(100, 200, 0, "high");
  const fibs = buildFibLevels(mwSeg);

  // Later wave: small size (50) but goes above 261.8 → fib breach
  const laterWave = makeSeg(220, 270, 20, "high");   // toPrice=270 > 261.8

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should detect fib breach");
  expect(result.reason, "fib_breach", "exceeding -0.618 = fib_breach");
});

// ──────────────────────────────────────────────────────────────────────────────
test("Origin breach — bear wave drops below 1.0 → fib_breach", () => {
  // MW: Bull wave 100 → 200 (size=100), origin = 100
  const mwSeg = makeSeg(100, 200, 0, "high");
  const fibs = buildFibLevels(mwSeg);

  // Later bear wave: toPrice = 90 < origin 100 → origin breach
  const laterWave = makeSeg(150, 90, 20, "low");

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should detect origin breach");
  expect(result.reason, "fib_breach", "breaching origin = fib_breach");
});

// ──────────────────────────────────────────────────────────────────────────────
test("SIZE CHECK runs before fib breach check (order matters)", () => {
  // If a wave is BOTH a fib breacher AND larger than MW size,
  // it should be labelled as size_promotion (size check runs first)
  const mwSeg = makeSeg(100, 200, 0, "high");
  const fibs = buildFibLevels(mwSeg);

  // Wave: size=150 (bigger), AND goes to 280 (above -0.618=261.8)
  const laterWave = makeSeg(120, 310, 20, "high");

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should find displacing wave");
  expect(result.reason, "size_promotion",
    "size_promotion must win over fib_breach when both conditions met");
});

// ─── SECTION 2: Bear MW tests ──────────────────────────────────────────────────

console.log("\n── SECTION 2: Bear MW tests ──\n");

test("Bear MW — Rule 3: equal size wave → size_promotion", () => {
  // Bear MW: from 200 → 100 (size=100)
  const mwSeg = makeSeg(200, 100, 0, "low");
  const fibs = buildFibLevels(mwSeg);

  // Later bear wave: 150 → 50 (size=100, equal)
  const laterWave = makeSeg(150, 50, 20, "low");

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should find displacing wave");
  expect(result.reason, "size_promotion", "equal bear wave must promote");
});

test("Bear MW — Rule 4: contained but larger → size_promotion", () => {
  // Bear MW: 200 → 100 (size=100)
  // -0.618 fib for bear = 100 - 0.618*100 = 38.2 (extension below tip)
  // 1.0 fib (origin) = 200
  const mwSeg = makeSeg(200, 100, 0, "low");
  const fibs = buildFibLevels(mwSeg);

  console.log(`       Bear MW fib levels: 1.0=${fibs["1.0"].toFixed(1)}  -0.618=${fibs["-0.618"].toFixed(1)}`);

  // Later bear wave: inside fib (doesn't breach 38.2 or go above 200)
  // But size=110 > 100
  // Wave: 185 → 75 (size=110, toPrice=75 stays above -0.618=38.2)
  const laterWave = makeSeg(185, 75, 20, "low");
  console.log(`       Later wave: ${laterWave.fromPrice} → ${laterWave.toPrice}  size=${sp(laterWave)}`);

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  expectNotNull(result, "should find displacing wave");
  expect(result.reason, "size_promotion", "RULE 4 bear: inside fib but larger → promote");
});

// ─── SECTION 3: Edge cases ─────────────────────────────────────────────────────

console.log("\n── SECTION 3: Edge cases ──\n");

test("Wave at EXACT equal size (not 1 less, not 1 more) → size_promotion", () => {
  const mwSeg = makeSeg(100, 200, 0, "high");   // size = 100 exactly
  const fibs = buildFibLevels(mwSeg);
  const laterWave = makeSeg(200, 300, 20, "high"); // size = 100 exactly

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);
  expectNotNull(result, "exact equal size should trigger");
  expect(result.reason, "size_promotion", "equal is >= so must promote");
});

test("Wave SLIGHTLY smaller (99.9) → no promotion (MW stays)", () => {
  const mwSeg = makeSeg(100, 200, 0, "high");      // size = 100
  const fibs = buildFibLevels(mwSeg);
  const laterWave = makeSeg(150, 249.9, 20, "high"); // size = 99.9

  const result = findDisplacingWave(mwSeg, fibs, [laterWave]);

  // 99.9 < 100 → no size promotion; also check if it breaches fibs
  // toPrice=249.9 vs -0.618=261.8 → no fib breach either
  if (result !== null) {
    throw new Error(`Size 99.9 < 100 should not displace, but got reason="${result.reason}"`);
  }
});

// ─── FINAL SUMMARY ────────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════");
console.log(`  RESULTS: ${passed} passed  |  ${failed} failed`);
console.log("═══════════════════════════════════════════════════\n");

if (failed === 0) {
  console.log("  🎉  ALL TESTS PASSED!");
  console.log("  ✔  Rule 3 (equal/larger wave = promote) is working correctly");
  console.log("  ✔  Rule 4 (inside fibs but larger = still promote) is working correctly");
  console.log("  ✔  Old fib breach logic is still working");
  console.log("  ✔  Size check runs before fib breach check (correct order)\n");
} else {
  console.log("  ⚠️  SOME TESTS FAILED — check the errors above\n");
}