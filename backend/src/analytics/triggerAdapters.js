"use strict";
/**
 * triggerAdapters.js — Chunk 4 of the Analytics module. Every strategy's
 * scan() returns events shaped differently (confirmed by reading each
 * strategy's source directly, not assumed):
 *
 *   - absorptionFlip.js events carry `dojiBarIndex` (index into the SAME
 *     candles array passed to scan()) + `direction` ("up"/"down") directly
 *     — verified at backend/src/strategies/absorptionFlip.js lines ~545-653.
 *
 *   - tgT5.js events carry `tag`/`side`/an internally-incremented `barIndex`
 *     counter (backend/src/strategies/tgT5.js's own running bar count, NOT
 *     confirmed to line up 1:1 with array indices the way absorptionFlip's
 *     does) — checked, meaningfully different, NOT wired below. Guessing a
 *     mapping here would silently produce wrong entries/stops for every
 *     TG-T5 trade, which is worse than not running it at all.
 *
 *   - s1s2s3 / type-ref event shapes — not yet read/verified.
 *
 * Only strategies with a verified adapter below are usable from
 * runAnalytics.js. Everything else fails loudly via isWired(), not
 * silently with wrong numbers.
 */

const ADAPTERS = {
  "absorption-flip": (event) => {
    if (event == null || event.dojiBarIndex == null || !event.direction) return null;
    if (event.direction !== "up" && event.direction !== "down") return null;
    return {
      triggerIndex: event.dojiBarIndex,
      direction: event.direction,
      // Strategy-specific fields, kept separate from the universal trade
      // shape (Analytics-project-plan.md Section 4's key-value reasoning,
      // even though it's an in-memory object here, not a DB row — same
      // principle: never hardcode one strategy's fields into the common
      // shape).
      conditions: {
        type: event.type,
        side: event.side,
        weak: event.weak,
        pokes: event.pokes,
        stepNo: event.stepNo,
      },
    };
  },

  // "tg-t5":    NOT YET WIRED — see file header. Needs its own verified
  //             adapter once tgT5.js's barIndex/side semantics are confirmed.
  // "s1s2s3":   NOT YET WIRED — event shape not yet read/verified.
  // "type-ref": NOT YET WIRED — event shape not yet read/verified.
};

function getAdapter(strategyId) {
  return ADAPTERS[strategyId] || null;
}

function isWired(strategyId) {
  return typeof ADAPTERS[strategyId] === "function";
}

function wiredStrategyIds() {
  return Object.keys(ADAPTERS);
}

module.exports = { getAdapter, isWired, wiredStrategyIds };
