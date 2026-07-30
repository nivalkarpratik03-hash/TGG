/**
 * backend/src/derivatives/gapFillScheduler.js
 *
 * Fires derivativesGapFill.runGapFillCheckpoint() at the 3 agreed points:
 *   - "startup"        — once, immediately, when the server boots
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
 * @param {object} [deps] — for tests: override nowIST, runGapFillCheckpoint, or the logger.
 * @returns {{ stop: () => void, _state: object }} stop() clears the interval — used by tests, not production.
 */
function startGapFillScheduler(deps = {}) {
  const nowFn = deps.nowIST || nowIST;
  const runFn = deps.runGapFillCheckpoint || runGapFillCheckpoint;
  const log = deps.log || ((msg) => console.log(msg));

  const lastRunDate = { nse_bse_close: null, mcx_close: null };

  async function fire(label) {
    try {
      const r = await runFn(label);
      log(`[GapFill] ${label}: scanned ${r.scanned} underlying(s) — options discovered ${r.optionsDiscovered}, options backfilled ${r.optionsBackfilled}, futures backfilled ${r.futuresBackfilled}${r.failed.length ? `, FAILED ${r.failed.length} (${r.failed.map((f) => f.underlying).join(", ")})` : ""}`);
    } catch (err) {
      log(`[GapFill] ${label} sweep error: ${err.message}`);
    }
  }

  // Startup checkpoint — once, immediately.
  setImmediate(() => fire("startup"));

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

  log("[GapFill] Scheduler wired — startup checkpoint now, NSE/BSE-close and MCX-close checked every minute thereafter");

  return { stop: () => clearInterval(interval), _state: lastRunDate };
}

module.exports = { startGapFillScheduler, istDateString };
