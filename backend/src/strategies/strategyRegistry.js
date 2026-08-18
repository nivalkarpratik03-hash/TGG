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

  // ── "Type" strategies (combined + R/E/F) ────────────────────────
  // All 4 live together in one file, typeREF.js, which exports an array
  // of 4 strategy objects — spread it in here. `variant: "combined"`
  // (type-ref) shows up in the Scanner UI's Strategy dropdown as a single
  // flat "Type E,R,F" entry; `variant: "single"` (type-e/type-r/type-f)
  // is excluded from the dropdown and only reachable via the Type E/R/F
  // tab buttons next to Results/Upcoming (frontend wiring not included
  // here — backend only, see typeREF.js header).
  ...require("./typeREF"),

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