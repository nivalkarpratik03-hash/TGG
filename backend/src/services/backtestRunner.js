/**
 * backtestRunner.js
 * ─────────────────────────────────────────────────────────────────
 * Scans all 350 symbols for candles that hit the Mother Wave
 * 0.618 (HOT) or 0.382 (NEAR) zone AFTER the MW tip, are red,
 * and close below EMA9 low.
 *
 * Zone definition (same as classifyZone in motherwave.js):
 *   tol = span * 0.05
 *   HOT  zone: fib_0.618 ± tol
 *   NEAR zone: fib_0.382 ± tol
 *
 * Candle touches zone when:
 *   candle.low  <= zoneHigh  AND
 *   candle.high >= zoneLow
 *
 * Red candle: close < open
 * EMA9 low:   close < ema9L at that bar index
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const EventEmitter = require("events");
const { fetchCandles } = require("../fyers/client");
const { detectMotherWaveForAPI } = require("./motherwave");

// ─── DB (optional) ────────────────────────────────────────────────────────────
let db = null;
let dbEnabled = false;
try {
  db = require("../../../database/src/index");
  dbEnabled = true;
} catch { /* DB optional */ }

const { deriveTimeframe } = require("./candleBuilder");

const CONCURRENCY = parseInt(process.env.SCANNER_CONCURRENCY || "3");
const BATCH_DELAY_MS = parseInt(process.env.SCANNER_BATCH_DELAY_MS || "1000");
const DEFAULT_RESOLUTION = parseInt(process.env.SCANNER_RESOLUTION || "15");
const RETRY_LIMIT = 3;

// ── EMA helper — single source of truth: backend/src/services/indicatorMath.js
const { calcEMA } = require("./indicatorMath");

// P3 #18 — shared with scannerRunner.js via ../utils/symbolValidation.js.
const { isValidSymbol } = require("../utils/symbolValidation");

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
class BacktestRunner extends EventEmitter {
  constructor() {
    super();
    this._results = [];        // all hits across all symbols
    this._chainIndex = new Map(); // mwNo → { mwNo, hitCount, stockCount, _hitSymbols }
    this._errors = new Map();
    this._retryQueue = [];
    this._running = false;
    this._aborted = false;
    this._symbolList = [];
    this._progress = { total: 0, done: 0, hits: 0 };
    this._resolution = DEFAULT_RESOLUTION;
    this._lookbackDays = null;
    this._lastRunAt = null;
    this._lastDurationMs = null;
  }

  setSymbols(symbols) {
    this._symbolList = [...new Set(symbols.filter(Boolean))].filter(isValidSymbol);
  }

  getSymbols() { return [...this._symbolList]; }

  async triggerNow(resolution, lookbackDays = null) {
    // lookbackDays is accepted for API compatibility but ignored —
    // backend always scans full 90d; date filtering is client-side.
    if (this._running) return { status: "already_running", progress: this._progress };
    if (resolution != null) this._resolution = parseInt(resolution) || DEFAULT_RESOLUTION;
    this._lookbackDays = null;
    this._aborted = false;
    this._results = [];
    await this._run();
    return { status: "triggered", symbols: this._symbolList.length, resolution: this._resolution };
  }

  stop() {
    if (this._running) { this._aborted = true; console.log("[Backtest] Stop requested."); }
  }

  getStatus() {
    return {
      running: this._running,
      symbolCount: this._symbolList.length,
      resolution: this._resolution,
      lastRunAt: this._lastRunAt,
      lastDurationMs: this._lastDurationMs,
      progress: this._progress,
    };
  }

  getResults() { return [...this._results]; }

  getChainIndex() {
    // Returns sorted array: mwNo 0 first, then -1, -2, -3 ...
    // Strip internal _hitSymbols set before sending to frontend
    return [...this._chainIndex.values()]
      .sort((a, b) => b.mwNo - a.mwNo)
      .map(({ mwNo, hitCount, stockCount }) => ({ mwNo, hitCount, stockCount }));
  }

  // ── Core loop ───────────────────────────────────────────────────────────────
  async _run() {
    if (this._running) return;
    if (!this._symbolList.length) return;

    this._running = true;
    this._aborted = false;
    this._results = [];
    this._chainIndex = new Map();
    this._errors = new Map();
    const startMs = Date.now();
    const res = this._resolution;

    const toScan = [...new Set([...this._retryQueue, ...this._symbolList])];
    this._retryQueue = [];
    this._progress = { total: toScan.length, done: 0, hits: 0 };

    console.log(`[Backtest] ${toScan.length} symbols @ res=${res}m`);
    this.emit("backtest_start", { total: toScan.length, resolution: res });

    for (let i = 0; i < toScan.length; i += CONCURRENCY) {
      if (this._aborted) { console.log(`[Backtest] Aborted after ${i} symbols.`); break; }
      const batch = toScan.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(sym => this._processSymbol(sym, false, res, this._lookbackDays)));
      this._progress.done = Math.min(i + CONCURRENCY, toScan.length);
      this.emit("backtest_progress", { ...this._progress });
      if (i + CONCURRENCY < toScan.length) await delay(BATCH_DELAY_MS);
    }

    // Retry pass
    if (!this._aborted && this._retryQueue.length > 0) {
      const retries = [...this._retryQueue];
      this._retryQueue = [];
      for (const sym of retries) {
        if (this._aborted) break;
        await this._processSymbol(sym, true, res, this._lookbackDays);
        await delay(600);
      }
    }

    const durationMs = Date.now() - startMs;
    this._lastRunAt = new Date().toISOString();
    this._lastDurationMs = durationMs;
    this._running = false;
    this._aborted = false;

    console.log(`[Backtest] Done in ${(durationMs / 1000).toFixed(1)}s — ${this._results.length} hits`);
    this.emit("backtest_complete", {
      total: toScan.length,
      hits: this._results.length,
      durationMs,
      finishedAt: this._lastRunAt,
      resolution: res,
    });
  }

  // ── Per-symbol processing ───────────────────────────────────────────────────
  async _processSymbol(symbol, isRetry = false, resolution = DEFAULT_RESOLUTION) {
    try {
      // ── DB-first: read from Postgres, fall back to Fyers if empty ─────────
      let candles = null;

      if (dbEnabled && db) {
        try {
          // Backtest needs FULL history — no date window, load everything stored.
          const oneMin = await db.loadCandles(symbol, 1, { limit: 200000 });
          if (oneMin && oneMin.length > 0) {
            candles = resolution === 1 ? oneMin : deriveTimeframe(oneMin, resolution);
            if (!candles || candles.length === 0) candles = null;
          }
        } catch (dbErr) {
          console.warn(`[Backtest] DB read failed for ${symbol}: ${dbErr.message} — trying Fyers`);
        }
      }

      if (!candles) {
        candles = await fetchCandles(symbol, resolution, 5000, 90);
      }

      if (!candles || candles.length < 10) return;

      this._errors.delete(symbol);

      const mwResult = detectMotherWaveForAPI(candles);
      if (!mwResult || !mwResult.chain || !mwResult.chain.length) return;

      // EMA9 of lows — shared across all MW checks
      const ema9L = calcEMA(candles.map(c => c.low), 9);

      // ── Sort chain: mwNo 0 first, -1 next, -2 after (most recent → oldest)
      const sortedChain = [...mwResult.chain].sort((a, b) => b.mwNo - a.mwNo);

      for (let mwIdx = 0; mwIdx < sortedChain.length; mwIdx++) {
        const mwEntry = sortedChain[mwIdx];
        const { mwNo, wave, fibLevels } = mwEntry;

        // ── Upper boundary: the NEXT more-recent MW's tip time
        // Candles after that tip belong to the newer MW, not this one
        const newerMW = mwIdx > 0 ? sortedChain[mwIdx - 1] : null;
        const upperTimeBound = newerMW ? newerMW.wave.toTime : Infinity;

        const span = wave.delta;
        const tol = span * 0.05;

        const hot618High = fibLevels["0.618"] + tol;
        const hot618Low = fibLevels["0.618"] - tol;
        const near382High = fibLevels["0.382"] + tol;
        const near382Low = fibLevels["0.382"] - tol;

        for (let idx = 0; idx < candles.length; idx++) {
          const c = candles[idx];

          // ✅ Candle must be AFTER this MW's tip
          if (c.time <= wave.toTime) continue;

          // ✅ NEW: Candle must be BEFORE the next (newer) MW's tip
          if (c.time >= upperTimeBound) continue;

          const ema = ema9L[idx];
          if (ema == null) continue;

          const isRed = c.close < c.open;
          const belowEma9L = c.close < ema;
          if (!isRed || !belowEma9L) continue;

          const touchesHot = c.low <= hot618High && c.high >= hot618Low;
          const touchesNear = c.low <= near382High && c.high >= near382Low;
          if (!touchesHot && !touchesNear) continue;

          const zone = touchesHot ? "HOT" : "NEAR";
          const hit = {
            symbol,
            mwNo,
            mwFromTime: wave.fromTime,
            mwTimestamp: wave.toTime,
            mwFromPrice: wave.fromPrice,
            mwToPrice: wave.toPrice,
            mwDelta: wave.delta,
            mwDir: wave.dir,
            zone,
            candleTime: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            ema9L: +ema.toFixed(2),
            fib618: +fibLevels["0.618"].toFixed(2),
            fib382: +fibLevels["0.382"].toFixed(2),
          };

          this._results.push(hit);
          this._progress.hits++;

          // ── Update chain index hit count + stock count ────────────────────
          if (!this._chainIndex.has(mwNo)) {
            this._chainIndex.set(mwNo, {
              mwNo,
              hitCount: 0,
              stockCount: 0,
              _hitSymbols: new Set(),
            });
          }
          const ci = this._chainIndex.get(mwNo);
          ci.hitCount++;
          if (!ci._hitSymbols.has(symbol)) {
            ci._hitSymbols.add(symbol);
            ci.stockCount++;
          }

          this.emit("backtest_hit", hit);
        }
      }

    } catch (err) {
      const prev = this._errors.get(symbol) || { count: 0 };
      prev.count++;
      prev.lastError = err.message;
      this._errors.set(symbol, prev);
      if (!isRetry && prev.count <= RETRY_LIMIT) {
        this._retryQueue.push(symbol);
        console.warn(`[Backtest] ⚠ ${symbol} failed (retry): ${err.message}`);
      } else {
        console.error(`[Backtest] ✗ ${symbol} permanently failed: ${err.message}`);
      }
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const backtestRunner = new BacktestRunner();
module.exports = { backtestRunner, BacktestRunner };