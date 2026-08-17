/**
 * backend/src/utils/verboseLog.js
 *
 * Single on/off switch for the noisy PER-SYMBOL / PER-STRIKE log lines
 * ([Fyers] candle-fetch-per-symbol, [Staleness] per-symbol lag/backfill,
 * [GapFill] strike (n/N), [Recovery] per-symbol issue lines). All the
 * SUMMARY lines (checkpoint start/complete, sweep complete, counts) are
 * NOT gated by this — those stay on always, they're what you actually
 * want to see in a normal run.
 *
 * OFF by default. Flip on with an env var when you need the full
 * line-by-line trace to debug something — no code edits, no
 * comment/uncomment hunting across 8 files:
 *
 *   VERBOSE_LOGS=true npm start          (one-off)
 *   # or add VERBOSE_LOGS=true to your .env file
 *
 * Every call site that used to be a raw console.log/log(...) for one of
 * those noisy per-symbol lines now calls vlog(...) instead. Nothing else
 * changed — same message text, same log level, just gated.
 */

const VERBOSE = process.env.VERBOSE_LOGS === "true";

function vlog(...args) {
  if (VERBOSE) console.log(...args);
}

function vwarn(...args) {
  if (VERBOSE) console.warn(...args);
}

module.exports = { VERBOSE, vlog, vwarn };
