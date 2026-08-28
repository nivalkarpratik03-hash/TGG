// absorptionResultShape.js
// ─────────────────────────────────────────────────────────────────
// Turns the raw absorptionFlip.js scan() output — per symbol:
//   { events[], results[], state: { regime, flipLevel, liveAbsorbing[], atr }, lastCandle, ... }
// into the row shapes AbsorptionScannerPanel needs.
//
// UPDATED (retest-entry spec, Chunk 2): the old "4-tab" shape is gone.
// `results` (today-only raw events) is now INTERNAL ONLY — it still gets
// computed and returned (unchanged) purely so the panel's ABSORPTION
// BREAKS (TODAY) / FLIP BREAKS (TODAY) summary cards keep working; it is
// no longer rendered as its own tab (dropped per spec — a break that
// happened today can never be Doji-confirmed yet, since confirmation
// looks 2 candles forward, so that tab was structurally near-always
// empty). `dojiBreakthroughs` is now the ONLY tab showing confirmed,
// actionable signals — the panel renders it under the renamed "Results"
// tab — and each row now also carries the retest-entry outcome
// (.entryPrice/.stopPrice/.targetPrice/.retestState/.rMultiple) that
// Chunk 1 already computed and attached as `.retest` on the backend
// event object. No retest math is redone here — every field below is a
// direct passthrough of what absorptionFlip.js's computeRetestOutcome()
// already produced.
//
//   - results (internal)  — every absorption_break / flip_break event,
//                         across every symbol, that happened TODAY (IST
//                         calendar day). Feeds the (TODAY) summary cards
//                         only — not rendered as a tab.
//   - History           — the same events, from any EARLIER day. Tab
//                         unchanged by this spec.
//   - Upcoming          — NOT events. Currently-live absorbing bands + the
//                         current flip-watch level per symbol
//                         (state.liveAbsorbing / state.flipLevel) — things
//                         that haven't broken yet — sorted nearest-to-break
//                         first, by ATR-normalized distance from the last
//                         close. This is deliberate: a ₹5 gap on a ₹40-ATR
//                         stock is not "closer" than a ₹5 gap on a ₹3-ATR
//                         stock, so plain % distance would misrank a mixed
//                         watchlist. absorptionFlip.js's state.atr is the
//                         CURRENT (most recent) ATR for that symbol.
//   - dojiBreakthroughs  — every event (BOTH absorption_break AND
//                         flip_break) across every symbol, ANY day (not
//                         just today — this is a standalone, cross-day
//                         list, not a Results/History split). This is the
//                         panel's "Results" tab (renamed from "Doji
//                         Breakthroughs"). absorptionFlip.js (backend)
//                         already only emits either event type when a
//                         Doji candle showed up within 2 candles of the
//                         triggering candle — see that file's
//                         `dojiWithinLookahead()`, called from both the
//                         flip branches AND the absorption-break branch —
//                         so every event that reaches this file at all is,
//                         by construction, Doji-confirmed, and (per Chunk
//                         1) already carries a `.retest` outcome. Carries
//                         the confirming Doji candle's own timestamp
//                         (`dojiTime`) alongside the triggering candle's,
//                         plus the retest-entry fields below.
//   - dojiTodayCount     — count of rows in dojiBreakthroughs whose
//                         CONFIRMING Doji candle (dojiTime, not the
//                         triggering candle's time) fell on today's IST
//                         calendar day. Feeds the new DOJI (TODAY)
//                         summary card. Computed once, here, so the panel
//                         doesn't need its own independent date-filter
//                         logic for it.
//
// Today/History split (and the dojiTodayCount date check above) reuses
// istUtils' toISTDate/getTodayIST AS-IS — same functions t5ResultShape.js
// already uses for its own Results/History split. No independent date
// logic anywhere in this file.
//
// This file does NO pattern logic and NO retest logic of its own — every
// field it reads (weak, pokes, stepNo, level, state.atr,
// state.liveAbsorbing, state.flipLevel, and now event.retest.*) is
// exactly what absorptionFlip.js's scan() already emits. If that shape
// ever changes, this is the only other file that needs to change.
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
        // Both absorption_break and flip_break now carry these (see
        // absorptionFlip.js's dojiWithinLookahead() gate, called from
        // both event branches) — always true when the event exists at
        // all, since an event is only pushed once the Doji check passes.
        dojiConfirmed: e.dojiConfirmed,
        dojiTime: e.dojiTime,
        dojiTimeLabel: e.dojiTime ? formatShortDateTimeIST(e.dojiTime) : null,
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

// ── R-multiple for a resolved retest outcome ────────────────────────────
// The engine only ever produces exact 1:1 R trades (target = entry ±
// risk, see computeRetestOutcome() in absorptionFlip.js), so a resolved
// win is always exactly +1R and a resolved loss always exactly -1R — this
// is a direct reflection of that fixed rule, not an independent
// computation. Anything not yet resolved (open/invalidated/watching/
// zero-risk) has no meaningful R yet, so it stays null and is rendered as
// "—" by the panel rather than a fabricated number.
function rMultipleFor(retestState) {
  if (retestState === "entered_win") return 1;
  if (retestState === "entered_loss") return -1;
  return null;
}

// ── Results tab (renamed from "Doji Breakthroughs") — absorption_break
// AND flip_break events, any day, on their own, now enriched with the
// retest-entry outcome Chunk 1 attached as `.retest` on the backend event
// object ───────────────────────────────────────────────────────────────
// Every event absorptionFlip.js emits (of either type) already passed the
// backend's post-breakthrough Doji check (dojiConfirmed: true) — nothing
// here re-derives that condition, it just pulls both event types out of
// the raw per-symbol event logs into one combined newest-first list, same
// shape as flattenEvents()'s rows plus the confirming Doji candle's own
// time AND its retest-entry outcome. weak/pokes/stepNo are carried
// through too so an absorption row here can still show its weak-test
// count, same as it does in History.
//
// entryPrice/stopPrice/targetPrice/retestState/retestExtreme are a
// straight passthrough of event.retest — computeRetestOutcome() in
// absorptionFlip.js is the ONLY place that logic lives; this function
// does not recompute or re-derive any of it.
function buildResultsRows(scanResults) {
  const rows = [];

  for (const r of scanResults || []) {
    if (!r || r.error || !Array.isArray(r.events) || r.events.length === 0) continue;
    for (const e of r.events) {
      if (!e.dojiConfirmed) continue;
      const retest = e.retest || null; // defensive — should always exist once dojiConfirmed, per run()'s wiring in absorptionFlip.js
      rows.push({
        symbol: r.symbol,
        type: e.type,
        direction: e.direction,
        side: e.side,
        level: e.level,
        price: e.price,
        weak: e.weak,
        pokes: e.pokes,
        stepNo: e.stepNo,
        time: e.time,
        timeMs: e.time ? new Date(e.time).getTime() : 0,
        timeLabel: formatShortDateTimeIST(e.time),
        dojiConfirmed: e.dojiConfirmed,
        dojiTime: e.dojiTime,
        dojiTimeLabel: formatShortDateTimeIST(e.dojiTime),
        // ── retest-entry outcome (Chunk 1's .retest, passed through as-is) ──
        retestState: retest ? retest.state : null, // "entered_win" | "entered_loss" | "entered_open" | "invalidated" | "watching" | "invalid_zero_risk" | null
        entryPrice: retest ? retest.entryPrice : null,
        stopPrice: retest ? retest.stopPrice : null,
        targetPrice: retest ? retest.targetPrice : null,
        retestExtreme: retest ? retest.retestExtreme : null,
        rMultiple: retest ? rMultipleFor(retest.state) : null,
      });
    }
  }

  rows.sort((a, b) => b.timeMs - a.timeMs);
  return rows;
}

// scanResults = array of scan() outputs, one per symbol.
export function buildAbsorptionRows(scanResults) {
  const today = getTodayIST();
  const { results, history } = flattenEvents(scanResults);
  const upcoming = buildUpcomingRows(scanResults);
  const dojiBreakthroughs = buildResultsRows(scanResults);
  // DOJI (TODAY) — count of Doji-confirmed breakthroughs (either type)
  // whose CONFIRMING Doji candle happened today, not the triggering
  // candle. Same toISTDate/getTodayIST comparison flattenEvents() already
  // uses above, just applied to dojiTime instead of time — no new date
  // logic invented for this.
  const dojiTodayCount = dojiBreakthroughs.filter(
    (row) => row.dojiTime && toISTDate(row.dojiTime) === today
  ).length;
  return { results, upcoming, history, dojiBreakthroughs, dojiTodayCount };
}