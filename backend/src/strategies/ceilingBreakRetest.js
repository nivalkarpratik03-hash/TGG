'use strict';

/**
 * Ceiling Break & Retest — Node.js port of Pine Script v5 indicator
 * "Ceiling Break & Retest Scanner v4"
 * ════════════════════════════════════════════════════════════════════════
 * SAME PATTERN AS tgT5.js / absorptionFlip.js: one self-contained file per
 * strategy — the engine class is ported and inlined directly here, not
 * split into a separate engine file, so this folder stays consistent
 * (every existing strategy — scannerS1.S2.S3.js, typeREF.js, tgT5.js,
 * absorptionFlip.js — is a single file; there is no existing precedent in
 * this codebase for a strategy engine living in its own file next to a
 * thin wrapper, so this file does not introduce one).
 *
 * The class below (CeilingBreakRetestScanner) and its two small helpers
 * (DEFAULT_CONFIG, findPivot) are a DIRECT, LOGIC-UNCHANGED copy of the
 * uploaded Node port — every line of the ceiling-clustering, breakout,
 * and RETEST/FAILED_RETEST/NO_RETEST/HIGHER_LOW state machine is exactly
 * as supplied. The only things removed from the original standalone file
 * are its own `module.exports = { CeilingBreakRetestScanner, DEFAULT_CONFIG }`
 * line and its `require.main === module` CLI block — neither exists in
 * any other file in this strategies/ folder (tgT5.js and absorptionFlip.js
 * are not runnable as their own CLI scripts either), so both are dropped
 * here rather than carried over, and replaced by the single
 * strategyRegistry.js-shaped `module.exports` at the bottom of this file.
 * Nothing else in the class or its helpers was touched.
 *
 * Behaviour (unchanged from the original port):
 *   - Detects "ceiling" resistance levels by clustering confirmed pivot highs.
 *   - Watches for a breakout above the ceiling.
 *   - Classifies what happens next as one of:
 *       RETEST            - price pulls back into the ceiling zone (genuine retest)
 *       FAILED_RETEST     - ceiling gives way / swing low breaks down
 *       NO_RETEST         - price extends and holds above the ceiling (frictionless move)
 *       HIGHER_LOW        - after a retest, price reclaims and prints a higher low (entry signal)
 *   - Uses the "hold window" fix: an extension above the ceiling does not
 *     instantly lock in NO_RETEST; it waits `noRetestHoldBars` bars to see
 *     if price dips back into the retest zone first.
 *
 * TRIGGER EVENT for future Analytics wiring (not wired yet — same
 * "explicitly out of scope this round" status strategyRegistry.js already
 * notes for other strategies' Analytics hookups): HIGHER_LOW is the
 * natural entry signal here, same role as absorptionFlip.js's
 * Doji-confirmed break. Exposed below as result.patternStage ===
 * "HIGHER_LOW" and result.results[i].isEntrySignal = true.
 *
 * Forming-candle guard: REUSED as-is from absorptionFlip.js
 * (isLastCandleForming / detectSpacingMs), not reimplemented — detection
 * must only ever see CLOSED candles, but result.lastCandle stays the raw
 * last candle (even mid-form) since that's what the UI shows as
 * "current price/bar".
 *
 * Purity: a brand-new CeilingBreakRetestScanner is constructed per scan()
 * call and fed the full candle history from scratch — no cached/carried
 * -over state between calls, same as every other strategy in this folder.
 *
 * `candles` must be an array of objects sorted oldest -> newest:
 *   { time, open, high, low, close }
 * ────────────────────────────────────────────────────────────────────────
 */

const { isLastCandleForming } = require("./absorptionFlip");

// ── Engine (unmodified logic — see header) ─────────────────────────────

const DEFAULT_CONFIG = {
  // Ceiling Detection
  pivotLen: 5, // Pivot Lookback (bars each side)
  tolerancePct: 1.0, // Ceiling Cluster Tolerance %
  minTouches: 2, // Minimum Touches to Qualify as Ceiling
  lookback: 150, // Pivot Search Lookback (bars)

  // Breakout
  breakoutBufPct: 0.3, // Breakout Confirmation Buffer %

  // Retest Classification
  minBarsBeforeRetest: 8, // Min bars after breakout before a pullback counts as retest
  retestTolPct: 2.0, // Retest Proximity Tolerance % (how close swing low must be to ceiling)
  failBufferPct: 0.5, // Failed-Retest Break Buffer % (close below ceiling by this much)
  extensionConfirmPct: 3.0, // Extension % above ceiling to confirm "No Retest" (checked every bar)
  noRetestHoldBars: 5, // Hold bars after extension before locking "No Retest"
  giveUpBars: 120, // Give up tracking after this many bars (no label, ambiguous)
};

/**
 * Simple confirmed pivot-high / pivot-low detector, equivalent to
 * ta.pivothigh(len, len) / ta.pivotlow(len, len) in Pine Script.
 *
 * A pivot high at `center` requires `high[center]` to be greater than every
 * high in the `len` bars before AND after it. A pivot low is the mirror
 * image using lows. Both are only "confirmed" once `len` bars have printed
 * after the candidate bar (hence the lag).
 */
function findPivot(candles, centerIdx, len, type) {
  const key = type === 'high' ? 'high' : 'low';
  const centerVal = candles[centerIdx][key];
  for (let j = centerIdx - len; j <= centerIdx + len; j++) {
    if (j === centerIdx) continue;
    const v = candles[j][key];
    if (type === 'high') {
      if (v >= centerVal) return false;
    } else {
      if (v <= centerVal) return false;
    }
  }
  return true;
}

class CeilingBreakRetestScanner {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };

    // normalize percentages to fractions, same as the Pine inputs (/100)
    this.tolerance = this.cfg.tolerancePct / 100;
    this.breakoutBuf = this.cfg.breakoutBufPct / 100;
    this.retestTol = this.cfg.retestTolPct / 100;
    this.failBuffer = this.cfg.failBufferPct / 100;
    this.extensionConfirm = this.cfg.extensionConfirmPct / 100;
  }

  /**
   * Run the scanner over a full candle series.
   * @param {Array<{time:any, open:number, high:number, low:number, close:number}>} candles
   * @returns {{ events: Array<Object>, series: Array<Object> }}
   */
  run(candles) {
    const cfg = this.cfg;
    const events = [];
    const series = new Array(candles.length);

    // ---------------- Pivot storage ----------------
    const pivotPrices = [];
    const pivotBars = [];

    // ---------------- State machine ----------------
    let state = 'idle'; // 'idle' | 'watching' | 'retested'
    let activeCeiling = NaN;
    let breakoutBar = NaN;
    let ceilLineStartBar = NaN; // equivalent of the ceiling line's x1
    let retestLow = NaN;
    let retestBarIdx = NaN;
    let extensionArmed = false;
    let extensionBar = NaN;

    const emit = (type, barIndex, price, extra = {}) => {
      events.push({
        type,
        barIndex,
        time: candles[barIndex] ? candles[barIndex].time : undefined,
        price,
        ...extra,
      });
    };

    // ---------------- Ceiling clustering (mirrors findCeiling()) ----------------
    const findCeiling = () => {
      const n = pivotPrices.length;
      if (n < cfg.minTouches) return { level: NaN, touches: 0, firstBar: NaN };

      const anchor = pivotPrices[n - 1];
      let cnt = 0;
      let sum = 0;
      let fB = NaN;

      for (let j = 0; j < n; j++) {
        const p = pivotPrices[j];
        if (Math.abs(p - anchor) / anchor <= this.tolerance) {
          cnt += 1;
          sum += p;
          const bIdx = pivotBars[j];
          fB = Number.isNaN(fB) ? bIdx : Math.min(fB, bIdx);
        }
      }

      if (cnt >= cfg.minTouches) {
        return { level: sum / cnt, touches: cnt, firstBar: fB };
      }
      return { level: NaN, touches: 0, firstBar: NaN };
    };

    // ---------------- Main bar-by-bar loop ----------------
    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];

      // --- pivot high detection (feeds the ceiling cluster) ---
      const centerIdx = i - cfg.pivotLen;
      let ph = NaN;
      let pl = NaN;
      if (centerIdx - cfg.pivotLen >= 0 && centerIdx + cfg.pivotLen <= i) {
        if (findPivot(candles, centerIdx, cfg.pivotLen, 'high')) {
          ph = candles[centerIdx].high;
        }
        if (findPivot(candles, centerIdx, cfg.pivotLen, 'low')) {
          pl = candles[centerIdx].low;
        }
      }

      if (!Number.isNaN(ph)) {
        pivotPrices.push(ph);
        pivotBars.push(centerIdx);
      }

      // drop pivots that have aged out of the lookback window
      while (
        pivotBars.length > 0 &&
        i - pivotBars[0] > cfg.lookback
      ) {
        pivotPrices.shift();
        pivotBars.shift();
      }

      // --- ceiling clustering ---
      const { level: ceilLevel, touches: ceilTouches, firstBar: ceilFirstBar } = findCeiling();
      const hasCeiling = ceilTouches >= cfg.minTouches;

      // --- breakout trigger (ta.crossover(close, ceilLevel * (1 + breakoutBuf))) ---
      let breakoutTrigger = false;
      if (hasCeiling && state === 'idle' && i > 0) {
        const threshold = ceilLevel * (1 + this.breakoutBuf);
        const prevClose = candles[i - 1].close;
        const currClose = bar.close;
        // crossover: previous close at/below threshold, current close above it
        breakoutTrigger = prevClose <= threshold && currClose > threshold;
      }

      if (breakoutTrigger) {
        activeCeiling = ceilLevel;
        breakoutBar = i;
        state = 'watching';
        retestLow = NaN;
        retestBarIdx = NaN;
        extensionArmed = false;
        extensionBar = NaN;
        ceilLineStartBar = ceilFirstBar;

        emit('CEILING_BROKEN', i, bar.high, { ceiling: activeCeiling });
      }

      // --- watching state ---
      if (state === 'watching') {
        const barsSince = i - breakoutBar;

        // 1) genuine confirmed pivot-low retest check
        if (!Number.isNaN(pl)) {
          const plBar = centerIdx;
          const plPrice = pl;
          if (plBar - breakoutBar >= cfg.minBarsBeforeRetest) {
            if (plPrice < activeCeiling * (1 - this.failBuffer)) {
              emit('FAILED_RETEST', plBar, plPrice, {
                reason: 'Ceiling gave way',
                ceiling: activeCeiling,
              });
              state = 'idle';
              activeCeiling = NaN;
            } else if (plPrice <= activeCeiling * (1 + this.retestTol)) {
              emit('RETEST', plBar, plPrice, {
                reason: 'Watching for Higher Low',
                ceiling: activeCeiling,
              });
              retestLow = plPrice;
              retestBarIdx = plBar;
              state = 'retested';
            }
          }
        }

        // 2) still open? track extension / hold window / give-up
        if (state === 'watching') {
          const dippedBack = i > breakoutBar && bar.low <= activeCeiling * (1 + this.retestTol);

          if (!extensionArmed && bar.close >= activeCeiling * (1 + this.extensionConfirm)) {
            extensionArmed = true;
            extensionBar = i;
          }

          if (extensionArmed) {
            if (dippedBack) {
              emit('RETEST', i, bar.low, {
                reason: 'Pullback after extension',
                ceiling: activeCeiling,
              });
              retestLow = bar.low;
              retestBarIdx = i;
              extensionArmed = false;
              state = 'retested';
            } else if (i - extensionBar >= cfg.noRetestHoldBars) {
              emit('NO_RETEST', i, bar.high, {
                reason: 'Frictionless Move',
                ceiling: activeCeiling,
              });
              state = 'idle';
              activeCeiling = NaN;
            }
          }

          if (state === 'watching' && barsSince > cfg.giveUpBars) {
            // ambiguous / choppy - close quietly, no event
            state = 'idle';
            activeCeiling = NaN;
          }
        }
      }

      // --- retested state: waiting for higher low (entry) or failure ---
      if (state === 'retested') {
        const barsSince = i - retestBarIdx;

        if (bar.close < activeCeiling * (1 - this.failBuffer) && bar.low < retestLow) {
          emit('FAILED_RETEST', i, bar.low, {
            reason: 'Broke the swing low',
            ceiling: activeCeiling,
          });
          state = 'idle';
          activeCeiling = NaN;
        } else if (
          bar.close > activeCeiling * (1 + this.breakoutBuf) &&
          bar.low > retestLow &&
          i > retestBarIdx
        ) {
          emit('HIGHER_LOW', i, bar.low, {
            reason: 'Entry Point',
            ceiling: activeCeiling,
          });
          state = 'idle';
          activeCeiling = NaN;
        } else if (barsSince > cfg.giveUpBars) {
          state = 'idle';
          activeCeiling = NaN;
        }
      }

      // --- per-bar snapshot (mirrors the plots/shading in the Pine script) ---
      const zoneHi = state !== 'idle' ? activeCeiling * (1 + this.retestTol) : NaN;
      const zoneLo = state !== 'idle' ? activeCeiling * (1 - this.failBuffer) : NaN;

      series[i] = {
        time: bar.time,
        state,
        hasCeiling,
        ceilingLevel: hasCeiling ? ceilLevel : NaN,
        activeCeiling: state !== 'idle' ? activeCeiling : NaN,
        ceilLineX1: state !== 'idle' ? ceilLineStartBar : NaN,
        ceilLineX2: state !== 'idle' ? i : NaN,
        zoneHi,
        zoneLo,
      };
    }

    return { events, series };
  }
}

// ── strategyRegistry.js wrapper ─────────────────────────────────────────

// Minimum candles needed before the engine's own pivot/cluster logic can
// possibly produce anything meaningful. The engine needs at least
// `2*pivotLen + 1` candles to confirm a single pivot, and `minTouches`
// such pivots before a ceiling exists at all — 30 mirrors absorptionFlip
// .js's own floor and comfortably covers the default pivotLen=5 /
// minTouches=2 config with room to spare.
const MIN_CANDLES = 30;

// context.cbr* -> engine config key map, so strategyRegistry.js callers
// can override defaults without needing to know the engine's internal
// field names 1:1. Only keys actually present in context are forwarded —
// CeilingBreakRetestScanner's constructor does a plain
// `{ ...DEFAULT_CONFIG, ...config }` spread, so an explicit `undefined`
// value would overwrite (not skip) a default.
const CONTEXT_CONFIG_KEY_MAP = {
  cbrPivotLen: 'pivotLen',
  cbrTolerancePct: 'tolerancePct',
  cbrMinTouches: 'minTouches',
  cbrLookback: 'lookback',
  cbrBreakoutBufPct: 'breakoutBufPct',
  cbrMinBarsBeforeRetest: 'minBarsBeforeRetest',
  cbrRetestTolPct: 'retestTolPct',
  cbrFailBufferPct: 'failBufferPct',
  cbrExtensionConfirmPct: 'extensionConfirmPct',
  cbrNoRetestHoldBars: 'noRetestHoldBars',
  cbrGiveUpBars: 'giveUpBars',
};

/**
 * strategyRegistry.js contract: { id, name, description, scan(symbol, candles) }
 * returning a ScanResult with at minimum { symbol, found, patternStage, error, scannedAt }.
 */
function scan(symbol, candles, context = {}) {
  const result = {
    symbol,
    found: false,
    patternStage: 'none',
    side: 'resistance',     // this scanner only ever tracks ceiling/resistance levels
    direction: null,         // "up" once a ceiling break sequence has started
    level: null,             // ceiling level of the most recent event
    events: [],               // full chronological history — every emitted event
    results: [],                // same events, MOST-RECENT-FIRST — for a scanner table
    state: null,                 // final per-bar snapshot (mirrors the Pine plots/shading)
    // lastCandle stays the RAW last candle (even if still forming) — this
    // is what the UI shows as "current price/bar". Only the DETECTION
    // path below excludes a forming candle.
    lastCandle: candles && candles.length ? candles[candles.length - 1] : null,
    candleCount: candles ? candles.length : 0,
    formingCandleExcluded: false,
    scannedAt: new Date().toISOString(),
    error: null,
  };

  try {
    if (!candles || candles.length < MIN_CANDLES) {
      result.error = 'insufficient_data';
      return result;
    }

    // ── Forming-candle guard (reused from absorptionFlip.js) ────────────
    let detectionCandles = candles;
    if (isLastCandleForming(candles)) {
      detectionCandles = candles.slice(0, -1);
      result.formingCandleExcluded = true;
      if (detectionCandles.length < MIN_CANDLES) {
        result.error = 'insufficient_data';
        return result;
      }
    }

    const configOverrides = {};
    for (const [ctxKey, cfgKey] of Object.entries(CONTEXT_CONFIG_KEY_MAP)) {
      if (context[ctxKey] !== undefined) configOverrides[cfgKey] = context[ctxKey];
    }

    const engine = new CeilingBreakRetestScanner(configOverrides);
    const { events, series } = engine.run(detectionCandles);

    result.events = events;
    result.results = events
      .slice()
      .reverse()
      .map((e) => ({ ...e, isEntrySignal: e.type === 'HIGHER_LOW' }));
    result.state = series.length ? series[series.length - 1] : null;

    if (events.length > 0) {
      const last = events[events.length - 1];
      result.found = true;
      result.patternStage = last.type;
      result.level = last.ceiling != null ? last.ceiling : null;
      result.direction = 'up';
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = {
  id: 'ceiling-break-retest',
  name: 'Ceiling Break & Retest',
  description:
    "Direct Node port of the Pine Script v5 'Ceiling Break & Retest Scanner v4' — clusters confirmed pivot highs into a ceiling, watches for a breakout, and classifies the follow-through as RETEST / FAILED_RETEST / NO_RETEST / HIGHER_LOW (the entry signal) across the full candle history.",
  scan,
  // Also exported for direct/standalone use and testing, same convention
  // as tgT5.js / absorptionFlip.js's module.exports tail.
  CeilingBreakRetestScanner,
  DEFAULT_CONFIG,
};
