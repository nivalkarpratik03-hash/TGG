/**
 * backend/src/derivatives/gapFillScheduler.js
 *
 * Fires derivativesGapFill.runGapFillCheckpoint() at the 3 agreed points:
 *   - "startup"        — once, but NOT from this file directly (see
 *                        fireStartupCheckpoint below) — the caller
 *                        (server.js) triggers it explicitly, only after
 *                        curated spot/index catch-up genuinely finishes.
 *   - "nse_bse_close"  — once per day, the first time the clock crosses
 *                        NSE/BSE's real close (15:30 IST)
 *   - "mcx_close"      — once per day, the first time the clock crosses
 *                        MCX's real close (23:30 IST weekdays, 14:00 IST
 *                        Saturday)
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
 * "Once per day" guard: tracks the IST calendar date (YYYY-MM-DD) each
 * checkpoint last fired on. A checkpoint won't fire again until that date
 * string changes — this is what stops it re-firing every minute for the
 * ~8+ hours the clock stays past the threshold each day.
 *
 * ROOT CAUSE FIXED HERE (2026-07-30): this file used to fire the startup
 * checkpoint itself, via its own unconditional `setImmediate(() =>
 * fire("startup"))`, completely independent of server.js's
 * `runCuratedSymbolCatchUp("startup")` setImmediate. Two unrelated
 * boot-time tasks both hitting the broker at the same time — the
 * "everything overlaps" symptom. Fixed by removing that call entirely and
 * exposing `fireStartupCheckpoint()` instead, which server.js now calls
 * explicitly, chained onto the curated catch-up Promise (`.then(...)`), so
 * curated spot/index catch-up always finishes first.
 */

const { nowIST, NSE_CLOSE_MIN, MCX_CLOSE_MIN, MCX_SAT_CLOSE } = require("../fyers/tickStream");
const { runGapFillCheckpoint } = require("./derivativesGapFill");

const CHECK_INTERVAL_MS = 60 * 1000; // check once a minute — cheap, no broker calls happen here, only the eventual checkpoint run does

function istDateString() {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10); // YYYY-MM-DD in IST
}

/**
 * Wires ONLY the recurring NSE/BSE-close and MCX-close checks. Does NOT
 * fire a startup checkpoint — call the returned fireStartupCheckpoint()
 * explicitly once curated spot/index catch-up has resolved.
 *
 * @param {object} [deps] — for tests: override nowIST, runGapFillCheckpoint, log, or sleep.
 * @returns {{ stop: () => void, fireStartupCheckpoint: () => Promise<void>, _state: object }}
 *   stop() clears the interval — used by tests, not production.
 *   fireStartupCheckpoint() runs the "startup" checkpoint exactly once —
 *   calling it again after the first call is a safe no-op (logged).
 */
function wireGapFillScheduler(deps = {}) {
  const nowFn = deps.nowIST || nowIST;
  const runFn = deps.runGapFillCheckpoint || runGapFillCheckpoint;
  const log = deps.log || ((msg) => console.log(msg));

  const lastRunDate = { nse_bse_close: null, mcx_close: null };
  let startupFired = false;

  async function fire(label) {
    try {
      const r = await runFn(label, deps);
      log(`[GapFill] ${label}: scanned ${r.scanned} underlying(s) — options discovered ${r.optionsDiscovered}, options backfilled ${r.optionsBackfilled}, futures backfilled ${r.futuresBackfilled}${r.failed.length ? `, FAILED ${r.failed.length} (${r.failed.map((f) => f.underlying).join(", ")})` : ""}`);
    } catch (err) {
      log(`[GapFill] ${label} sweep error: ${err.message}`);
    }
  }

  const interval = setInterval(() => {
    const { mins, dow } = nowFn();
    const today = istDateString();

    if (mins >= NSE_CLOSE_MIN && lastRunDate.nse_bse_close !== today) {
      lastRunDate.nse_bse_close = today;
      fire("nse_bse_close");
    }

    const mcxCloseThreshold = dow === 6 ? MCX_SAT_CLOSE : MCX_CLOSE_MIN;
    if (mins >= mcxCloseThreshold && lastRunDate.mcx_close !== today) {
      lastRunDate.mcx_close = today;
      fire("mcx_close");
    }
  }, CHECK_INTERVAL_MS);

  log("[GapFill] Scheduler wired — NSE/BSE-close and MCX-close checked every minute; startup checkpoint fires once curated spot/index catch-up finishes");

  async function fireStartupCheckpoint() {
    if (startupFired) {
      log("[GapFill] Startup checkpoint already fired — skipping duplicate call");
      return;
    }
    startupFired = true;
    await fire("startup");
  }

  return { stop: () => clearInterval(interval), fireStartupCheckpoint, _state: lastRunDate };
}

module.exports = { wireGapFillScheduler, istDateString };