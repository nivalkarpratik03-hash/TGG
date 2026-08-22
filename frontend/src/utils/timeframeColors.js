/** @type {Record<number, string>} resolution (minutes) → hex color */
export const TIMEFRAME_COLORS = {
  1: "#ff9500", // 1m  → Orange
  3: "#39ff14", // 3m  → Neon Green
  5: "#800020", // 5m  → Burgundy 
  15: "#8000ff", // 15m → Purple
  60: "#ff1493", // 1H  → Neon Pink
  1440: "#00e5ff", // 1D  → Cyan Blue  
  10080: "#ffff00", // 1W  → Yellow
  43200: "#ff6ec7", // 1M  → Bubblegum Pink
};

/**
 * Returns the configured color for a given resolution.
 * Falls back to a neutral default so the app never breaks on an unknown TF.
 *
 * @param {number|string} resolution  – resolution in minutes (1, 3, 5, 15, 60, 1440, 10080, 43200)
 * @param {string}        [fallback]  – color to use when resolution is unknown
 * @returns {string} hex color string
 */
export function getTimeframeColor(resolution, fallback = "#b2b5be") {
  return TIMEFRAME_COLORS[Number(resolution)] ?? fallback;
}

/**
 * Human-readable label for a resolution value.
 * Mirrors the labels used in FibDashboardPage tfOptions.
 */
export const TIMEFRAME_LABELS = {
  1: "1m",
  3: "3m",
  5: "5m",
  15: "15m",
  60: "1H",
  1440: "1D",
  10080: "1W",
  43200: "1M",
};