/**
 * timeframeShortcut.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for "the user typed some digits, what timeframe (if
 * any) does that resolve to?" — the Fyers-style type-a-number-to-switch-
 * timeframe shortcut.
 *
 * Before this module existed, ChartsPage.js's ChartPanel and AtmWorkspace.js
 * each had their OWN copy of this exact validation (parse the digits, check
 * membership in TIMEFRAMES, build the same warning string) — genuine
 * duplicated logic, not just similar-looking code. Both now call
 * resolveTypedTimeframe() below and only differ in what they DO with the
 * result (ChartPanel sets one panel's resolution; AtmWorkspace sets whichever
 * column is currently focused). The digit-buffer/keydown timer that collects
 * the typed digits in the first place is separately already shared — it
 * lives once in ChartsPage.js and drives both targets via panelActionsRef /
 * atmActionsRef — this module is the other half of the duplication, the
 * validation itself.
 *
 * Extending the supported timeframe list (e.g. adding Monthly) only means
 * editing frontend/src/utils/formatResolution.js's TIMEFRAMES export — this
 * function (and both call sites) pick the change up automatically.
 */
import { TIMEFRAMES } from "./formatResolution";

/**
 * @param {string} digits  raw typed digits, e.g. "15", "1440"
 * @returns {{ resolution: number, error: null } | { resolution: null, error: string }}
 */
export function resolveTypedTimeframe(digits) {
  const n = parseInt(digits, 10);
  const supported = TIMEFRAMES.some((tf) => tf.value === n);
  if (!Number.isFinite(n) || !supported) {
    const known = TIMEFRAMES.map((tf) => tf.value).join(", ");
    return { resolution: null, error: `"${digits}" isn't a supported timeframe (${known}).` };
  }
  return { resolution: n, error: null };
}