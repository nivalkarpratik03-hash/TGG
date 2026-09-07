/**
 * analyticsRouter.js
 * ─────────────────────────────────────────────────────────────────
 * REST API for Strategy Analytics (Analytics-project-plan.md).
 * Mounted at: /api/analytics
 *
 * GET /api/analytics/strategies   — which strategies are wired for analytics yet
 * GET /api/analytics/run          — run (or serve cached) analytics for a strategy
 * ─────────────────────────────────────────────────────────────────
 *
 * NOTE ON TESTING: this file's HTTP layer cannot be exercised end-to-end in
 * a sandbox without live Fyers credentials and network access — same
 * documented limitation GapFill-checkpoint-redesign.md already hit for its
 * own DB-backed integration test. What IS tested (sanity_runAnalytics.js)
 * is everything this file delegates to: the real strategy code, the real
 * adapter, the real simulator/aggregator/cache. This file itself is
 * syntax-checked and structurally reviewed, not live-request-tested.
 */

"use strict";

const express = require("express");
const router = express.Router();

const strategies = require("../strategies/strategyRegistry");
const { runAnalytics } = require("../analytics/runAnalytics");
const { wiredStrategyIds } = require("../analytics/triggerAdapters");
const { resolveInstrumentSymbols } = require("../services/instrumentTypeResolver");
const cache = require("../analytics/cache");
const { toBuffer } = require("../analytics/etlExport");
// Same shared DB-first-then-Fyers-fallback + throttled batching Scanner
// uses — see candleFetch.js. This replaces the earlier version of this
// file, which called Fyers directly per symbol with no DB check and no
// throttle, causing the real rate-limit storm seen in production logs.
const { fetchCandlesBatched } = require("../services/candleFetch");
// Reusing the SAME closed-candle guard already proven in the forming-candle
// fix (see absorptionFlip.js) rather than re-deriving it here. Historical
// analytics needs this exactly as much as live scanning does — a still-
// forming last candle would corrupt a trigger/entry the same way either way.
const { isLastCandleForming } = require("../strategies/absorptionFlip");

// GET /api/analytics/strategies
// Tells the frontend which strategies actually have a verified adapter
// (triggerAdapters.js) — so the Strategy dropdown can show all 4 (matches
// strategyRegistry.js) but grey out/flag the ones not analyzable yet,
// instead of letting a person pick one and silently get nothing.
router.get("/strategies", (req, res) => {
  const wired = new Set(wiredStrategyIds());
  res.json(
    strategies.map((s) => ({
      id: s.id,
      name: s.name,
      analyticsWired: wired.has(s.id),
    }))
  );
});

// GET /api/analytics/run
// Query params (all optional except strategyId):
//   strategyId    — required, must match a strategyRegistry.js id
//   assetClass    — "equity" | "index" | "commodity" (default: "index")
//   instrumentType— "spot" | "futures" (default: "spot") — see
//                   instrumentTypeResolver.js's own valid-combination rules
//   resolution    — candle resolution in minutes (default: 5)
//   params        — JSON string, strategy-specific params (passed straight
//                   into the cache key, not yet interpreted by any
//                   strategy's scan() — see Analytics-project-plan.md
//                   Section 6 open question on where these get consumed)
router.get("/run", async (req, res) => {
  try {
    const { strategyId } = req.query;
    if (!strategyId) {
      return res.status(400).json({ error: "missing_strategyId" });
    }

    const strategy = strategies.find((s) => s.id === strategyId);
    if (!strategy) {
      return res.status(400).json({ error: "unknown_strategy", strategyId });
    }

    const assetClass = req.query.assetClass || "index";
    const instrumentType = req.query.instrumentType || "spot";
    const resolution = Number(req.query.resolution) || 5;
    const params = req.query.params ? JSON.parse(req.query.params) : {};
    const filters = { assetClass, instrumentType, resolution };

    // Reuses the SAME symbol-resolution logic scannerRunner.js's own
    // instrument-type filtering is built on — not a separate symbol list
    // invented for Analytics.
    const symbols = await resolveInstrumentSymbols(assetClass, instrumentType);

    // Same DB-first-then-Fyers-fallback + CONCURRENCY/BATCH_DELAY_MS
    // throttle Scanner uses (candleFetch.js) — no longer a direct
    // per-symbol Fyers loop. A symbol that genuinely fails (DB empty AND
    // Fyers error) is isolated in `fetchErrors`, not thrown — the run
    // still completes with whatever symbols succeeded.
    const { candlesBySymbol: rawCandlesBySymbol, errors: fetchErrors } =
      await fetchCandlesBatched(symbols, resolution, { logPrefix: "[Analytics]" });

    // Bug caught reviewing an earlier draft: candle data (whether from DB
    // or Fyers) can end with a still-forming last candle exactly like the
    // live scanner path can (see absorptionFlip.js's isLastCandleForming
    // doc comment) — a historical run must never let that unclosed candle
    // become a trigger or an entry bar either.
    const candlesBySymbol = {};
    for (const [symbol, raw] of Object.entries(rawCandlesBySymbol)) {
      candlesBySymbol[symbol] = raw && raw.length && isLastCandleForming(raw) ? raw.slice(0, -1) : raw;
    }

    const result = runAnalytics({ strategy, candlesBySymbol, params, filters });
    if (Object.keys(fetchErrors).length > 0) {
      result.fetchErrors = fetchErrors; // surfaced, not hidden — some symbols may be missing from the run
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "analytics_run_failed", message: e.message });
  }
});

// GET /api/analytics/export
// Same query params as /run — must match exactly (same strategyId/params/
// filters) since this reads from the SAME cache key /run would have
// written to. Does NOT trigger a fresh run itself (Analytics-project-plan.md
// Section 7 Q4 — resolved as "re-run first" for now): if nothing's cached
// under that key yet, this returns 409 rather than silently computing a
// fresh run the person didn't ask this endpoint to do.
router.get("/export", (req, res) => {
  try {
    const { strategyId } = req.query;
    if (!strategyId) {
      return res.status(400).json({ error: "missing_strategyId" });
    }
    const assetClass = req.query.assetClass || "index";
    const instrumentType = req.query.instrumentType || "spot";
    const resolution = Number(req.query.resolution) || 5;
    const params = req.query.params ? JSON.parse(req.query.params) : {};
    const filters = { assetClass, instrumentType, resolution };

    const key = cache.buildCacheKey(strategyId, params, filters);
    const cached = cache.get(key);
    if (!cached) {
      return res.status(409).json({
        error: "no_cached_result",
        message: "Nothing cached for this exact strategy/params/filters combo yet — run GET /api/analytics/run first.",
      });
    }

    const buffer = toBuffer(cached);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${strategyId}.xlsx"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: "analytics_export_failed", message: e.message });
  }
});

// GET /api/analytics/cached
// Read-only — same role as Scanner's GET /results/:strategyId (see
// ScannerPage.js's fetchResults/comboScannedAt): NEVER triggers a compute.
// If this exact strategy/params/filters combo has already been run by ANY
// client (shared in-memory cache.js, same sharing mechanism as Scanner's
// _results Map — one backend process, one Map, every client sees the
// same thing), returns it instantly. If not, returns { cached: false } —
// the frontend then knows an explicit GET /run is needed (that's what
// "Apply / Run analysis" does, same role as Scanner's "Scan Now").
router.get("/cached", (req, res) => {
  try {
    const { strategyId } = req.query;
    if (!strategyId) {
      return res.status(400).json({ error: "missing_strategyId" });
    }
    const assetClass = req.query.assetClass || "index";
    const instrumentType = req.query.instrumentType || "spot";
    const resolution = Number(req.query.resolution) || 5;
    const params = req.query.params ? JSON.parse(req.query.params) : {};
    const filters = { assetClass, instrumentType, resolution };

    const key = cache.buildCacheKey(strategyId, params, filters);
    const cached = cache.get(key);
    if (!cached) {
      return res.json({ cached: false });
    }
    res.json({ cached: true, ...cached, fromCache: true });
  } catch (e) {
    res.status(500).json({ error: "analytics_cached_check_failed", message: e.message });
  }
});

module.exports = router;