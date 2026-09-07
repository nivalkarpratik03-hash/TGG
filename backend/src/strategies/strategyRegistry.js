/**
 * strategies/strategyRegistry.js
 * ─────────────────────────────────────────────────────────────────
 * Central list of all scanner strategies.
 *
 * TO ADD A NEW STRATEGY:
 *   1. Create  backend/src/strategies/myStrategy.js
 *   2. Export: { id, name, description, scan(symbol, candles) }
 *   3. Add require() line below — that's it.
 *
 * Every strategy must export:
 *   id          {string}  — unique key e.g. "s1s2s3"
 *   name        {string}  — display name
 *   description {string}  — one-liner shown in UI
 *   scan        {fn}      — (symbol, candles) => ScanResult
 *
 * ScanResult shape (minimum required fields):
 *   { symbol, found: bool, patternStage: string, error: string|null, scannedAt: ISO }
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const strategies = [
  require("./scannerS1.S2.S3"),

  // ── "Type" strategies (combined + R/E/F) — added Chunk 2 ────────────────
  // All 4 live together in one file, typeREF.js, which exports an array of
  // 4 strategy objects — spread it in here. `variant: "combined"` (type-ref)
  // shows up in the Scanner UI's Strategy dropdown as a single flat
  // "Type E,R,F" entry; `variant: "single"` (type-e/type-r/type-f) is
  // excluded from the dropdown and only reachable via the Type E/R/F tab
  // buttons next to Results/Upcoming (frontend wiring — Chunk 3, not yet
  // added). Depends on Chunk 1's motherwave.js (buildPerBarMwDwTimeline) —
  // do not add this line without Chunk 1 already in place.
  ...require("./typeREF"),

  // ── TG T5 — direct Pine port (Script A v16.15 BETA) ─────────────────────
  // Single self-contained file, same pattern as scannerS1.S2.S3.js /
  // typeREF.js: the full 9EMA-trend + double-top(T5H)/double-bottom(T5L)
  // point state machine (P1–P6) is ported and inlined in tgT5.js itself —
  // no separate engine/session/trend service files.
  require("./tgT5"),

  // ── 9EMA Absorption / Flip Break — direct Pine port ──────────────────────
  // Single self-contained file, same pattern as scannerS1.S2.S3.js / tgT5.js:
  // the full 9EMA-pivot S/R band engine (regime state machine, band
  // clustering/lifecycle, ABSORPTION watch-state) is ported and inlined in
  // absorptionFlip.js itself. Detects two Pine alertconditions across the
  // full candle history — "Absorbing RESISTANCE/SUPPORT broken" and
  // "TREND FLIPPED UP/DOWN" — and returns them as a symbol's events/results.
  require("./absorptionFlip"),

  // ── Ceiling Break & Retest v4 — direct Pine port ────────────────────────
  // Single self-contained file, same pattern as absorptionFlip.js / tgT5.js:
  // clusters confirmed pivot highs into a ceiling, watches a breakout, and
  // classifies the follow-through (Retest / Failed Retest / No Retest /
  // Higher Low). Bullish-continuation only — found=true only on HIGHER_LOW
  // (the source script's own "Entry Point"). Frontend indicator counterpart:
  // indicators/CeilingRetestIndicator.js (engine copy: indicators/ceilingBreakRetestEngine.js).
  require("./ceilingBreakRetest"),

  // ── Add new strategies below ──────────────────────────────────
  // require("./breakoutStrategy"),
  // require("./divergenceStrategy"),
  // require("./insideBarStrategy"),
];

// Validate all strategies have required fields at startup
for (const s of strategies) {
  if (!s.id || !s.name || typeof s.scan !== "function") {
    throw new Error(`[StrategyRegistry] Strategy missing id/name/scan: ${JSON.stringify(s)}`);
  }
}

console.log(`[StrategyRegistry] Loaded ${strategies.length} strategies: ${strategies.map(s => s.id).join(", ")}`);

module.exports = strategies;