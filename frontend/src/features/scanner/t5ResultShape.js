// t5ResultShape.js
// ─────────────────────────────────────────────────────────────────
// Turns a raw tgT5.js scan() result (flat event log + engine state)
// into the two row shapes the Scanner UI needs:
//   - a Results row  (P4/main trigger has fired — T5H4/T5L4 or later)
//   - an Upcoming row (stage 1–3, main trigger not fired yet)
//
// This file does NO pattern logic of its own — it only reads the tag
// names tgT5.js already emits (same tag strings as the Pine
// alertcondition()s / the cheat-sheets) and reshapes them. If tgT5.js's
// tags ever change, this is the only other file that needs to change.
// ─────────────────────────────────────────────────────────────────

import { formatDateTimeIST } from "../../utils/istUtils";

// The 6-point info tags tgT5.js now emits (added alongside the action tags):
//   T5H1 T5H2 T5H3 [S T5H4] T5H5 [S T5H6 | T5H6NC]
//   T5L1 T5L2 T5L3 [L T5L4] T5L5 [L T5L6 | T5L6NC]
const POINT_TAGS = {
  T5H: ["T5H1", "T5H2", "T5H3", "S T5H4", "T5H5", "S T5H6"],
  T5L: ["T5L1", "T5L2", "T5L3", "L T5L4", "L T5L6"], // P5 handled separately (T5L5 tag) below
};

// Every actionable "this disarms the structure" tag (mirrors ACTIONABLE_TAGS
// in tgT5.js, minus the two main triggers which don't disarm on their own).
const FLIP_TAGS = new Set([
  "S T5H2 FLIP", "S T5H5 FLIP", "S T5L FLIP (trap)",
  "L T5L2 FLIP", "L T5L5 FLIP", "L T5H FLIP (trap)",
]);
const CANCEL_TAGS = new Set(["✕ S T5H4 CANCELLED", "✕ L T5L4 CANCELLED"]);
const CAUTION_TAGS = new Set(["S/L CAUT T5H3 FLIP", "S/L CAUT T5L3 FLIP"]);

function fmtTime(ms) {
  if (!ms) return null;
  try { return formatDateTimeIST(ms).split(" ").pop(); } // just HH:MM:SS
  catch { return new Date(ms).toISOString().slice(11, 19); }
}

// Build the 6-slot points[] + done count for one side ("T5H" or "T5L"),
// scanning the FULL event log for the info/point tags belonging to the
// most recent (still-relevant) structure — i.e. everything after the
// last time this side's stage was 0 / the last "done" tag on this side.
function pointsTimeline(side, events) {
  const prefix = side; // "T5H" | "T5L"
  const p5Tag = side === "T5H" ? "T5H5" : "T5L5";
  const orderedTags = [`${prefix}1`, `${prefix}2`, `${prefix}3`,
    side === "T5H" ? "S T5H4" : "L T5L4", p5Tag,
    side === "T5H" ? "S T5H6" : "L T5L6"];

  // The most recent cycle starts at this side's last "{prefix}1" (point-1
  // anchor) tag — NOT at the last done/expired boundary, since that
  // boundary often IS the very event that closes the cycle we want to show
  // (e.g. an "expired" after P4 fired is still a real Results row).
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].tag === `${prefix}1`) { startIdx = i; break; }
  }
  const slice = events.slice(startIdx);

  const points = [null, null, null, null, null, null];
  let done = 0;
  orderedTags.forEach((tag, idx) => {
    const hit = [...slice].reverse().find(e => e.tag === tag || (idx === 5 && e.tag === `${prefix}6NC`));
    if (hit) { points[idx] = fmtTime(hit.time); done = Math.max(done, idx + 1); }
  });
  return { points, done, slice };
}

function stageLabel(stage) {
  const names = ["idle", "candidate (P1)", "armed (P1-2)", "dip set (P3)"];
  return names[Math.min(stage, 3)] || `stage ${stage}`;
}

// ─── Main entry point ──────────────────────────────────────────────
// scanResult = the object returned by tgT5.js's scan(symbol, candles)
function shapeT5Row(scanResult) {
  const { symbol, events, state, error } = scanResult;
  if (error || !events) return null;

  for (const side of ["T5H", "T5L"]) {
    const { points, done, slice } = pointsTimeline(side, events);
    if (done < 4) continue; // main trigger (P4) hasn't fired — this side is Upcoming, not Results

    const lastFireIdx = [...slice].reverse().findIndex(e =>
      e.tag === (side === "T5H" ? "S T5H4" : "L T5L4"));
    const afterFire = lastFireIdx === -1 ? slice : slice.slice(slice.length - lastFireIdx);

    const wasCancelled = afterFire.some(e => CANCEL_TAGS.has(e.tag)) ||
      slice.some(e => FLIP_TAGS.has(e.tag) && e.time >= slice.find(x =>
        x.tag === (side === "T5H" ? "S T5H4" : "L T5L4"))?.time);
    const wasExpired = slice.some(e => e.tag === `${side} ✕ expired`);
    const confirmTag = slice.slice().reverse().find(e =>
      e.tag === (side === "T5H" ? "S T5H6" : "L T5L6") ||
      e.tag === (side === "T5H" ? "S T5H5 FLIP" : "L T5L5 FLIP"));

    // "last" must be the most recent event that actually BELONGS to this
    // side's cycle — the raw slice also contains unrelated global events
    // (e.g. "MH / ML broken" fires independently of T5H/T5L state).
    const sideTagRe = new RegExp(`^(${side}\\d|[SL] ${side}|✕ [SL] (T5H4|T5L4) CANCELLED|${side} (✓ done|✕ expired|✓ dissolved))`);
    const relevant = slice.filter(e => sideTagRe.test(e.tag));
    const last = relevant[relevant.length - 1] || slice[slice.length - 1];

    let status = "live", statusNote = done < 5 ? "watching P5" : "watching P6";
    if (wasCancelled) { status = "cancelled"; statusNote = `${side === "T5H" ? "S T5H4" : "L T5L4"} retracted`; }
    else if (confirmTag) { status = "confirmed"; statusNote = ""; }
    else if (wasExpired) { status = "cancelled"; statusNote = "expired — P5/P6 never resolved"; }

    return {
      symbol,
      side,
      points,
      done,
      tag: last?.tag || (side === "T5H" ? "S T5H4" : "L T5L4"),
      status,
      statusNote,
      time: fmtTime(last?.time),
      timeMs: last?.time || 0,
    };
  }
  return null; // no side has reached P4 yet — belongs in Upcoming, not Results
}

function shapeT5Upcoming(scanResult) {
  const { symbol, events, state, error } = scanResult;
  if (error || !events || !state) return null;

  // Prefer whichever side currently has the higher live stage (1-3).
  const sides = [
    { side: "T5H", stage: state.t5h.stage, caution: state.t5h.caution },
    { side: "T5L", stage: state.t5l.stage, caution: state.t5l.caution },
  ].filter(s => s.stage >= 1 && s.stage <= 3);
  if (sides.length === 0) return null;
  sides.sort((a, b) => b.stage - a.stage);
  const pick = sides[0];

  const last = events[events.length - 1];
  return {
    symbol,
    side: pick.side,
    stage: pick.stage,
    stageText: stageLabel(pick.stage),
    flip: pick.caution,
    flipName: pick.caution
      ? (pick.side === "T5H" ? "S/L CAUT T5H3 FLIP watch" : "S/L CAUT T5L3 FLIP watch")
      : null,
    time: fmtTime(last?.time),
    timeMs: last?.time || 0,
  };
}

// scanResults = array of scan() outputs, one per symbol
function buildScannerRows(scanResults) {
  const results = [];
  const upcoming = [];
  for (const r of scanResults) {
    const row = shapeT5Row(r);
    if (row) { results.push(row); continue; }
    const up = shapeT5Upcoming(r);
    if (up) upcoming.push(up);
  }
  results.sort((a, b) => b.timeMs - a.timeMs);
  upcoming.sort((a, b) => b.timeMs - a.timeMs);
  return { results, upcoming };
}

// Exported for ScannerPage.js / T5ScannerPanel.js
export { shapeT5Row, shapeT5Upcoming, buildScannerRows, stageLabel, fmtTime };
