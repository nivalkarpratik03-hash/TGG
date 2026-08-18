/**
 * backend/src/services/t5Trend.test.js
 *
 * TEST FILE — not part of the running app. Run manually:
 *   node backend/src/services/t5Trend.test.js
 *
 * The main scenario's bandHigh/bandLow (EMA9) values are computed BY
 * HAND in the comments below (k = 2/10 = 0.2) rather than re-derived
 * from calcEMA in the test itself — an independent check, not a mirror
 * of computeTrend's own math, so it actually catches a wrong port
 * instead of just confirming the code agrees with itself.
 */

"use strict";

const assert = require("assert");
const { computeTrend } = require("./t5Trend");

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

console.log("[t5Trend.test] ──");

function bar(time, open, high, low, close) {
  return { time, open, high, low, close };
}

// ── Scenario: SIDEWAYS -> UP (unconfirmed) -> UP (confirmed) -> DOWN ──
//
// Hand-computed EMA9 (k=0.2, ema[i] = price[i]*0.2 + ema[i-1]*0.8),
// seeded from the first bar (same as Pine's ta.ema and calcEMA()):
//
//   i  high  low   bandHigh                 bandLow
//   0  100   95    100                      95
//   1  100   95    100                      95
//   2  100   95    100                      95
//   3  130   125   136*.2+... = 106         101 (125*.2+95*.8)
//   4  136   130   136*.2+106*.8=112.0      130*.2+101*.8=106.8
//   5  92    78    92*.2+112*.8=108.0       78*.2+106.8*.8=101.04
//
// Bars 0-2: open=close=100 (flat/neutral) -> stays SIDEWAYS.
// Bar 3:   open=120 close=128 high=130 low=125 (green).
//          close(128) > bandHigh(106) -> switches to UP.
//          structHigh set to THIS bar's own high (130), so the
//          same-bar confirm check (close > structHigh) is 128 > 130 =
//          false -> stays UNCONFIRMED on the switching bar itself.
// Bar 4:   open=131 close=135 high=136 low=130 (green).
//          still UP (no re-switch). confirm check uses bar 3's
//          structHigh (130): close(135) > 130 = true, isGreen = true
//          -> CONFIRMS on this bar.
// Bar 5:   open=90 close=80 high=92 low=78 (red).
//          close(80) < bandLow(101.04) and trendState != DOWN ->
//          switches straight to DOWN (no SIDEWAYS in between).
//          trendConfirmed must reset to false on the switch.
const candles = [
  bar(0, 100, 100, 95, 100),
  bar(1, 100, 100, 95, 100),
  bar(2, 100, 100, 95, 100),
  bar(3, 120, 130, 125, 128),
  bar(4, 131, 136, 130, 135),
  bar(5, 90, 92, 78, 80),
];
const trend = computeTrend(candles);

check("bar 0-2: stays SIDEWAYS while close is inside the band both ways", () => {
  for (let i = 0; i <= 2; i++) {
    assert.strictEqual(trend[i].trendState, "SIDEWAYS");
    assert.strictEqual(trend[i].trendConfirmed, false);
    assert.strictEqual(trend[i].sidewaysNow, true);
    assert.strictEqual(trend[i].huntT5H, false);
    assert.strictEqual(trend[i].huntT5L, false);
  }
});

check("bar 0-2: bandHigh/bandLow match hand-computed EMA9 seed", () => {
  assert.strictEqual(trend[0].bandHigh, 100);
  assert.strictEqual(trend[0].bandLow, 95);
  assert.strictEqual(trend[2].bandHigh, 100);
  assert.strictEqual(trend[2].bandLow, 95);
});

check("bar 3: switches to UP but is NOT confirmed on the switching bar", () => {
  assert.strictEqual(trend[3].trendState, "UP");
  assert.strictEqual(trend[3].trendConfirmed, false);
  assert.strictEqual(trend[3].huntT5H, false, "hunt flag requires confirmation, not just the switch");
  assert.ok(Math.abs(trend[3].bandHigh - 106) < 1e-9);
});

check("bar 4: same bar confirms — green close beats the switching bar's own high", () => {
  assert.strictEqual(trend[4].trendState, "UP");
  assert.strictEqual(trend[4].trendConfirmed, true);
  assert.strictEqual(trend[4].huntT5H, true);
});

check("bar 5: DOWN switch is direct from UP — no SIDEWAYS step in between", () => {
  assert.strictEqual(trend[5].trendState, "DOWN");
});

check("bar 5: trendConfirmed resets to false on ANY trend switch", () => {
  assert.strictEqual(trend[5].trendConfirmed, false);
  assert.strictEqual(trend[5].huntT5L, false);
});

// ── Structural invariants ────────────────────────────────────────────
check("huntT5H and huntT5L are never both true on the same bar", () => {
  for (const t of trend) assert.ok(!(t.huntT5H && t.huntT5L));
});

check("trendConfirmed is always false while sidewaysNow is true", () => {
  for (const t of trend) if (t.sidewaysNow) assert.strictEqual(t.trendConfirmed, false);
});

check("output length/order matches input; time is passed through untouched", () => {
  assert.strictEqual(trend.length, candles.length);
  for (let i = 0; i < candles.length; i++) assert.strictEqual(trend[i].time, candles[i].time);
});

check("empty input never throws", () => {
  assert.deepStrictEqual(computeTrend([]), []);
});

check("single-bar input never throws and stays SIDEWAYS (no band history yet to break)", () => {
  const out = computeTrend([bar(0, 100, 101, 99, 100)]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].trendState, "SIDEWAYS");
});

// ── Regression guard — longer synthetic series never crashes / NaNs ──
check("long synthetic series: no NaN/undefined, no throw", () => {
  const n = 300;
  const arr = [];
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let px = 100;
  for (let i = 0; i < n; i++) {
    const open = px;
    px += (rand() - 0.5) * 4;
    const close = px;
    const high = Math.max(open, close) + rand();
    const low = Math.min(open, close) - rand();
    arr.push(bar(i, open, high, low, close));
  }
  const out = computeTrend(arr);
  assert.strictEqual(out.length, n);
  for (const t of out) {
    assert.ok(["UP", "DOWN", "SIDEWAYS"].includes(t.trendState));
    assert.strictEqual(typeof t.trendConfirmed, "boolean");
    assert.ok(t.bandHigh === null || Number.isFinite(t.bandHigh));
    assert.ok(t.bandLow === null || Number.isFinite(t.bandLow));
  }
});

console.log(`\n[t5Trend.test] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
