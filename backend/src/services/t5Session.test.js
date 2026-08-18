/**
 * backend/src/services/t5Session.test.js
 *
 * TEST FILE — not part of the running app. Run manually:
 *   node backend/src/services/t5Session.test.js
 */

"use strict";

const assert = require("assert");
const { getSessionBoundaries, computeSymScale } = require("./t5Session");

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

console.log("[t5Session.test] ──");

// Helper: build a fake 15m candle at a given IST date + HH:mm, stored as
// true UTC epoch ms (mirrors candleBuilder.js's floorToMinute() output —
// IST wall-clock time converted to the real UTC instant).
function istCandle(dateStr, hh, mm, close = 100) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const utcMs = new Date(`${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`).getTime() - IST_OFFSET_MS;
  return { time: utcMs, open: close, high: close, low: close, close };
}

// ── getSessionBoundaries ────────────────────────────────────────────
check("getSessionBoundaries: single day — only index 0 is a boundary", () => {
  const candles = [
    istCandle("2026-08-17", 9, 15),
    istCandle("2026-08-17", 9, 30),
    istCandle("2026-08-17", 9, 45),
  ];
  assert.deepStrictEqual(getSessionBoundaries(candles), [0]);
});

check("getSessionBoundaries: three trading days — one boundary per day", () => {
  const candles = [
    istCandle("2026-08-17", 9, 15),
    istCandle("2026-08-17", 9, 30),
    istCandle("2026-08-18", 9, 15),
    istCandle("2026-08-18", 9, 30),
    istCandle("2026-08-18", 9, 45),
    istCandle("2026-08-19", 9, 15),
  ];
  assert.deepStrictEqual(getSessionBoundaries(candles), [0, 2, 5]);
});

check("getSessionBoundaries: late-night IST bar doesn't get misdated to UTC's calendar day", () => {
  // 23:30 IST on 17 Aug is still 17 Aug in IST even though in raw UTC
  // (18:00 UTC) it's the same UTC day too here — pick a case where UTC
  // and IST calendar dates actually DIFFER: 00:30 IST on 18 Aug is
  // 19:00 UTC on 17 Aug. A naive UTC-only date read would mislabel this
  // as still-17th; the IST-shifted read must call it the 18th.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const utcMsFor0030ist18Aug = new Date("2026-08-18T00:30:00.000Z").getTime() - IST_OFFSET_MS;
  const candles = [
    istCandle("2026-08-17", 15, 30), // ordinary last bar of the 17th
    { time: utcMsFor0030ist18Aug, open: 1, high: 1, low: 1, close: 1 },
  ];
  const boundaries = getSessionBoundaries(candles);
  assert.deepStrictEqual(boundaries, [0, 1], "the 00:30 IST bar must register as a new session");
});

check("getSessionBoundaries: empty input never throws", () => {
  assert.deepStrictEqual(getSessionBoundaries([]), []);
});

// ── computeSymScale ─────────────────────────────────────────────────
check("computeSymScale: autoScale=false → 1.0 for every bar, always", () => {
  const candles = [
    istCandle("2026-08-17", 9, 15, 500),
    istCandle("2026-08-17", 9, 30, 24000000), // absurd close — must NOT matter
  ];
  const boundaries = getSessionBoundaries(candles);
  const out = computeSymScale(candles, boundaries, false);
  assert.deepStrictEqual(out, [1.0, 1.0]);
});

check("computeSymScale: autoScale=true → recomputed at each boundary, carried forward otherwise", () => {
  const candles = [
    istCandle("2026-08-17", 9, 15, 24000), // day 1 open — scale = 1.0
    istCandle("2026-08-17", 9, 30, 48000), // same day — scale unchanged despite close doubling
    istCandle("2026-08-18", 9, 15, 12000), // day 2 open — scale = 0.5
    istCandle("2026-08-18", 9, 30, 999),   // same day — still 0.5
  ];
  const boundaries = getSessionBoundaries(candles); // [0, 2]
  const out = computeSymScale(candles, boundaries, true);
  assert.strictEqual(out[0], 1.0);
  assert.strictEqual(out[1], 1.0, "must carry forward, not react to bar 1's own close");
  assert.strictEqual(out[2], 0.5);
  assert.strictEqual(out[3], 0.5);
});

check("computeSymScale: floors at 0.000001, matching Pine's math.max floor", () => {
  const candles = [istCandle("2026-08-17", 9, 15, 0)];
  const boundaries = getSessionBoundaries(candles);
  const out = computeSymScale(candles, boundaries, true);
  assert.strictEqual(out[0], 0.000001);
});

console.log(`\n[t5Session.test] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
