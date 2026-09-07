/**
 * ceilingBreakRetestEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Frontend copy of backend/src/strategies/ceilingBreakRetest.js
 * (CeilingBreakRetestScanner — the ceiling-clustering, breakout, and
 * RETEST/FAILED_RETEST/NO_RETEST/HIGHER_LOW state machine).
 *
 * This file is a byte-for-byte copy of the backend module from `'use
 * strict';` through the end of the CeilingBreakRetestScanner class — NO
 * trading-logic lines were changed. Only an ES-module export list was
 * appended at the bottom so the frontend (which uses import/export, not
 * CommonJS) can consume it directly, same pattern as tgT5Engine.js.
 *
 * ONE deliberate deviation from a pure byte-for-byte copy, and it is not
 * a trading-logic change: the backend file's top-level
 * `const { isLastCandleForming } = require("./absorptionFlip");` line is
 * dropped here. That import exists solely for the backend's scan()
 * wrapper (the forming-candle guard applied before detection runs) —
 * grep confirms isLastCandleForming is referenced nowhere inside the
 * CeilingBreakRetestScanner class itself, only inside scan(), which is
 * NOT part of this copy (see below). Left in, it would try to `require`
 * a CommonJS backend module from an ES bundle and break the frontend
 * build for a dependency the class never uses. Every other line the
 * class/DEFAULT_CONFIG/findPivot actually touch is unchanged.
 *
 * Also NOT copied (same as tgT5Engine.js excluding tgT5.js's scan()):
 * the backend file's "── strategyRegistry.js wrapper ──" section —
 * MIN_CANDLES, CONTEXT_CONFIG_KEY_MAP, scan(), and its module.exports.
 * Those are backend/strategyRegistry.js-facing plumbing, not drawing
 * logic, and scan()'s forming-candle guard has no equivalent need here —
 * the chart indicator (CeilingBreakIndicator.js, Chunk 8) will call
 * `new CeilingBreakRetestScanner(config).run(candles)` directly, the same
 * way T5Indicator.js drives TgT5Engine.
 *
 * If the ceiling-break detection rules ever change, update
 * backend/src/strategies/ceilingBreakRetest.js first and re-sync this
 * copy (or replace it with a shared package) so the scanner and the
 * chart indicator never drift apart.
 *
 * Will be used by indicators/CeilingBreakIndicator.js (Chunk 8) to draw
 * the same ceiling line / zone band / RETEST-FAILED_RETEST-NO_RETEST-
 * HIGHER_LOW markers on the chart, live, as the backend scanner finds
 * when it runs the ceiling-break-retest strategy.
 * ─────────────────────────────────────────────────────────────────────────────
 */

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

// ── ES module exports (added for the frontend copy only — see header) ──
export { CeilingBreakRetestScanner, DEFAULT_CONFIG, findPivot };
