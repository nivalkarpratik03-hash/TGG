/**
 * strategies/kronosDirection.js
 * ─────────────────────────────────────────────────────────────────
 * Kronos — AI-forecasted direction + confidence, via the standalone
 * Kronos FastAPI service (kronos-service/app.py, Chunk 2). This is the
 * ONLY strategy in this registry that makes a network call — every other
 * one is pure synchronous pattern-matching over already-fetched candles.
 * That's why scannerRunner.js's _runOneStrategy() had to become async
 * (2026-09-26) before this could be added — see that file's own comment
 * for the full reasoning.
 *
 * PLACEMENT: standalone strategy tile only (Option A) — deliberately NOT
 * wired as a filter into any existing strategy's logic (Option B). Final
 * decision, not a placeholder — existing strategies stay untouched.
 *
 * MODE: research/backtest only for now, not a live trading signal —
 * Kronos is zero-shot (trained on 45 global exchanges' general candle
 * patterns, never fine-tuned on this account's specific instruments), so
 * its real accuracy here is unproven until validated over time. Revisit
 * this decision once there's enough history in this strategy's owns
 * History tab to judge it by.
 *
 * ScanResult shape returned: the required minimum (symbol, found,
 * patternStage, error, scannedAt) PLUS extra fields (confidence,
 * direction, predictedClose, currentClose, horizon, resolution) — same
 * "keep the required contract, add extra fields alongside it" pattern
 * every other strategy already uses for its own extras (Pinaka's tag/
 * side/signalCount, etc.) — see strategyRegistry.js's header.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const axios = require("axios");

// ── Tunable knobs — change these, not the logic below ──────────────────
// All three were explicit decisions made while planning this feature,
// kept as named constants specifically so they're easy to find and
// change in minutes if sir wants different numbers later, without
// touching any logic.
const KRONOS_HORIZON = 16;          // bars ahead to forecast — ~4hrs at 15min
const KRONOS_SAMPLE_COUNT = 20;     // independent forecast runs for the confidence calc
const KRONOS_CONFIDENCE_THRESHOLD = 65; // % — below this, found stays false even if directional

// Configurable via .env so moving kronos-service to cloud hosting later
// is a one-line env change, not a code change (see Chunk 2/3 planning —
// cloud hosting is a known separate next step, not done yet).
const KRONOS_SERVICE_URL = process.env.KRONOS_SERVICE_URL || "http://localhost:8001";
// MEASURED, not guessed (test_forecast.py on the real machine, CPU only,
// 100 candles, 20 samples): ~50.8s PER SYMBOL, roughly 2.5s per sample.
// Real scanner calls send up to 512 candles (slower than the 100 tested)
// and the scanner can have several symbols in flight at once, all
// competing for the same CPU — so the old 60s budget would have timed
// out. 5 minutes is a safety ceiling, not an expectation. The real fix
// for speed is fewer samples, batching, or a GPU host (cloud step).
const KRONOS_TIMEOUT_MS = 300_000;

const MAX_CONTEXT = 512; // Kronos-small's hard cap — mirrored client-side
                          // too so this doesn't send an oversized payload
                          // over the wire, even though app.py also
                          // truncates server-side as a second safety net

// Candle-interval (ms) -> the resolution label app.py's Pydantic model
// requires (Literal["1min","3min","5min","15min","1hr","1day"]).
// Inferred from the candles' OWN timestamps rather than trusted from an
// external resolution parameter — context (scannerRunner.js's per-symbol
// context object) doesn't carry resolution today, and inferring directly
// from actual candle spacing is more robust anyway: it can never disagree
// with the data it's about to send.
const RESOLUTION_BY_MINUTES = [
  [1, "1min"], [3, "3min"], [5, "5min"], [15, "15min"], [60, "1hr"], [1440, "1day"],
];

function inferResolutionLabel(candles) {
  if (candles.length < 2) return null;
  // Median of the last few gaps, not just the very last one — one stale/
  // duplicate candle at the end shouldn't misclassify the whole series.
  const gaps = [];
  for (let i = Math.max(1, candles.length - 6); i < candles.length; i++) {
    gaps.push(candles[i].time - candles[i - 1].time);
  }
  gaps.sort((a, b) => a - b);
  const medianMs = gaps[Math.floor(gaps.length / 2)];
  const medianMinutes = Math.round(medianMs / 60000);
  let closest = RESOLUTION_BY_MINUTES[0];
  let closestDiff = Infinity;
  for (const entry of RESOLUTION_BY_MINUTES) {
    const diff = Math.abs(entry[0] - medianMinutes);
    if (diff < closestDiff) { closestDiff = diff; closest = entry; }
  }
  return closest[1];
}

async function scan(symbol, candles /*, context */) {
  const scannedAt = new Date().toISOString();

  if (!candles || candles.length < 30) {
    // Same floor app.py itself enforces (see app.py's own comment) —
    // checked here too so an obviously-too-small request never even
    // makes the network round trip.
    return {
      symbol, found: false, patternStage: "insufficient_data",
      error: null, scannedAt,
    };
  }

  const resolution = inferResolutionLabel(candles);
  if (!resolution) {
    return {
      symbol, found: false, patternStage: "error",
      error: "Could not infer a valid resolution from candle timestamps.", scannedAt,
    };
  }

  const trimmed = candles.slice(-MAX_CONTEXT);
  const currentClose = trimmed[trimmed.length - 1].close;

  try {
    const { data } = await axios.post(`${KRONOS_SERVICE_URL}/forecast`, {
      candles: trimmed.map((c) => ({
        time: c.time, open: c.open, high: c.high, low: c.low,
        close: c.close, volume: c.volume || 0,
      })),
      resolution,
      horizon: KRONOS_HORIZON,
      sample_count: KRONOS_SAMPLE_COUNT,
    }, { timeout: KRONOS_TIMEOUT_MS });

    // found = true only when BOTH confident AND directional — a
    // "neutral" result (see app.py's documented up/down-tie edge case)
    // never counts as found, regardless of its confidence number, since
    // "neutral" isn't a tradeable direction.
    const found = data.direction !== "neutral" && data.confidence >= KRONOS_CONFIDENCE_THRESHOLD;

    return {
      symbol,
      found,
      patternStage: data.direction, // "up" | "down" | "neutral" — a string, per the required contract
      error: null,
      scannedAt,
      // Extra fields, alongside the required ones — same pattern every
      // other strategy already uses for its own extras.
      confidence: data.confidence,
      direction: data.direction,
      predictedClose: data.predictedClose,
      currentClose: data.currentClose,
      horizon: data.horizon,
      resolution: data.resolution,
    };
  } catch (err) {
    // Self-caught, not thrown — matches every other strategy's own
    // convention (see absorptionFlip.js's scan(), for example): a
    // strategy failure becomes a result with error populated, not an
    // exception for scannerRunner.js's outer catch to handle.
    const message = err.response
      ? `Kronos service returned ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.code === "ECONNREFUSED"
        ? `Kronos service unreachable at ${KRONOS_SERVICE_URL} — is uvicorn running?`
        : err.message;
    return {
      symbol, found: false, patternStage: "error",
      error: message, scannedAt,
    };
  }
}

module.exports = {
  id: "kronos",
  name: "Kronos",
  description: "AI-forecasted direction + confidence via the Kronos foundation model (research/backtest mode — zero-shot, not yet validated as a live signal on this account's instruments).",
  scan,
};
