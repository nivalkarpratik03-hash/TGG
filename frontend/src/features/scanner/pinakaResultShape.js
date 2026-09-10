// pinakaResultShape.js
// ─────────────────────────────────────────────────────────────────
// Reshapes the raw ScanResult[] backend/src/strategies/pinaka.js returns
// (see that file's header for the exact shape: { symbol, found,
// patternStage, side, tag, signals[], lastCandle, candleCount, scannedAt,
// error }) into what PinakaScannerPanel.js renders. Same
// no-pattern-logic-here rule as ceilingBreakResultShape.js /
// absorptionResultShape.js — this file only flattens/sorts, it never
// re-derives a signal.
//
// USAGE:
//   const rows = buildPinakaRows(results);
//   // rows.results  -> one row per symbol with a most-recent TRADE
//   //                   signal (A1/A2/B/B2), newest first
//   // rows.counts   -> { a1, a2, b, b2 } counts across rows.results
// ─────────────────────────────────────────────────────────────────

export function buildPinakaRows(results = []) {
  const rows = [];
  const counts = { a1: 0, a2: 0, b: 0, b2: 0 };

  for (const r of results || []) {
    if (!r || r.error || !r.found || !r.tag) continue;

    const lastSignal =
      (r.signals || []).slice().reverse().find((s) => s.type === r.tag) || null;

    rows.push({
      symbol: r.symbol,
      tag: r.tag,
      side: r.side,
      time: lastSignal?.time || r.lastCandle?.time || null,
      close: lastSignal?.close ?? r.lastCandle?.close ?? null,
      detail: lastSignal?.detail || null,
      signalCount: (r.signals || []).filter(
        (s) => s.type === "A1" || s.type === "A2" || s.type === "B" || s.type === "B2"
      ).length,
      scannedAt: r.scannedAt,
    });

    const key = r.tag.toLowerCase();
    if (counts[key] !== undefined) counts[key] += 1;
  }

  rows.sort((a, b) => (b.time || 0) - (a.time || 0));

  return { results: rows, counts };
}