// frontend/src/utils/holidayCalendar.js
//
// NSE/BSE/MCX trading-holiday calendar, used ONLY to nudge exact expiry-day
// calculations (last-Tuesday/last-Thursday roll decisions) when the raw
// day-of-week lands on a day the exchange is actually closed.
//
// SOURCE: cross-checked against NSE's official holiday page
// (nseindia.com/resources/exchange-communication-holidays) and the exchange
// circulars reported by Zerodha/ClearTax/ICICIDirect for calendar year 2026.
// NEEDS AN ANNUAL REFRESH — add next year's list before December each year.
// If a date isn't in the list (e.g. we're asking about a year not covered
// yet), isTradingHoliday() simply returns false — callers degrade to the
// plain day-of-week rule, which is what the whole codebase did before this
// file existed. Never throws, never blocks on an out-of-range year.
//
// IMPORTANT — keep this file's contents identical (in spirit) to
// backend/src/data/holidays.js. They intentionally live as two separate
// copies (ES module frontend vs CommonJS backend, different build
// pipelines) — if you update one, update the other.

// ── NSE/BSE full-closure weekday holidays (2026) ──────────────────────────
// Both exchanges share the same equity/index F&O holiday calendar.
const NSE_BSE_HOLIDAYS_2026 = new Set([
  "2026-01-15", // Maharashtra municipal elections (regional, NSE/BSE observed)
  "2026-01-26", // Republic Day
  "2026-03-03", // Holi
  "2026-03-26", // Shri Ram Navami
  "2026-03-31", // Shri Mahavir Jayanti
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-28", // Bakri Id
  "2026-06-26", // Muharram
  "2026-09-14", // Ganesh Chaturthi
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-10-20", // Dussehra
  "2026-11-10", // Diwali - Balipratipada
  "2026-11-24", // Guru Nanak Jayanti
  "2026-12-25", // Christmas
  // 2026-11-08 (Diwali Laxmi Pujan) falls on a Sunday — Muhurat trading only,
  // not a weekday closure, so intentionally NOT listed here.
]);

// ── MCX full-day-closure holidays (2026) ───────────────────────────────────
// MCX runs two sessions (morning + evening); many festival days only close
// the MORNING session while the evening stays open, which is not a real
// "market closed" day for our purposes. Only the 4 FULL closures are listed:
// Republic Day, Good Friday, Gandhi Jayanti, Christmas. Partial-holiday days
// (Holi, Maharashtra Day, Bakri Id, Muharram, Ganesh Chaturthi, Dussehra,
// Ambedkar Jayanti, Mahavir Jayanti, Ram Navami) are deliberately excluded —
// MCX is still tradeable (evening session) on those dates.
const MCX_HOLIDAYS_2026 = new Set([
  "2026-01-26", // Republic Day
  "2026-04-03", // Good Friday
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-12-25", // Christmas
]);

function toKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * True if `date` is a weekend OR a listed exchange holiday.
 * exchange: "NSE" | "BSE" | "MCX" (NSE/BSE share one calendar)
 */
export function isTradingHoliday(date, exchange = "NSE") {
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return true; // Sat/Sun

  const key = toKey(date);
  if (exchange === "MCX") return MCX_HOLIDAYS_2026.has(key);
  return NSE_BSE_HOLIDAYS_2026.has(key);
}

/**
 * Walk backward from `date` to the nearest actual trading day (skipping
 * weekends + holidays). This mirrors how NSE/BSE/MCX handle an expiry that
 * would otherwise land on a non-trading day — settlement always moves to
 * the PREVIOUS trading day, never forward.
 *
 * Bounded to 10 days of lookback as a safety guard — holidays never cluster
 * that densely in this calendar, so hitting the bound means something's
 * wrong upstream; in that case we just return the original date unshifted
 * rather than risk walking into the previous month.
 */
export function previousTradingDay(date, exchange = "NSE") {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  let guard = 0;
  while (isTradingHoliday(d, exchange) && guard < 10) {
    d.setDate(d.getDate() - 1);
    guard++;
  }
  if (guard >= 10) return new Date(date); // bail out safely, unshifted
  return d;
}

export { NSE_BSE_HOLIDAYS_2026, MCX_HOLIDAYS_2026 };
