// absorptionResultShape.js
// ─────────────────────────────────────────────────────────────────
// Turns the raw absorptionFlip.js scan() output — per symbol:
//   { events[], results[], state: { regime, flipLevel, liveAbsorbing[], atr }, lastCandle, ... }
// into the THREE row shapes AbsorptionScannerPanel needs:
//
//   - Results   — every absorption_break / flip_break event, across every
//                 symbol, that happened TODAY (IST calendar day).
//   - History   — the same events, from any EARLIER day.
//   - Upcoming  — NOT events. Currently-live absorbing bands + the current
//                 flip-watch level per symbol (state.liveAbsorbing /
//                 state.flipLevel) — things that haven't broken yet —
//                 sorted nearest-to-break first, by ATR-normalized
//                 distance from the last close. This is deliberate: a ₹5
//                 gap on a ₹40-ATR stock is not "closer" than a ₹5 gap on
//                 a ₹3-ATR stock, so plain % distance would misrank a
//                 mixed watchlist. absorptionFlip.js's state.atr is the
//                 CURRENT (most recent) ATR for that symbol.
//
// Today/History split reuses istUtils' toISTDate/getTodayIST AS-IS — same
// functions t5ResultShape.js already uses for its own Results/History
// split. No independent date logic here.
//
// This file does NO pattern logic of its own — every field it reads
// (weak, pokes, stepNo, level, state.atr, state.liveAbsorbing,
// state.flipLevel) is exactly what absorptionFlip.js's scan() already
// emits. If that shape ever changes, this is the only other file that
// needs to change.
// ─────────────────────────────────────────────────────────────────

import { toISTDate, getTodayIST, formatShortDateTimeIST } from "../../utils/istUtils";

// ── event flattening (Results / History) ───────────────────────────────
// scanResults = array of scan() outputs, one per symbol (same input shape
// buildScannerRows(t5ResultShape.js) takes).
function flattenEvents(scanResults) {
  const today = getTodayIST();
  const results = [];
  const history = [];

  for (const r of scanResults || []) {
    if (!r || r.error || !Array.isArray(r.events) || r.events.length === 0) continue;
    for (const e of r.events) {
      const row = {
        symbol: r.symbol,
        type: e.type,               // "absorption_break" | "flip_break"
        direction: e.direction,     // "up" | "down"
        side: e.side,               // "resistance" | "support"
        level: e.level,
        price: e.price,
        // Only absorption_break events carry these (see absorptionFlip.js
        // event push) — undefined on flip_break, left as-is, not coerced.
        weak: e.weak,
        pokes: e.pokes,
        stepNo: e.stepNo,
        time: e.time,
        timeMs: e.time ? new Date(e.time).getTime() : 0,
        timeLabel: formatShortDateTimeIST(e.time),
      };
      if (toISTDate(e.time) === today) results.push(row);
      else history.push(row);
    }
  }

  results.sort((a, b) => b.timeMs - a.timeMs);
  history.sort((a, b) => b.timeMs - a.timeMs);
  return { results, history };
}

// ── live/upcoming (not-yet-broken) rows ─────────────────────────────────
function buildUpcomingRows(scanResults) {
  const rows = [];

  for (const r of scanResults || []) {
    if (!r || r.error || !r.state || !r.lastCandle) continue;
    const atr = r.state.atr;
    const close = r.lastCandle.close;
    // Can't compute a meaningful ATR-normalized distance without both —
    // skip rather than fabricate a 0/NaN distance that would wrongly
    // sort to the top.
    if (atr == null || !(atr > 0) || close == null) continue;

    for (const b of r.state.liveAbsorbing || []) {
      if (b.level == null) continue;
      rows.push({
        symbol: r.symbol,
        kind: "absorbing",
        side: b.side,             // "resistance" | "support"
        level: b.level,
        weak: b.weak,
        stepNo: b.stepNo,
        close,
        distanceATR: Math.abs(close - b.level) / atr,
      });
    }

    if (r.state.flipLevel != null && r.state.regime && r.state.regime !== "none") {
      rows.push({
        symbol: r.symbol,
        kind: "flip_watch",
        // Mirrors flip_break's own side convention: an UP regime flips
        // DOWN through its support (refSWL), a DOWN regime flips UP
        // through its resistance (refSWH) — see absorptionFlip.js's
        // finalState.flipLevel derivation.
        side: r.state.regime === "up" ? "support" : "resistance",
        regime: r.state.regime,
        level: r.state.flipLevel,
        close,
        distanceATR: Math.abs(close - r.state.flipLevel) / atr,
      });
    }
  }

  rows.sort((a, b) => a.distanceATR - b.distanceATR);
  return rows;
}

// scanResults = array of scan() outputs, one per symbol.
export function buildAbsorptionRows(scanResults) {
  const { results, history } = flattenEvents(scanResults);
  const upcoming = buildUpcomingRows(scanResults);
  return { results, upcoming, history };
}
