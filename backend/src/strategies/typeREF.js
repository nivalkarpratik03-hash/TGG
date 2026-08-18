/**
 * strategies/typeREF.js
 * ─────────────────────────────────────────────────────────────────
 * Strategies for the "Type" feature (R / E / F), alongside Motherwave.
 * Mother Wave / Driver Wave detection itself is NEVER touched here —
 * this file only reads context.motherwave (and context.motherwave.dw)
 * for display, and separately replays motherwave.js's own
 * buildPerBarMwDwTimeline() (a read-only wrapper — see motherwave.js)
 * to know which DW was active on each historical bar. No detection
 * logic is duplicated or modified.
 *
 * Exports 4 strategy objects in one array:
 *   1. type-ref  ("Type E,R,F")  — the ONE entry in the Strategy
 *      dropdown, next to "Motherwave S1/S2/S3". Shows whichever of
 *      R/E/F most recently triggered per symbol (see scanCombined).
 *   2-4. type-e / type-r / type-f — tab-only (Type E / Type R /
 *      Type F buttons next to Results/Upcoming), not in the dropdown.
 *
 * ── Active Event Rule (Scanner Only) ───────────────────────────────
 * Applied independently per event type — E, R, and F all go through
 * the same concurrency rule:
 *   • While a Type E (or R, or F) event is ACTIVE (created, not yet
 *     exited), further qualifying triggers of that SAME type are
 *     ignored — no new event.
 *   • Once that event exits, the next FUTURE qualifying trigger
 *     (not necessarily the very next candle) opens the next event.
 *   • Type E, Type R and Type F are tracked completely independently.
 * The concurrency/dedup state-machine (formerly a separate
 * eventStateTracker.js module — merged in here since it only ever had
 * the one caller) is buildEventsWithConcurrencyRule() below; this file's
 * detectors just supply the per-type `detectTrigger` / `detectExit`
 * callbacks it replays candle-by-candle.
 *
 * ── Trigger / exit conditions — ported from the w_mw_dw_heatmap-main
 * spec (application/services/event_observation_service.py, configs/
 * events.yaml). Only the ENTRY and EXIT conditions are ported — the
 * Python engine's Fib-grid/level-assignment/quadrant machinery is
 * Phase 5 analytics and has no Scanner-UI equivalent, so it's left
 * out here on purpose:
 *
 *   Type R (candles are w.r.t. the DW active on that bar, "ref"):
 *     Candle A — strong opposing candle: body >= 0.6 x ATR14-exclusive,
 *       red if ref is bullish / green if ref is bearish.
 *     Candle B — the first candle within 3 bars of A that closes back
 *       beyond A's extreme in ref's own direction (confirms the
 *       reversal). Event opens ON candle B (per events.yaml's
 *       multiple_a_pairing: most_recent_valid_a — if a newer A shows
 *       up before B confirms, it replaces the pending A).
 *   Type E:
 *     Single-candle trigger — a colour-qualified close beyond EMA9
 *       (close < EMA9-low & red, if ref is bullish; close > EMA9-high
 *       & green, if ref is bearish). Event opens on the trigger candle
 *       itself, no confirmation candle.
 *   Type F (reference = any wave ever activated as DW under the
 *   CURRENT Mother Wave — events.yaml's type_f_reference_scope:
 *   current_mw_only):
 *     Candle A — high/low penetrates the reference wave's -0.236 or
 *       1.234 fib level (graded WICK, or CLOSE_OUT if the close itself
 *       clears the level too — this Scanner port skips the Python
 *       engine's extra ATR-qualified "CUT" sub-grade, which needs
 *       DW-invalidation's own qualifying-cut evaluator; not worth
 *       duplicating that logic a second time here).
 *     Reclaim candle — within 3 bars of A, the first candle that
 *       closes back through the level by >= 20% of its own body.
 *       Event opens on the reclaim candle. First anchor per
 *       (reference wave, level) wins for good once an event actually
 *       opens; an expired pending candidate (no reclaim in time) can
 *       be re-armed by a later penetration.
 *   Shared exit (E, R and F alike — events.yaml's exit_body_ratio /
 *   negation_window_bars):
 *     Starting scenario is BULLISH if ref was bearish, BEARISH if ref
 *     was bullish (Type F: BULLISH if the reclaim candle's close was
 *     already above the level, else same ref-direction rule as R/E —
 *     mirrors _measure()'s nested ternary exactly). Within 3 bars of
 *     entry, a single one-time negation can flip the scenario if price
 *     closes back through the entry candle's opposite extreme. From
 *     then on, the first candle that closes >= 20% of its own body
 *     beyond EMA9 AGAINST the current scenario closes the event
 *     (mirrors _measure()'s trailing-EMA9 exit — the same exit rule
 *     the Python engine uses for every event type).
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { buildPerBarMwDwTimeline, fibPrice } = require("../services/motherwave");
const { calcEMA, trueRanges, wilderATR } = require("../services/indicatorMath");

// ─── Active Event Rule (Scanner Only) — concurrency/dedup state machine ───────
// Formerly its own module (strategies/eventStateTracker.js) — merged in here
// since typeREF.js was its only caller and there was no reuse benefit to
// keeping it split out. Generic replay over a full candle history: the
// caller supplies `detectTrigger`/`detectExit` (this file's Type E/R/F
// detector factories further down); this function only enforces "at most
// one active event of a given type at a time, next qualifying trigger opens
// the next one after the previous exits" — it has no idea what actually
// makes a candle a Type E/R/F trigger.
//
// Because the scanner re-fetches the FULL candle history every scan cycle
// (candles are not streamed incrementally — see scannerRunner.js), this is
// a pure, stateless replay rather than something persisted between scans:
// given the same candles, it always produces the same event list.
//
// @param {Array} candles - full chronological candle array.
// @param {(candle, index, candles) => (boolean|Object|null)} detectTrigger
//   Called only when there is NO currently-active event. Return a truthy
//   value (boolean `true`, or a payload object stashed on the event as
//   `.trigger`) to open a new event on this candle.
// @param {(candle, index, candles, activeEvent) => boolean} detectExit
//   Called only while an event IS active. Return `true` on the candle
//   where that event should be considered exited.
// @returns {Array<Event>} chronological list of events, oldest first:
//   { entryIndex, entryTime, entryPrice, exitIndex, exitTime, exitPrice,
//     exited, trigger }
//   NOTE: only the LAST entry can have `exited: false` (still running as
//   of the last candle) — a new event can only open after the previous one
//   of that type exited.
function buildEventsWithConcurrencyRule(candles, detectTrigger, detectExit) {
  const events = [];
  let active = null;

  if (!Array.isArray(candles)) return events;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (active) {
      // An event of this type is already active — per the Active Event
      // Rule, ignore any new trigger candidates entirely while active.
      // Only check whether THIS active event should now exit.
      if (detectExit(c, i, candles, active)) {
        active.exitIndex = i;
        active.exitTime = c.time;
        active.exitPrice = c.close;
        active.exited = true;
        events.push(active);
        active = null;
      }
      continue;
    }

    // No active event of this type — the next qualifying trigger
    // (whenever it occurs, not necessarily the very next candle)
    // opens the next event.
    const trig = detectTrigger(c, i, candles);
    if (trig) {
      active = {
        entryIndex: i,
        entryTime: c.time,
        entryPrice: c.close,
        exitIndex: null,
        exitTime: null,
        exitPrice: null,
        exited: false,
        trigger: trig === true ? null : trig,
      };
    }
  }

  // A still-open event (no exit yet as of the latest candle) is reported
  // too, marked `exited: false`, so the UI can show it as "Active" — it
  // just isn't pushed until here since the loop above only pushes on exit.
  if (active) events.push(active);

  return events;
}

// Convenience — the single most-recent event (active if one is open,
// otherwise the most recently exited one), or null if none yet.
function latestEvent(events) {
  return events.length ? events[events.length - 1] : null;
}


// Mirrors configs/events.yaml (w_mw_dw_heatmap-main) — only the fields the
// Scanner's entry/exit conditions actually need (grid/level-tolerance/
// asymmetry-cap fields are Phase 5 analytics, not used here).
const EVENTS_CFG = {
  emaLength: 9,
  atrLength: 14,
  bodyAtrRatio: 0.6,         // Type R candle-A strength: body >= 0.6x ATR14-exclusive
  confirmationWindowBars: 3, // Type R/F: confirming candle must land within this many bars of A
  exitBodyRatio: 0.20,       // shared exit: close must clear EMA9 by >= 20% of its own body
  negationWindowBars: 3,     // shared: one-time scenario flip allowed within this many bars
  reclaimBodyRatio: 0.20,    // Type F: reclaim close must clear the penetrated level by >= 20% of its own body
  typeFRatios: { F_NEG0236: -0.236, F_1234: 1.234 }, // events.yaml's type_f_ratios
};

// ─── Shared per-symbol precomputation ──────────────────────────────────────────
// Computed once per scan (not per-candle) and handed to the Type E/R/F
// detector factories below, so EMA9/ATR14/MW-DW-timeline are each built
// exactly once per symbol per scan cycle.
function buildTypeContext(candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const emaH = calcEMA(highs, EVENTS_CFG.emaLength);
  const emaL = calcEMA(lows, EVENTS_CFG.emaLength);
  const atr = wilderATR(trueRanges(highs, lows, closes), EVENTS_CFG.atrLength);
  const { waves, dwWaveNoAfterBar, mwWaveNoAfterBar, dwPeriods } = buildPerBarMwDwTimeline(candles, "intraday");
  const waveByNo = new Map(waves.map(w => [w.waveNo, w]));
  return { emaH, emaL, atr, dwWaveNoAfterBar, mwWaveNoAfterBar, dwPeriods, waveByNo };
}

// A wave shape frontend/src/utils/motherWaveNav.js already knows how to turn
// into a fib drawing / chart URL (buildFibDrawingPayload / buildWaveChartUrl
// both read fromPrice/toPrice/fromTime/toTime) — built straight off the same
// `ref` wave record (computeSegments()' output) each detector matched
// against, so a clicked event draws the ACTUAL reference wave it fired
// against, not a synthetic line between its own entry/exit prices.
function refWaveObj(ref) {
  if (!ref) return null;
  return {
    dir: ref.direction,
    fromPrice: ref.originPrice, toPrice: ref.tipPrice,
    fromTime: ref.originTime, toTime: ref.tipTime,
  };
}

// ─── Shared exit — identical rule for Type E, Type R and Type F ───────────────
// `activeEvent.trigger` is set by the matching detectTrigger below to
// { refDirection, referenceWave, [level] }. We stash the live negation/
// scenario state on that same object (mutable, shared by reference across
// calls for this active event) so it survives from one candle to the next
// without any extra bookkeeping in eventStateTracker.js itself.
function makeDetectExit(ctx) {
  return function detectExit(candle, index, candles, activeEvent) {
    const { emaH, emaL } = ctx;
    const anchor = candles[activeEvent.entryIndex];
    const t = activeEvent.trigger || (activeEvent.trigger = {});
    if (!t.scenario) {
      // First exit-check for this event — derive the starting scenario.
      // Type F (t.level set): bullish if the reclaim candle's close already
      // cleared the penetrated level, else falls back to the ref-direction
      // rule same as R/E (mirrors _measure()'s nested ternary exactly).
      if (t.level != null) {
        t.scenario = anchor.close > t.level ? "bullish" : (t.refDirection === "bear" ? "bullish" : "bearish");
      } else {
        t.scenario = t.refDirection === "bull" ? "bearish" : "bullish";
      }
    }

    const offset = index - activeEvent.entryIndex;
    if (offset <= 0) return false; // exit checks only run on candles AFTER entry

    if (!t.negated && offset <= EVENTS_CFG.negationWindowBars) {
      if (t.scenario === "bullish" && candle.close < candle.open && candle.close < anchor.low) {
        t.scenario = "bearish";
        t.negated = true;
      } else if (t.scenario === "bearish" && candle.close > candle.open && candle.close > anchor.high) {
        t.scenario = "bullish";
        t.negated = true;
      }
    }

    const body = Math.abs(candle.close - candle.open);
    if (body <= 0) return false;
    const i = index;
    if (
      t.scenario === "bullish" &&
      candle.close < candle.open &&
      emaL[i] != null &&
      candle.close < emaL[i] &&
      (emaL[i] - candle.close) >= EVENTS_CFG.exitBodyRatio * body
    ) {
      return true;
    }
    if (
      t.scenario === "bearish" &&
      candle.close > candle.open &&
      emaH[i] != null &&
      candle.close > emaH[i] &&
      (candle.close - emaH[i]) >= EVENTS_CFG.exitBodyRatio * body
    ) {
      return true;
    }
    return false;
  };
}

// ─── Type E trigger — single-candle EMA9 cross, colour-qualified ──────────────
function makeDetectTriggerE(ctx) {
  const { emaH, emaL, dwWaveNoAfterBar, waveByNo } = ctx;
  return function detectTriggerE(candle, index) {
    const dwNo = dwWaveNoAfterBar[index];
    if (dwNo == null) return false;
    const ref = waveByNo.get(dwNo);
    if (!ref) return false;
    const bull = ref.direction === "bull";
    const bear = ref.direction === "bear";
    // Type E opens on the SAME candle it triggers on, so the anchor bar for
    // MW/DW time is just `index` — no confirmation-candle lag to worry
    // about here (unlike R and F below).
    const mwTime = mwTimeAtBar(ctx, index);
    const dwTime = ref.tipTime;
    if (bear && candle.close > candle.open && emaH[index] != null && candle.close > emaH[index]) {
      return { refDirection: "bear", referenceWave: refWaveObj(ref), mwTime, dwTime };
    }
    if (bull && candle.close < candle.open && emaL[index] != null && candle.close < emaL[index]) {
      return { refDirection: "bull", referenceWave: refWaveObj(ref), mwTime, dwTime };
    }
    return false;
  };
}

// ─── Type R trigger — candle A (strong opposing body) then candle B
// (confirmation within 3 bars). Event opens ON candle B. ──────────────────────
function makeDetectTriggerR(ctx) {
  const { atr, dwWaveNoAfterBar, waveByNo } = ctx;
  let pending = null; // { aIndex, aCandle, ref, mwTime, dwTime } — "most_recent_valid_a" (events.yaml)

  return function detectTriggerR(candle, index) {
    // 1. A pending candle-A is waiting for its confirming candle-B.
    if (pending) {
      const offset = index - pending.aIndex;
      if (offset > EVENTS_CFG.confirmationWindowBars) {
        pending = null;
      } else if (offset >= 1) {
        const ref = pending.ref;
        const confirmed =
          (ref.direction === "bear" && candle.close > candle.open && candle.close > pending.aCandle.high) ||
          (ref.direction === "bull" && candle.close < candle.open && candle.close < pending.aCandle.low);
        if (confirmed) {
          // Event opens HERE, on candle B — but mwTime/dwTime travel with
          // `pending` from candle A, the bar where `ref` was actually
          // chosen. Using index (candle B) here instead would read
          // whatever DW is active NOW, which can already have rolled to a
          // different wave than the one this event fired against.
          const trig = {
            refDirection: ref.direction,
            referenceWave: refWaveObj(ref),
            mwTime: pending.mwTime,
            dwTime: pending.dwTime,
          };
          pending = null;
          return trig;
        }
      }
    }

    // 2. Independently of the above, this candle may itself qualify as a
    // new candle-A (replaces any still-pending older A — most-recent-A wins).
    const dwNo = dwWaveNoAfterBar[index];
    if (dwNo != null) {
      const ref = waveByNo.get(dwNo);
      const exclusive = index > 0 ? atr[index - 1] : null;
      if (ref && exclusive != null) {
        const body = Math.abs(candle.close - candle.open);
        const strong = body >= EVENTS_CFG.bodyAtrRatio * exclusive;
        const isA =
          (ref.direction === "bear" && candle.close < candle.open && strong) ||
          (ref.direction === "bull" && candle.close > candle.open && strong);
        if (isA) {
          pending = {
            aIndex: index, aCandle: candle, ref,
            mwTime: mwTimeAtBar(ctx, index),
            dwTime: ref.tipTime,
          };
        }
      }
    }

    return false;
  };
}

// ─── Type F reference registry — "every wave ever activated as a Driver Wave,
// scoped to the CURRENT Mother Wave" (events.yaml's type_f_reference_scope:
// current_mw_only). Built once per symbol from dwPeriods (already tracked by
// buildMwdwState / exposed read-only via buildPerBarMwDwTimeline — nothing
// here re-derives DW selection itself), grouped by the MW wave each DW
// period belonged to (parentMwWaveNo) so lookups at any bar are O(group
// size) instead of rescanning every dwPeriod on every bar. ────────────────────
function buildFReferenceGroups(dwPeriods) {
  const byMw = new Map(); // mwWaveNo -> Map<dwWaveNo, {ref, activatedAtBar}>
  for (const p of dwPeriods) {
    let group = byMw.get(p.parentMwWaveNo);
    if (!group) byMw.set(p.parentMwWaveNo, (group = new Map()));
    const existing = group.get(p.wave.waveNo);
    if (!existing || p.activatedAtBar < existing.activatedAtBar) {
      group.set(p.wave.waveNo, { ref: p.wave, activatedAtBar: p.activatedAtBar });
    }
  }
  return byMw;
}

// ─── Type F trigger — candle A penetrates -0.236 or 1.234 of an eligible
// reference wave, graded WICK/CLOSE_OUT, then a reclaim candle within 3 bars
// closing back through the level (by >= 20% of its own body) opens the
// event. First anchor per (reference wave, level) wins — once an event has
// been created for a given (waveNo, level) pair it's retired for good; a
// pending candidate that expires without reclaiming can be re-armed by a
// later penetration (mirrors events.yaml's
// deduplicate_first_anchor_per_event_type_reference_wave_level). ──────────────
function makeDetectTriggerF(ctx) {
  const { mwWaveNoAfterBar, dwPeriods, waveByNo } = ctx;
  const groups = buildFReferenceGroups(dwPeriods);
  const pending = new Map(); // "waveNo|col" -> { aIndex, ref, level, grade, reclaimDir, col, mwTime, dwTime }
  const done = new Set();    // "waveNo|col" — retired once an event has actually opened

  return function detectTriggerF(candle, index) {
    const i = index;

    // 1. Existing pending penetrations waiting for their reclaim candle.
    for (const [key, p] of pending) {
      const offset = i - p.aIndex;
      if (offset > EVENTS_CFG.confirmationWindowBars) { pending.delete(key); continue; }
      if (offset < 1) continue;
      const body = Math.abs(candle.close - candle.open);
      if (body <= 0) continue;
      const reclaimed =
        (p.reclaimDir === "UP" && candle.close > candle.open && candle.close > p.level &&
          (candle.close - p.level) >= EVENTS_CFG.reclaimBodyRatio * body) ||
        (p.reclaimDir === "DOWN" && candle.close < candle.open && candle.close < p.level &&
          (p.level - candle.close) >= EVENTS_CFG.reclaimBodyRatio * body);
      if (reclaimed) {
        pending.delete(key);
        done.add(key);
        // mwTime/dwTime travel with `p` from candle A (the penetration
        // bar), same reasoning as Type R above — the reclaim candle here
        // can be several bars later, by which point the CURRENT MW/DW may
        // have already moved on from the one this event actually fired
        // against.
        return {
          refDirection: p.ref.direction,
          referenceWave: refWaveObj(p.ref),
          fakeGrade: p.grade,
          level: p.level,
          col: p.col,
          mwTime: p.mwTime,
          dwTime: p.dwTime,
        };
      }
    }

    // 2. New candle-A penetrations this bar, scoped to the current MW's
    // registry of waves ever activated as DW (most-recent-A replaces any
    // still-pending older A for the same reference/level, same convention
    // as Type R).
    const mwNo = mwWaveNoAfterBar[i];
    const group = mwNo != null ? groups.get(mwNo) : null;
    if (group) {
      const mwTimeHere = mwNo != null ? (waveByNo.get(mwNo)?.tipTime ?? null) : null;
      for (const [waveNo, entry] of group) {
        if (entry.activatedAtBar > i) continue;
        const ref = entry.ref;
        for (const [col, ratio] of Object.entries(EVENTS_CFG.typeFRatios)) {
          const key = `${waveNo}|${col}`;
          if (done.has(key)) continue;
          const level = fibPrice(ref, ratio);
          const outside = (ref.direction === "bull") === (ratio < 0) ? "UP" : "DOWN";
          const penetrated = outside === "UP" ? candle.high > level : candle.low < level;
          if (!penetrated) continue;
          const closeOut = outside === "UP" ? candle.close > level : candle.close < level;
          pending.set(key, {
            aIndex: i,
            ref,
            level,
            grade: closeOut ? "CLOSE_OUT" : "WICK",
            reclaimDir: outside === "UP" ? "DOWN" : "UP",
            col,
            mwTime: mwTimeHere,
            dwTime: ref.tipTime,
          });
        }
      }
    }

    return false;
  };
}

// Type E / Type R / Type F detectors are stateful per-symbol closures
// (pending-A/pending-F tracking, shared EMA9/ATR/MW-DW arrays) — built fresh
// per scan via makeDetectors(candles) rather than as flat module-level
// functions.
function makeDetectors(type, candles) {
  const ctx = buildTypeContext(candles);
  const exit = makeDetectExit(ctx);
  if (type === "E") return { trigger: makeDetectTriggerE(ctx), exit, ctx };
  if (type === "R") return { trigger: makeDetectTriggerR(ctx), exit, ctx };
  if (type === "F") return { trigger: makeDetectTriggerF(ctx), exit, ctx };
  return null;
}

// ─── Per-event historical MW/DW time lookup ────────────────────────────────────
// BUG FIX ROUND 1 (Scanner Type E/R/F table showing wrong/missing Driver Wave
// Time): the table used to stamp every event row for a symbol with that
// symbol's CURRENT mwTime/dwTime (context.motherwave / context.motherwave.dw
// — the wave active as of the LATEST candle). That's correct only for the
// most recent event; older events got the wrong wave, and dwTime showed "—"
// whenever there's currently no active DW, even though the event fired
// against a perfectly real DW back when it triggered.
//
// BUG FIX ROUND 2 (MW/DW date still wrong after round 1): round 1 looked up
// the MW/DW active at the event's own ENTRY bar. That's only correct for
// Type E, where the trigger fires and the event opens on the SAME candle.
// For Type R and Type F, the event opens later — on the confirmation candle
// (R) or the reclaim candle (F) — while the reference wave was actually
// selected earlier, on the anchor candle (candle A / the penetration
// candle). Fixed by having each trigger detector capture mwTime/dwTime
// itself, at the exact anchor bar where it picks `ref`, and stashing it on
// the trigger payload.
//
// BUG FIX ROUND 3 (this pass — MW date STILL wrong, Driver Wave now fine):
// `waveByNo` holds RAW wave segments straight out of computeSegments()
// (this file's `ctx.waveByNo`), and those use `originTime` / `tipTime` as
// field names. Only the API-shaped wave objects built by motherwave.js's
// buildWaveObj() (e.g. context.motherwave.wave) use `fromTime` / `toTime`.
// This function was reading `.toTime` off a RAW segment — which doesn't
// exist there, so it silently returned undefined for every single event,
// for all of E, R and F. dwTime was unaffected because it's read directly
// off `ref.tipTime` (the correct field name) elsewhere in this file — only
// mwTime went through this buggy helper. The frontend's
// `ev.mwTime ?? r.mwTime` fallback then quietly substituted the symbol's
// CURRENT Mother Wave time for every row. Because MW changes rarely, that
// fallback often coincidentally matched the real per-event MW — so it read
// as "correct" even though it was never actually being computed per event.
// Fix: read `.tipTime`, the real field name on a raw wave object.
function mwTimeAtBar(ctx, barIndex) {
  const mwNo = ctx.mwWaveNoAfterBar[barIndex];
  const mwWave = mwNo != null ? ctx.waveByNo.get(mwNo) : null;
  return mwWave?.tipTime ?? null;
}

// ─── Mother Wave / Driver Wave read-only accessors ─────────────────────────────
// Straight reads off context.motherwave (built by scannerRunner.js via
// detectMotherWaveForAPI — see motherwave.js). Never recomputed here.
// NOTE: context.motherwave.wave / .dw.wave ARE the API-shaped objects (built
// via buildWaveObj() inside detectMotherWaveForAPI), so `.toTime` here is
// correct — do not "fix" this to `.tipTime`, that would break it.
function mwDirOf(context) { return context?.motherwave?.wave?.dir ?? null; }
function mwTimeOf(context) { return context?.motherwave?.wave?.toTime ?? null; }
function dwDirOf(context) { return context?.motherwave?.dw?.wave?.dir ?? null; }
function dwTimeOf(context) { return context?.motherwave?.dw?.wave?.toTime ?? null; }

// ─── Per-type scan — runs the Active Event Rule for E/R, stub for F ───────────
// context is provided by scannerRunner.js:
//   context.motherwave = { wave, fibLevels, invalidation, chain, dw, dwChain }
//   context.trapZone, context.zone, context.lastCandle
function scanForType(type, symbol, candles, context = {}) {
  const result = {
    symbol,
    found: false,
    // "none"      — no Type {type} event has ever triggered for this symbol
    // "active"    — an event is open right now (entry fired, no exit yet)
    // "completed" — the most recent event has exited
    patternStage: "none",
    motherwave: context.motherwave || null,
    trapZone: context.trapZone || null,
    // MW/DW summary fields — read straight from context, same for every
    // event of this symbol (S1/S2/S3-style per-candle fields don't apply
    // to Type events, so they're intentionally omitted here).
    mw: mwDirOf(context),
    mwTime: mwTimeOf(context),
    dw: dwDirOf(context),
    dwTime: dwTimeOf(context),
    type, // "R" | "E" | "F"
    entry: null,
    exit: null,
    // Full chronological event history for this symbol (Active Event
    // Rule already applied) — the Scanner UI flattens these across
    // symbols to list "every Type {X} event", not just the latest one.
    events: [],
    lastCandle: context.lastCandle || (candles.length > 0 ? candles[candles.length - 1] : null),
    candleCount: candles.length,
    scannedAt: new Date().toISOString(),
    error: null,
  };

  try {
    if (!Array.isArray(candles) || candles.length === 0) return result;

    const detectors = makeDetectors(type, candles);
    if (!detectors) return result; // unknown type — leave as neutral stub

    const events = buildEventsWithConcurrencyRule(candles, detectors.trigger, detectors.exit);
    // Flatten the trigger payload's referenceWave/fakeGrade onto the event
    // itself — frontend/src/pages/ScannerPage.js flattens `events` straight
    // into table rows and needs these at the top level, not nested under
    // `.trigger` (which is really just this file's own internal state slot).
    // mwTime/dwTime come straight off the trigger payload — captured by the
    // detector at the exact anchor bar where it chose the reference wave
    // (see makeDetectTriggerE/R/F above), so each row shows the wave that
    // was actually active when THAT event triggered, not the symbol's
    // current wave, and not whatever's active on the (possibly later)
    // entry/confirmation bar.
    result.events = events.map(e => ({
      ...e,
      type,
      referenceWave: e.trigger?.referenceWave || null,
      fakeGrade: e.trigger?.fakeGrade || null,
      mwTime: e.trigger?.mwTime ?? null,
      dwTime: e.trigger?.dwTime ?? null,
    }));

    const latest = latestEvent(events);
    if (latest) {
      result.entry = latest.entryPrice;
      result.exit = latest.exited ? latest.exitPrice : null;
      result.patternStage = latest.exited ? "completed" : "active";
      // "found" mirrors how scannerS1.S2.S3.js uses it — true once this
      // symbol has at least one fully completed (entry→exit) event, so
      // it counts toward the "Full Signals" stat and fires signal_found.
      result.found = latest.exited;
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

// ─── Combined type-ref — picks whichever of E/R/F most recently triggered ─────
// Runs all three (independent Active Event Rule state per type, exactly as
// the spec requires), then reports whichever type's latest event started
// most recently for this symbol. If none has ever triggered, returns a
// neutral "none" result (type: null).
function scanCombined(symbol, candles, context) {
  const byType = {
    E: scanForType("E", symbol, candles, context),
    R: scanForType("R", symbol, candles, context),
    F: scanForType("F", symbol, candles, context),
  };

  const withEvents = Object.values(byType).filter(r => r.events.length > 0);
  if (withEvents.length === 0) {
    // Neutral stub — same shape as scanForType(), just no type matched yet.
    return { ...byType.E, type: null };
  }

  withEvents.sort((a, b) => {
    const la = a.events[a.events.length - 1];
    const lb = b.events[b.events.length - 1];
    return (lb.entryTime ?? 0) - (la.entryTime ?? 0);
  });

  return withEvents[0];
}

// ─── The ONE combined strategy — shows in the Strategy dropdown ───────────────
const typeCombined = {
  id: "type-ref",
  name: "Type E,R,F",
  group: "type",           // extended-column marker (see ScannerPage.js)
  variant: "combined",     // shown in the dropdown, flat, next to Motherwave
  description: "Shows whichever of Type E/R/F most recently triggered per symbol",
  scan: (symbol, candles, context) => scanCombined(symbol, candles, context),
};

// ─── The 3 individual strategies — tab-only, NOT in the dropdown ──────────────
function makeSingleType(letter) {
  return {
    id: `type-${letter.toLowerCase()}`,
    name: `Type ${letter}`,
    group: "type",          // extended-column marker (see ScannerPage.js)
    variant: "single",      // excluded from the dropdown — tab button only
    typeLetter: letter,
    description: `Type ${letter} — Active Event Rule (one active event at a time)`,
    scan: (symbol, candles, context) => scanForType(letter, symbol, candles, context),
  };
}

const typeE = makeSingleType("E");
const typeR = makeSingleType("R");
const typeF = makeSingleType("F");

// strategyRegistry.js spreads this array in with `...require("./typeREF")`.
module.exports = [typeCombined, typeE, typeR, typeF];