/**
 * scannerRunner.js
 * ─────────────────────────────────────────────────────────────────
 * Runs ALL registered strategies across all symbols.
 *
 * Results are stored per-strategy, PER SCAN-SCOPE ("combo"):
 *   _results = Map<strategyId, Map<comboKey, Map<symbol, ScanResult>>>
 *
 * comboKey = `${resolution}|${assetClass}|${instrumentType}` (see
 * buildComboKey below). Each distinct filter combination the Scanner UI
 * can select (e.g. "15|commodity|fut" vs "15|equity|spot" vs the
 * "15|all|all" full-scan bucket) gets its OWN result set. Scanning one
 * combo never overwrites or merges into another combo's bucket — so
 * switching the UI's Asset Class / Instrument Type / Timeframe dropdowns
 * shows exactly that combo's cached results (or an empty state if that
 * exact combo has never been scanned), never a mix of two different
 * scopes. This is what /api/scanner/results/:strategyId's assetClass/
 * instrumentType/resolution query params key off of — see scannerRouter.js.
 *
 * FIX (2026-08-18) — previously results were stored flat as
 * Map<strategyId, Map<symbol, ScanResult>> with NO scope information at
 * all. Every scan — regardless of which category/instrument-type/
 * timeframe was selected — wrote into the exact same per-strategy map,
 * keyed only by symbol. So scanning Commodity, then later scanning
 * Equity, left BOTH sets of symbols sitting in the same map forever, and
 * the results endpoint had no way to return "just Commodity" — it always
 * returned everything ever scanned for that strategy. That's the "I
 * selected Commodity but it still shows EQ rows" bug. Callers that don't
 * pass a comboKey (getResultsByStrategy/getResult/getSummary with
 * comboKey omitted) still get the old flatten-everything view, for
 * backward compat with StrategiesPage.js, which has no scope filters.
 *
 * Manual-only scan control:
 *   scanner.triggerNow(resolution?, scanSymbols?, assetClass?, instrumentType?)
 *   scanner.stop()                   — abort any running scan
 *   No auto-start. No periodic timer. You control when it runs.
 *
 * Symbol filtering:
 *   MCX continuous contract symbols (ending in -I or -I suffix pattern)
 *   are silently dropped — Fyers does not support them for intraday history.
 *
 * MW shape:
 *   detectMotherWaveForAPI returns { wave, fibLevels, invalidation }.
 *   context.motherwave is that full object.
 *   Strategies access context.motherwave.wave.endIndex etc.
 *   trapZone and zone are derived here and passed separately for convenience.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const EventEmitter = require("events");
const { fetchCandles } = require("../fyers/client");
const strategies = require("../strategies/strategyRegistry");
const { detectMotherWaveForAPI, calcTrapZone, classifyZone } = require("./motherwave");

// ─── DB (optional) ────────────────────────────────────────────────────────────
let db = null;
let dbEnabled = false;
try {
  db = require("../../../database/src/index");
  dbEnabled = true;
} catch { /* DB optional — runs Fyers-only if not available */ }

const { deriveTimeframe } = require("./candleBuilder");

// ─── Config ───────────────────────────────────────────────────────────────────
const CONCURRENCY = parseInt(process.env.SCANNER_CONCURRENCY || "3");
const BATCH_DELAY_MS = parseInt(process.env.SCANNER_BATCH_DELAY_MS || "1000");
const DEFAULT_RESOLUTION = parseInt(process.env.SCANNER_RESOLUTION || "15");
const RETRY_LIMIT = 5;

// ─── Symbol filter ────────────────────────────────────────────────────────────
// P3 #18 — shared with backtestRunner.js via ../utils/symbolValidation.js.
// Aliased to the existing local name so the two call sites below don't need
// to change.
const { isValidSymbol: isValidScanSymbol } = require("../utils/symbolValidation");

// ─── Combo key ────────────────────────────────────────────────────────────────
// Normalizes (resolution, assetClass, instrumentType) into one canonical
// string used both to WRITE results (during a scan) and to READ them back
// (from /api/scanner/results). Both scannerRunner.js and scannerRouter.js
// build this the same way so a trigger with { assetClass: "commodity",
// instrumentType: "fut" } and a results fetch with the same two query
// params always land on the exact same bucket.
function buildComboKey(resolution, assetClass, instrumentType) {
  const res = parseInt(resolution) || DEFAULT_RESOLUTION;
  const ac = String(assetClass || "all").trim().toLowerCase() || "all";
  const it = String(instrumentType || "all").trim().toLowerCase() || "all";
  return `${res}|${ac}|${it}`;
}

// ─── ScannerRunner ────────────────────────────────────────────────────────────
class ScannerRunner extends EventEmitter {
  constructor() {
    super();
    this._results = new Map();
    this._errors = new Map();
    this._retryQueue = [];
    this._running = false;
    this._aborted = false;
    this._scanCount = 0;
    this._symbolList = [];
    this._lastScanAt = null;
    this._lastScanDurationMs = null;
    this._progress = { total: 0, done: 0, found: 0 };
    this._resolution = DEFAULT_RESOLUTION;
    // Per-combo scan bookkeeping — comboKey -> ISO timestamp of that
    // combo's last completed scan. Lets callers (and, if ever needed, the
    // UI) tell "never scanned" apart from "scanned, zero results".
    this._lastScanAtByCombo = new Map();
    this._lastComboKey = null;
    // NEW — tracks how many symbols the MOST RECENTLY COMPLETED scan
    // actually covered (the scoped count for that combo, e.g. 202 for
    // Equity/Spot), separate from this._symbolList.length (the full
    // boot-time universe across every asset class + all generated
    // futures contracts, e.g. 826). getStatus() exposes both — see its
    // own comment for which the frontend header should show.
    this._lastScopedSymbolCount = null;
    this._lastScopedComboKey = null;

    for (const s of strategies) {
      // Inner value is now Map<comboKey, Map<symbol, ScanResult>> instead
      // of a flat Map<symbol, ScanResult> — see file header FIX note.
      this._results.set(s.id, new Map());
    }
  }

  // ── Result bucket helpers ────────────────────────────────────────────────────
  // Gets (creating if needed) the Map<symbol, ScanResult> for one
  // strategy+combo. Always used when WRITING a result during a scan.
  _bucket(strategyId, comboKey) {
    const byCombo = this._results.get(strategyId);
    if (!byCombo) return null;
    let bucket = byCombo.get(comboKey);
    if (!bucket) {
      bucket = new Map();
      byCombo.set(comboKey, bucket);
    }
    return bucket;
  }

  // ── Symbol list ──────────────────────────────────────────────────────────────
  setSymbols(symbols) {
    const raw = [...new Set(symbols.filter(Boolean))];
    const valid = raw.filter(isValidScanSymbol);
    const dropped = raw.length - valid.length;
    this._symbolList = valid;
    console.log(
      `[Scanner] Symbol list: ${valid.length} symbols` +
      (dropped > 0 ? ` (${dropped} unsupported symbols dropped)` : "")
    );
  }
  getSymbols() { return [...this._symbolList]; }

  // ── Manual trigger ───────────────────────────────────────────────────────────
  // NEW 2026-08-02 — optional `scanSymbols`: when provided (from the Scanner
  // UI's category dropdown), scans ONLY that subset instead of the full
  // persistent _symbolList, and does not touch _symbolList or the persistent
  // _retryQueue at all — a scoped scan is a one-off, it never changes what
  // the next full scan (or another scoped scan) will cover.
  //
  // NEW (2026-08-18) — assetClass/instrumentType are now also used to build
  // this scan's comboKey (see buildComboKey above), which determines WHICH
  // per-strategy result bucket this scan's results get written into. This
  // is what makes results per-filter-combo instead of one giant shared pile
  // — see file header FIX note.
  async triggerNow(resolution, scanSymbols, assetClass = "all", instrumentType = "all") {
    if (this._running) return { status: "already_running", progress: this._progress };
    if (resolution != null) this._resolution = parseInt(resolution) || DEFAULT_RESOLUTION;
    this._aborted = false;

    let scopedSymbols = null;
    if (Array.isArray(scanSymbols) && scanSymbols.length > 0) {
      const raw = [...new Set(scanSymbols.filter(Boolean))];
      scopedSymbols = raw.filter(isValidScanSymbol);
      if (scopedSymbols.length === 0) {
        return { status: "no_valid_symbols", symbols: 0, resolution: this._resolution };
      }
    }

    const comboKey = buildComboKey(this._resolution, assetClass, instrumentType);
    this._lastComboKey = comboKey;

    await this._runScan(scopedSymbols, comboKey);
    return {
      status: "triggered",
      symbols: (scopedSymbols || this._symbolList).length,
      scoped: !!scopedSymbols,
      resolution: this._resolution,
      assetClass,
      instrumentType,
      comboKey,
    };
  }

  // ── Stop ─────────────────────────────────────────────────────────────────────
  stop() {
    if (this._running) {
      this._aborted = true;
      console.log("[Scanner] Stop requested — aborting current scan.");
    } else {
      console.log("[Scanner] Stop called — no scan running.");
    }
  }

  // ── Core scan loop ────────────────────────────────────────────────────────────
  async _runScan(scopedSymbols = null, comboKey = null) {
    // Legacy/internal callers that don't pass a comboKey (there are none
    // left in this codebase, but stay defensive) fall back to the
    // resolution-only "all|all" bucket rather than throwing.
    const effectiveComboKey = comboKey || buildComboKey(this._resolution, "all", "all");
    if (this._running) return;
    const isScoped = !!scopedSymbols;
    const baseList = isScoped ? scopedSymbols : this._symbolList;
    if (baseList.length === 0) { console.log("[Scanner] No symbols — skipping"); return; }

    // Record BEFORE the running/aborted early-return guards below, so a
    // scan that starts (even if aborted partway through) still updates
    // "what was this combo's most recent target size" rather than only
    // ever reflecting a fully-completed run.
    this._lastScopedSymbolCount = baseList.length;
    this._lastScopedComboKey = effectiveComboKey;

    this._running = true;
    this._aborted = false;
    this._scanCount++;
    const scanId = this._scanCount;
    const startMs = Date.now();
    const resolution = this._resolution;

    // Scoped (category-filtered) runs never merge in or write back to the
    // persistent _retryQueue — that queue exists for the full-symbol-list
    // scan cycle only. A scoped run gets its own local retry queue that
    // lives and dies with this one call, same immediate-retry behavior,
    // just not shared across runs or across scopes.
    const retryTarget = isScoped ? [] : this._retryQueue;
    const toScan = isScoped ? [...new Set(baseList)] : [...new Set([...this._retryQueue, ...baseList])];
    if (!isScoped) this._retryQueue = [];
    this._progress = { total: toScan.length, done: 0, found: 0 };

    console.log(`[Scanner #${scanId}] ${toScan.length} symbols × ${strategies.length} strategies @ res=${resolution}m${isScoped ? " (scoped)" : ""} combo=${effectiveComboKey}`);
    this.emit("scan_start", {
      scanId,
      total: toScan.length,
      resolution,
      scoped: isScoped,
      comboKey: effectiveComboKey,
      strategies: strategies.map(s => ({ id: s.id, name: s.name })),
    });

    for (let i = 0; i < toScan.length; i += CONCURRENCY) {
      if (this._aborted) {
        console.log(`[Scanner #${scanId}] Aborted after ${i} symbols.`);
        break;
      }
      const batch = toScan.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map((sym) => this._processSymbol(sym, false, resolution, retryTarget, effectiveComboKey)));
      this._progress.done = Math.min(i + CONCURRENCY, toScan.length);
      this.emit("scan_progress", { ...this._progress, scanId });
      if (i + CONCURRENCY < toScan.length) await delay(BATCH_DELAY_MS);
    }

    // Retry pass (only if not aborted)
    if (!this._aborted && retryTarget.length > 0) {
      const retries = [...retryTarget];
      retryTarget.length = 0;
      console.log(`[Scanner #${scanId}] Retrying ${retries.length} symbols...`);
      for (const sym of retries) {
        if (this._aborted) break;
        await this._processSymbol(sym, true, resolution, retryTarget, effectiveComboKey);
        await delay(600);
      }
    }

    const durationMs = Date.now() - startMs;
    this._lastScanAt = new Date().toISOString();
    this._lastScanDurationMs = durationMs;
    this._lastScanAtByCombo.set(effectiveComboKey, this._lastScanAt);
    this._running = false;
    this._aborted = false;

    // Scoped to THIS scan's combo only — not a merge across every combo
    // ever scanned — so the emitted totals match what the UI that
    // triggered this scan will actually see when it refetches.
    const summary = this.getSummaryAll(effectiveComboKey);
    const totalFound = Object.values(summary).reduce((acc, s) => acc + s.full.length, 0);

    console.log(`[Scanner #${scanId}] Done in ${(durationMs / 1000).toFixed(1)}s — ${totalFound} total signals across ${strategies.length} strategies (combo=${effectiveComboKey})`);
    this.emit("scan_complete", {
      scanId,
      total: toScan.length,
      durationMs,
      scannedAt: this._lastScanAt,
      resolution,
      scoped: isScoped,
      comboKey: effectiveComboKey,
      summary,
    });
  }

  // ── Process one symbol — fetch candles ONCE, run all strategies ───────────────
  async _processSymbol(symbol, isRetry = false, resolution = DEFAULT_RESOLUTION, retryTarget = null, comboKey = null) {
    const effectiveComboKey = comboKey || buildComboKey(resolution, "all", "all");
    const retryQueue = retryTarget || this._retryQueue;
    try {
      // ── DB-first: read from Postgres, fall back to Fyers if empty ─────────
      let candles = null;

      if (dbEnabled && db) {
        try {
          const windowMs = 90 * 24 * 60 * 60 * 1000;
          const oneMin = await db.loadCandles(symbol, 1, {
            from: new Date(Date.now() - windowMs),
            to: new Date(),
            limit: 50000,
          });
          if (oneMin && oneMin.length > 0) {
            candles = resolution === 1 ? oneMin : deriveTimeframe(oneMin, resolution);
            if (!candles || candles.length === 0) candles = null;
          }
        } catch (dbErr) {
          console.warn(`[Scanner] DB read failed for ${symbol}: ${dbErr.message} — trying Fyers`);
        }
      }

      if (!candles) {
        candles = await fetchCandles(symbol, resolution, 5000);
      }

      this._errors.delete(symbol);

      // ── Compute Mother Wave ONCE for this symbol ───────────────────────────
      // detectMotherWaveForAPI is THE one function — returns { wave, fibLevels, invalidation }.
      // Strategies receive context.motherwave = this full object.
      // They access context.motherwave.wave.endIndex for S1 search start bar.
      const mwResult = detectMotherWaveForAPI(candles);

      // Derive trapZone and zone from the new shape for convenience
      const trapZone = mwResult ? calcTrapZone(mwResult) : null;
      const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
      const zone = mwResult && lastCandle
        ? classifyZone(mwResult, lastCandle.close)
        : "trap";

      const context = {
        motherwave: mwResult,   // full { wave, fibLevels, invalidation }
        trapZone,
        zone,
        lastCandle,
      };

      for (const strategy of strategies) {
        try {
          const result = strategy.scan(symbol, candles, context);
          this._bucket(strategy.id, effectiveComboKey).set(symbol, result);

          if (result.found) {
            this._progress.found++;
            this.emit("signal_found", { ...result, strategyId: strategy.id, strategyName: strategy.name });
            console.log(`[Scanner] ✅ ${strategy.id} | ${symbol} — SIGNAL (${result.patternStage})`);
          } else if (result.patternStage === "s2") {
            this.emit("signal_partial", { ...result, strategyId: strategy.id, strategyName: strategy.name });
          }
        } catch (stratErr) {
          console.error(`[Scanner] Strategy ${strategy.id} error on ${symbol}: ${stratErr.message}`);
          this._bucket(strategy.id, effectiveComboKey).set(symbol, {
            symbol, found: false, patternStage: "none",
            error: stratErr.message, scannedAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      const prev = this._errors.get(symbol) || { count: 0, lastError: "" };
      prev.count++;
      prev.lastError = err.message;
      this._errors.set(symbol, prev);

      if (!isRetry && prev.count <= RETRY_LIMIT) {
        retryQueue.push(symbol);
        console.warn(`[Scanner] ⚠ ${symbol} fetch failed (retry): ${err.message}`);
      } else {
        console.error(`[Scanner] ✗ ${symbol} permanently failed: ${err.message}`);
        for (const strategy of strategies) {
          this._bucket(strategy.id, effectiveComboKey).set(symbol, {
            symbol, found: false, patternStage: "none",
            error: err.message, scannedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  // ── Query helpers ─────────────────────────────────────────────────────────────
  // All of these now take an OPTIONAL comboKey (see buildComboKey above):
  //   - comboKey provided  → results for that EXACT scan scope only. Never
  //     scanned yet → empty array (correct "no signals" state, not an
  //     error) — this is what the Scanner UI (ScannerPage.js) always
  //     passes now, one per selected Asset Class + Instrument Type +
  //     Timeframe combo.
  //   - comboKey omitted   → legacy flattened view merging every combo
  //     ever scanned for that strategy, deduped by symbol (most recently
  //     scanned wins). This is what StrategiesPage.js gets, unchanged from
  //     before — it has no scope filters of its own.

  getResultsByStrategy(strategyId, comboKey = null) {
    const byCombo = this._results.get(strategyId);
    if (!byCombo) return null; // unknown strategyId — caller 404s

    if (comboKey) {
      const bucket = byCombo.get(comboKey);
      return bucket ? [...bucket.values()] : [];
    }

    // Legacy merge across all combos, most-recently-scanned wins per symbol.
    const merged = new Map();
    for (const bucket of byCombo.values()) {
      for (const [symbol, result] of bucket) {
        const existing = merged.get(symbol);
        if (!existing || new Date(result.scannedAt || 0) >= new Date(existing.scannedAt || 0)) {
          merged.set(symbol, result);
        }
      }
    }
    return [...merged.values()];
  }

  getResult(strategyId, symbol, comboKey = null) {
    const byCombo = this._results.get(strategyId);
    if (!byCombo) return null;

    if (comboKey) {
      return byCombo.get(comboKey)?.get(symbol) || null;
    }
    // Legacy: most recent across all combos.
    let best = null;
    for (const bucket of byCombo.values()) {
      const r = bucket.get(symbol);
      if (r && (!best || new Date(r.scannedAt || 0) >= new Date(best.scannedAt || 0))) best = r;
    }
    return best;
  }

  getSummary(strategyId, comboKey = null) {
    const all = this.getResultsByStrategy(strategyId, comboKey);
    if (!all) return null;
    return {
      full: all.filter((r) => r.found),
      partial: all.filter((r) => r.patternStage === "s2"),
      errors: all.filter((r) => r.error),
    };
  }

  getSummaryAll(comboKey = null) {
    const out = {};
    for (const s of strategies) { out[s.id] = this.getSummary(s.id, comboKey); }
    return out;
  }

  // Whether this exact combo has ever completed a scan — lets a caller
  // distinguish "never scanned" from "scanned, zero matches" if needed.
  hasScannedCombo(comboKey) {
    return this._lastScanAtByCombo.has(comboKey);
  }

  lastScanAtForCombo(comboKey) {
    return this._lastScanAtByCombo.get(comboKey) || null;
  }

  // group/variant are needed by the Scanner UI to pick the right stats/
  // table rendering per strategy family — different strategy families use
  // different patternStage vocabularies (s1s2s3: "s1"/"s2"/"s3_complete",
  // type E/R/F: "none"/"active"/"completed", T5 (upcoming): its own set),
  // so the frontend can no longer assume s1s2s3's shape everywhere. Prior
  // to this fix, ScannerPage.js hardcoded s1s2s3's patternStage strings
  // for stats + tables regardless of which strategy was selected, so
  // switching to "Type E,R,F" showed 0 signals / "No completed signals
  // yet" even when the backend log showed hundreds of real completions —
  // group lets the frontend tell strategy families apart and branch.
  getStrategies() {
    return strategies.map((s) => ({ id: s.id, name: s.name, description: s.description, group: s.group || null, variant: s.variant || null }));
  }

  getStatus() {
    return {
      running: this._running,
      // Full boot-time universe across ALL asset classes plus every
      // generated futures contract (e.g. 826) — NOT scoped to whatever
      // is currently selected in the Scanner UI's dropdowns. Kept for
      // back-compat / anyone relying on "total known symbols".
      symbolCount: this._symbolList.length,
      // NEW — how many symbols the last COMPLETED (or in-progress) scan
      // actually targeted for its specific assetClass+instrumentType
      // combo (e.g. 202 for Equity/Spot). This is what the Scanner UI's
      // header should show as "N symbols" — it matches the "Scanned"
      // stat chip instead of the unrelated full-universe count above.
      // null until the very first scan of this process completes.
      lastScopedSymbolCount: this._lastScopedSymbolCount,
      lastScopedComboKey: this._lastScopedComboKey,
      resolution: this._resolution,
      lastScanAt: this._lastScanAt,
      lastScanDurationMs: this._lastScanDurationMs,
      progress: this._progress,
      scanCount: this._scanCount,
      errorCount: this._errors.size,
      concurrency: CONCURRENCY,
      batchDelayMs: BATCH_DELAY_MS,
      strategies: this.getStrategies(),
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Singleton ────────────────────────────────────────────────────────────────
const scanner = new ScannerRunner();
module.exports = { scanner, ScannerRunner, buildComboKey };