"use strict";
// Standalone sanity test for computeRetestOutcome() — the Retest-Entry engine
// added in Chunk 1. Run with: node sanity_retest.js
// No test framework dependency — plain assert, exits non-zero on any failure.

const assert = require("assert");
const { computeRetestOutcome } = require("./strategies/absorptionFlip.js");

let passed = 0;
function check(label, actual, expected) {
  try {
    assert.strictEqual(actual, expected, `${label}: expected ${expected}, got ${actual}`);
    passed += 1;
  } catch (e) {
    console.error("FAIL:", e.message);
    process.exitCode = 1;
  }
}

// candle helper — {time, open, high, low, close}
const c = (t, o, h, l, cl) => ({ time: t, open: o, high: h, low: l, close: cl });

// ─────────────────────────────────────────────────────────────────────────
// TEST 1 — Bull, clean WIN
// doji at idx2: high=110 (ref level). zoneLevel=95 (invalidation boundary).
// retest dips to 98, then re-crosses above 110 at idx5 (entry), target (122)
// hit at idx6 before stop (98).
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4), // doji, high=110
    c(3, 104, 107, 101, 104),   // retest dip
    c(4, 100, 103, 98, 100),    // dip extreme = 98
    c(5, 100, 112, 99, 111),    // re-crosses 110 -> entry
    c(6, 111, 123, 115, 120),   // target(122) hit, stop(98) not hit -> win
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T1 state", r.state, "entered_win");
  check("T1 entryPrice", r.entryPrice, 110);
  check("T1 stopPrice", r.stopPrice, 98);
  check("T1 targetPrice", r.targetPrice, 122);
  check("T1 entryBarIndex", r.entryBarIndex, 5);
  check("T1 resolutionBarIndex", r.resolutionBarIndex, 6);
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 2 — Bull, clean LOSS (same setup, resolution candle hits stop instead)
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4),
    c(3, 104, 107, 101, 104),
    c(4, 100, 103, 98, 100),
    c(5, 100, 112, 99, 111),
    c(6, 111, 105, 97, 100),   // low=97 <= stop(98) -> loss; high never reaches target
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T2 state", r.state, "entered_loss");
  check("T2 resolutionBarIndex", r.resolutionBarIndex, 6);
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 3 — Bull, INVALIDATED (closes back into/below original zone before
// ever re-crossing the doji high)
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4), // doji, high=110
    c(3, 100, 103, 92, 94),     // closes 94 <= zoneLevel(95) -> invalidated
    c(4, 94, 130, 90, 129),     // would have crossed 110, but too late
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T3 state", r.state, "invalidated");
  check("T3 invalidatedBarIndex", r.invalidatedBarIndex, 3);
  check("T3 entryPrice is null", r.entryPrice, null);
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 4 — Bull, WATCHING (never invalidates, never re-crosses, candles run out)
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4), // doji, high=110, zoneLevel=90
    c(3, 100, 103, 96, 99),
    c(4, 99, 104, 97, 101),
    c(5, 101, 106, 98, 102),
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 90 };
  const r = computeRetestOutcome(event, candles);
  check("T4 state", r.state, "watching");
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 5 — Bear, clean WIN (mirror of T1)
// doji at idx2: low=90 (ref). zoneLevel=105.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 92, 93, 91, 92),
    c(1, 92, 93, 91, 91.5),
    c(2, 91, 92, 90, 90.6),   // doji, low=90
    c(3, 95, 98, 93, 95),     // retest rise
    c(4, 100, 103, 97, 100),  // rise extreme = 103
    c(5, 100, 101, 88, 89),   // low=88 crosses below 90 -> entry
    c(6, 89, 92, 75, 78),     // target(77) hit? target = 90-(103-90)=77; low=75<=77 -> win, high 92 < stop(103)
  ];
  const event = { direction: "down", dojiBarIndex: 2, zoneLevel: 105 };
  const r = computeRetestOutcome(event, candles);
  check("T5 state", r.state, "entered_win");
  check("T5 entryPrice", r.entryPrice, 90);
  check("T5 stopPrice", r.stopPrice, 103);
  check("T5 targetPrice", r.targetPrice, 77);
  check("T5 entryBarIndex", r.entryBarIndex, 5);
  check("T5 resolutionBarIndex", r.resolutionBarIndex, 6);
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 6 — Bear, INVALIDATED (mirror of T3)
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 92, 93, 91, 92),
    c(1, 92, 93, 91, 91.5),
    c(2, 91, 92, 90, 90.6),   // doji, low=90
    c(3, 100, 108, 98, 106),  // closes 106 >= zoneLevel(105) -> invalidated
    c(4, 106, 107, 80, 82),   // would have crossed below 90, too late
  ];
  const event = { direction: "down", dojiBarIndex: 2, zoneLevel: 105 };
  const r = computeRetestOutcome(event, candles);
  check("T6 state", r.state, "invalidated");
  check("T6 invalidatedBarIndex", r.invalidatedBarIndex, 3);
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 7 — TIE-BREAK: same resolution candle touches both stop and target.
// Flagged assumption: stop wins (conservative). Bull setup, entry=110,
// stop=98, target=122 (same numbers as T1), resolution candle spans both.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4),
    c(3, 104, 107, 101, 104),
    c(4, 100, 103, 98, 100),
    c(5, 100, 112, 99, 111),   // entry at 110
    c(6, 111, 125, 90, 100),   // low=90 (<=stop 98) AND high=125 (>=target 122) same bar
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T7 tie-break resolves to loss (stop-first assumption)", r.state, "entered_loss");
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 8 — OPEN/unresolved: entered but candles run out before stop or
// target is hit.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4),
    c(3, 104, 107, 101, 104),
    c(4, 100, 103, 98, 100),
    c(5, 100, 112, 99, 111),   // entry at 110, stop=98, target=122
    // no more candles after entry bar -> unresolved
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T8 state", r.state, "entered_open");
  check("T8 resolutionBarIndex is null", r.resolutionBarIndex, null);
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 9 — Degenerate zero-risk edge case: the entry candle's own low
// equals the doji-high reference level exactly (dip extreme == entry
// price), so risk would be 0. Must not divide-by-zero or emit a garbage
// target.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4), // doji, high=110 (ref)
    c(3, 110, 115, 110, 112),   // low=110 == ref, high=115 crosses -> zero risk
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T9 state", r.state, "invalid_zero_risk");
  check("T9 targetPrice is null", r.targetPrice, null);
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 10 — dojiBarIndex points past the end of available candles (no
// lookahead data yet) -> must not crash, returns watching.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [c(0, 100, 101, 99, 100)];
  const event = { direction: "up", dojiBarIndex: 5, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T10 state (out-of-range dojiBarIndex)", r.state, "watching");
}

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) {
  console.error("SOME TESTS FAILED.");
} else {
  console.log("ALL TESTS PASSED.");
}
