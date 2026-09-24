// pinakaResultShape.js
// ─────────────────────────────────────────────────────────────────
// Reshapes raw pinaka.js scan() results — { symbol, found, tag, side,
// signals[], upcoming[], lastCandle, error } per symbol — into the
// three lists PinakaScannerPanel.js renders as its Results / Upcoming
// / History tabs, same split as ceilingBreakResultShape.js uses for
// CeilingBreakScannerPanel.
//
//   const { results, upcoming, history, counts } = buildPinakaRows(rawResults);
//
//   results  -> one row per symbol: its MOST RECENT A1/A2/B/B2 trigger
//               (unchanged from before — this is what the panel showed
//               when it only had one tab).
//   upcoming -> one row per symbol PER in-progress setup (a symbol can
//               have more than one building at once, e.g. an A2 stage
//               and a B2 arm at the same time) — straight from
//               pinaka.js's computeUpcoming(), nothing recomputed here.
//   history  -> one row per PAST A1/A2/B/B2 trigger (every entry in
//               r.signals, not just the latest) — this is what used to
//               be collapsed into the Results row's `signalCount`
//               number; now each of those triggers is its own row with
//               its own timestamp.
//   counts   -> { a1, a2, b, b2 } across `results` only (unchanged —
//               these still drive the top stat chips).
//
// All three lists are sorted newest-first (results/history by `time`,
// upcoming by `since`).
// ─────────────────────────────────────────────────────────────────

const TRADE_TYPES = new Set(["A1", "A2", "B", "B2"]);

export function buildPinakaRows(results = []) {
  const resultRows = [];
  const historyRows = [];
  const upcomingRows = [];
  const counts = { a1: 0, a2: 0, b: 0, b2: 0 };

  for (const r of results || []) {
    if (!r || r.error) continue;

    // ---- Results: latest trade signal per symbol ----
    if (r.found && r.tag) {
      const lastSignal =
        (r.signals || []).slice().reverse().find((s) => s.type === r.tag) || null;

      resultRows.push({
        symbol: r.symbol,
        tag: r.tag,
        side: r.side,
        time: lastSignal?.time || r.lastCandle?.time || null,
        close: lastSignal?.close ?? r.lastCandle?.close ?? null,
        detail: lastSignal?.detail || null,
        signalCount: (r.signals || []).filter((s) => TRADE_TYPES.has(s.type)).length,
        scannedAt: r.scannedAt,
      });

      const key = r.tag.toLowerCase();
      if (counts[key] !== undefined) counts[key] += 1;
    }

    // ---- History: every past A1/A2/B/B2 trigger, its own row ----
    for (const s of r.signals || []) {
      if (!TRADE_TYPES.has(s.type)) continue; // skip reference-only A1x/A2x
      historyRows.push({
        symbol: r.symbol,
        tag: s.type,
        side: s.side,
        close: s.close,
        time: s.time,
      });
    }

    // ---- Upcoming: setups currently building, not fired yet ----
    for (const u of r.upcoming || []) {
      upcomingRows.push({
        symbol: r.symbol,
        tag: u.tag,
        side: u.side,
        stage: u.stage,
        waiting: u.waiting,
        since: u.since,
      });
    }
  }

  resultRows.sort((a, b) => (b.time || 0) - (a.time || 0));
  historyRows.sort((a, b) => (b.time || 0) - (a.time || 0));
  upcomingRows.sort((a, b) => (b.since || 0) - (a.since || 0));

  return { results: resultRows, upcoming: upcomingRows, history: historyRows, counts };
}