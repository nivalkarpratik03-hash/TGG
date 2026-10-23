/**
 * backend/src/paperTrading/autoEntryListener.js
 * ─────────────────────────────────────────────────────────────────
 * Auto Entry — wires the scanner's EXISTING "signal_found" event
 * (scannerRunner.js already emits this for every strategy, unchanged)
 * into the shared paper trading engine. No scanner code is modified —
 * this just subscribes, the same way scheduler.js already relays
 * "signal_found" to Socket.IO.
 *
 * On every signal_found event:
 *   1. Look up that strategy's paper config (config.js).
 *   2. If disabled → ignore.
 *   3. If a trade is already OPEN for this exact strategy+symbol →
 *      ignore (no pyramiding/duplicate entries on repeated scan hits
 *      for the same still-active signal).
 *   4. Otherwise open a LONG paper trade via engine.openTrade() using
 *      that strategy's fixed SL/Target points.
 *
 * Direction: every strategy in this registry currently signals bullish
 * setups (HIGHER_LOW / breakout / absorption-flip-up entries — see each
 * strategy's own header), so auto-entries open LONG. If a strategy later
 * adds a short-side signal, extend result.patternStage / a `side` field
 * on the ScanResult and branch here — no engine change needed either way.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { scanner } = require("../services/scannerRunner");
const paperConfig = require("./config");
const engine = require("./engine");

let wired = false;

function wireAutoEntry() {
  if (wired) return; // idempotent — safe if server.js restarts wiring
  wired = true;

  scanner.on("signal_found", async (result) => {
    try {
      const { strategyId, strategyName, symbol } = result;
      if (!strategyId || !symbol) return;

      const cfg = await paperConfig.getConfig(strategyId);
      if (!cfg || !cfg.enabled) return;

      const alreadyOpen = await engine.listTrades({ source: "auto", strategyId, status: "OPEN" });
      if (alreadyOpen.some((t) => t.symbol === symbol)) return;

      await engine.openTrade({
        source: "auto",
        strategyId,
        strategyName,
        symbol,
        side: "LONG",
        qty: cfg.qty,
        slPoints: cfg.slPoints,
        targetPoints: cfg.targetPoints,
      });
    } catch (err) {
      console.error(`[PaperTrading] Auto-entry failed for ${result && result.symbol}:`, err.message);
    }
  });

  console.log("[PaperTrading] Auto Entry listener wired to scanner signal_found events.");
}

module.exports = { wireAutoEntry };