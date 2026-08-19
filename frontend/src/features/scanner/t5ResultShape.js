// t5ResultShape.js
// ─────────────────────────────────────────────────────────────────
// Turns a raw tgT5.js scan() result (flat event log + engine state)
// into the THREE row shapes the Scanner UI needs:
//   - a Results row   (P3 formed "forming", P4 fired "live", or a
//     confirmed/cancelled/flipped close that happened TODAY)
//   - an Upcoming row (stage 1-2 only — P1 candidate / P1-2 armed)
//   - a History row   (a confirmed/cancelled/flipped close from an
//     EARLIER day — kept, never deleted, just out of the live feed)
//
// RESULTS/UPCOMING/HISTORY REDESIGN (Aug 2026):
//   Results should only ever show what's tradeable/actionable RIGHT NOW,
//   not a growing log. So the split is:
//     stage 1, stage 2                          -> Upcoming
//     stage 3 (P3 formed, nothing fired yet)     -> Results, status "forming"
//     P4 fired, watching P5/P6                   -> Results, status "live"
//     confirmed / cancelled / disarmed (flip)    -> Results IF it closed
//                                                    today (IST), else History
//   "Today" is measured in IST calendar days via istUtils' toISTDate/
//   getTodayIST (reused as-is — see PUBLIC ENTRY POINTS below) so a cycle
//   that fired-and-closed in the same session stays visible, but doesn't
//   linger in the live feed once the trading day has moved on.
//
//   Every fired/closed row also now carries an explicit `flipped` boolean
//   (+ `flippedTag`) separate from `status`/`statusNote`, so the UI can
//   render a dedicated Flipped column/badge instead of parsing it out of
//   free-text status notes.
//
// STATE-FIRST DESIGN (carried over, see project notes, Aug 2026):
//   tgT5.js's engine.getState() (state.t5h.stage / state.t5l.stage) is the
//   only source of truth for "what's live right now" on a symbol. Trusting
//   event-log history alone (e.g. "the last T5H1/T5L1 tag") can let a
//   long-dead, already-closed cycle on one side keep shadowing a brand-new,
//   genuinely live cycle on the other side — so live stage always wins for
//   deciding which side's cycle is current.
//
// This file does NO pattern logic of its own — it only reads the tag
// names tgT5.js already emits (same tag strings as the Pine
// alertcondition()s / the cheat-sheet) and reshapes them. If tgT5.js's
// tags ever change, this is the only other file that needs to change.
// tgT5.js itself is NOT modified by this rewrite.
// ─────────────────────────────────────────────────────────────────

import { formatDateTimeIST, formatShortDateTimeIST, toISTDate, getTodayIST } from "../../utils/istUtils";

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

// Full IST date+time (e.g. "19/08/2026, 15:15:00") — used for the P1-P6
// hover tooltip in pointsOf() below, where there's room for the whole
// string. Previously this stripped everything but HH:MM:SS via
// `.split(" ").pop()`, which silently threw away the date and made any
// point look like it happened "today" even when the row was from an
// earlier session — fixed by just returning formatDateTimeIST's output
// as-is instead of truncating it.
function fmtTime(ms) {
  if (!ms) return null;
  try { return formatDateTimeIST(ms); }
  catch { return new Date(ms).toISOString().slice(0, 19).replace("T", " "); }
}

// Compact IST date+time (e.g. "19 Aug, 15:15") — used for the Results/
// Upcoming "Time" table column, which is too narrow for the full
// seconds-precision formatDateTimeIST string. Still carries the calendar
// date (the actual bug being fixed here — see istUtils.js), just
// abbreviated to fit the column.
function fmtTimeShort(ms) {
  if (!ms) return null;
  try { return formatShortDateTimeIST(ms); }
  catch { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
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

// Resolves the candle time of the SPECIFIC point that matches a side's
// CURRENT stage (P1's tag for stage 1, P2's tag for stage 2, P3's tag
// for stage 3) — never "whatever the side's last-logged event happened
// to be". Without this, a later info-only tag on the same side (NC,
// CAUT, a gate-2 re-arm note, etc.) sitting after the stage's own point
// tag in the event log would overwrite the row's displayed time with a
// wrong, later timestamp even though the stage itself hasn't advanced.
// A gate-2 re-arm re-emits the stage's own point tag (e.g. "T5H2") on
// the correct re-anchored bar (tgT5.js emits it in the same block that
// re-arms), so scanning for the LAST occurrence of that exact tag also
// picks up a gate-2 re-anchor's new time for free — no separate case
// needed for it here.
function stagePointTime(side, cycleEvents, stage) {
  const def = SIDE_DEF[side];
  const stageTag = stage === 1 ? def.p1 : stage === 2 ? def.p2 : stage === 3 ? def.p3 : null;
  if (!stageTag) return null;
  for (let i = cycleEvents.length - 1; i >= 0; i--) {
    if (cycleEvents[i].tag === stageTag) return cycleEvents[i].time || null;
  }
  return null;
}

// Whether a closed cycle's close event happened on today's IST trading
// day. Reused as the single staleness test for "does this still belong
// in the live Results feed, or has it aged into History" — see file
// header. Falls back to "not stale" (true) if the timestamp is missing,
// so a row is never silently dropped from Results for lack of a time.
function closedToday(timeMs) {
  if (!timeMs) return true;
  return toISTDate(timeMs) === getTodayIST();
}

// ── per-side outcome: results row / upcoming row / history row / nothing ──
// This is the single place that decides what one side (T5H or T5L) is
// currently showing, so shapeT5Row/shapeT5Upcoming/shapeT5History can
// never disagree with each other about the same side's state.
function sideOutcome(side, sideEvents, stageSlice) {
  if (!sideEvents.length) return { type: "none", lastTime: -Infinity };

  const lastTime = sideEvents[sideEvents.length - 1].time || 0;
  const cycle = latestCycle(side, sideEvents);
  if (!cycle) return { type: "none", lastTime };

  const cls = classifyCycle(side, cycle);
  const { points, done } = pointsOf(side, cycle);

  if (cls.status === "quiet") {
    // Cycle ended with no actionable outcome — nothing to show for it,
    // in Results OR History (per cheat-sheet rule 1: pure context).
    return { type: "none", lastTime };
  }

  if (cls.status === "confirmed" || cls.status === "cancelled" || cls.status === "disarmed") {
    const closeMs = cls.closeEvent.time || 0;
    const isFlip = cls.status === "disarmed";
    const row = {
      side, points, done,
      tag: cls.tag,
      status: cls.status,
      statusNote: cls.statusNote,
      flipped: isFlip,
      flippedTag: isFlip ? cls.tag : null,
      time: fmtTimeShort(closeMs),
      timeMs: closeMs,
    };
    // Closed today -> still current, stays in the live Results feed.
    // Closed on an earlier day -> aged out, moves to History (not lost).
    return { type: closedToday(closeMs) ? "results" : "history", lastTime, row };
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
        flipped: false,
        flippedTag: null,
        time: fmtTimeShort(lastTime),
        timeMs: lastTime,
      },
    };
  }

  // cls.status === "open": never reached P4 and never closed. Which
  // bucket depends on the engine's LIVE stage (state-first guard):
  //   stage 1-2 -> Upcoming (candidate / armed, nothing formed enough yet)
  //   stage 3   -> Results, status "forming" (P3 formed — moved out of
  //                Upcoming per the redesign, no tag until P4 fires)
  if (stageSlice && stageSlice.stage >= 1 && stageSlice.stage <= 3) {
    // Displayed time must be the current stage's own point (P1/P2/P3),
    // not the side's last-logged event — see stagePointTime() above.
    // `lastTime` (last event, whatever it was) stays the fallback only
    // for the rare case the stage tag itself isn't in the log.
    const stageTime = stagePointTime(side, cycle, stageSlice.stage) ?? lastTime;

    if (stageSlice.stage === 3) {
      return {
        type: "results",
        lastTime,
        row: {
          side, points, done,
          tag: null,
          status: "forming",
          statusNote: "P3 formed \u2014 watching for P4",
          flipped: false,
          flippedTag: null,
          time: fmtTimeShort(stageTime),
          timeMs: stageTime,
        },
      };
    }

    return {
      type: "upcoming",
      lastTime,
      row: {
        side,
        stage: stageSlice.stage,
        stageText: stageLabel(stageSlice.stage),
        flip: !!stageSlice.caution,
        flipName: stageSlice.caution ? SIDE_DEF[side].cautionFlipLabel : null,
        time: fmtTimeShort(stageTime),
        timeMs: stageTime,
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

// ─── Public entry points (unchanged signatures + one addition) ────────
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

// New: a stale (earlier-day) confirmed/cancelled/flipped close — the
// History tab's row shape. Mirrors shapeT5Row/shapeT5Upcoming exactly.
function shapeT5History(scanResult) {
  if (!scanResult) return null;
  const outcome = pickSymbolOutcome(scanResult);
  if (!outcome || outcome.type !== "history") return null;
  return { symbol: scanResult.symbol, ...outcome.row };
}

// scanResults = array of scan() outputs, one per symbol
function buildScannerRows(scanResults) {
  const results = [];
  const upcoming = [];
  const history = [];
  for (const r of scanResults || []) {
    if (!r || r.error || !r.events) continue;
    const outcome = pickSymbolOutcome(r);
    if (!outcome) continue;
    if (outcome.type === "results") results.push({ symbol: r.symbol, ...outcome.row });
    else if (outcome.type === "upcoming") upcoming.push({ symbol: r.symbol, ...outcome.row });
    else if (outcome.type === "history") history.push({ symbol: r.symbol, ...outcome.row });
  }
  results.sort((a, b) => b.timeMs - a.timeMs);
  upcoming.sort((a, b) => b.timeMs - a.timeMs);
  history.sort((a, b) => b.timeMs - a.timeMs);
  return { results, upcoming, history };
}

// Exported for ScannerPage.js / T5ScannerPanel.js
export {
  shapeT5Row, shapeT5Upcoming, shapeT5History, buildScannerRows,
  stageLabel, fmtTime, fmtTimeShort,
};