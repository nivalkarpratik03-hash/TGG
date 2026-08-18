/**
 * motherwave.js
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for Mother Wave (MW) / Driver Wave (DW) detection.
 *
 * 2026-08-13 — REPLACED the previous "last 50 waves, largest, fib-breach OR
 * size-promotion" algorithm with the full-history, succession-rule engine
 * below (ported from the TGGD dev branch), which adds Driver Wave tracking.
 * This changes Mother Wave output app-wide — every consumer of this file
 * (ScannerPage/scannerRunner.js, ReportsPage/chartRouter.js's
 * /api/motherwave, backtestRunner.js, StrategiesPage, scannerS1.S2.S3.js)
 * now sees the new engine's MW, not the old one. Fib math (fibPrice /
 * calcTrapZone / buildFibLevels) still comes from services/fibMath.js —
 * see that file's 2026-08-13 note for the fallback it gained to support
 * this engine's raw wave objects (originPrice/tipPrice field names).
 *
 * Ported from w_mw_dw_logic_py:
 *   waves/detector.py + classification.py  → computeSegments() (wave engine)
 *   mw/engine.py                           → buildMwdwState() MW half
 *   dw/engine.py                           → buildMwdwState() DW half
 *   indicators/atr.py                      → indicatorMath.js (trueRanges/wilderATR)
 *
 * ONE public function: detectMotherWaveForAPI
 *   → Returns: { wave, fibLevels, invalidation, chain, dw, dwChain }
 *     `dw`/`dwChain` are new (Driver Wave) — every other field keeps the
 *     same shape existing consumers already read (mwNo, wave, fibLevels,
 *     invalidation). `chain[i].displacedBy` values changed from
 *     "fib_breach"/"size_promotion" to "S1_LARGER_WAVE" /
 *     "S2_CUT_BEYOND_MW_NEG_0618" / "S3_CUT_BEYOND_MW_1_234" — nothing in
 *     this app's frontend currently branches on those strings, but flagging
 *     it here in case a future consumer does.
 *
 *   chain = [
 *     { mwNo: 0,  wave, fibLevels, invalidation, invalidated: false, displacedBy: null },  ← current MW
 *     { mwNo: -1, wave, fibLevels, invalidation, invalidated: true,  displacedBy: "S1_LARGER_WAVE" | "S2_CUT_BEYOND_MW_NEG_0618" | "S3_CUT_BEYOND_MW_1_234" },
 *     { mwNo: -2, ... },
 *     ...
 *   ]
 *
 * ── ALGORITHM ──────────────────────────────────────────────────────────
 *
 *   1. Process the FULL wave history (not just the last 50) — matches
 *      wave_detection.yaml's `preserve_full_history: true`.
 *   2. MW is initialized once exactly the first `initial_wave_count` (50)
 *      waves have completed: pick the largest of those 50 (ties broken by
 *      most-recent wave_no).
 *   3. From then on, each new completed wave is checked against the current
 *      MW via succession rules, IN THIS ORDER:
 *        S1 — candidate.size > currentMW.size                    → promote immediately
 *        S2 — same direction as MW, size >= 0.5x MW size, AND a
 *             "qualifying cut" (body >= 0.6x ATR14, close beyond the
 *             MW's -0.618 fib level) occurs within the candidate's span
 *                                                                  → promote
 *        S3 — opposite direction, size >= 0.5x MW size, AND a qualifying
 *             cut beyond the MW's 1.234 fib level                → promote
 *      Otherwise the wave is either a Driver Wave candidate (size >= 0.3x
 *      MW size, temporally eligible) or "noise" (no effect on MW/DW state).
 *   4. Driver Wave (DW) also gets invalidated mid-flight if a qualifying cut
 *      beyond its own 1.234 fib level occurs.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { calcEMA, trueRanges, wilderATR } = require("./indicatorMath");
const { fibPrice, calcTrapZone, buildFibLevels } = require("./fibMath");

// ─── Wave detection config ─────────────────────────────────────────────────
// Mirrors w_mw_dw_logic_py/configs/wave_detection.yaml (the REAL production
// values — no longer placeholders). Keep this identical to WAVE_CFG in
// frontend/src/indicators/WavesIndicator.js so the chart overlay and this
// Mother Wave chain are always built from the same waves.
const WAVE_CFG = {
  minimumWaveBars: 3,
  useFivePointValidation: false,
  equalHighLowTolerancePct: 0.2,
  firstPivotSearchLimit: 300,
  laterPivotSearchLimit: 480,
  anyColorBearTrigger: true,
  confirmBar: false,
};

// ─── MW/DW config ───────────────────────────────────────────────────────────
// Mirrors w_mw_dw_logic_py/configs/mw_dw.yaml.
const MWDW_CFG = {
  initialWaveCount: 50,
  s2S3MinRatio: 0.5,
  dwMinRatio: 0.3,
  qualifyingCutBodyAtrRatio: 0.6,
  atrLength: 14,
  fibS2Ratio: -0.618,
  fibS3Ratio: 1.234,
  fibDwInvalidationRatio: 1.234,
  floatEpsilon: 1e-12,
};

function _bearSignals(open_, close_, emaLow, cfg, previousBearNow) {
  const bodyMidBelow = (open_ + close_) / 2 < emaLow;
  const bearNow = cfg.anyColorBearTrigger
    ? bodyMidBelow
    : (close_ < open_ && bodyMidBelow);
  const bearTrigger = cfg.confirmBar
    ? (previousBearNow && close_ < emaLow)
    : bearNow;
  return { bearNow, bearTrigger };
}

// ─── Wave segment computation — ported from waves/detector.py's
// detect_completed_waves() + classification.py's classify_pivot(). Identical
// engine to frontend/src/indicators/WavesIndicator.js. Returns the FULL
// (uncapped) chronological wave list — MW/DW needs the whole history, not
// just the last 50; any display-only capping happens on the frontend.
function computeSegments(candles) {
  if (!candles || candles.length < 5) return [];

  const eH = calcEMA(candles.map(c => c.high), 9);
  const eL = calcEMA(candles.map(c => c.low), 9);
  const cfg = WAVE_CFG;

  const o = candles.map(c => c.open);
  const h = candles.map(c => c.high);
  const l = candles.map(c => c.low);
  const c = candles.map(c => c.close);
  const t = candles.map(c => c.time);

  const minWaveBars = cfg.minimumWaveBars;
  const k = cfg.useFivePointValidation ? 2 : 1;
  const eqTolPct = cfg.equalHighLowTolerancePct;
  const capFirst = cfg.firstPivotSearchLimit;
  const capAfter = cfg.laterPivotSearchLimit;

  // -1: searching for a pivot LOW to start an up-leg
  //  1: searching for a pivot HIGH to close the up-leg
  let legState = -1;
  let lastConfirmation = null; // confirmation bar of the last pivot
  let lastActual = null;       // actual (extreme) bar of the last pivot
  let previousHigh = null;
  let previousLow = null;
  let previousBearNow = false;

  const pivots = [];  // { price, bar, cls, time } chronological
  const waves = [];   // pivot-to-pivot legs, chronological, full history

  for (let i = 0; i < candles.length; i++) {
    if (eH[i] == null || eL[i] == null) { previousBearNow = false; continue; }

    const waveLongEnough =
      lastConfirmation === null || i - lastConfirmation + 1 >= minWaveBars;

    const greenBull = c[i] > o[i] && c[i] > eH[i];
    const { bearNow, bearTrigger } = _bearSignals(o[i], c[i], eL[i], cfg, previousBearNow);

    let npType = 0, npPrice = null, npBar = null;

    if (legState === -1 && greenBull && waveLongEnough) {
      const span =
        lastActual === null
          ? Math.min(i, capFirst)
          : Math.max(Math.min(i - lastActual - 1, capAfter), 1);
      const start = i - span;

      let bestIdx = start, bestVal = l[start];
      for (let j = start; j <= i; j++) {
        if (l[j] < bestVal) { bestVal = l[j]; bestIdx = j; } // leftmost tie winner
      }

      let valid = true;
      for (let j = 1; j <= k; j++) {
        const loBar = Math.max(bestIdx - j, start);
        const hiBar = Math.min(bestIdx + j, i);
        if (Math.min(l[loBar], l[hiBar]) < bestVal) { valid = false; break; }
      }

      if (valid) { npPrice = bestVal; npBar = bestIdx; npType = -1; }
    }

    else if (legState === 1 && bearTrigger && waveLongEnough) {
      const span =
        lastActual === null
          ? Math.min(i, capFirst)
          : Math.max(Math.min(i - lastActual - 1, capAfter), 1);
      const start = i - span;

      let bestIdx = start, bestVal = h[start];
      for (let j = start; j <= i; j++) {
        if (h[j] > bestVal) { bestVal = h[j]; bestIdx = j; }
      }

      let valid = true;
      for (let j = 1; j <= k; j++) {
        const loBar = Math.max(bestIdx - j, start);
        const hiBar = Math.min(bestIdx + j, i);
        if (Math.max(h[loBar], h[hiBar]) > bestVal) { valid = false; break; }
      }

      if (valid) { npPrice = bestVal; npBar = bestIdx; npType = 1; }
    }

    if (npType !== 0) {
      // classify_pivot(): HH/LH/EH for highs, HL/LL/EL for lows, H/L for the first
      const ref = npType === 1 ? previousHigh : previousLow;
      let cls;
      if (ref === null) {
        cls = npType === 1 ? "H" : "L";
      } else {
        const dPct = (Math.abs(npPrice - ref) / ref) * 100;
        if (dPct <= eqTolPct) cls = npType === 1 ? "EH" : "EL";
        else if (npType === 1) cls = npPrice > ref ? "HH" : "LH";
        else cls = npPrice > ref ? "HL" : "LL";
      }

      if (pivots.length) {
        const prev = pivots[pivots.length - 1];
        waves.push({
          waveNo: waves.length + 1, // ascending, 1-based — matches python wave_no
          direction: npType === 1 ? "bull" : "bear", // origin was a LOW → bull leg up to this HIGH
          originBarIndex: prev.bar, originPrice: prev.price, originTime: prev.time,
          tipBarIndex: npBar, tipPrice: npPrice, tipTime: t[npBar],
          size: Math.abs(npPrice - prev.price),
          tipConfirmationBarIndex: i, tipConfirmationTime: t[i],
          toSide: npType === 1 ? "high" : "low",
          prevWaveType: prev.cls, currWaveType: cls,
        });
      }

      pivots.push({ price: npPrice, bar: npBar, cls, time: t[npBar] });

      if (npType === 1) { previousHigh = npPrice; legState = -1; }
      else { previousLow = npPrice; legState = 1; }
      lastConfirmation = i;
      lastActual = npBar;
    }

    previousBearNow = bearNow;
  }

  // waveNum: display label used by the frontend chart/report table (-1 = most
  // recent, -2 = one before, ...). Anchored to "distance from the most recent
  // wave", so it's identical whether computed over the full history (here) or
  // a display-capped slice (frontend) — the two always agree for any wave
  // that's actually visible on the frontend.
  const total = waves.length;
  waves.forEach((w, i) => { w.waveNum = -(total - i); });

  return waves;
}

// ─── Fib helpers ─────────────────────────────────────────────────────────────
// fibPrice / buildFibLevels now come from services/fibMath.js (this app's
// single source of truth for fib math — see require() above). fibMath.js's
// fibPrice already falls back through tipPrice/originPrice (this engine's
// raw wave field names) as well as toPrice/fromPrice (buildWaveObj()'s
// public shape), so both this file's internal callers (mwSuccession,
// buildMwdwState, buildPerBarMwDwTimeline — pass raw wave records) and
// external callers (scannerS1.S2.S3.js, StrategiesPage.js — pass the
// buildWaveObj()-shaped { toPrice, fromPrice }) get identical results, with
// zero local duplication.

// Build the wave object (public shape) — UNCHANGED field names from before,
// so every existing consumer (ReportsPage, ScannerPage, StrategiesPage,
// scannerS1.S2.S3.js) keeps working with zero changes.
function buildWaveObj(wave) {
  return {
    dir: wave.direction,
    col1Time: wave.originTime,
    col1Price: wave.originPrice,
    col2Time: wave.tipTime,
    col2Price: wave.tipPrice,
    delta: +wave.size.toFixed(2),
    waveNum: wave.waveNum,
    label: (wave.prevWaveType && wave.currWaveType)
      ? `${wave.prevWaveType}\u2192${wave.currWaveType}`
      : "—",
    toSide: wave.toSide,
    fromPrice: wave.originPrice,
    toPrice: wave.tipPrice,
    fromTime: wave.originTime,
    toTime: wave.tipTime,
    startIndex: wave.originBarIndex,
    endIndex: wave.tipBarIndex,
  };
}

// ─── Qualifying cut — ported from mw/engine.py ─────────────────────────────
function evaluateQualifyingCut(candles, barIndex, atrExclusive, level, direction, timeframe, cfg) {
  const candle = candles[barIndex];
  if (atrExclusive == null) return { evidence: null, rejection: "ATR_UNAVAILABLE" };
  const body = Math.abs(candle.close - candle.open);
  if (body < cfg.qualifyingCutBodyAtrRatio * atrExclusive) return { evidence: null, rejection: "BODY_TOO_SMALL" };
  const beyond = direction === "UP" ? candle.close > level : candle.close < level;
  if (!beyond) return { evidence: null, rejection: "CLOSE_NOT_BEYOND" };
  if (timeframe === "daily" && barIndex > 0) {
    const previousClose = candles[barIndex - 1].close;
    const gap = direction === "UP"
      ? (previousClose <= level && candle.open > level)
      : (previousClose >= level && candle.open < level);
    if (gap) return { evidence: null, rejection: "DAILY_GAP_OVER_LEVEL" };
  }
  return {
    evidence: {
      barIndex, time: candle.time, open: candle.open, close: candle.close,
      body, atrExclusive, level, direction,
    },
    rejection: null,
  };
}

function findQualifyingCut(candles, atr, start, end, level, direction, timeframe, cfg) {
  for (let barIndex = Math.max(start, 1); barIndex <= end; barIndex++) {
    const { evidence } = evaluateQualifyingCut(candles, barIndex, atr[barIndex - 1], level, direction, timeframe, cfg);
    if (evidence) return evidence;
  }
  return null;
}

// S1/S2/S3 succession check for a candidate wave against the current MW.
function mwSuccession(candidate, currentMwWave, candles, atr, timeframe, cfg) {
  if (candidate.size > currentMwWave.size + cfg.floatEpsilon) {
    return { rule: "S1_LARGER_WAVE", cut: null };
  }
  if (candidate.size + cfg.floatEpsilon < cfg.s2S3MinRatio * currentMwWave.size) {
    return { rule: null, cut: null };
  }
  const sameDirection = candidate.direction === currentMwWave.direction;
  const ratio = sameDirection ? cfg.fibS2Ratio : cfg.fibS3Ratio;
  const level = fibPrice(currentMwWave, ratio);
  let direction, rule;
  if (sameDirection) {
    direction = currentMwWave.direction === "bull" ? "UP" : "DOWN";
    rule = "S2_CUT_BEYOND_MW_NEG_0618";
  } else {
    direction = currentMwWave.direction === "bull" ? "DOWN" : "UP";
    rule = "S3_CUT_BEYOND_MW_1_234";
  }
  const cut = findQualifyingCut(
    candles, atr, candidate.originBarIndex + 1, candidate.tipBarIndex,
    level, direction, timeframe, cfg,
  );
  return cut ? { rule, cut } : { rule: null, cut: null };
}

// ─── Driver Wave qualification — ported from dw/engine.py ─────────────────
function qualifiesAsDriverSize(wave, mwWave, cfg) {
  return wave.waveNo !== mwWave.waveNo && wave.size + cfg.floatEpsilon >= cfg.dwMinRatio * mwWave.size;
}
function isTemporallyEligibleDriver(wave, mwWave, mwActivatedAtBar) {
  return wave.waveNo !== mwWave.waveNo
    && wave.originBarIndex >= mwWave.originBarIndex
    && wave.tipConfirmationBarIndex >= mwActivatedAtBar;
}
function qualifiesAsForwardDriver(wave, mwWave, mwActivatedAtBar, invalidatedSet, cfg) {
  return !invalidatedSet.has(wave.waveNo)
    && qualifiesAsDriverSize(wave, mwWave, cfg)
    && isTemporallyEligibleDriver(wave, mwWave, mwActivatedAtBar);
}

// ─── MW/DW state machine — ported from mw/engine.py's build_mwdw_state().
// Processes the full wave history sequentially. `timeframe` defaults to
// "intraday" (the daily-gap qualifying-cut exception only applies when
// timeframe === "daily"; none of TGGD's current callers pass a timeframe).
function buildMwdwState(candles, waves, timeframe, cfg) {
  const trs = trueRanges(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close));
  const atr = wilderATR(trs, cfg.atrLength);

  const wavesByConfirmation = new Map();
  waves.forEach(w => wavesByConfirmation.set(w.tipConfirmationBarIndex, w));

  const completed = [];
  const mwPeriods = [];
  const dwPeriods = [];
  const invalidated = new Set();
  let currentMw = null;
  let currentDw = null;

  for (let barIndex = 0; barIndex < candles.length; barIndex++) {
    const candle = candles[barIndex];
    const wave = wavesByConfirmation.get(barIndex) || null;

    // DW invalidation: a qualifying cut beyond the DW's own 1.234 fib level
    if (currentDw) {
      const direction = currentDw.wave.direction === "bull" ? "DOWN" : "UP";
      const level = fibPrice(currentDw.wave, cfg.fibDwInvalidationRatio);
      const atrExclusive = barIndex > 0 ? atr[barIndex - 1] : null;
      const { evidence } = evaluateQualifyingCut(candles, barIndex, atrExclusive, level, direction, timeframe, cfg);
      if (evidence) {
        invalidated.add(currentDw.wave.waveNo);
        currentDw.deactivatedAtBar = barIndex;
        currentDw.deactivatedAtTime = candle.time;
        currentDw.endReason = "INVALIDATED_BY_QUALIFYING_CUT_1_234";
        currentDw.invalidationCut = evidence;
        currentDw = null;
      }
    }

    if (wave) {
      completed.push(wave);

      if (!currentMw && completed.length === cfg.initialWaveCount) {
        // Largest of the first 50 waves; ties broken by most-recent wave_no
        // (mirrors mw_dw.yaml's first_50_equal_size_tie: most_recent_wave).
        let selected = completed[0];
        for (const w of completed) {
          if (w.size > selected.size || (w.size === selected.size && w.waveNo > selected.waveNo)) selected = w;
        }
        currentMw = {
          mwPeriodNo: mwPeriods.length + 1,
          wave: selected,
          activatedAtBar: barIndex,
          activatedAtTime: candle.time,
          activationRule: "INITIAL_LARGEST_FIRST_50",
          previousMwWaveNo: null,
          triggerWaveNo: wave.waveNo,
          qualifyingCut: null,
          deactivatedAtBar: null, deactivatedAtTime: null, replacementWaveNo: null, endReason: null,
        };
        mwPeriods.push(currentMw);
        currentDw = null; // forward-only lifecycle: MW starts without a historical DW
      } else if (currentMw) {
        const { rule, cut } = mwSuccession(wave, currentMw.wave, candles, atr, timeframe, cfg);
        if (rule) {
          const oldMwWaveNo = currentMw.wave.waveNo;
          currentMw.deactivatedAtBar = barIndex;
          currentMw.deactivatedAtTime = candle.time;
          currentMw.replacementWaveNo = wave.waveNo;
          currentMw.endReason = rule;
          if (currentDw) {
            currentDw.deactivatedAtBar = barIndex;
            currentDw.deactivatedAtTime = candle.time;
            currentDw.endReason = "MW_CHANGED";
            currentDw = null;
          }
          currentMw = {
            mwPeriodNo: mwPeriods.length + 1,
            wave,
            activatedAtBar: barIndex,
            activatedAtTime: candle.time,
            activationRule: rule,
            previousMwWaveNo: oldMwWaveNo,
            triggerWaveNo: wave.waveNo,
            qualifyingCut: cut,
            deactivatedAtBar: null, deactivatedAtTime: null, replacementWaveNo: null, endReason: null,
          };
          mwPeriods.push(currentMw);
          // The successor wave is the MW and cannot also become its own DW.
          currentDw = null;
        } else if (qualifiesAsForwardDriver(wave, currentMw.wave, currentMw.activatedAtBar, invalidated, cfg)) {
          if (currentDw) {
            currentDw.deactivatedAtBar = barIndex;
            currentDw.deactivatedAtTime = candle.time;
            currentDw.replacementDwWaveNo = wave.waveNo;
            currentDw.endReason = "REPLACED_BY_NEWER_QUALIFYING_WAVE";
          }
          currentDw = {
            dwPeriodNo: dwPeriods.length + 1,
            parentMwPeriodNo: currentMw.mwPeriodNo,
            parentMwWaveNo: currentMw.wave.waveNo,
            wave,
            dwToMwRatio: wave.size / currentMw.wave.size,
            thresholdRatio: cfg.dwMinRatio,
            activatedAtBar: barIndex,
            activatedAtTime: candle.time,
            selectionTriggerWaveNo: wave.waveNo,
            activationReason: "NEWER_WAVE_AT_LEAST_0_3_MW",
            deactivatedAtBar: null, deactivatedAtTime: null, replacementDwWaveNo: null, endReason: null, invalidationCut: null,
          };
          dwPeriods.push(currentDw);
        }
        // else: noise wave — no effect on MW/DW state
      }
    }
  }

  return { mwPeriods, dwPeriods, invalidatedDwWaveNumbers: invalidated, currentMw, currentDw };
}

// ─── API-ready MW detection — THE ONE PUBLIC FUNCTION ─────────────────────────
//
// Returns:
// {
//   wave, fibLevels, invalidation,   ← current MW (top-level, for backward compat)
//   chain: [
//     { mwNo: 0,  wave, fibLevels, invalidation, invalidated: false, displacedBy: null },
//     { mwNo: -1, wave, fibLevels, invalidation, invalidated: true,  displacedBy },
//     ...
//   ]
// }
//
// `timeframe` defaults to "intraday" — pass "daily" only for daily-resolution
// candles, which is the only case where the daily-gap qualifying-cut
// exception (mw_dw.yaml's daily_gap_definition) applies.
function detectMotherWaveForAPI(candles, timeframe = "intraday") {
  const waves = computeSegments(candles);
  if (!waves.length) return null;

  const { mwPeriods, dwPeriods, currentDw } = buildMwdwState(candles, waves, timeframe, MWDW_CFG);
  if (!mwPeriods.length) return null; // fewer than initialWaveCount waves so far

  // current-first ordering: mwNo 0 = current (last created), -1 = previous, ...
  const chainOrdered = [...mwPeriods].reverse();
  const chain = chainOrdered.map((period, idx) => {
    const fibs = buildFibLevels(period.wave);
    return {
      mwNo: -idx,
      // Internal ascending wave number (period.wave.waveNo) — additive field,
      // kept separate from wave.waveNum (the display-only, distance-from-most-
      // recent label already exposed on buildWaveObj). Lets a DW chain entry's
      // parentMwWaveNo be matched back to "which MW period is this" without
      // guessing from position, e.g. ReportsPage scoping its DW list to only
      // the current MW. Existing consumers ignore unknown fields, so this is
      // safe to add without touching chain's established shape.
      waveNo: period.wave.waveNo,
      wave: buildWaveObj(period.wave),
      fibLevels: fibs,
      invalidation: fibs["-0.618"],
      invalidated: idx !== 0,
      displacedBy: idx === 0 ? null : period.endReason, // "S1_LARGER_WAVE" | "S2_CUT_BEYOND_MW_NEG_0618" | "S3_CUT_BEYOND_MW_1_234"
    };
  });

  const current = chain[0];

  // ── Driver Wave — additive, does not touch anything above. current-first
  // ordering, same convention as the MW chain. `currentDw` (returned
  // directly by buildMwdwState) is the source of truth for which dwPeriod,
  // if any, is still active — no positional guessing needed.
  const dwChainOrdered = [...dwPeriods].reverse();
  const dwChain = dwChainOrdered.map((period, idx) => {
    const fibs = buildFibLevels(period.wave);
    const isActive = currentDw === period;
    return {
      dwNo: -idx,
      wave: buildWaveObj(period.wave),
      fibLevels: fibs,
      // invalidation kept as its own explicit field (same value as
      // fibs["1.234"] now that buildFibLevels() includes it) — callers that
      // only care about "is DW invalidated" shouldn't need to know the key.
      invalidation: fibPrice(period.wave, MWDW_CFG.fibDwInvalidationRatio),
      parentMwWaveNo: period.parentMwWaveNo,
      dwToMwRatio: +period.dwToMwRatio.toFixed(4),
      thresholdRatio: period.thresholdRatio,
      invalidated: !isActive,
      // "INVALIDATED_BY_QUALIFYING_CUT_1_234" | "MW_CHANGED" |
      // "REPLACED_BY_NEWER_QUALIFYING_WAVE" | null (still active)
      endReason: isActive ? null : period.endReason,
    };
  });
  // No active DW is a normal, expected state (forward-only lifecycle — see
  // buildMwdwState above), not an error. But leaving `dw` as bare `null`
  // meant every consumer (Charts fib overlay, Reports summary) rendered
  // nothing at all even when a DW existed and only just ended.
  //
  // dwChain[0] is NOT safe to use directly here: it's the most recent DW
  // period across ALL Mother Waves, not just the current one. A DW that
  // ended via MW_CHANGED belongs to the PREVIOUS MW — surfacing it under the
  // current MW would show the wrong wave entirely. Scope by parentMwWaveNo
  // (mirrors the same filter ReportsPage.js's DriverWaveSection already
  // applies independently) before taking the most recent one.
  const mostRecentDwForCurrentMw = currentDw
    ? dwChain[0]
    : dwChain.find(d => d.parentMwWaveNo === current.waveNo) || null;
  const dw = currentDw
    ? mostRecentDwForCurrentMw
    : (mostRecentDwForCurrentMw ? { ...mostRecentDwForCurrentMw, isInvalidatedFallback: true } : null);

  return {
    wave: current.wave,
    fibLevels: current.fibLevels,
    invalidation: current.invalidation,
    chain,
    // Driver Wave — same entry shape as a chain entry, or null if none active.
    dw,
    dwChain,
  };
}

// ─── Zone classification — uses the shared fibPrice (services/fibMath.js),
// same fallback (toPrice/fromPrice OR tipPrice/originPrice) as everything
// else in this file. calcTrapZone itself is re-exported directly from
// fibMath.js below (module.exports) — no local copy needed here anymore.
function classifyZone(mw, currentPrice) {
  const w = mw.wave || mw;
  if (!w || currentPrice == null) return "other";
  const to = w.toPrice ?? w.tipPrice;
  const from = w.fromPrice ?? w.originPrice;
  const span = Math.abs(from - to);
  const tol = span * 0.05;

  if (Math.abs(currentPrice - fibPrice(w, 0.618)) <= tol) return "hot618";
  if (Math.abs(currentPrice - fibPrice(w, 0.382)) <= tol) return "near382";

  const tip = fibPrice(w, 0);
  const ret = fibPrice(w, 0.236);
  const trapHigh = Math.max(tip, ret);
  const trapLow = Math.min(tip, ret);
  if (currentPrice >= trapLow && currentPrice <= trapHigh) return "trap";

  return "other";
}

// ─── Per-bar MW/DW timeline — additive, read-only wrapper ─────────────────────
// Does NOT change MW/DW detection in any way — it just replays the SAME
// mwPeriods/dwPeriods that buildMwdwState() already produces (activatedAtBar /
// deactivatedAtBar are already tracked on every period) into a flat
// "which wave number was the active MW/DW as of bar i" lookup, matching the
// w_mw_dw_heatmap-main Python pipeline's per-row `mw_wave_no_after_bar` /
// `dw_wave_no_after_bar` timeline columns (phase3_build_mwdw.py).
// Needed by strategies/typeREF.js (Type E / Type R triggers reference
// "whichever DW is active on this bar") — added here instead of duplicating
// buildMwdwState's succession/invalidation logic a second time.
function buildPerBarMwDwTimeline(candles, timeframe = "intraday") {
  const waves = computeSegments(candles);
  const n = candles.length;
  const mwWaveNoAfterBar = new Array(n).fill(null);
  const dwWaveNoAfterBar = new Array(n).fill(null);
  if (!waves.length) return { waves, mwPeriods: [], dwPeriods: [], mwWaveNoAfterBar, dwWaveNoAfterBar };

  const { mwPeriods, dwPeriods } = buildMwdwState(candles, waves, timeframe, MWDW_CFG);

  const fill = (periods, out) => {
    for (const period of periods) {
      const start = period.activatedAtBar;
      // deactivatedAtBar is the bar on which the OLD period stops being
      // current (the new state — successor MW, or no DW — already applies
      // from that same bar onward, mirroring how buildMwdwState nulls
      // currentDw at that same barIndex before moving on).
      const end = period.deactivatedAtBar == null ? n - 1 : period.deactivatedAtBar - 1;
      for (let i = start; i <= end && i < n; i++) out[i] = period.wave.waveNo;
    }
  };
  fill(mwPeriods, mwWaveNoAfterBar);
  fill(dwPeriods, dwWaveNoAfterBar);

  return { waves, mwPeriods, dwPeriods, mwWaveNoAfterBar, dwWaveNoAfterBar };
}

module.exports = {
  detectMotherWaveForAPI,
  // fibPrice / calcTrapZone / buildFibLevels are forwarded straight through
  // from services/fibMath.js (this app's single source of truth for fib
  // math) — kept as exports here too since scannerRunner.js and other
  // existing callers already do `require("./motherwave").calcTrapZone` etc.
  fibPrice,
  calcTrapZone,
  buildFibLevels,
  classifyZone,
  computeSegments,
  buildPerBarMwDwTimeline,
  // Additive exports — pure addition, no existing export's behavior or
  // signature changes. Not currently called from outside this file except
  // by strategies/typeREF.js (buildPerBarMwDwTimeline, fibPrice), but kept
  // exported for any future bounded-incremental or reporting use.
  buildWaveObj,
  mwSuccession,
  evaluateQualifyingCut,
  qualifiesAsForwardDriver,
  qualifiesAsDriverSize,
  MWDW_CFG,
};