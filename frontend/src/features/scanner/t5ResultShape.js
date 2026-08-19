// t5ResultShape.js
// ─────────────────────────────────────────────────────────────────
// Turns a raw tgT5.js scan() result (flat event log + engine state)
// into the two row shapes the Scanner UI needs:
//   - a Results row  (P4/main trigger fired, OR an early actionable
//     flip disarmed the structure before P4 ever fired)
//   - an Upcoming row (stage 1–3, main trigger not fired yet, still live)
//
// STATE-FIRST REWRITE (see project notes, Aug 2026):
//   tgT5.js's engine.getState() (state.t5h.stage / state.t5l.stage) is the
//   only source of truth for "what's live right now" on a symbol. The old
//   version of this file trusted event-log history instead — it searched
//   for "the last T5H1/T5L1 tag" and returned the first side that reached
//   P4, without ever comparing which side actually has the newest activity
//   or consulting engine state. That produced two bugs:
//     1. A long-dead, already-closed cycle on one side could keep shadowing
//        a brand-new, genuinely live cycle on the other side.
//     2. An early actionable flip (structure disarms before P4) had no
//        bucket to land in — not a Results row (no P4), not an Upcoming
//        row (state.stage resets to 0 on the flip) — so it vanished.
//
// This file does NO pattern logic of its own — it only reads the tag
// names tgT5.js already emits (same tag strings as the Pine
// alertcondition()s / the cheat-sheet) and reshapes them. If tgT5.js's
// tags ever change, this is the only other file that needs to change.
// tgT5.js itself is NOT modified by this rewrite.
// ─────────────────────────────────────────────────────────────────

import { formatDateTimeIST } from "../../utils/istUtils";

// ── per-side tag vocabulary (verbatim strings emitted by tgT5.js) ──────
// Everything here is read off tgT5.js's `emit(...)` calls — nothing here
// is inferred or guessed.
const SIDE_DEF = {
  T5H: {
    p1: "T5H1", p2: "T5H2", p3: "T5H3", p4: "S T5H4", p5: "T5H5",
    p6Confirm: "S T5H6", p6NC: "T5H6NC",
    p4TagName: "S T5H4",
    // P6 confirmed, or the point-5 continuation running in the trigger's
    // favour — both are a genuine "this played out" close (Sr. 95/97, 59).
    confirmTags: new Set(["S T5H6", "S T5H5 FLIP"]),
    // Explicit "the P4 trigger got retracted" / "P5-P6 window timed out".
    explicitCancelTags: new Set(["\u2715 S T5H4 CANCELLED"]),
    expiredTag: "T5H \u2715 expired",
    // Actionable flips that can fire with OR without a prior P4 — S T5H2
    // FLIP only ever fires at stage 2 (always pre-P4); the trap flip
    // (L T5H FLIP (trap)) can fire pre- or post-P4, distinguished by
    // whether a P4 tag is present earlier in the same cycle.
    flipTags: new Set(["S T5H2 FLIP", "L T5H FLIP (trap)"]),
    // Non-actionable close: caution resolved AGAINST the structure. Per
    // the cheat-sheet this is pure context (rule 1) — the cycle just ends
    // quietly, nothing goes in Results.
    quietCloseTag: "T5H \u2713 dissolved",
    cautionFlipLabel: "S/L CAUT T5H3 FLIP watch",
    disarmNotes: {
      "S T5H2 FLIP": "origin broken (T5H1) \u2014 structure disarms, hands off as new T5L1 candidate",
      "L T5H FLIP (trap)": "trap ceiling broken \u2014 double top failed, structure disarms",
    },
  },
  T5L: {
    p1: "T5L1", p2: "T5L2", p3: "T5L3", p4: "L T5L4", p5: "T5L5",
    p6Confirm: "L T5L6", p6NC: "T5L6NC",
    p4TagName: "L T5L4",
    confirmTags: new Set(["L T5L6", "L T5L5 FLIP"]),
    explicitCancelTags: new Set(["\u2715 L T5L4 CANCELLED"]),
    expiredTag: "T5L \u2715 expired",
    flipTags: new Set(["L T5L2 FLIP", "S T5L FLIP (trap)"]),
    quietCloseTag: "T5L \u2713 dissolved",
    cautionFlipLabel: "S/L CAUT T5L3 FLIP watch",
    disarmNotes: {
      "L T5L2 FLIP": "origin broken (T5L1) \u2014 structure disarms, hands off as new T5H1 candidate",
      "S T5L FLIP (trap)": "trap floor broken \u2014 double bottom failed, structure disarms",
    },
  },
};

const STAGE_NAMES_0_3 = ["idle", "candidate (P1)", "armed (P1-2)", "dip set (P3)"];

function fmtTime(ms) {
  if (!ms) return null;
  try { return formatDateTimeIST(ms).split(" ").pop(); } // just HH:MM:SS
  catch { return new Date(ms).toISOString().slice(11, 19); }
}

function stageLabel(stage) {
  return STAGE_NAMES_0_3[Math.min(stage, 3)] || `stage ${stage}`;
}

// Every tag tgT5.js emits for a side contains that side's prefix
// ("T5H"/"T5L") somewhere in the string — mirrors tgT5.js's own internal
// structureOf() helper.
function sideOfTag(tag) {
  if (tag.indexOf("T5H") !== -1) return "T5H";
  if (tag.indexOf("T5L") !== -1) return "T5L";
  return null;
}

// Find the most recent cycle for one side: everything from that side's
// LAST `{prefix}1` (point-1 anchor) tag through the end of the event log.
// A cycle NOT starting at a `1` tag can't happen — tgT5.js only re-emits
// `{prefix}1` on a genuine new anchor, never on a re-arm/gate-2 hand-off
// (those stay inside the same cycle, same colour, per the cheat-sheet).
function latestCycle(side, sideEvents) {
  let startIdx = -1;
  for (let i = sideEvents.length - 1; i >= 0; i--) {
    if (sideEvents[i].tag === SIDE_DEF[side].p1) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  return sideEvents.slice(startIdx);
}

// Walk a cycle's events forward and classify how (or whether) it closed.
// Returns { closeEvent, hadP4, status, statusNote, tag } — closeEvent is
// null if the cycle is still open (nothing fired to end it yet).
function classifyCycle(side, cycleEvents) {
  const def = SIDE_DEF[side];
  let hadP4 = false;
  for (let i = 0; i < cycleEvents.length; i++) {
    const ev = cycleEvents[i];
    if (ev.tag === def.p4) hadP4 = true;

    if (def.confirmTags.has(ev.tag)) {
      return { closeEvent: ev, hadP4, status: "confirmed", statusNote: "", tag: ev.tag };
    }
    if (def.explicitCancelTags.has(ev.tag)) {
      return { closeEvent: ev, hadP4, status: "cancelled", statusNote: `${def.p4TagName} retracted`, tag: def.p4TagName };
    }
    if (ev.tag === def.expiredTag) {
      return { closeEvent: ev, hadP4, status: "cancelled", statusNote: "expired \u2014 P5/P6 never resolved", tag: def.p4TagName };
    }
    if (def.flipTags.has(ev.tag)) {
      if (hadP4) {
        return { closeEvent: ev, hadP4, status: "cancelled", statusNote: `${def.p4TagName} retracted`, tag: def.p4TagName };
      }
      return {
        closeEvent: ev, hadP4, status: "disarmed",
        statusNote: def.disarmNotes[ev.tag] || "structure disarms",
        tag: ev.tag,
      };
    }
    if (ev.tag === def.quietCloseTag) {
      // Non-actionable close (caution resolved against the structure) —
      // rule 1: context only, never a Results row.
      return { closeEvent: ev, hadP4, status: "quiet", statusNote: "", tag: ev.tag };
    }
  }
  // Nothing closed it yet — still open/live.
  return { closeEvent: null, hadP4, status: hadP4 ? "live" : "open", statusNote: "", tag: hadP4 ? def.p4TagName : null };
}

// Build the 6-slot points[] + done count for a cycle's events.
function pointsOf(side, cycleEvents) {
  const def = SIDE_DEF[side];
  const orderedTags = [def.p1, def.p2, def.p3, def.p4, def.p5, def.p6Confirm];
  const points = [null, null, null, null, null, null];
  let done = 0;
  orderedTags.forEach((tag, idx) => {
    // Last occurrence wins (re-arms/gate-2 can re-emit P2 on a later bar).
    for (let i = cycleEvents.length - 1; i >= 0; i--) {
      const t = cycleEvents[i].tag;
      if (t === tag || (idx === 5 && t === def.p6NC)) {
        points[idx] = fmtTime(cycleEvents[i].time);
        done = Math.max(done, idx + 1);
        break;
      }
    }
  });
  return { points, done };
}

// ── per-side outcome: results row / upcoming row / nothing ─────────────
// This is the single place that decides what one side (T5H or T5L) is
// currently showing, so shapeT5Row/shapeT5Upcoming can never disagree
// with each other about the same side's state.
function sideOutcome(side, sideEvents, stageSlice) {
  if (!sideEvents.length) return { type: "none", lastTime: -Infinity };

  const lastTime = sideEvents[sideEvents.length - 1].time || 0;
  const cycle = latestCycle(side, sideEvents);
  if (!cycle) return { type: "none", lastTime };

  const cls = classifyCycle(side, cycle);
  const { points, done } = pointsOf(side, cycle);

  if (cls.status === "quiet") {
    // Cycle ended with no actionable outcome — nothing to show for it.
    return { type: "none", lastTime };
  }

  if (cls.status === "confirmed" || cls.status === "cancelled" || cls.status === "disarmed") {
    return {
      type: "results",
      lastTime,
      row: {
        side, points, done,
        tag: cls.tag,
        status: cls.status,
        statusNote: cls.statusNote,
        time: fmtTime(cls.closeEvent.time),
        timeMs: cls.closeEvent.time || 0,
      },
    };
  }

  if (cls.status === "live") {
    // P4 fired, still watching P5/P6 — Results row, status "live".
    return {
      type: "results",
      lastTime,
      row: {
        side, points, done,
        tag: cls.tag,
        status: "live",
        statusNote: done < 5 ? "watching P5" : "watching P6",
        time: fmtTime(lastTime),
        timeMs: lastTime,
      },
    };
  }

  // cls.status === "open": never reached P4 and never closed — only a
  // real Upcoming candidate if the engine's LIVE state agrees this side
  // is actually still sitting at stage 1-3 right now (defensive check;
  // this is the state-first guard the old file never had).
  if (stageSlice && stageSlice.stage >= 1 && stageSlice.stage <= 3) {
    return {
      type: "upcoming",
      lastTime,
      row: {
        side,
        stage: stageSlice.stage,
        stageText: stageLabel(stageSlice.stage),
        flip: !!stageSlice.caution,
        flipName: stageSlice.caution ? SIDE_DEF[side].cautionFlipLabel : null,
        time: fmtTime(lastTime),
        timeMs: lastTime,
      },
    };
  }
  return { type: "none", lastTime };
}

// ── shared derivation: one outcome per symbol ───────────────────────────
// Compares the most recent event across BOTH sides (by time) — whichever
// side actually has the newest activity wins the symbol's single row. If
// the newer side turns out to have nothing to show (a quiet close with
// nothing after it), falls back to the other side rather than hiding a
// valid signal.
function pickSymbolOutcome(scanResult) {
  const { events, state, error } = scanResult || {};
  if (error || !events) return null;

  const t5hEvents = events.filter((e) => sideOfTag(e.tag) === "T5H");
  const t5lEvents = events.filter((e) => sideOfTag(e.tag) === "T5L");

  const h = sideOutcome("T5H", t5hEvents, state && state.t5h);
  const l = sideOutcome("T5L", t5lEvents, state && state.t5l);

  const ordered = h.lastTime >= l.lastTime ? [h, l] : [l, h];
  for (const outcome of ordered) {
    if (outcome.type !== "none") return outcome;
  }
  return null;
}

// ─── Public entry points (unchanged signatures) ────────────────────────
// scanResult = the object returned by tgT5.js's scan(symbol, candles)
function shapeT5Row(scanResult) {
  if (!scanResult) return null;
  const outcome = pickSymbolOutcome(scanResult);
  if (!outcome || outcome.type !== "results") return null;
  return { symbol: scanResult.symbol, ...outcome.row };
}

function shapeT5Upcoming(scanResult) {
  if (!scanResult) return null;
  const outcome = pickSymbolOutcome(scanResult);
  if (!outcome || outcome.type !== "upcoming") return null;
  return { symbol: scanResult.symbol, ...outcome.row };
}

// scanResults = array of scan() outputs, one per symbol
function buildScannerRows(scanResults) {
  const results = [];
  const upcoming = [];
  for (const r of scanResults || []) {
    if (!r || r.error || !r.events) continue;
    const outcome = pickSymbolOutcome(r);
    if (!outcome) continue;
    if (outcome.type === "results") results.push({ symbol: r.symbol, ...outcome.row });
    else if (outcome.type === "upcoming") upcoming.push({ symbol: r.symbol, ...outcome.row });
  }
  results.sort((a, b) => b.timeMs - a.timeMs);
  upcoming.sort((a, b) => b.timeMs - a.timeMs);
  return { results, upcoming };
}

// Exported for ScannerPage.js / T5ScannerPanel.js
export { shapeT5Row, shapeT5Upcoming, buildScannerRows, stageLabel, fmtTime };