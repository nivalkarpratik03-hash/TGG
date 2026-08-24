// absorptionFlipResultShape.js
// ─────────────────────────────────────────────────────────────────
// Turns a raw absorptionFlip.js scan() result (per-symbol flat event log,
// most-recent-first in `.results`) into the TWO row shapes the Scanner
// UI's Absorption Flip panel needs:
//
//   - Absorption rows   — every symbol with at least one "absorption_break"
//                          event, carrying its LATEST and PREVIOUS such
//                          event (exact candle timestamp on each).
//   - Breakthrough rows — same, for "flip_break" events (the regime's
//                          refSWL/refSWH flip level breaking on close —
//                          shown to the user as "Breakthrough").
//
// This file does NO pattern logic of its own — it only reads the event
// shape absorptionFlip.js already emits (see that file's `scan()`) and
// reshapes it for the table. If absorptionFlip.js's event shape ever
// changes, this is the only other file that needs to change.
//
// r.results is absorptionFlip.js's full chronological event history,
// MOST-RECENT-FIRST (see that file: `result.results = events.slice().reverse()`),
// so results[0] is always the latest event of ANY type for that symbol —
// filtering by type and taking the first two entries gives latest/previous
// for that type directly, no re-sorting needed.
// ─────────────────────────────────────────────────────────────────

/**
 * @param {Array} results — raw scan() result objects, one per symbol
 *   (the `results` array the Scanner UI already fetches per-strategy).
 * @returns {{ absorption: Array, breakthrough: Array }}
 */
export function buildAbsorptionFlipRows(results) {
  const absorption = [];
  const breakthrough = [];

  for (const r of results || []) {
    if (!r || r.error) continue;
    const events = Array.isArray(r.results) ? r.results : []; // most-recent-first

    const absEvents = events.filter((e) => e.type === "absorption_break");
    const flipEvents = events.filter((e) => e.type === "flip_break");

    if (absEvents.length > 0) {
      absorption.push({
        symbol: r.symbol,
        latest: absEvents[0],
        previous: absEvents[1] || null,
        count: absEvents.length,
        scannedAt: r.scannedAt,
        lastCandle: r.lastCandle,
      });
    }
    if (flipEvents.length > 0) {
      breakthrough.push({
        symbol: r.symbol,
        latest: flipEvents[0],
        previous: flipEvents[1] || null,
        count: flipEvents.length,
        scannedAt: r.scannedAt,
        lastCandle: r.lastCandle,
      });
    }
  }

  // Most-recently-signaled symbol first, same recency-first convention as
  // the rest of the Scanner UI (see ScannerPage.js's resultsTable sort).
  absorption.sort((a, b) => (b.latest.time || 0) - (a.latest.time || 0));
  breakthrough.sort((a, b) => (b.latest.time || 0) - (a.latest.time || 0));

  return { absorption, breakthrough };
}