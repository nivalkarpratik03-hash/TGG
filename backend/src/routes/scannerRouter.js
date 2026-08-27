/**
 * scannerRouter.js
 * ─────────────────────────────────────────────────────────────────
 * REST API for the multi-strategy scanner.
 * Mounted at: /api/scanner
 *
 * GET  /api/scanner/status                     — runner state + strategy list
 * GET  /api/scanner/strategies                 — all registered strategies
 * GET  /api/scanner/signals                    — signals across ALL strategies
 * GET  /api/scanner/signals/:strategyId        — signals for one strategy
 * GET  /api/scanner/results/:strategyId        — results for one strategy, scoped to a
 *                                                  filter combo (paginated) — see query
 *                                                  params on the route below
 * GET  /api/scanner/result/:strategyId/:symbol — single symbol result
 * POST /api/scanner/trigger                    — run scan now (body: { resolution?, assetClass?, instrumentType?, strategyId? })
 * POST /api/scanner/stop                       — abort running scan
 * GET  /api/scanner/symbols                    — current symbol list
 * POST /api/scanner/symbols                    — replace symbol list
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");
const router = express.Router();
const { scanner, buildComboKey } = require("../services/scannerRunner");
const symbolsRouter = require("./symbolsRouter");
const instrumentTypeResolver = require("../services/instrumentTypeResolver");

// Maps the Scanner UI's category dropdown value to the `type` field
// getSymbols() already tags every symbol with. "commodity" intentionally
// maps to type "commodity" (the near-month tradable contract), not
// "future" — see symbolsRouter.js buildFutures()'s own comment on why
// that distinction exists. "all"/anything else → no filter, full list.
const ASSET_CLASS_TO_TYPE = {
  index: "index",
  equity: "equity",
  commodity: "commodity",
};

// GET /api/scanner/status
router.get("/status", (req, res) => {
  res.json(scanner.getStatus());
});

// GET /api/scanner/strategies
router.get("/strategies", (req, res) => {
  res.json(scanner.getStrategies());
});

// GET /api/scanner/signals  — all strategies, compact
router.get("/signals", (req, res) => {
  const summaryAll = scanner.getSummaryAll();
  const out = {};
  let totalFull = 0, totalPartial = 0;
  for (const [id, s] of Object.entries(summaryAll)) {
    out[id] = { full: s.full, partial: s.partial, counts: { full: s.full.length, partial: s.partial.length, errors: s.errors.length } };
    totalFull += s.full.length;
    totalPartial += s.partial.length;
  }
  res.json({ strategies: out, totals: { full: totalFull, partial: totalPartial }, scannedAt: scanner.getStatus().lastScanAt });
});

// GET /api/scanner/signals/:strategyId  — one strategy
router.get("/signals/:strategyId", (req, res) => {
  const { strategyId } = req.params;
  const summary = scanner.getSummary(strategyId);
  if (!summary) return res.status(404).json({ error: `Unknown strategy: ${strategyId}` });
  res.json({
    strategyId,
    full: summary.full,
    partial: summary.partial,
    counts: { full: summary.full.length, partial: summary.partial.length, errors: summary.errors.length },
    scannedAt: scanner.getStatus().lastScanAt,
  });
});

// GET /api/scanner/results/:strategyId  — paginated result list, scoped to
// one filter combo.
//
// Query params:
//   assetClass, instrumentType, resolution  — NEW (2026-08-18). When ALL
//     THREE are provided, results are scoped to that exact combo's bucket
//     only — see buildComboKey / the scannerRunner.js file header FIX note.
//     When any is omitted (e.g. StrategiesPage.js's caller, which doesn't
//     have these filters at all), falls back to the legacy flattened view
//     merging every combo ever scanned for this strategy — unchanged
//     behavior for callers that don't know about combos.
//   page, per_page, stage, found — unchanged, applied after combo scoping.
//
// FIX (2026-08-18) — this endpoint previously had NO scope filtering at
// all: /results/:strategyId returned every symbol ever scanned for that
// strategy, regardless of which Asset Class / Instrument Type / Timeframe
// the Scanner UI had selected. Selecting "Commodity" therefore still
// showed EQ rows scanned earlier, because the backend had no per-category
// storage to filter against. Fixed by scoping the underlying
// getResultsByStrategy() call to a comboKey built from these 3 new query
// params — see scannerRunner.js.
//
// FIX (2026-08-03, still in effect) — perPage capped at 200 previously
// truncated multi-category result sets that shared one bucket; that risk
// is now moot per-combo (each combo's bucket is far smaller), but the
// higher ceiling and scannedAt-DESC sort are kept as-is since callers
// (Scanner UI's stats bar, Results/Upcoming tables) still want the full
// set for that combo and recency-first ordering.
router.get("/results/:strategyId", (req, res) => {
  const { strategyId } = req.params;
  const page = Math.max(1, parseInt(req.query.page || "1"));
  const perPage = Math.min(5000, Math.max(1, parseInt(req.query.per_page || "100")));
  const stage = req.query.stage || null;
  const found = req.query.found;

  // Combo scoping — only applied when the caller actually sent all three.
  // Partial params (e.g. just `resolution`) are treated as "not scoped"
  // rather than guessing at defaults for the missing ones, so a caller
  // either opts fully into per-combo scoping or gets the old merged view.
  const { assetClass, instrumentType, resolution } = req.query;
  const comboKey = (assetClass != null && instrumentType != null && resolution != null)
    ? buildComboKey(resolution, assetClass, instrumentType)
    : null;

  let all = scanner.getResultsByStrategy(strategyId, comboKey);
  if (all === null) return res.status(404).json({ error: `Unknown strategy: ${strategyId}` });

  // Recency first — see fix note above. Falls back to 0 for any legacy
  // result missing scannedAt so it sorts last rather than throwing.
  all = [...all].sort((a, b) => new Date(b.scannedAt || 0) - new Date(a.scannedAt || 0));

  if (stage) all = all.filter((r) => r.patternStage === stage);
  if (found === "true") all = all.filter((r) => r.found);

  const total = all.length;
  const slice = all.slice((page - 1) * perPage, page * perPage);
  res.json({
    strategyId,
    total,
    page,
    perPage,
    results: slice,
    comboKey,
    // NEW — both now scoped to this EXACT strategyId + comboKey (not just
    // comboKey alone), via scannerRunner.js's strategy-aware
    // hasScannedCombo/lastScanAtForCombo — see its own comment for why
    // strategyId must be folded in (type-ref vs type-e/type-r/type-f each
    // need their own bookkeeping even though selecting "Type E,R,F" runs
    // all 4 together).
    scanned: comboKey ? scanner.hasScannedCombo(comboKey, strategyId) : true,
    // NEW — the actual last-scanned timestamp for this exact
    // strategy+combo. Previously missing entirely; the frontend had no
    // way to show a per-combo scan time and fell back to the single
    // global status.lastScanAt, which didn't match whatever combo was
    // actually on screen. Falls back to the global timestamp when this
    // request isn't combo-scoped at all (legacy callers, e.g.
    // StrategiesPage.js).
    scannedAt: comboKey ? scanner.lastScanAtForCombo(comboKey, strategyId) : scanner.getStatus().lastScanAt,
  });
});

// GET /api/scanner/result/:strategyId/:symbol
router.get("/result/:strategyId/:symbol", (req, res) => {
  const { strategyId } = req.params;
  const symbol = decodeURIComponent(req.params.symbol);
  const result = scanner.getResult(strategyId, symbol);
  if (!result) return res.status(404).json({ error: `No result for ${strategyId}/${symbol}` });
  res.json(result);
});

// POST /api/scanner/trigger
// Body (optional): {
//   resolution: number,
//   assetClass: "all"|"index"|"equity"|"commodity",
//   instrumentType: "all"|"spot"|"fut"|"opt"   (NEW 2026-08-03)
//   strategyId: one of the registered strategy ids (NEW) — scopes this
//     scan pass to just that strategy family instead of all 7. Omitted →
//     unscoped full scan, unchanged prior behavior.
// }
// NEW 2026-08-02 — assetClass scopes the scan to one category instead of
// the full symbol list, without changing the persistent list any other
// trigger (or the next full scan) uses. "all"/omitted → unchanged
// existing full-scan behavior.
//
// NEW 2026-08-03 — instrumentType additionally scopes WHICH instrument
// type(s) within that asset class to resolve symbols for (Spot/Fut/Opt/All),
// via instrumentTypeResolver.js. BACKWARD COMPATIBLE: when instrumentType is
// omitted entirely (old callers), behavior is byte-identical to before —
// the original assetClass-only symbolsRouter.getSymbols() filter path below
// still runs, unchanged. instrumentType is only consulted when the caller
// actually sends one.
router.post("/trigger", async (req, res) => {
  try {
    const resolution = req.body?.resolution;
    const assetClass = (req.body?.assetClass || "all").toLowerCase();
    const instrumentTypeRaw = req.body?.instrumentType;

    // NEW — strategyId scopes this scan to just the selected strategy
    // family (see scannerRunner.js's resolveStrategiesToRun). Optional:
    // omitted/null → unscoped full scan across every registered strategy,
    // same as before this feature existed. When provided, validated
    // against the registry the same way assetClass/instrumentType are
    // validated below — reject unknown ids rather than silently no-op-ing.
    const strategyIdRaw = req.body?.strategyId;
    let strategyId = null;
    if (strategyIdRaw != null && strategyIdRaw !== "") {
      const knownIds = scanner.getStrategies().map((s) => s.id);
      if (!knownIds.includes(strategyIdRaw)) {
        return res.status(400).json({ error: `Unknown strategyId "${strategyIdRaw}" — expected one of: ${knownIds.join(", ")}` });
      }
      strategyId = strategyIdRaw;
    }

    let scopedSymbols;

    if (instrumentTypeRaw != null) {
      // ── New path: instrumentType explicitly provided ──────────────────
      const instrumentType = String(instrumentTypeRaw).toLowerCase();

      if (!instrumentTypeResolver.ASSET_CLASSES.includes(assetClass)) {
        return res.status(400).json({ error: `Unknown assetClass "${assetClass}" — expected one of: ${instrumentTypeResolver.ASSET_CLASSES.join(", ")}` });
      }
      if (!instrumentTypeResolver.INSTRUMENT_TYPES.includes(instrumentType)) {
        return res.status(400).json({ error: `Unknown instrumentType "${instrumentType}" — expected one of: ${instrumentTypeResolver.INSTRUMENT_TYPES.join(", ")}` });
      }
      const allowedTypes = instrumentTypeResolver.VALID_INSTRUMENT_TYPES_FOR_ASSET_CLASS[assetClass];
      if (!allowedTypes.includes(instrumentType)) {
        return res.status(400).json({ error: `Invalid combination: assetClass "${assetClass}" + instrumentType "${instrumentType}" — allowed instrumentType(s) for "${assetClass}": ${allowedTypes.join(", ")}` });
      }

      try {
        scopedSymbols = await instrumentTypeResolver.resolveInstrumentSymbols(assetClass, instrumentType);
      } catch (resolveErr) {
        return res.status(400).json({ error: resolveErr.message });
      }
      if (scopedSymbols.length === 0) {
        return res.status(400).json({ error: `No symbols resolved for assetClass "${assetClass}" + instrumentType "${instrumentType}"` });
      }
    } else if (assetClass !== "all") {
      // ── Original path: assetClass-only scoping, UNCHANGED ──────────────
      const type = ASSET_CLASS_TO_TYPE[assetClass];
      if (!type) {
        return res.status(400).json({ error: `Unknown assetClass "${assetClass}" — expected one of: all, index, equity, commodity` });
      }
      scopedSymbols = symbolsRouter.getSymbols().filter((s) => s.type === type).map((s) => s.symbol);
      if (scopedSymbols.length === 0) {
        return res.status(400).json({ error: `No symbols found for assetClass "${assetClass}"` });
      }
    }
    // assetClass === "all" && instrumentTypeRaw == null → scopedSymbols
    // stays undefined → scanner.triggerNow's original full-scan behavior,
    // byte-identical to before this feature existed.

    // instrumentType defaults to "all" for the comboKey when the caller
    // used the legacy assetClass-only path (instrumentTypeRaw == null) —
    // matches the default ASSET_TO_INSTRUMENT_TYPES value the frontend
    // would have shown for that assetClass anyway.
    const instrumentTypeForCombo = instrumentTypeRaw != null ? String(instrumentTypeRaw).toLowerCase() : "all";
    const out = await scanner.triggerNow(resolution, scopedSymbols, assetClass, instrumentTypeForCombo, strategyId);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scanner/stop
router.post("/stop", (req, res) => {
  scanner.stop();
  res.json({ status: "stop_requested", running: scanner.getStatus().running });
});

// GET /api/scanner/symbols
router.get("/symbols", (req, res) => {
  const syms = scanner.getSymbols();
  res.json({ symbols: syms, count: syms.length });
});

// POST /api/scanner/symbols
router.post("/symbols", (req, res) => {
  const { symbols } = req.body || {};
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: "body.symbols must be a non-empty array" });
  }
  scanner.setSymbols(symbols);
  res.json({ count: scanner.getSymbols().length, message: "Symbol list updated" });
});

module.exports = router;