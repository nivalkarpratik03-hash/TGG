'use strict';

/**
 * strategies/pinakaEngine.js
 * ─────────────────────────────────────────────────────────────────────────
 * PINAKA SPEC 3 — THE DETECTORS (A1 · A2 · B · B2)
 * Direct Node.js port of pinaka_detectors_3.pine (v7, TG Levels Pvt Ltd).
 *
 * THIS IS THE ONLY COPY OF THIS LOGIC IN THE WHOLE PROJECT.
 * ───────────────────────────────────────────────────────────────────────
 * Every other consumer requires/imports THIS EXACT FILE — nobody
 * re-implements the state machines:
 *   - backend/src/strategies/pinaka.js        (scanner)  → require()
 *   - frontend/src/indicators/PinakaIndicator.js (chart)  → import
 *   - any future watchlist feature                        → import/require
 *
 * It lives under frontend/src/ (not backend/src/) for one reason only:
 * CRA's webpack config (ModuleScopePlugin) refuses to bundle anything
 * imported from OUTSIDE frontend/src, so the frontend build requires the
 * file to sit here. Node's `require()` has no such restriction, so the
 * backend reaches in via a relative path — see pinaka.js's header. If a
 * previous strategy in this project ever ends up with a duplicate copy
 * under backend/src/strategies/ instead of a single shared file, that's
 * the older, now-abandoned pattern (kept in sync by hand) — this file is
 * the newer, correct one: physically one file, never copy-pasted.
 *
 * Plain CommonJS, zero DOM/Node dependencies — runs unmodified in the
 * browser bundle and under Node.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * USAGE
 * -----
 *   const { PinakaDetectors } = require('./pinakaEngine'); // or import
 *   const engine = new PinakaDetectors({ tickSize: 0.05 });
 *   const { signals, series } = engine.run(candles);
 *
 *   candles: array of { time, open, high, low, close, volume }, ascending,
 *   one entry per bar — matches the candle shape used everywhere else in
 *   this project (see backend/src/services/candleFetch.js). `time` is an
 *   epoch-ms number. `volume` is optional; missing/zero volume falls back
 *   to a bar-count of 1, exactly like the Pine script does for indices
 *   with no reported volume. VWAP is anchored to the calendar year (same
 *   as the Pine script's `year != year[1]` reset) and works unchanged at
 *   any resolution/timeframe this project fetches candles at.
 */

class PinakaDetectors {
  constructor(options = {}) {
    // ---- ENGINE ----
    this.sigma      = options.sigma      ?? 1.0;   // VWAP band sigma
    this.emaLen     = options.emaLen     ?? 9;     // EMA length (highs & lows)
    this.warmupBars = options.warmupBars ?? 20;    // warm-up bars (carry old band)
    this.tickSize   = options.tickSize   ?? 0.05;  // syminfo.mintick equivalent

    // ---- PIVOTS ----
    this.pivL = options.pivotLeft  ?? 2;
    this.pivR = options.pivotRight ?? 2;

    // ---- CANDLES ----
    this.bodyPct = options.bodyPct ?? 60.0; // full body: body/range >= %

    // ---- A1 ----
    this.a1Strict   = options.a1Strict   ?? false;
    this.a1UseDepth = options.a1UseDepth ?? false;
    this.a1MaxRatio = options.a1MaxRatio ?? 0.33;
    this.a1UseSlope = options.a1UseSlope ?? false;
    this.a1SlopeLen = options.a1SlopeLen ?? 5;

    // ---- FILTERS (B) ----
    this.bGapMin = options.bGapMin ?? 5.0;  // min gap emaLow -> upper band (%)
    this.flyWin  = options.flyWin  ?? 10;   // flying candle must be within N bars of trigger

    // ---- B2 ----
    this.b2Win        = options.b2Win        ?? 8;    // turn must come within N bars of poke
    this.b2MinGreen   = options.b2MinGreen   ?? 1;     // min green candles poke -> turn
    this.b2CloseAbove = options.b2CloseAbove ?? false; // poke candle must also close above band
  }

  run(candles) {
    const n = candles.length;
    if (n === 0) return { signals: [], series: [] };

    const yearOf = (t) => (t instanceof Date ? t : new Date(t)).getUTCFullYear();

    // =========================================================================
    // MODULE 1 · ENGINE — yearly-anchored VWAP with sigma bands + warm-up
    // =========================================================================
    const vwapVal = new Array(n), bandUp = new Array(n), bandDn = new Array(n);
    const warm = new Array(n), isNewYear = new Array(n);
    let cumPV = 0, cumPV2 = 0, cumV = 0, barsIn = 0;
    let carryUp = NaN, carryDn = NaN, prevYear = null;

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const yr = yearOf(c.time);
      const newYear = prevYear !== null && yr !== prevYear;
      isNewYear[i] = newYear;

      if (newYear) {
        const oldVw = cumV > 0 ? cumPV / cumV : NaN;
        const oldVar = cumV > 0 ? Math.max(cumPV2 / cumV - oldVw * oldVw, 0) : NaN;
        const oldSd = Number.isNaN(oldVar) ? NaN : Math.sqrt(oldVar);
        carryUp = Number.isNaN(oldVw) ? NaN : oldVw + this.sigma * oldSd;
        carryDn = Number.isNaN(oldVw) ? NaN : oldVw - this.sigma * oldSd;
        cumPV = 0; cumPV2 = 0; cumV = 0; barsIn = 0;
      }

      const src = (c.high + c.low + c.close) / 3; // hlc3
      const v = (!c.volume || c.volume === 0) ? 1 : c.volume;
      cumPV += src * v;
      cumPV2 += src * src * v;
      cumV += v;
      barsIn += 1;

      const vw = cumV > 0 ? cumPV / cumV : NaN;
      const variance = cumV > 0 ? Math.max(cumPV2 / cumV - vw * vw, 0) : NaN;
      const sd = Number.isNaN(variance) ? NaN : Math.sqrt(variance);
      const isWarm = barsIn <= this.warmupBars && !Number.isNaN(carryUp);

      vwapVal[i] = vw;
      bandUp[i] = isWarm ? carryUp : vw + this.sigma * sd;
      bandDn[i] = isWarm ? carryDn : vw - this.sigma * sd;
      warm[i] = isWarm;
      prevYear = yr;
    }

    // =========================================================================
    // MODULE 2 · EMA PAIR — EMA(len) of highs, EMA(len) of lows
    // =========================================================================
    const emaH = new Array(n), emaL = new Array(n);
    const k = 2 / (this.emaLen + 1);
    for (let i = 0; i < n; i++) {
      const { high, low } = candles[i];
      emaH[i] = i === 0 ? high : (high - emaH[i - 1]) * k + emaH[i - 1];
      emaL[i] = i === 0 ? low : (low - emaL[i - 1]) * k + emaL[i - 1];
    }

    // =========================================================================
    // MODULE 3 · CANDLES — pure per-bar arithmetic
    // =========================================================================
    const isGreen = new Array(n), isRed = new Array(n);
    const fullGreen = new Array(n), redEngulf = new Array(n), bodyRatio = new Array(n);
    for (let i = 0; i < n; i++) {
      const { open, high, low, close } = candles[i];
      const rng = Math.max(high - low, this.tickSize);
      const br = Math.abs(close - open) / rng * 100;
      const grn = close > open, red = close < open;
      isGreen[i] = grn;
      isRed[i] = red;
      bodyRatio[i] = br;
      fullGreen[i] = grn && br >= this.bodyPct;
      if (i > 0) {
        const po = candles[i - 1].open, pc = candles[i - 1].close;
        redEngulf[i] = red && pc > po && open >= pc && close <= po;
      } else {
        redEngulf[i] = false;
      }
    }

    // mandatory A1 / B structure — the advance is REAL
    const structUp = new Array(n);
    for (let i = 0; i < n; i++) structUp[i] = emaH[i] > bandUp[i] && emaL[i] > bandUp[i];

    // =========================================================================
    // MODULE 4 · PIVOTS — confirmed `pivR` bars after they print
    // NOTE: "unique max/min in window" is the practical pivot test used here.
    // Verify against your own pivot marks if you need an exact match on data
    // with repeated highs/lows (rare on daily index/equity data).
    // =========================================================================
    const isPivotHigh = (p) => {
      const lo = p - this.pivL, hi = p + this.pivR;
      if (lo < 0 || hi >= n) return false;
      let max = -Infinity, cnt = 0;
      for (let j = lo; j <= hi; j++) if (candles[j].high > max) max = candles[j].high;
      for (let j = lo; j <= hi; j++) if (candles[j].high === max) cnt++;
      return candles[p].high === max && cnt === 1;
    };
    const isPivotLow = (p) => {
      const lo = p - this.pivL, hi = p + this.pivR;
      if (lo < 0 || hi >= n) return false;
      let min = Infinity, cnt = 0;
      for (let j = lo; j <= hi; j++) if (candles[j].low < min) min = candles[j].low;
      for (let j = lo; j <= hi; j++) if (candles[j].low === min) cnt++;
      return candles[p].low === min && cnt === 1;
    };

    // =========================================================================
    // SEQUENTIAL PASS — ratcheting references + all four detectors
    // =========================================================================
    let refHi = NaN, refHiPrev = NaN;   // B's reference (ratchets UP)
    let refLo = NaN;                    // A2's reference (ratchets DOWN, never resets)
    let pivLast = NaN, pivPrev = NaN;   // A1's own pivot-high sequence

    let a1StructSeen = false, a1Pulled = false;
    let a2Stage = 0;
    let bAbove = false, bFlew = false, bFlewBar = NaN;
    let b2Armed = false, b2PokeBar = NaN, b2PokeHi = NaN, b2PokeCl = NaN, b2GrnCnt = 0;

    const signals = [];
    const series = [];

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const p = i - this.pivR; // bar that a pivot confirmed THIS bar would refer to

      let qualHigh = false, qualLow = false, pivHighVal = NaN, pivLowVal = NaN;
      if (p >= 0) {
        if (isPivotHigh(p) && candles[p].high > emaH[p]) {
          qualHigh = true; pivHighVal = candles[p].high;
        }
        if (isPivotLow(p) && candles[p].low < emaL[p] && candles[p].low < bandDn[p]) {
          qualLow = true; pivLowVal = candles[p].low;
        }
      }

      // ---- MODULE 4a · ref HIGH (ratchets up, resets each new year) ----
      if (isNewYear[i]) { refHi = NaN; refHiPrev = NaN; }
      let refHiMoved = false;
      if (qualHigh && (Number.isNaN(refHi) || pivHighVal > refHi)) {
        refHiPrev = refHi; refHi = pivHighVal; refHiMoved = true;
      }

      // ---- MODULE 4b · ref LOW (ratchets down, never resets) ----
      let refLoMoved = false;
      if (qualLow && (Number.isNaN(refLo) || pivLowVal < refLo)) {
        refLo = pivLowVal; refLoMoved = true;
      }

      // ---- A1's own pivot-high sequence (last two qualifying highs) ----
      let pivSeqMoved = false;
      if (qualHigh) { pivPrev = pivLast; pivLast = pivHighVal; pivSeqMoved = true; }
      const pivRising = Number.isNaN(pivPrev) || pivLast > pivPrev;

      // =======================================================================
      // MODULE 5a · A1 — LONG, continuation inside an established advance
      // =======================================================================
      if (pivSeqMoved) a1Pulled = false;                 // fresh pivot restarts the watch
      if (structUp[i] && !Number.isNaN(pivLast)) a1StructSeen = true; // latched
      if (c.close < vwapVal[i]) { a1StructSeen = false; a1Pulled = false; } // advance is over
      const a1OkStruct = this.a1Strict ? structUp[i] : a1StructSeen;
      if (a1OkStruct && !Number.isNaN(pivLast) && c.close < emaL[i]) a1Pulled = true;
      const a1Raw = a1OkStruct && !Number.isNaN(pivLast) && a1Pulled &&
                    fullGreen[i] && c.close > emaL[i];
      if (a1Raw) { a1Pulled = false; a1StructSeen = false; }

      // classify: TRADE vs REFERENCE-ONLY
      const a1dBand = c.close - bandUp[i];
      const a1dPivot = Number.isNaN(pivLast) ? NaN : pivLast - c.close;
      const a1Ratio = Number.isNaN(a1dPivot) ? NaN
        : (a1dPivot <= 0 ? 0 : Math.max(a1dBand, 0) / a1dPivot);
      const a1RatioOK = !Number.isNaN(a1Ratio) && a1Ratio <= this.a1MaxRatio;
      const a1DepthOK = !this.a1UseDepth || a1RatioOK;
      const a1SlopeOK = !this.a1UseSlope ||
        (i >= this.a1SlopeLen && emaL[i] >= emaL[i - this.a1SlopeLen]);
      const a1Pass = pivRising && a1DepthOK && a1SlopeOK;
      const a1Trade = a1Raw && a1Pass;
      const a1Refx = a1Raw && !a1Pass;

      // =======================================================================
      // MODULE 5b · A2 — LONG, reversal from a depressed extreme
      // =======================================================================
      if (refLoMoved) a2Stage = 0;
      if (!Number.isNaN(refLo) && c.low < refLo) a2Stage = 0;
      let a2Raw = false;
      if (!Number.isNaN(refLo)) {
        if (a2Stage === 0) {
          if (isGreen[i] && c.close > emaL[i]) a2Stage = 1;
        } else if (a2Stage === 1) {
          if (c.low <= emaL[i]) a2Stage = 2;
        } else if (a2Stage === 2) {
          if (fullGreen[i] && c.close > emaH[i]) { a2Raw = true; a2Stage = 0; }
        }
      }
      const a2BelowVwap = c.close < vwapVal[i];
      const a2Trade = a2Raw && a2BelowVwap;
      const a2Refx = a2Raw && !a2BelowVwap;

      // =======================================================================
      // MODULE 5c · B — SHORT, reversal from an extended, unretested top
      // =======================================================================
      if (!structUp[i]) { bAbove = false; bFlew = false; bFlewBar = NaN; }
      if (refHiMoved && !Number.isNaN(refHiPrev)) bAbove = true; // ratchet IS proof
      if (!Number.isNaN(refHi) && c.close > refHi) bAbove = true;
      if (bAbove && c.low > emaH[i]) { bFlew = true; bFlewBar = i; }
      const bGap = structUp[i] ? (emaL[i] - bandUp[i]) / emaL[i] * 100 : NaN;
      const bGapOK = !Number.isNaN(bGap) && bGap >= this.bGapMin;
      const bFlyFresh = bFlew && !Number.isNaN(bFlewBar) && (i - bFlewBar) <= this.flyWin;
      const bTrig = redEngulf[i] || (isRed[i] && c.close < emaL[i]);
      const bRaw = structUp[i] && bAbove && bFlyFresh && bGapOK && bTrig;
      if (bRaw) { bAbove = false; bFlew = false; bFlewBar = NaN; }

      // =======================================================================
      // MODULE 5d · B2 — SHORT, the failed poke of the upper band
      // =======================================================================
      const prevBandUp = i > 0 ? bandUp[i - 1] : NaN;
      const prevClose = i > 0 ? candles[i - 1].close : NaN;
      const fromBelow = c.low <= bandUp[i] ||
        (!Number.isNaN(prevBandUp) && prevClose <= prevBandUp);
      const poke = isGreen[i] && c.high > bandUp[i] && c.close > emaH[i] && fromBelow &&
        (!this.b2CloseAbove || c.close > bandUp[i]);
      if (poke) {
        b2Armed = true; b2PokeBar = i; b2PokeHi = c.high; b2PokeCl = c.close; b2GrnCnt = 1;
      } else if (b2Armed) {
        if (isGreen[i]) b2GrnCnt += 1;
        if (!Number.isNaN(b2PokeBar) && (i - b2PokeBar) > this.b2Win) {
          b2Armed = false; b2GrnCnt = 0;
        }
      }
      const b2Raw = b2Armed && isRed[i] && redEngulf[i] &&
        c.close < bandUp[i] && b2GrnCnt >= this.b2MinGreen;
      if (b2Raw) { b2Armed = false; b2GrnCnt = 0; }

      // ---- emit ----
      const base = { index: i, time: c.time, close: c.close };
      if (a1Trade) signals.push({ ...base, type: 'A1', side: 'long', detail: {
        bodyRatio: bodyRatio[i], emaLow: emaL[i], emaHigh: emaH[i], bandUp: bandUp[i],
        vwap: vwapVal[i], lastPivot: pivLast, priorPivot: pivPrev,
        depthRatio: a1Ratio, maxRatio: this.a1MaxRatio,
      }});
      if (a1Refx) signals.push({ ...base, type: 'A1x', side: null,
        reason: !pivRising ? 'FALLING_PIVOT_SEQUENCE'
              : !a1DepthOK ? 'DEPTH_MIDAIR'
              : 'SLOPE_STILL_FALLING',
        detail: { depthRatio: a1Ratio, maxRatio: this.a1MaxRatio, pivotRising: pivRising }});
      if (a2Trade) signals.push({ ...base, type: 'A2', side: 'long', detail: {
        bodyRatio: bodyRatio[i], emaHigh: emaH[i], emaLow: emaL[i],
        bandDn: bandDn[i], trackedPivot: refLo,
      }});
      if (a2Refx) signals.push({ ...base, type: 'A2x', side: null, reason: 'ABOVE_VWAP_CENTRE',
        detail: { vwap: vwapVal[i], trackedPivot: refLo }});
      if (bRaw) signals.push({ ...base, type: 'B', side: 'short', detail: {
        trigger: redEngulf[i] ? 'RED_ENGULFING' : 'RED_BODY_BELOW_EMA_LOW',
        emaLow: emaL[i], emaHigh: emaH[i], bandUp: bandUp[i],
        highestPivot: refHi, frictionlessGap: bGap, minGap: this.bGapMin,
      }});
      if (b2Raw) signals.push({ ...base, type: 'B2', side: 'short', detail: {
        bandUp: bandUp[i], emaHigh: emaH[i], emaLow: emaL[i],
        pokeHigh: b2PokeHi, pokeClose: b2PokeCl, greenRun: b2GrnCnt, minGreen: this.b2MinGreen,
      }});

      series.push({
        index: i, time: c.time,
        vwap: vwapVal[i], bandUp: bandUp[i], bandDn: bandDn[i], warm: warm[i],
        emaHigh: emaH[i], emaLow: emaL[i], structUp: structUp[i],
        refHigh: refHi, refLow: refLo, lastPivot: pivLast, pivotRising: pivRising,
        a1: { structSeen: a1StructSeen, pulled: a1Pulled },
        a2Stage, bAbove, bFlew, b2Armed,
      });
    }

    return { signals, series };
  }
}

module.exports = { PinakaDetectors };