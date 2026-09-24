// typeResultShape.js
// ─────────────────────────────────────────────────────────────────
// Reshapes raw typeREF.js scan() results — { symbol, type, entry, exit,
// mw, mwTime, dw, dwTime, patternStage, events[] } per symbol — into the
// History list TypeScannerPanel.js renders as its History tab.
//
// Results/Upcoming for Type are unchanged and NOT built here — ScannerPage.js
// still derives those directly from `results` (one row per symbol: its
// CURRENT/latest event only, via r.patternStage). This shaper only adds
// History: one row per PAST completed event, same "every past trigger, its
// own row" convention pinakaResultShape.js already established for Pinaka's
// History tab (includes the current/latest event too, not just older ones
// — matches how Pinaka's demo/reference behaves).
//
//   const historyRows = buildTypeHistoryRows(rawResults);
//
// Each event object (typeREF.js's buildEventsWithConcurrencyRule, flattened
// at typeREF.js's scanForType()) carries: entryTime, entryPrice, exitTime,
// exitPrice, exited, type, referenceWave, fakeGrade, mwTime, dwTime — but
// NOT a per-event bull/bear direction flag. r.dw/r.mw on the raw result are
// the symbol's CURRENT wave direction only, not what it was at each
// historical event's time, so a History row intentionally does not show a
// DW column (unlike the Results/Upcoming table) — showing today's current
// direction next to an old event would misrepresent what was true then.
// ─────────────────────────────────────────────────────────────────

export function buildTypeHistoryRows(results = []) {
  const history = [];

  for (const r of results || []) {
    if (!r || r.error || !Array.isArray(r.events)) continue;

    for (const e of r.events) {
      if (!e.exited) continue; // still-open event — that's Upcoming's job, not History's
      history.push({
        symbol: r.symbol,
        type: e.type || null,
        entry: e.entryPrice ?? null,
        exit: e.exitPrice ?? null,
        entryTime: e.entryTime || null,
        exitTime: e.exitTime || null,
        timeMs: e.exitTime || e.entryTime || 0,
      });
    }
  }

  history.sort((a, b) => b.timeMs - a.timeMs);
  return history;
}
