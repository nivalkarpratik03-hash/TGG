/**
 * formatResolution.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for converting a numeric resolution into a human-
 * readable label. Previously an inline ternary chain in ChartsPage.js JSX
 * and a static lookup table in StatusBar.js — now one shared function.
 *
 * Consumers:
 *   ChartsPage.js  → chart symbol overlay badge (e.g. "3m" next to "NIFTY50")
 *   StatusBar.js   → TIMEFRAMES array labels
 */

const RESOLUTION_LABELS = {
  1:     "1m",
  3:     "3m",
  5:     "5m",
  15:    "15m",
  60:    "1h",
  1440:  "1D",
  10080: "1W",
  43200: "1M",
};

/**
 * Convert a numeric resolution to its display label.
 * Falls back to "<n>m" for any resolution not in the table.
 * @param {number} resolution
 * @returns {string}
 */
export function formatResolution(resolution) {
  return RESOLUTION_LABELS[resolution] ?? `${resolution}m`;
}

/**
 * The ordered list of supported timeframes — consumed by StatusBar.js for
 * the resolution pill buttons. Replaces the inline TIMEFRAMES constant.
 */
export const TIMEFRAMES = [
  { label: "1m",  value: 1     },
  { label: "3m",  value: 3     },
  { label: "5m",  value: 5     },
  { label: "15m", value: 15    },
  { label: "1h",  value: 60    },
  { label: "1D",  value: 1440  },
  { label: "1W",  value: 10080 },
  { label: "1M",  value: 43200 },
];