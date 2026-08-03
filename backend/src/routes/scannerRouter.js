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
 * GET  /api/scanner/results/:strategyId        — all results for one strategy (paginated)
 * GET  /api/scanner/result/:strategyId/:symbol — single symbol result
 * POST /api/scanner/trigger                    — run scan now (body: { resolution?, assetClass? })
 * POST /api/scanner/stop                       — abort running scan
 * GET  /api/scanner/symbols                    — current symbol list
 * POST /api/scanner/symbols                    — replace symbol list
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");
const router = express.Router();
const { scanner } = require("../services/scannerRunner");
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

// GET /api/scanner/results/:strategyId  — paginated full result list
router.get("/results/:strategyId", (req, res) => {
  const { strategyId } = req.params;
  const page = Math.max(1, parseInt(req.query.page || "1"));
  const perPage = Math.min(200, Math.max(1, parseInt(req.query.per_page || "100")));
  const stage = req.query.stage || null;
  const found = req.query.found;

  let all = scanner.getResultsByStrategy(strategyId);
  if (!all) return res.status(404).json({ error: `Unknown strategy: ${strategyId}` });
  if (stage) all = all.filter((r) => r.patternStage === stage);
  if (found === "true") all = all.filter((r) => r.found);

  const total = all.length;
  const slice = all.slice((page - 1) * perPage, page * perPage);
  res.json({ strategyId, total, page, perPage, results: slice });
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

    const out = await scanner.triggerNow(resolution, scopedSymbols);
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