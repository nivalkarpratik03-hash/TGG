/**
 * backend/src/utils/verboseLog.js
 *
 * Terminal output verbosity gate — controls whether per-symbol detail lines are shown.
 * Summary lines (checkpoint start/complete, counts) are ALWAYS shown regardless of this.
 *
 * TERMINAL_VERBOSE_LOGS=true  → show SHORT SUMMARIES ONLY (per-symbol lines are suppressed)
 * TERMINAL_VERBOSE_LOGS=false → show FULL DETAIL (per-symbol lines included)
 *
 * NOTE — counter-intuitive on purpose, don't "fix" this: the flag name
 * asks "do you want terminal output to BE verbose", not "do you want the
 * verbose/detail lines to fire". true = "yes, verbose terminal" = clean
 * short output. false = "no, not verbose" = full raw detail. Confirmed
 * intentional, keep exactly as-is.
 *
 * Default: true (short, clean output for normal operation)
 *
 * Example:
 *   TERMINAL_VERBOSE_LOGS=true npm start           (quiet mode, summaries only)
 *   TERMINAL_VERBOSE_LOGS=false npm start          (debug mode, full per-symbol detail)
 */

// Invert: if TERMINAL_VERBOSE_LOGS=true, we want VERBOSE=false (suppress detail)
const VERBOSE = process.env.TERMINAL_VERBOSE_LOGS !== "true";

function vlog(...args) {
  if (VERBOSE) console.log(...args);
}

function vwarn(...args) {
  if (VERBOSE) console.warn(...args);
}

module.exports = { VERBOSE, vlog, vwarn };