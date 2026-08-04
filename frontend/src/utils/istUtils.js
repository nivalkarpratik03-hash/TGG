/**
 * istUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all IST (Asia/Kolkata) date/time helpers.
 *
 * Previously each of these functions was copy-pasted into 9 separate files:
 *   SignalTable, StatsPanel, WaveSignalTable, WaveStatsPanel,
 *   ConsolidationZoneTable, ConsolidationStatsPanel, CandleChart,
 *   BubbleIndicator, ChartsPage, ReportsPage
 *
 * Now all files import from here. To change timezone logic, change it once.
 *
 * UPDATE (2026-08-04): ReportsPage.js was still carrying one more local
 * leftover under a different name — toISTStr(dd/Mon HH:MM) — using manual
 * "tsMs + 5.5h, read UTC parts" math instead of a real Asia/Kolkata timezone
 * conversion. Missed by earlier name-based duplicate sweeps because the name
 * didn't match anything else. Replaced with formatShortDateIST() + the
 * existing formatTimeIST(), same visible output, real timezone-safe math.
 */

/**
 * Convert a timestamp (ms) to an IST calendar date string.
 * Used for "today mode" filtering — compare two results to check same day.
 * @param {number} tsMs - Unix timestamp in milliseconds
 * @returns {string} e.g. "06/06/2026" (en-IN locale, IST)
 */
export function toISTDate(tsMs) {
  if (!tsMs) return "";
  return new Date(tsMs).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

/**
 * Get today's IST calendar date string.
 * Used as the reference value when todayMode is on.
 * @returns {string} e.g. "06/06/2026" (en-IN locale, IST)
 */
export function getTodayIST() {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

/**
 * Format a timestamp (ms) as a short IST calendar date (day + short month).
 * Used where a compact date is needed alongside a time value, e.g. table
 * cells showing wave start/end timestamps that can span multiple days but
 * don't need the full year (see formatDateTimeIST for the full version).
 * @param {number} tsMs - Unix timestamp in milliseconds
 * @returns {string} e.g. "06/Aug" or "—" if falsy
 */
/**
 * Format a timestamp (ms) as a short IST calendar date (day + short month).
 * Used where a compact date is needed alongside a time value, e.g. table
 * cells showing wave start/end timestamps that can span multiple days but
 * don't need the full year (see formatDateTimeIST for the full version).
 * @param {number} tsMs - Unix timestamp in milliseconds
 * @param {string} [separator="/"] - character(s) between day and month
 * @returns {string} e.g. "06/Aug" (default) or "06-Aug" with separator="-"; "—" if falsy
 */
export function formatShortDateIST(tsMs, separator = "/") {
  if (!tsMs) return "—";
  const parts = new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", timeZone: "Asia/Kolkata",
  }).formatToParts(new Date(tsMs));
  const day = parts.find(p => p.type === "day")?.value ?? "";
  const month = parts.find(p => p.type === "month")?.value ?? "";
  return `${day}${separator}${month}`;
}

/**
 * Format a timestamp (ms) as an IST time string (HH:MM, 24h).
 * @param {number} tsMs - Unix timestamp in milliseconds
 * @returns {string} e.g. "09:15" or "—" if falsy
 */
export function formatTimeIST(tsMs) {
  if (!tsMs) return "—";
  return new Date(tsMs).toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
  });
}

/**
 * Format a timestamp (ms or ISO string) as a combined IST date+time string.
 * Use this anywhere a bare time-of-day (formatTimeIST) is ambiguous without
 * the calendar date — e.g. per-stage (S1/S2/S3) candle timestamps and
 * motherwave timestamps in the Scanner tables, which can span multiple days.
 * @param {number|string} ts - Unix timestamp in ms, or an ISO date string
 * @returns {string} e.g. "06/06/2026, 09:15:00" or "—" if falsy
 */
export function formatDateTimeIST(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZone: "Asia/Kolkata",
  });
}