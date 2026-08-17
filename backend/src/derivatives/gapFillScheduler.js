/**
 * backend/src/derivatives/gapFillScheduler.js
 *
 * RESTRUCTURED 2026-08-06 (items 4 & 6 of the ongoing cleanup plan,
 * TGG-project-plan.md Section 4l): this file used to only fire
 * derivativesGapFill.runGapFillCheckpoint() at the 3 checkpoints below.
 * It now fires the FULL chain, in order, at each of those same 3
 * checkpoints:
 *
 *     sweepCuratedStaleness  →  runGapFillCheckpoint  →  runValidatorRecovery
 *
 * (item 6 — the new agreed order). Previously, Validator+Recovery+
 * Staleness ran ONCE, at boot only, via catchUp.js's old combined
 * runCuratedSymbolCatchUp(), chained BEFORE GapFill's own startup
 * checkpoint via a one-time .then() in scheduler.js. That whole chain is
 * gone — this file's existing once-per-day-per-checkpoint gate (below) now
 * covers Staleness and Validator/Recovery too, not just GapFill, so all
 * three genuinely run 3x/day (item 4), not once at boot.
 *
 * Fires at:
 *   - "startup"        — once, but NOT from this file directly (see
 *                        fireStartupCheckpoint below) — the caller
 *                        (scheduler.js) triggers it explicitly.
 *   - "nse_bse_close"  — once per day, the first time the clock crosses
 *                        NSE/BSE's real close + a 10min buffer (real close
 *                        15:40 IST → fires 15:50 IST). See
 *                        CHECKPOINT_CLOSE_GAP_MIN below.
 *   - "mcx_close"      — once per day, the first time the clock crosses
 *                        MCX's real close + the same 10min buffer (real
 *                        close 23:30 IST weekdays → fires 23:40 IST; 14:00
 *                        IST Saturday → fires 14:10 IST).
 *   - "reauth"         — via fireReauthCheckpoint(), whenever a Fyers
 *                        token goes from invalid to valid again (see
 *                        chartRouter.js). Deliberately NOT subject to the
 *                        once-per-day date gate below — a re-auth is an
 *                        exceptional, unscheduled event that can happen
 *                        more than once in a day (token expired twice),
 *                        and each time it does, the full chain should run
 *                        again rather than silently no-op because
 *                        "today" already fired once for a different
 *                        reason.
 *
 * Reuses the exact IST time logic already tested and used for live-market
 * gating elsewhere (fyers/tickStream.js's nowIST() + its real close-time
 * constants) rather than a second, independently-maintained copy of the
 * same clock math.
 *
 * Deliberately NOT gated by isTradingDay/isLiveMarket — same reasoning as
 * pruneExpiredDerivatives.js's schedule: this makes real broker calls, but
 * running it on a holiday just means the broker returns whatever the last
 * real trading day's data already was — harmless, not incorrect. Simpler
 * to always run than to special-case holidays here too.
 *
 * "Once per day" guard: tracks the IST calendar date (YYYY-MM-DD) each of
 * nse_bse_close/mcx_close last fired on. A checkpoint won't fire again
 * until that date string changes — this is what stops it re-firing every
 * minute for the ~8+ hours the clock stays past the threshold each day.
 * "startup" and "reauth" are each their own one-off/unlimited triggers,
 * outside this date-gated mechanism entirely (see their own guards below).
 */

const { nowIST, NSE_CLOSE_MIN, MCX_CLOSE_MIN, MCX_SAT_CLOSE } = require("../fyers/tickStream");
const { runGapFillCheckpoint } = require("./derivativesGapFill");

const CHECK_INTERVAL_MS = 60 * 1000; // check once a minute — cheap, no broker calls happen here, only the eventual checkpoint run does

// ADDED 2026-08-17 — one on/off flag for the two CLOCK-TRIGGERED recurring
// checkpoints only (nse_bse_close, mcx_close). Same pattern as
// VERBOSE_LOGS in verboseLog.js: an env var, off is the exception not the
// default, no code edits needed to flip it.
//
// Deliberately does NOT touch "startup" (fireStartupCheckpoint) or
// "reauth" (fireReauthCheckpoint) — those are one-off/user-triggered, not
// clock-driven, so they were never the thing this flag needs to stop.
// This exists for a specific situation: a startup chain that's still
// running (e.g. after a restart mid-morning) when the clock crosses the
// nse_bse_close threshold later the same day — runGapFillCheckpoint has no
// "already running" guard (unlike sweepCuratedStaleness and
// runValidatorRecovery, which do), so an unwanted second fire can overlap
// the still-running first one. Setting this to false for the rest of that
// one day avoids that, without touching the startup chain already in
// flight.
//
// Defaults to true (checkpoints run normally) unless explicitly set to
// the string "false" — same true-by-default convention as every other
// env flag in this codebase (see chartRouter.js's other env checks).
const CHECKPOINTS_ENABLED = process.env.CHECKPOINTS_ENABLED !== "false";

// UPDATED 2026-08-12: checkpoints now fire 10min AFTER each exchange's real
// close (NSE_CLOSE_MIN/MCX_CLOSE_MIN/MCX_SAT_CLOSE above), not exactly at
// it — a buffer so the exchange's own final candle has actually landed
// before the checkpoint runs. Deliberately kept as its own constant here,
// separate from the close-time constants in tickStream.js, since those are
// also used by isLiveMarket()/isAnyMarketLive() and must keep reflecting
// the REAL close time, not the checkpoint's delayed fire time.
const CHECKPOINT_CLOSE_GAP_MIN = 10;

function istDateString() {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD in IST
}

/**
 * Wires ONLY the recurring NSE/BSE-close and MCX-close checks. Does NOT
 * fire a startup checkpoint — call the returned fireStartupCheckpoint()
 * explicitly once the server is otherwise ready.
 *
 * @param {object} deps — REQUIRED: sweepCuratedStaleness and
 *   runValidatorRecovery (both from catchUp.js's createCatchUp() —
 *   see server.js's wiring). Also accepts test overrides: nowIST,
 *   runGapFillCheckpoint, log, or sleep.
 * @returns {{ stop: () => void, fireStartupCheckpoint: () => Promise<void>,
 *   fireReauthCheckpoint: () => Promise<void>, _state: object }}
 *   stop() clears the interval — used by tests, not production.
 *   fireStartupCheckpoint() runs the "startup" checkpoint exactly once —
 *   calling it again after the first call is a safe no-op (logged).
 *   fireReauthCheckpoint() runs the full chain every time it's called —
 *   no "already fired" guard, see file header for why.
 */
function wireGapFillScheduler(deps = {}) {
  const nowFn = deps.nowIST || nowIST;
  const runGapFillFn = deps.runGapFillCheckpoint || runGapFillCheckpoint;
  const { sweepCuratedStaleness, runValidatorRecovery } = deps;
  const log = deps.log || ((msg) => console.log(msg));

  if (!sweepCuratedStaleness || !runValidatorRecovery) {
    throw new Error("[GapFill] wireGapFillScheduler requires sweepCuratedStaleness and runValidatorRecovery in deps — see server.js wiring");
  }

  const lastRunDate = { nse_bse_close: null, mcx_close: null };
  let startupFired = false;

  async function fire(label) {
    // Staleness first — proactively refreshes spot data before GapFill or
    // Validator/Recovery touch anything this checkpoint.
    try {
      await sweepCuratedStaleness(label);
    } catch (err) {
      log(`[Staleness] ${label} sweep error: ${err.message} — continuing to GapFill regardless`);
    }

    // GapFill second — discovers/backfills fut+opt contracts. Its own
    // symbol list is sourced independently from root (index.json +
    // commodity.json + derivatives-config.json via
    // curatedUnderlyingsLoader.js's loadCuratedUnderlyings()) — unrelated
    // to what Staleness just swept.
    try {
      const r = await runGapFillFn(label, deps);
      log(`[GapFill] ${label}: scanned ${r.scanned} underlying(s) — options discovered ${r.optionsDiscovered}, options backfilled ${r.optionsBackfilled}, futures backfilled ${r.futuresBackfilled}${r.failed.length ? `, FAILED ${r.failed.length} (${r.failed.map((f) => f.underlying).join(", ")})` : ""}`);
    } catch (err) {
      log(`[GapFill] ${label} sweep error: ${err.message} — continuing to Validator/Recovery regardless`);
    }

    // Validator/Recovery last — queries the DB directly for whatever's
    // actually there right now (spot + all 6 derivatives tables), which by
    // this point includes exactly what Staleness and GapFill just wrote.
    // Deliberately does not receive GapFill's discoveredSymbols — see
    // validationEngine.js's getAllTrackedSymbols() for why.
    try {
      await runValidatorRecovery(label);
    } catch (err) {
      log(`[Recovery] ${label} validator/recovery error: ${err.message}`);
    }
  }

  const interval = setInterval(() => {
    const { mins, dow } = nowFn();
    const today = istDateString();

    if (mins >= NSE_CLOSE_MIN + CHECKPOINT_CLOSE_GAP_MIN && lastRunDate.nse_bse_close !== today) {
      lastRunDate.nse_bse_close = today;
      if (CHECKPOINTS_ENABLED) {
        fire("nse_bse_close");
      } else {
        log("[GapFill] nse_bse_close: skipped — CHECKPOINTS_ENABLED=false (won't fire again today; startup/reauth are unaffected by this flag)");
      }
    }

    const mcxCloseThreshold = (dow === 6 ? MCX_SAT_CLOSE : MCX_CLOSE_MIN) + CHECKPOINT_CLOSE_GAP_MIN;
    if (mins >= mcxCloseThreshold && lastRunDate.mcx_close !== today) {
      lastRunDate.mcx_close = today;
      if (CHECKPOINTS_ENABLED) {
        fire("mcx_close");
      } else {
        log("[GapFill] mcx_close: skipped — CHECKPOINTS_ENABLED=false (won't fire again today; startup/reauth are unaffected by this flag)");
      }
    }
  }, CHECK_INTERVAL_MS);

  log("[GapFill] Scheduler wired — Staleness→GapFill→Validator/Recovery chain runs at NSE/BSE-close and MCX-close (checked every minute) plus startup and any re-auth");

  async function fireStartupCheckpoint() {
    if (startupFired) {
      log("[GapFill] Startup checkpoint already fired — skipping duplicate call");
      return;
    }
    startupFired = true;
    await fire("startup");
  }

  async function fireReauthCheckpoint() {
    await fire("reauth");
  }

  return { stop: () => clearInterval(interval), fireStartupCheckpoint, fireReauthCheckpoint, _state: lastRunDate };
}

module.exports = { wireGapFillScheduler, istDateString };