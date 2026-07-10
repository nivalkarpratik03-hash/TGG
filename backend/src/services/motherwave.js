/**
 * motherwave.js
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for Mother Wave detection.
 *
 * ONE public function: detectMotherWaveForAPI
 *   → Returns: { wave, fibLevels, invalidation, chain }
 *
 *   chain = [
 *     { mwNo: 0,  wave, fibLevels, invalidation },   ← current MW
 *     { mwNo: -1, wave, fibLevels, invalidation },   ← previous (invalidated)
 *     { mwNo: -2, wave, fibLevels, invalidation },   ← older
 *     ...
 *   ]
 *
 * ── ALGORITHM ────────────────────────────────────────────────────
 *
 *   1. Take last 50 wave segments, sorted chronologically.
 *   2. Find the LARGEST wave by delta → first MW candidate.
 *   3. Check all waves AFTER it:
 *        BULL MW invalidated when: any wave HIGH > -0.618 fib  OR  any wave LOW < 1.0 fib (origin)
 *        BEAR MW invalidated when: any wave LOW  < -0.618 fib  OR  any wave HIGH > 1.0 fib (origin)
 *        RULE 3 — Equal/Larger Wave Promotion:
 *          If any subsequent wave size >= current MW size → promote as new MW
 *        RULE 4 — Fibonacci Containment but Larger → Promote:
 *          If a subsequent wave does NOT breach -0.618 / 1.0 fib levels but its
 *          size > current MW size → still promote as new MW
 *          (Rule 4 is implicitly covered by Rule 3; both are handled together)
 *   4. If invalidated or promoted → record that MW in chain, find LARGEST wave
 *      among waves from the invalidating/promoting wave onward → repeat.
 *   5. If not invalidated/promoted → current MW (mwNo = 0).
 *   6. Number the chain: 0 = current, -1 = previous, -2 = older ...
 *
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

// ─── EMA helper ───────────────────────────────────────────────────────────────
// Single source of truth — see backend/src/services/indicatorMath.js
const { calcEMA } = require("./indicatorMath");

// ─── Wave segment computation (matches WavesIndicator.js) ─────────────────────
function computeSegments(candles) {
  if (!candles || candles.length < 5) return [];

  const eH = calcEMA(candles.map(c => c.high), 9);
  const eL = calcEMA(candles.map(c => c.low), 9);

  let state = 0, bestPrice = null, bestBar = null, legTouchedEMA = false;
  let lastPrice = null, lastBar = null, prevWaveType = "";
  let prevHigh = null, prevLow = null, currWaveType = "";
  const segments = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const emaH = eH[i], emaL = eL[i];
    if (emaH == null || emaL == null) continue;

    const isGreen = c.close > c.open;
    const isRed = c.close < c.open;
    const touchHigh = (isGreen && c.close > emaH) || (isRed && c.open > emaH);
    const touchLow = (isGreen && c.open < emaL) || (isRed && c.close < emaL);

    if (state === 0) {
      if (touchHigh) { state = 1; bestPrice = c.high; bestBar = i; legTouchedEMA = true; }
      else if (touchLow) { state = -1; bestPrice = c.low; bestBar = i; legTouchedEMA = true; }
      continue;
    }

    if (state === 1) {
      if (c.high > bestPrice) { bestPrice = c.high; bestBar = i; }
      if (touchHigh) legTouchedEMA = true;
      if (touchLow && legTouchedEMA) {
        const lp = bestPrice, lb = bestBar;
        currWaveType = prevHigh === null ? "HH" : lp > prevHigh ? "HH" : "LH";
        prevHigh = lp;
        if (lastPrice !== null) {
          segments.push({
            fromBarIndex: lastBar, fromPrice: lastPrice,
            toBarIndex: lb, toPrice: lp, toSide: "high",
            fromTime: candles[lastBar].time, toTime: candles[lb].time,
            prevWaveType, currWaveType,
          });
        }
        prevWaveType = currWaveType; lastPrice = lp; lastBar = lb;
        state = -1; bestPrice = c.low; bestBar = i; legTouchedEMA = touchLow;
      }
      continue;
    }

    if (state === -1) {
      if (c.low < bestPrice) { bestPrice = c.low; bestBar = i; }
      if (touchLow) legTouchedEMA = true;
      if (touchHigh && legTouchedEMA) {
        const lp = bestPrice, lb = bestBar;
        currWaveType = prevLow === null ? "LL" : lp < prevLow ? "LL" : "HL";
        prevLow = lp;
        if (lastPrice !== null) {
          segments.push({
            fromBarIndex: lastBar, fromPrice: lastPrice,
            toBarIndex: lb, toPrice: lp, toSide: "low",
            fromTime: candles[lastBar].time, toTime: candles[lb].time,
            prevWaveType, currWaveType,
          });
        }
        prevWaveType = currWaveType; lastPrice = lp; lastBar = lb;
        state = 1; bestPrice = c.high; bestBar = i; legTouchedEMA = touchHigh;
      }
      continue;
    }
  }

  return segments;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
const sp = s => Math.abs(s.toPrice - s.fromPrice);
const bull = s => s.toSide === "high";

// Build fib levels object from a wave segment
function buildFibLevels(seg) {
  const isBull = bull(seg);
  const span = sp(seg);
  const origin = seg.fromPrice;
  const end = seg.toPrice;

  return isBull
    ? {
      "-0.618": end + 0.618 * span,   // invalidation — extension above tip
      "0.0": end,
      "0.236": end - 0.236 * span,
      "0.382": end - 0.382 * span,
      "0.5": end - 0.5 * span,
      "0.618": end - 0.618 * span,
      "0.786": end - 0.786 * span,
      "1.0": origin,               // invalidation — origin / base
    }
    : {
      "1.0": origin,               // invalidation — origin / base
      "0.786": origin - 0.214 * span,
      "0.618": origin - 0.382 * span,
      "0.5": origin - 0.5 * span,
      "0.382": origin - 0.618 * span,
      "0.236": origin - 0.764 * span,
      "0.0": end,
      "-0.618": end - 0.618 * span,   // invalidation — extension below tip
    };
}

// Build the wave object (public shape) from a segment + waveNum
function buildWaveObj(seg, waveNum) {
  return {
    dir: bull(seg) ? "bull" : "bear",
    col1Time: seg.fromTime,
    col1Price: seg.fromPrice,
    col2Time: seg.toTime,
    col2Price: seg.toPrice,
    delta: +sp(seg).toFixed(2),
    waveNum,
    label: (seg.prevWaveType && seg.currWaveType)
      ? `${seg.prevWaveType}\u2192${seg.currWaveType}`
      : "—",
    toSide: seg.toSide,
    fromPrice: seg.fromPrice,
    toPrice: seg.toPrice,
    fromTime: seg.fromTime,
    toTime: seg.toTime,
    startIndex: seg.fromBarIndex,
    endIndex: seg.toBarIndex,
  };
}

// ─── MW Displacement checker ──────────────────────────────────────────────────
//
// Scans waves that come after the current MW candidate and returns the FIRST
// wave that either:
//
//   (A) INVALIDATES the MW via Fibonacci breach  [original rules 1 & 2]
//         BULL MW: any wave HIGH > -0.618 fib  OR  any wave LOW  < 1.0 fib
//         BEAR MW: any wave LOW  < -0.618 fib  OR  any wave HIGH > 1.0 fib
//
//   (B) PROMOTES itself as a new MW via size  [new rules 3 & 4]
//         Rule 3 — Equal Wave Size:
//           new wave size >= current MW size → promote (regardless of fib position)
//         Rule 4 — Contained but Larger:
//           wave does NOT breach -0.618 / 1.0 levels (contained within fibs)
//           BUT its size > current MW size → still promote
//         Both Rule 3 & 4 reduce to the same numeric test:
//           sp(w) >= sp(mwSeg)
//         Rule 3 covers the >= case outright.
//         Rule 4 is the explicit callout for the contained sub-case, already
//         captured by Rule 3 since containment ⊂ all waves.
//
// Returns: { wave, reason }
//   reason = "fib_breach" | "size_promotion"
//   or null if no displacement found
//
function findDisplacingWave(mwSeg, fibLevels, laterWaves) {
  const isBull = bull(mwSeg);
  const inv = fibLevels["-0.618"];   // extension invalidation level
  const originLvl = fibLevels["1.0"];      // origin invalidation level
  const mwSize = sp(mwSeg);             // current MW size (for Rules 3 & 4)

  for (const w of laterWaves) {
    if (w.fromTime <= mwSeg.toTime) continue; // must be strictly after MW tip

    // ── Rule 3 & 4: Size promotion ─────────────────────────────────────────
    // Check size FIRST so that a wave that is both a fib-breacher AND size-
    // promoter gets labelled as a promotion (the dominant reason).
    if (sp(w) >= mwSize) {
      return { wave: w, reason: "size_promotion" };
    }

    // ── Original rules 1 & 2: Fibonacci breach invalidation ────────────────
    if (isBull) {
      if (bull(w) && w.toPrice > inv) return { wave: w, reason: "fib_breach" };
      if (!bull(w) && w.toPrice < originLvl) return { wave: w, reason: "fib_breach" };
    } else {
      if (!bull(w) && w.toPrice < inv) return { wave: w, reason: "fib_breach" };
      if (bull(w) && w.toPrice > originLvl) return { wave: w, reason: "fib_breach" };
    }
  }

  return null;
}

// ─── API-ready MW detection — THE ONE PUBLIC FUNCTION ─────────────────────────
//
// Returns:
// {
//   wave, fibLevels, invalidation,   ← current MW (top-level, for backward compat)
//   chain: [
//     { mwNo: 0,  wave, fibLevels, invalidation, displacedBy },   current
//     { mwNo: -1, wave, fibLevels, invalidation, displacedBy },   previous
//     ...
//   ]
// }
//
// displacedBy: "fib_breach" | "size_promotion" | null
//
function detectMotherWaveForAPI(candles) {
  const segs = computeSegments(candles);
  if (!segs.length) return null;

  // Sort chronologically — oldest first
  const allWaves = [...segs].sort((a, b) => a.fromTime - b.fromTime);

  // Cap to last MAX_WAVES=50 segments
  const MAX_WAVES = 50;
  const waves = allWaves.slice(-MAX_WAVES);

  // Assign waveNum labels: -N for oldest, -1 for newest
  const total = waves.length;
  waves.forEach((w, i) => { w._waveNum = -(total - i); });

  // ── Iterative MW chain builder ───────────────────────────────────────────
  // Each iteration:
  //   1. Find largest wave in the current search window
  //   2. Check if anything after it displaces it (fib breach OR size promotion)
  //   3. If yes → record it, advance window to start from displacing wave
  //   4. If no  → it's the current (live) MW → stop

  const rawChain = [];       // collected chronologically (oldest MW first)
  let searchStart = 0;       // index into waves[] to search from
  const MAX_ITER = 20;      // safety cap
  let iter = 0;

  while (searchStart < waves.length && iter++ < MAX_ITER) {
    const pool = waves.slice(searchStart);
    if (!pool.length) break;

    // Find largest wave in this pool
    let largestIdx = 0;
    let largestDelta = 0;
    for (let k = 0; k < pool.length; k++) {
      const d = sp(pool[k]);
      if (d > largestDelta) { largestDelta = d; largestIdx = k; }
    }

    const mwSeg = pool[largestIdx];
    const fibs = buildFibLevels(mwSeg);
    const mwAbsIdx = waves.indexOf(mwSeg);
    const laterWaves = waves.slice(mwAbsIdx + 1);

    const displacement = findDisplacingWave(mwSeg, fibs, laterWaves);

    if (!displacement) {
      // No displacement → this is the current (live) MW
      rawChain.push({ seg: mwSeg, fibs, invalidated: false, displacedBy: null });
      break;
    } else {
      // Displaced (fib breach or size promotion) → record and advance
      rawChain.push({
        seg: mwSeg,
        fibs,
        invalidated: true,
        displacedBy: displacement.reason,  // "fib_breach" | "size_promotion"
      });
      searchStart = waves.indexOf(displacement.wave);
    }
  }

  if (!rawChain.length) return null;

  // ── Number the chain: current = mwNo 0, previous = -1, -2 … ────────────
  const chainOrdered = [...rawChain].reverse(); // current-first
  const chain = chainOrdered.map(({ seg, fibs, invalidated, displacedBy }, idx) => {
    const mwNo = -idx;
    const wave = buildWaveObj(seg, seg._waveNum);
    return {
      mwNo,
      wave,
      fibLevels: fibs,
      invalidation: fibs["-0.618"],
      invalidated,
      displacedBy,  // null for current MW; "fib_breach"/"size_promotion" for older ones
    };
  });

  const current = chain[0];

  return {
    wave: current.wave,
    fibLevels: current.fibLevels,
    invalidation: current.invalidation,
    chain,
  };
}

// ─── Fib helpers ─────────────────────────────────────────────────────────────
function fibPrice(mw, ratio) {
  const w = mw.wave || mw;
  const to = w.toPrice ?? w.endPrice;
  const from = w.fromPrice ?? w.startPrice;
  return to + ratio * (from - to);
}

function calcTrapZone(mw) {
  const w = mw.wave || mw;
  const tip = fibPrice(w, 0);
  const ret = fibPrice(w, 0.236);
  return {
    high: Math.max(tip, ret),
    low: Math.min(tip, ret),
    center: (tip + ret) / 2,
    range: Math.abs(w.toPrice - w.fromPrice),
  };
}

function classifyZone(mw, currentPrice) {
  const w = mw.wave || mw;
  if (!w || currentPrice == null) return "other";
  const span = Math.abs(w.fromPrice - w.toPrice);
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

module.exports = {
  detectMotherWaveForAPI,
  fibPrice,
  calcTrapZone,
  classifyZone,
  computeSegments,
};