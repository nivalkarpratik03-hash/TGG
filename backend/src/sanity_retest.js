"use strict";
// Standalone sanity test for computeRetestOutcome() — the Retest-Entry engine
// added in Chunk 1. Run with: node sanity_retest.js
// No test framework dependency — plain assert, exits non-zero on any failure.

const assert = require("assert");
const { computeRetestOutcome, isLastCandleForming, detectSpacingMs, scan } = require("./strategies/absorptionFlip.js");

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
  check("T7 tie on a POST-entry candle (not the entry bar) still resolves to loss", r.state, "entered_loss");
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 7b — BIG CANDLE (user-confirmed rule): the ENTRY bar itself is the
// one that hits both stop and target in its own range (small Doji dip,
// then one big-range candle re-crosses AND runs to target AND its own low
// sets/undercuts the stop, all on that same candle — realistic on 1D bars).
// Must NOT be scored as a win or a loss — its own outcome, "big_candle".
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = [
    c(0, 108, 109, 107, 108),
    c(1, 108, 109, 107, 108.5),
    c(2, 109, 110, 108, 109.4), // doji, high=110 (ref)
    c(3, 104, 107, 101, 104),   // dip
    c(4, 100, 103, 98, 100),    // dip continues, low=98
    c(5, 100, 135, 90, 132),    // entry bar: low=90 sets stop; high=135 crosses ref (110) AND clears target (130) same candle
  ];
  const event = { direction: "up", dojiBarIndex: 2, zoneLevel: 95 };
  const r = computeRetestOutcome(event, candles);
  check("T7b entry-bar tie resolves to big_candle, not win/loss", r.state, "big_candle");
  check("T7b entryPrice", r.entryPrice, 110);
  check("T7b stopPrice", r.stopPrice, 90);
  check("T7b targetPrice", r.targetPrice, 130);
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

// ═════════════════════════════════════════════════════════════════════════
// TESTS 11+ — Forming-candle guard (FIX — 2026-09-02)
// Doji must never fire off a candle that hasn't closed yet. Covers
// detectSpacingMs() + isLastCandleForming() directly across several real
// timeframes, then scan() end-to-end to confirm the guard is actually wired
// in and doesn't crash the strategy.
// ─────────────────────────────────────────────────────────────────────────
const now = Date.now();

// Build N candles ending at `lastTime`, spaced `spacingMs` apart, oldest
// first — plain, non-doji-shaped OHLC (irrelevant to these tests; only
// timing matters here).
function buildSpacedCandles(count, spacingMs, lastTime) {
  const out = [];
  const start = lastTime - spacingMs * (count - 1);
  for (let i = 0; i < count; i++) {
    const t = start + i * spacingMs;
    const base = 100 + (i % 5);
    out.push(c(t, base, base + 2, base - 2, base + 0.5));
  }
  return out;
}

// ── TEST 11 — detectSpacingMs: uniform 1-minute spacing ────────────────
{
  const candles = buildSpacedCandles(10, 60 * 1000, now);
  check("T11 detectSpacingMs 1m", detectSpacingMs(candles), 60 * 1000);
}

// ── TEST 12 — detectSpacingMs: uniform 5-minute spacing ────────────────
{
  const candles = buildSpacedCandles(10, 5 * 60 * 1000, now);
  check("T12 detectSpacingMs 5m", detectSpacingMs(candles), 5 * 60 * 1000);
}

// ── TEST 13 — detectSpacingMs: one irregular gap (holiday/session break)
// among otherwise-regular 15m bars — majority spacing must still win.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(12, 15 * 60 * 1000, now);
  // Blow out one gap in the middle (simulates an overnight/holiday jump) —
  // shift every candle from index 6 onward forward by 3 hours.
  for (let i = 6; i < candles.length; i++) candles[i].time += 3 * 60 * 60 * 1000;
  check("T13 detectSpacingMs ignores one outlier gap", detectSpacingMs(candles), 15 * 60 * 1000);
}

// ── TEST 14 — isLastCandleForming: 1m candle that closed 4 minutes ago
// (fully historical) -> NOT forming.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(10, 60 * 1000, now - 5 * 60 * 1000);
  check("T14 1m closed candle -> not forming", isLastCandleForming(candles), false);
}

// ── TEST 15 — isLastCandleForming: 1m candle that started 30s ago (its
// own 60s period hasn't elapsed yet) -> IS forming. This is the exact bug
// the user flagged: a live candle still running, mid-bar.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(10, 60 * 1000, now - 30 * 1000);
  check("T15 1m live mid-bar candle -> forming", isLastCandleForming(candles), true);
}

// ── TEST 16 — isLastCandleForming: daily (1D) bar for TODAY, started 2
// hours ago, market still open — the whole-day period (~24h) hasn't
// elapsed -> IS forming. Confirms the guard also protects D/W/M timeframes,
// not just intraday.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(10, 24 * 60 * 60 * 1000, now - 2 * 60 * 60 * 1000);
  check("T16 daily bar still within today -> forming", isLastCandleForming(candles), true);
}

// ── TEST 17 — isLastCandleForming: daily bar from 3 days ago (fully
// closed, e.g. running scan() on old/historical data) -> NOT forming.
// Confirms the guard doesn't wrongly trim genuinely historical data.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(10, 24 * 60 * 60 * 1000, now - 3 * 24 * 60 * 60 * 1000);
  check("T17 old daily bar -> not forming", isLastCandleForming(candles), false);
}

// ── TEST 18 — isLastCandleForming: too little history to infer spacing
// (<3 candles) -> safe default false, never crashes.
// ─────────────────────────────────────────────────────────────────────────
{
  check("T18 1 candle -> safe false", isLastCandleForming([c(now, 100, 101, 99, 100)]), false);
  check("T18 2 candles -> safe false", isLastCandleForming(buildSpacedCandles(2, 60000, now)), false);
  check("T18 empty array -> safe false", isLastCandleForming([]), false);
}

// ── TEST 19 — scan() end-to-end: 40 clean 5m candles, last one still
// forming (started 1 minute ago, well inside its own 5m period). Detection
// must run on the 39 closed candles only, flag formingCandleExcluded=true,
// and must not crash.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(40, 5 * 60 * 1000, now - 60 * 1000);
  const result = scan("TEST:FORMING5M", candles);
  check("T19 no crash (error null)", result.error, null);
  check("T19 formingCandleExcluded flag set", result.formingCandleExcluded, true);
  check("T19 lastCandle still the RAW last (live) candle", result.lastCandle.time, candles[candles.length - 1].time);
}

// ── TEST 20 — scan() end-to-end: exactly 30 candles, last one forming.
// After exclusion only 29 remain (< 30 minimum) -> must degrade to
// insufficient_data cleanly, not crash, not silently run on too little data.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(30, 60 * 1000, now - 20 * 1000);
  const result = scan("TEST:FORMING_BOUNDARY", candles);
  check("T20 formingCandleExcluded flag set", result.formingCandleExcluded, true);
  check("T20 degrades to insufficient_data", result.error, "insufficient_data");
}

// ── TEST 21 — scan() end-to-end: 40 fully-closed 15m candles (old
// historical data, e.g. after market close or a genuine backtest window) ->
// formingCandleExcluded must stay false, unchanged behavior.
// ─────────────────────────────────────────────────────────────────────────
{
  const candles = buildSpacedCandles(40, 15 * 60 * 1000, now - 60 * 60 * 1000);
  const result = scan("TEST:ALLCLOSED15M", candles);
  check("T21 no crash (error null)", result.error, null);
  check("T21 formingCandleExcluded stays false on closed data", result.formingCandleExcluded, false);
}

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) {
  console.error("SOME TESTS FAILED.");
} else {
  console.log("ALL TESTS PASSED.");
}