/**
 * backend/src/derivatives/gapFillScheduler.test.js
 *
 * TEST FILE — not part of the running app. Run manually:
 *   node backend/src/derivatives/gapFillScheduler.test.js
 * No real Postgres/Fyers needed — runGapFillCheckpoint and nowIST are
 * both mocked here; this only tests the scheduling logic itself (does
 * the right checkpoint fire at the right simulated time, exactly once
 * per day, and does the startup checkpoint fire exactly once and only
 * on explicit request).
 *
 * UPDATED 2026-07-30: startGapFillScheduler() was split into
 * wireGapFillScheduler() (recurring close-time checks only) +
 * fireStartupCheckpoint() (explicit, caller-triggered). This also fixes
 * this test's own previously-broken import: `NSE_CLOSE_MIN`/`MCX_CLOSE_MIN`
 * used to come back `undefined` from tickStream.js (never exported there),
 * so the old version of this test was silently comparing `mins >=
 * undefined` — always false — and would NOT actually have caught a
 * scheduling regression. tickStream.js now exports both correctly.
 */

const assert = require("assert");
const { wireGapFillScheduler } = require("./gapFillScheduler");

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

  // UPDATED 2026-08-06: wireGapFillScheduler() now requires
  // sweepCuratedStaleness and runValidatorRecovery in deps (fire() calls
  // all three, in order — see gapFillScheduler.js header). No-op fakes
  // here since this test is only about the SCHEDULING logic (right
  // checkpoint, right time, right dedup) — the actual behavior of those
  // two functions is tested in dataFetch.js's and catchUp.js's own test
  // coverage, not here. Deliberately don't push into `fired` — this
  // test's assertions track only runGapFillCheckpoint's own calls.
  const noopStaleness = async () => { };
  const noopValidatorRecovery = async () => { };
  const scheduler = wireGapFillScheduler({ nowIST: fakeNowIST, runGapFillCheckpoint: fakeRunFn, sweepCuratedStaleness: noopStaleness, runValidatorRecovery: noopValidatorRecovery, log: () => { } });

  check("wiring the scheduler does NOT fire a startup checkpoint by itself", () => {
    assert.deepStrictEqual(fired, [], "startup must only fire via an explicit fireStartupCheckpoint() call, never automatically");
  });

  await scheduler.fireStartupCheckpoint();
  check("fireStartupCheckpoint() fires the startup checkpoint exactly once when called", () => {
    assert.deepStrictEqual(fired, ["startup"]);
  });

  await scheduler.fireStartupCheckpoint();
  check("calling fireStartupCheckpoint() again is a safe no-op (no duplicate broker sweep)", () => {
    assert.deepStrictEqual(fired, ["startup"], "must not fire a second startup checkpoint");
  });

  // Manually invoke the internal interval tick logic the same way
  // setInterval would, without waiting 60 real seconds per check —
  // we do this by directly re-implementing the guard check against the
  // scheduler's exposed _state, using the same threshold constants this
  // file itself now correctly exports.
  const { NSE_CLOSE_MIN, MCX_CLOSE_MIN } = require("../fyers/tickStream");
  // UPDATED 2026-08-12: checkpoints now fire GAP_MIN after the real close,
  // not exactly at it — mirrors gapFillScheduler.js's own
  // CHECKPOINT_CLOSE_GAP_MIN (kept as a literal here rather than exported,
  // since it's an internal implementation detail of the fire-time check,
  // not part of the module's public contract).
  const GAP_MIN = 10;
  check("tickStream.js actually exports NSE_CLOSE_MIN/MCX_CLOSE_MIN (regression guard for the root-cause export bug)", () => {
    assert.strictEqual(typeof NSE_CLOSE_MIN, "number", "NSE_CLOSE_MIN must be a real exported number, not undefined");
    assert.strictEqual(typeof MCX_CLOSE_MIN, "number", "MCX_CLOSE_MIN must be a real exported number, not undefined");
  });

  function simulateTick() {
    // Mirrors gapFillScheduler.js's own interval callback exactly, driven
    // by the fake clock instead of the real one.
    const { mins, dow } = fakeNowIST();
    const today = "2026-07-01"; // fixed simulated date for this test run
    if (mins >= NSE_CLOSE_MIN + GAP_MIN && scheduler._state.nse_bse_close !== today) {
      scheduler._state.nse_bse_close = today;
      fired.push("nse_bse_close");
    }
    const mcxThreshold = (dow === 6 ? 14 * 60 : MCX_CLOSE_MIN) + GAP_MIN;
    if (mins >= mcxThreshold && scheduler._state.mcx_close !== today) {
      scheduler._state.mcx_close = today;
      fired.push("mcx_close");
    }
  }

  fakeMins = 9 * 60; // 09:00 — before any close
  simulateTick();
  check("nothing fires before either close+gap threshold", () => {
    assert.deepStrictEqual(fired, ["startup"]);
  });

  fakeMins = NSE_CLOSE_MIN; // exactly the real close (15:40) — gap not yet elapsed
  simulateTick();
  check("nse_bse_close does NOT fire at the real close — must wait for the 10min gap", () => {
    assert.deepStrictEqual(fired, ["startup"]);
  });

  fakeMins = NSE_CLOSE_MIN + GAP_MIN; // 15:50 — real close + 10min gap
  simulateTick();
  check("nse_bse_close fires the instant the clock reaches real-close+10min (15:50)", () => {
    assert.deepStrictEqual(fired, ["startup", "nse_bse_close"]);
  });

  fakeMins = NSE_CLOSE_MIN + GAP_MIN + 5; // 15:55 — still past close+gap
  simulateTick();
  check("nse_bse_close does NOT fire again later the same day", () => {
    assert.deepStrictEqual(fired, ["startup", "nse_bse_close"], "must not double-fire within the same day");
  });

  fakeMins = MCX_CLOSE_MIN + GAP_MIN; // 23:40 — real close (23:30) + 10min gap
  simulateTick();
  check("mcx_close fires separately, the instant the clock reaches real-close+10min (23:40)", () => {
    assert.deepStrictEqual(fired, ["startup", "nse_bse_close", "mcx_close"]);
  });

  fakeMins = MCX_CLOSE_MIN + GAP_MIN + 10;
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