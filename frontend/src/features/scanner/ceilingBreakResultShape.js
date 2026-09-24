// ceilingBreakResultShape.js
// ─────────────────────────────────────────────────────────────────
// Turns the raw ceilingBreakRetest.js scan() output — per symbol:
//   { events[], results[], state, lastCandle, level, direction,
//     patternStage, found, error, ... }
// into the row shapes CeilingBreakScannerPanel needs (Chunk 5).
//
// Mirrors absorptionResultShape.js's file layout and conventions
// (same istUtils import, same toISTDate/getTodayIST today-split, same
// "no pattern logic lives here" rule) but the three buckets are NOT a
// 1:1 copy of Absorption's, because this engine's per-symbol output
// shape is different in one key way: ceilingBreakRetest.js's scan()
// only exposes ONE state snapshot per symbol — `state` is the LAST
// bar's snapshot only (state.state: 'idle' | 'watching' | 'retested'),
// not a running series. absorptionFlip.js's state.liveAbsorbing /
// state.flipLevel have no equivalent here, so Upcoming/Results below
// read off `state` + `events` directly per the spec agreed before
// writing this file:
//
//   - Upcoming  — hasCeiling && state.state === 'idle': a ceiling has
//                 been clustered (minTouches met) but no breakout
//                 sequence is in progress. One row per symbol, sorted
//                 nearest-to-ceiling first. NOTE: there is no ATR
//                 field anywhere in ceilingBreakRetest.js's per-bar
//                 snapshot (state.atr does not exist, unlike
//                 absorptionFlip.js) — plain %-distance
//                 (|close - ceilingLevel| / ceilingLevel) is used for
//                 sorting instead. If ATR-normalized distance is
//                 wanted later, it has to be computed from the raw
//                 candles in the wrapper and added to `state` there —
//                 not invented here from nothing.
//
//   - Results   — "actively watching/retested, OR fired today."
//                 This is two different row sources merged into one
//                 array, discriminated by `row.kind` — SAME PATTERN
//                 buildUpcomingRows() in absorptionResultShape.js
//                 already uses to mix "absorbing" and "flip_watch"
//                 rows in one array (see that file). Two kinds here:
//                   kind: "active"      — state.state is 'watching'
//                                         or 'retested' RIGHT NOW.
//                                         One row per symbol; carries
//                                         the zone (zoneHi/zoneLo) and
//                                         the most recent event as
//                                         `latestEvent` (whether or
//                                         not that event happened
//                                         today — the row exists
//                                         because the sequence is
//                                         live, not because of when
//                                         its last event fired).
//                   kind: "fired_today" — state.state is 'idle' (the
//                                         sequence already resolved:
//                                         HIGHER_LOW / NO_RETEST /
//                                         FAILED_RETEST all reset to
//                                         'idle', see
//                                         ceilingBreakRetest.js's
//                                         emit-then-reset blocks) BUT
//                                         at least one event for that
//                                         symbol landed on today's IST
//                                         date. One row PER such
//                                         event (not per symbol) —
//                                         differs from "active" rows,
//                                         which are per-symbol.
//                 A symbol can only produce "active" rows OR
//                 "fired_today" rows, never both — state.state is a
//                 single value, so the branch is a strict if/else on
//                 state.state, no double-counting possible.
//
//                 SORT ORDER (changed): every row, active or
//                 fired_today, carries `ceilingBrokenAt` /
//                 `ceilingBrokenAtMs` — the timestamp of the
//                 CEILING_BROKEN event that started ITS sequence
//                 (found by walking each symbol's full `events` array
//                 forward and remembering the most recent
//                 CEILING_BROKEN seen so far, so a symbol with
//                 multiple past sequences still pairs each event with
//                 the correct one — not just "the last CEILING_BROKEN
//                 in the array"). Results is sorted purely by
//                 `ceilingBrokenAtMs` descending — freshest ceiling
//                 break first, full stop. Whether that sequence is
//                 still Watching, still Retested, or has already
//                 resolved (fired_today) plays NO role in ordering
//                 anymore. Previously "active" rows had no time-based
//                 order at all (encounter order only) and
//                 "fired_today" rows sorted by their LAST retest-stage
//                 event, not the original breakout — both fixed here.
//
//   - History   — every event from any EARLIER (non-today) IST day,
//                 across every symbol, any type. Same
//                 toISTDate/getTodayIST split flattenEvents() uses in
//                 absorptionResultShape.js. Deliberately type-agnostic
//                 (includes CEILING_BROKEN too, not just the terminal
//                 types) — same "don't invent a filter the spec didn't
//                 ask for" principle as the rest of this file.
//
// Upcoming/Results overlap guard: a symbol whose state is 'idle' AND
// which has a "fired_today" Results row is EXCLUDED from Upcoming,
// even if state.hasCeiling is still true post-reset — otherwise a
// symbol that just printed HIGHER_LOW today would show up as both a
// "fired today" Results row AND a "still idle, watch this ceiling"
// Upcoming row on the same render, which would read as contradictory
// in the UI. This exclusion was flagged as a design decision (not a
// spec-literal "hasCeiling && idle" reading) — see conversation before
// this file was written.
//
// This file does NO pattern logic and NO retest logic of its own —
// every field it reads (state.hasCeiling, state.state,
// state.ceilingLevel, state.activeCeiling, state.zoneHi/zoneLo,
// event.type/price/ceiling/reason/time) is exactly what
// ceilingBreakRetest.js's scan() already emits. If that shape ever
// changes, this is the only other file that needs to change.
// ─────────────────────────────────────────────────────────────────

import { toISTDate, getTodayIST, formatShortDateTimeIST } from "../../utils/istUtils";

// ── pair every event with ITS sequence's CEILING_BROKEN time ───────────
// Walks a symbol's full events array (chronological, oldest -> newest —
// this is exactly the shape ceilingBreakRetest.js's scan() already
// returns as result.events) and stamps each event with the time of the
// most recent CEILING_BROKEN seen so far. This correctly handles a
// symbol that has had several past breakout sequences: an event from
// sequence #2 gets sequence #2's CEILING_BROKEN time, not sequence #1's
// or "whatever the last CEILING_BROKEN in the array happens to be."
// A CEILING_BROKEN event is paired with itself (its own time).
function attachCeilingBrokenAt(events) {
  let brokenTime = null;
  let brokenTimeMs = 0;
  return events.map((e) => {
    if (e.type === "CEILING_BROKEN") {
      brokenTime = e.time;
      brokenTimeMs = e.time ? new Date(e.time).getTime() : 0;
    }
    return { ...e, ceilingBrokenAt: brokenTime, ceilingBrokenAtMs: brokenTimeMs };
  });
}

// ── per-event row (shared shape for History and "fired_today" Results) ──
function toEventRow(symbol, e) {
  return {
    symbol,
    type: e.type, // CEILING_BROKEN | RETEST | FAILED_RETEST | NO_RETEST | HIGHER_LOW
    side: "resistance", // this scanner only ever tracks ceiling/resistance levels (matches scan()'s result.side)
    level: e.ceiling != null ? e.ceiling : null,
    price: e.price != null ? e.price : null,
    reason: e.reason || null, // CEILING_BROKEN carries no reason; the other 4 types do
    isEntrySignal: e.type === "HIGHER_LOW",
    time: e.time,
    timeMs: e.time ? new Date(e.time).getTime() : 0,
    timeLabel: formatShortDateTimeIST(e.time),
    // the sequence-level breakout time this event belongs to (see
    // attachCeilingBrokenAt) — this, not `time`/`timeMs` above, is what
    // Results is sorted by.
    ceilingBrokenAt: e.ceilingBrokenAt != null ? e.ceilingBrokenAt : e.time,
    ceilingBrokenAtMs: e.ceilingBrokenAtMs != null ? e.ceilingBrokenAtMs : (e.time ? new Date(e.time).getTime() : 0),
  };
}

// ── split each symbol's events into today / history, per-symbol ────────
// Returns { history: Row[], todayEventsBySymbol: Map<symbol, Row[]> } —
// the map (not a flat array) is needed because Results' "fired_today"
// branch and the Upcoming-exclusion guard both need to know, per
// symbol, whether *any* event fired today.
function splitTodayAndHistory(scanResults) {
  const today = getTodayIST();
  const history = [];
  const todayEventsBySymbol = new Map();

  for (const r of scanResults || []) {
    if (!r || r.error || !Array.isArray(r.events) || r.events.length === 0) continue;
    const pairedEvents = attachCeilingBrokenAt(r.events);
    for (const e of pairedEvents) {
      const row = toEventRow(r.symbol, e);
      if (e.time && toISTDate(e.time) === today) {
        const list = todayEventsBySymbol.get(r.symbol) || [];
        list.push(row);
        todayEventsBySymbol.set(r.symbol, list);
      } else {
        history.push(row);
      }
    }
  }

  history.sort((a, b) => b.timeMs - a.timeMs);
  for (const list of todayEventsBySymbol.values()) {
    list.sort((a, b) => b.timeMs - a.timeMs);
  }
  return { history, todayEventsBySymbol };
}

// ── Results tab: "active" (watching/retested right now) rows ───────────
function buildActiveRow(r, todayEventsForSymbol) {
  const s = r.state;
  const pairedEvents = Array.isArray(r.events) ? attachCeilingBrokenAt(r.events) : [];
  const lastPaired = pairedEvents.length ? pairedEvents[pairedEvents.length - 1] : null;
  const latest = lastPaired ? toEventRow(r.symbol, lastPaired) : null;
  return {
    symbol: r.symbol,
    kind: "active",
    state: s.state, // 'watching' | 'retested'
    ceilingLevel: s.ceilingLevel != null ? s.ceilingLevel : null,
    activeCeiling: s.activeCeiling != null ? s.activeCeiling : null,
    zoneHi: s.zoneHi != null ? s.zoneHi : null,
    zoneLo: s.zoneLo != null ? s.zoneLo : null,
    latestEvent: latest,
    firedToday: todayEventsForSymbol && todayEventsForSymbol.length > 0,
    // the current live sequence's own breakout time, not its latest
    // retest-stage event's time — this is what Results sorts by.
    ceilingBrokenAt: lastPaired ? lastPaired.ceilingBrokenAt : null,
    ceilingBrokenAtMs: lastPaired ? lastPaired.ceilingBrokenAtMs : 0,
  };
}

// scanResults = array of scan() outputs, one per symbol (same input
// shape buildAbsorptionRows()/buildScannerRows() take).
export function buildCeilingBreakRows(scanResults) {
  const { history, todayEventsBySymbol } = splitTodayAndHistory(scanResults);

  const results = [];
  const upcoming = [];

  for (const r of scanResults || []) {
    if (!r || r.error || !r.state) continue;
    const s = r.state;
    const todayEventsForSymbol = todayEventsBySymbol.get(r.symbol) || [];

    if (s.state === "watching" || s.state === "retested") {
      // Live sequence in progress right now — always a Results row,
      // regardless of whether its latest event happened today.
      results.push(buildActiveRow(r, todayEventsForSymbol));
      continue; // never also eligible for Upcoming — state isn't 'idle'
    }

    // state.state === 'idle' from here down.
    if (todayEventsForSymbol.length > 0) {
      // Resolved today (HIGHER_LOW / NO_RETEST / FAILED_RETEST all
      // reset to 'idle') — one Results row PER today event, and
      // excluded from Upcoming (see file header).
      for (const row of todayEventsForSymbol) {
        results.push({ ...row, kind: "fired_today" });
      }
      continue;
    }

    // Truly idle, nothing fired today: eligible for Upcoming.
    if (!s.hasCeiling) continue;
    if (s.ceilingLevel == null || !r.lastCandle || r.lastCandle.close == null) continue;
    const close = r.lastCandle.close;
    const ceilingLevel = s.ceilingLevel;
    if (!(ceilingLevel > 0)) continue; // guard against div-by-zero on a malformed level
    upcoming.push({
      symbol: r.symbol,
      ceilingLevel,
      close,
      distancePct: Math.abs(close - ceilingLevel) / ceilingLevel,
    });
  }

  // Sorted PURELY by ceilingBrokenAtMs, descending — the freshest
  // ceiling break is always first, regardless of whether that sequence
  // is still Watching, still Retested, or already resolved
  // (fired_today). Symbol is a secondary tiebreaker only for
  // deterministic output when two ceilings broke in the exact same
  // millisecond (practically never, but keeps the sort well-defined).
  results.sort((a, b) => {
    const diff = (b.ceilingBrokenAtMs || 0) - (a.ceilingBrokenAtMs || 0);
    if (diff !== 0) return diff;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
  upcoming.sort((a, b) => a.distancePct - b.distancePct);

  return { upcoming, results, history };
}