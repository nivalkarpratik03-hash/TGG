/**
 * paperTradingRouter.js
 * ─────────────────────────────────────────────────────────────────
 * REST API for the global Paper Trading system.
 * Mounted at: /api/papertrading
 *
 * GET  /api/papertrading/config              — every strategy + its Auto Entry config (enabled/SL/Target/qty)
 * PUT  /api/papertrading/config/:strategyId  — update one strategy's Auto Entry config
 * POST /api/papertrading/manual              — open a Manual Entry paper trade
 * POST /api/papertrading/close/:id           — manually close any open trade (auto or manual)
 * GET  /api/papertrading/trades              — list trades (query: source, strategyId, tradingDay, status)
 * GET  /api/papertrading/report/auto/:date   — Auto Entry EOD report for a trading day (YYYY-MM-DD)
 * GET  /api/papertrading/report/manual/:date — Manual Entry EOD report for a trading day (YYYY-MM-DD)
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");
const router = express.Router();

const paperConfig = require("../paperTrading/config");
const engine = require("../paperTrading/engine");
const reportGenerator = require("../paperTrading/reportGenerator");

// GET /api/papertrading/config
router.get("/config", async (req, res) => {
  try {
    res.json(await paperConfig.getAllConfigs());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/papertrading/config/:strategyId  body: { enabled?, slPoints?, targetPoints?, qty? }
router.put("/config/:strategyId", async (req, res) => {
  try {
    const updated = await paperConfig.updateConfig(req.params.strategyId, req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/papertrading/manual
// body: { symbol, side ('LONG'|'SHORT'), qty, slPoints?, targetPoints?, slPrice?, targetPrice? }
router.post("/manual", async (req, res) => {
  try {
    const { symbol, side, qty = 1, slPoints, targetPoints, slPrice, targetPrice } = req.body || {};
    if (!symbol || !side) return res.status(400).json({ error: "symbol and side are required" });
    if (slPrice == null && slPoints == null) return res.status(400).json({ error: "slPrice or slPoints is required" });
    if (targetPrice == null && targetPoints == null) return res.status(400).json({ error: "targetPrice or targetPoints is required" });

    const trade = await engine.openTrade({ source: "manual", symbol, side, qty, slPoints, targetPoints, slPrice, targetPrice });
    res.json(trade);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/papertrading/close/:id  — manual square-off of any open trade
router.post("/close/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const exitPrice = req.body && req.body.exitPrice != null
      ? Number(req.body.exitPrice)
      : null;

    let price = exitPrice;
    if (price == null) {
      const target = (await engine.listTrades({})).find((t) => t.id === id);
      if (!target) return res.status(404).json({ error: `Trade #${id} not found` });
      const db = require("../../../database/src");
      const latest = await db.getLatestCandle(target.symbol, 1);
      if (!latest) return res.status(400).json({ error: `No price data available for ${target.symbol} to close at market` });
      price = latest.close;
    }

    const closed = await engine.closeTrade(id, { exitPrice: price, exitReason: "MANUAL_CLOSE" });
    res.json(closed);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/papertrading/trades?source=&strategyId=&tradingDay=&status=
router.get("/trades", async (req, res) => {
  try {
    const { source, strategyId, tradingDay, status } = req.query;
    res.json(await engine.listTrades({ source, strategyId, tradingDay, status }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/papertrading/report/auto/:date
router.get("/report/auto/:date", async (req, res) => {
  try {
    res.json(await reportGenerator.buildAutoReport(req.params.date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/papertrading/report/manual/:date
router.get("/report/manual/:date", async (req, res) => {
  try {
    res.json(await reportGenerator.buildManualReport(req.params.date));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;