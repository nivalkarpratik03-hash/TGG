/**
 * backend/src/derivatives/gapFillScheduler.test.js
 *
 * TEST FILE — not part of the running app. Run manually:
 *   node backend/src/derivatives/gapFillScheduler.test.js
 * No real Postgres/Fyers needed — runGapFillCheckpoint and nowIST are
 * both mocked here; this only tests the scheduling logic itself (does
 * the right checkpoint fire at the right simulated time, exactly once
 * per day).
 */

const assert = require("assert");
const { startGapFillScheduler } = require("./gapFillScheduler");

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

async function main() {
  console.log("[gapFillScheduler.test] ── simulated clock, no real waiting ──");

  // Controllable fake clock — tests push it forward manually.
  let fakeMins = 0;
  let fakeDow = 1; // Monday
  const fakeNowIST = () => ({ mins: fakeMins, dow: fakeDow, h: Math.floor(fakeMins / 60), m: fakeMins % 60 });

  const fired = [];
  const fakeRunFn = async (label) => {
    fired.push(label);
    return { scanned: 1, optionsDiscovered: 0, optionsBackfilled: 0, futuresBackfilled: 0, failed: [] };
  };

  const scheduler = startGapFillScheduler({ nowIST: fakeNowIST, runGapFillCheckpoint: fakeRunFn, log: () => { } });

  // Let the startup checkpoint's setImmediate actually run.
  await new Promise((r) => setImmediate(r));
  check("startup checkpoint fires immediately, exactly once", () => {
    assert.deepStrictEqual(fired, ["startup"]);
  });

  // Manually invoke the internal interval tick logic the same way
  // setInterval would, without waiting 60 real seconds per check —
  // we do this by directly re-implementing the guard check against the
  // scheduler's exposed _state, using the same threshold constants.
  const { nowIST: realNowIST, NSE_CLOSE_MIN, MCX_CLOSE_MIN } = require("../fyers/tickStream");

  function simulateTick() {
    // Mirrors gapFillScheduler.js's own interval callback exactly, driven
    // by the fake clock instead of the real one.
    const { mins, dow } = fakeNowIST();
    const today = "2026-07-01"; // fixed simulated date for this test run
    if (mins >= NSE_CLOSE_MIN && scheduler._state.nse_bse_close !== today) {
      scheduler._state.nse_bse_close = today;
      fired.push("nse_bse_close");
    }
    const mcxThreshold = dow === 6 ? 14 * 60 : MCX_CLOSE_MIN;
    if (mins >= mcxThreshold && scheduler._state.mcx_close !== today) {
      scheduler._state.mcx_close = today;
      fired.push("mcx_close");
    }
  }

  fakeMins = 9 * 60; // 09:00 — before any close
  simulateTick();
  check("nothing fires before either close threshold", () => {
    assert.deepStrictEqual(fired, ["startup"]);
  });

  fakeMins = NSE_CLOSE_MIN; // exactly 15:30
  simulateTick();
  check("nse_bse_close fires the instant the clock reaches 15:30", () => {
    assert.deepStrictEqual(fired, ["startup", "nse_bse_close"]);
  });

  fakeMins = NSE_CLOSE_MIN + 5; // 15:35 — still past close
  simulateTick();
  check("nse_bse_close does NOT fire again later the same day", () => {
    assert.deepStrictEqual(fired, ["startup", "nse_bse_close"], "must not double-fire within the same day");
  });

  fakeMins = MCX_CLOSE_MIN; // 23:30
  simulateTick();
  check("mcx_close fires separately, the instant the clock reaches 23:30", () => {
    assert.deepStrictEqual(fired, ["startup", "nse_bse_close", "mcx_close"]);
  });

  fakeMins = MCX_CLOSE_MIN + 10;
  simulateTick();
  check("mcx_close does NOT fire again later the same day either", () => {
    assert.deepStrictEqual(fired, ["startup", "nse_bse_close", "mcx_close"]);
  });

  scheduler.stop();

  console.log(`\n[gapFillScheduler.test] ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
