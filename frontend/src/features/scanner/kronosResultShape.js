// kronosResultShape.js
// ─────────────────────────────────────────────────────────────────
// Reshapes raw kronosDirection.js scan() results — one flat forecast
// object per symbol { symbol, found, patternStage, confidence,
// direction, predictedClose, currentClose, horizon, resolution, error,
// scannedAt } — into what KronosScannerPanel.js renders.
//
//   const { results, upcoming, history, counts } = buildKronosRows(rawResults);
//
//   results  -> one row per symbol with a usable forecast (skips rows
//               with an error, or "insufficient_data"/"error" stages —
//               those aren't a forecast to show, they're why there
//               isn't one). Sorted by confidence, highest first — the
//               most conviction forecasts surface at the top, unlike
//               the other panels' newest-first sort, since Kronos only
//               ever has ONE row per symbol (this run's forecast), not
//               a timestamped sequence of past triggers to rank by
//               recency.
//   upcoming -> always [] — Kronos has no multi-stage setup building
//               toward a trigger the way Pinaka/T5/Absorption do; a
//               forecast either exists this scan or it doesn't.
//   history  -> always [] for now — deliberately NOT built yet. Kronos's
//               scan() makes ONE forecast call for the CURRENT moment
//               per symbol; it doesn't walk past candles logging every
//               past forecast the way pattern-detector strategies do
//               (see kronosDirection.js's header for why). Revisit this
//               once real speed numbers exist for the repeated-forecast
//               approach that would be needed to backfill History
//               properly, rather than faking it here.
//   counts   -> { up, down, neutral, highConfidence } across `results`
//               — drives the panel's stat chips.
// ─────────────────────────────────────────────────────────────────

export function buildKronosRows(results = []) {
  const resultRows = [];
  const counts = { up: 0, down: 0, neutral: 0, highConfidence: 0 };

  for (const r of results || []) {
    if (!r || r.error) continue;
    if (r.patternStage === "insufficient_data" || r.patternStage === "error") continue;
    if (typeof r.confidence !== "number") continue; // no usable forecast to show

    resultRows.push({
      symbol: r.symbol,
      direction: r.direction,
      confidence: r.confidence,
      currentClose: r.currentClose,
      predictedClose: r.predictedClose,
      horizon: r.horizon,
      resolution: r.resolution,
      found: r.found,
      scannedAt: r.scannedAt,
    });

    if (r.direction === "up") counts.up += 1;
    else if (r.direction === "down") counts.down += 1;
    else counts.neutral += 1;
    if (r.found) counts.highConfidence += 1;
  }

  resultRows.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  return { results: resultRows, upcoming: [], history: [], counts };
}
