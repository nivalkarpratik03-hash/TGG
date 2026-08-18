/**
 * backend/src/services/indicatorMath.test.js
 *
 * TEST FILE — not part of the running app. Run manually:
 *   node backend/src/services/indicatorMath.test.js
 *
 * Covers the T5 Node Port Plan's Chunk 1 addition: pivotHigh/pivotLow.
 * calcEMA/trueRanges/wilderATR already run in production elsewhere in
 * the app (motherwave.js, backtestRunner.js, etc.) so this file only
 * adds a couple of cheap sanity checks for those, and focuses on the
 * new pivot functions, which had zero test coverage before this chunk.
 */

"use strict";

const assert = require("assert");
const { calcEMA, pivotHigh, pivotLow } = require("./indicatorMath");

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

console.log("[indicatorMath.test] ──");

// ── calcEMA — cheap existing-behaviour sanity check ────────────────
check("calcEMA: skips null/NaN instead of poisoning later values", () => {
  const prices = [10, 11, null, 12, NaN, 13];
  const out = calcEMA(prices, 3);
  assert.strictEqual(out[0], 10);
  assert.strictEqual(out[2], null); // untouched — no valid price yet at this index
  for (const v of out) assert.ok(v === null || !isNaN(v), "no NaN should ever appear in output");
});

// ── pivotHigh ───────────────────────────────────────────────────────
check("pivotHigh: simple 5-bar peak, left=2 right=2, confirms 2 bars late", () => {
  //            i:  0   1   2   3   4
  const highs = [10, 12, 15, 12, 10];
  const out = pivotHigh(highs, 2, 2);
  assert.strictEqual(out.length, 5);
  // Only bar index 2 can be a centre (needs 2 bars each side); it
  // becomes knowable at index 2+2=4, same lag the Node Port Plan
  // Chunk 1 checklist explicitly calls out ("pivot at bar p only
  // becomes knowable at bar p+right").
  assert.strictEqual(out[0], null);
  assert.strictEqual(out[1], null);
  assert.strictEqual(out[2], null);
  assert.strictEqual(out[3], null);
  assert.ok(out[4] !== null, "pivot should confirm at index 4");
  assert.strictEqual(out[4].price, 15);
  assert.strictEqual(out[4].pivotIndex, 2);
});

check("pivotHigh: no pivot when centre is not strictly highest", () => {
  const highs = [10, 12, 12, 12, 10]; // tie at the centre — not a pivot
  const out = pivotHigh(highs, 2, 2);
  assert.ok(out.every(v => v === null), "a tie must not register as a pivot");
});

check("pivotHigh: flat-then-rising — no false pivot mid-flat", () => {
  const highs = [5, 5, 5, 5, 5, 6, 5, 5, 5, 5, 5];
  const out = pivotHigh(highs, 2, 2);
  const hits = out.filter(v => v !== null);
  assert.strictEqual(hits.length, 1, "exactly one pivot expected");
  assert.strictEqual(hits[0].pivotIndex, 5);
  assert.strictEqual(hits[0].price, 6);
});

check("pivotHigh: too few bars around the edges never throws", () => {
  const highs = [1, 2, 3];
  const out = pivotHigh(highs, 2, 2);
  assert.strictEqual(out.length, 3);
  assert.ok(out.every(v => v === null));
});

check("pivotHigh: left/right = 0 means every strictly-local bar can pivot", () => {
  const highs = [1, 2, 1];
  const out = pivotHigh(highs, 0, 0);
  // With no window at all, every bar is trivially its own pivot.
  assert.strictEqual(out.filter(v => v !== null).length, 3);
});

check("pivotHigh: rejects negative left/right", () => {
  assert.throws(() => pivotHigh([1, 2, 3], -1, 2));
});

// ── pivotLow — mirror of pivotHigh ─────────────────────────────────
check("pivotLow: simple 5-bar trough, left=2 right=2, confirms 2 bars late", () => {
  const lows = [10, 8, 5, 8, 10];
  const out = pivotLow(lows, 2, 2);
  assert.strictEqual(out[0], null);
  assert.strictEqual(out[3], null);
  assert.ok(out[4] !== null);
  assert.strictEqual(out[4].price, 5);
  assert.strictEqual(out[4].pivotIndex, 2);
});

check("pivotLow: no pivot when centre is not strictly lowest", () => {
  const lows = [10, 8, 8, 8, 10];
  const out = pivotLow(lows, 2, 2);
  assert.ok(out.every(v => v === null));
});

check("pivotLow/pivotHigh: never emit NaN/undefined prices across a longer synthetic series", () => {
  // Deterministic pseudo-random walk — regression guard against any
  // off-by-one indexing bug throwing or emitting garbage.
  const n = 200;
  const highs = new Array(n);
  const lows = new Array(n);
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let base = 100;
  for (let i = 0; i < n; i++) {
    base += (rand() - 0.5) * 2;
    highs[i] = base + rand();
    lows[i] = base - rand();
  }
  const hi = pivotHigh(highs, 2, 2);
  const lo = pivotLow(lows, 2, 2);
  for (const v of hi) if (v !== null) assert.ok(Number.isFinite(v.price) && Number.isInteger(v.pivotIndex));
  for (const v of lo) if (v !== null) assert.ok(Number.isFinite(v.price) && Number.isInteger(v.pivotIndex));
});

console.log(`\n[indicatorMath.test] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
