/**
 * motherwave.js
 * ─────────────────────────────────────────────────────────────────
 * Single source of truth for Mother Wave (MW) / Driver Wave (DW) detection.
 *
 * ONE public function: detectMotherWaveForAPI
 *   → Returns: { wave, fibLevels, invalidation, chain, driverWave }
 *
 *   chain = [
 *     { mwNo: 0,  wave, fibLevels, invalidation, crownedBy, displacedBy },  ← current MW
 *     { mwNo: -1, wave, fibLevels, invalidation, crownedBy, displacedBy },  ← previous
 *     { mwNo: -2, ... },   ← older
 *     ...
 *   ]
 *
 * ── PORTED (28-Jul-2026) ─────────────────────────────────────────
 * The wave-detection, Mother Wave, and Driver Wave strategy logic below is
 * a direct port of the Python reference implementation
 * (src/wave_detector.py's `StreamingWaveEngine`, itself ported from the
 * Owner's Pine Script `MW_DW_TypeE_ema_wave_engine.pine`). This REPLACES
 * the previous algorithm (running-extreme EMA-touch state machine +
 * fib-breach/size-promotion chain scan). Only the wave/MW/DW detection
 * logic changed — `fibPrice`, `calcTrapZone`, `classifyZone`, and the
 * public function names/shapes below are unchanged (additive fields only:
 * `driverWave`, `promotionLevel618`, `invalidationLevel1234`, `crownedBy`).
 *
 * ── ALGORITHM (matches src/wave_detector.py exactly) ────────────────────
 *
 * 1. WAVE / PIVOT DETECTION (Pine §2-3)
 *    The engine alternates between "awaiting a low" and "awaiting a high"
 *    (always starts awaiting a low). A candle only SIGNALS that a turning
 *    point happened recently:
 *      - Confirm LOW: candle is green (close > open) AND close > EMA9(high),
 *        AND enough bars have passed since the last signal candle
 *        (`i - lastConfirmBar + 1 >= minBarsSincePivot`, default 3).
 *      - Confirm HIGH: candle's body midpoint (open+close)/2 is below
 *        EMA9(low), same timing gate (color-blind by default).
 *    Once signalled, the engine searches BACKWARD over a bounded window
 *    (300 candles for the very first pivot ever, else 480, never reaching
 *    into/past the previous confirmed pivot) for the single most extreme
 *    candle (ties favor the older candle), then checks its immediate
 *    neighbor(s) aren't more extreme — if they are, the candidate is
 *    rejected and a later signal gets another chance.
 *
 * 2. MOTHER WAVE (MW) — Pine §4-5
 *    NOT crowned until 50 waves have been confirmed; at that point the
 *    single BIGGEST of exactly those first 50 waves is crowned (one-time
 *    warm-up/bootstrap — never re-runs after that). From then on the MW
 *    stays crowned until a newly-confirmed wave `w` satisfies one of:
 *      S1  w.size >  MW.size                                  (simply bigger)
 *      S2  w.size >= 0.5 * MW.size AND w's tip candle delivers a
 *          QUALIFYING CUT beyond MW's -0.618 extension, continuing in
 *          MW's own direction
 *      S3  w.size >= 0.5 * MW.size AND w's tip candle delivers a
 *          QUALIFYING CUT beyond MW's 1.234 extension, in the direction
 *          OPPOSITE to MW
 *    A QUALIFYING CUT (checked ONLY at the wave's tip candle, using that
 *    candle's own open/close and ATR(14) from ONE bar before it): the
 *    candle's body (|close-open|, never high-low) is >= 0.6 * ATR(14) AND
 *    it closes beyond the level having opened on the near side of it (a
 *    gap over the level does NOT count).
 *    When succession fires, the current DW is retired immediately.
 *
 * 3. DRIVER WAVE (DW) — Pine §8-9
 *    Whenever a newly-confirmed wave is >= 0.3 * MW.size (and a MW is
 *    already crowned), it immediately becomes the new DW — newest
 *    qualifying wave always wins. A DW is invalidated LIVE, on every bar
 *    (not only at wave confirmation) by a qualifying cut beyond its OWN
 *    1.234 extension — this fully clears the DW back to "none".
 *
 * 4. NOISE
 *    Any wave < 0.3 * MW.size. Never becomes DW; can never satisfy S1/S2/
 *    S3 either (both gates need >= 0.3x at minimum, S2/S3 need >= 0.5x).
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

// ─── EMA helper ───────────────────────────────────────────────────────────────
// Single source of truth — see backend/src/services/indicatorMath.js
const { calcEMA } = require("./indicatorMath");

// ─── ATR(14) — Wilder/RMA smoothing ────────────────────────────────────────────
// Ported from indicators.py's calculate_indicators() (`ta.atr(high, low,
// close, length=14)`, pandas_ta's default mamode="rma"): True Range,
// smoothed with a recursive EMA of alpha = 1/period (Wilder's smoothing),
// equivalent to pandas' `.ewm(alpha=1/period, adjust=False).mean()`, with
// output only exposed from index `period-1` onward (matching
// `min_periods=length`). This is new — the previous implementation didn't
// need ATR at all; it's required here for the "qualifying cut" test used
// by MW succession (S2/S3) and DW invalidation.
function calcATR(candles, period = 14) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const h = candles[i].high, l = candles[i].low;
    if (i === 0) { tr[i] = h - l; continue; }
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const alpha = 1 / period;
  const atr = new Array(n).fill(null);
  let prev = null;
  for (let i = 0; i < n; i++) {
    prev = prev === null ? tr[i] : alpha * tr[i] + (1 - alpha) * prev;
    atr[i] = i >= period - 1 ? prev : null;
  }
  return atr;
}

// ─── Pure strategy helpers (ported 1:1 from wave_detector.py) ─────────────────

const sp = (seg) => Math.abs(seg.toPrice - seg.fromPrice); // wave size
const isBull = (seg) => seg.toSide === "high";

// Ported from indicators.fib_levels() / wave_detector.build_fib_levels().
// `swing` is SIGNED (toPrice - fromPrice), so the same formula produces the
// correct mirrored levels for both bull and bear waves without branching.
function buildFibLevels(seg) {
  const swing = seg.toPrice - seg.fromPrice;
  if (swing === 0) return {};
  return {
    "0.0": seg.toPrice,
    "0.236": seg.toPrice - 0.236 * swing,
    "0.382": seg.toPrice - 0.382 * swing,
    "0.5": seg.toPrice - 0.5 * swing,
    "0.618": seg.toPrice - 0.618 * swing,
    "0.786": seg.toPrice - 0.786 * swing,
    "1.0": seg.fromPrice,
    "-0.236": seg.toPrice + 0.236 * swing,
  };
}

// General-purpose ratio pricer (not restricted to the display table above) —
// used for the structural MW/DW thresholds (-0.618 promotion, 1.234
// invalidation) exactly like wave_detector.price_at_ratio().
function priceAtRatio(seg, ratio) {
  const end = seg.toPrice, origin = seg.fromPrice;
  return end - ratio * (end - origin);
}

// The single qualifying-cut test (docx §2 / Pine §12), ported from
// wave_detector.is_qualifying_cut(). A candle whose body is
// >= bodyAtrMult * ATR(14)[one bar before it] AND which closes beyond
// `level`, having opened on the near side of it (a gap over the level does
// NOT count even if the body is large enough). Returns "up" | "down" | null.
function isQualifyingCut(open_, close, atr, level, bodyAtrMult = 0.6) {
  if (atr == null || Number.isNaN(atr)) return null;
  const body = Math.abs(close - open_);
  if (body < bodyAtrMult * atr) return null;
  if (close > level && open_ <= level) return "up";
  if (close < level && open_ >= level) return "down";
  return null;
}

// MW Succession Rules S1/S2/S3 — ported from
// wave_detector.determine_mw_succession(). `newWave.cut618Dir` /
// `cut1234Dir` must already be populated (see StreamingWaveEngine
// `_onNewSegment`, which sets them from the wave's tip candle only).
function determineMwSuccession(mwSeg, newWave, sizePromotionRatio = 0.5) {
  const mwSize = sp(mwSeg), wSize = sp(newWave);

  if (wSize > mwSize) return "S1";
  if (wSize < sizePromotionRatio * mwSize) return null;

  const bullMw = isBull(mwSeg);

  const need618Dir = bullMw ? "up" : "down";
  if (newWave.cut618Dir === need618Dir) return "S2";

  const need1234Dir = bullMw ? "down" : "up";
  if (newWave.cut1234Dir === need1234Dir) return "S3";

  return null;
}

// ─── Streaming wave / MW / DW engine (ported from wave_detector.py's
// StreamingWaveEngine) ──────────────────────────────────────────────────────
//
// Feed a full candle array via .run(); afterwards `.mw` / `.dw` hold the
// final (as-of-last-candle) state, `.segments`/`.pivots` hold every
// confirmed wave/pivot (unbounded, chronological — the "first 50 waves"
// MW warm-up needs the true FIRST ones, not a rolling window), and
// `.mwHistory` holds every MW crowning/succession event in order (used to
// build the public `chain`).
class StreamingWaveEngine {
  constructor(opts = {}) {
    this.dwMinSizeRatio = opts.dwMinSizeRatio ?? 0.3;
    this.mwSizePromotionRatio = opts.mwSizePromotionRatio ?? 0.5;
    this.mwPromotionPriceRatio = opts.mwPromotionPriceRatio ?? -0.618;
    this.mwInvalidationPriceRatio = opts.mwInvalidationPriceRatio ?? 1.234;
    this.qualifyingCutAtrMult = opts.qualifyingCutAtrMult ?? 0.6;
    this.minBarsSincePivot = opts.minBarsSincePivot ?? 3;
    this.firstPivotLookback = opts.firstPivotLookback ?? 300;
    this.pivotLookback = opts.pivotLookback ?? 480;
    this.neighborRadius = opts.neighborRadius ?? 1;
    this.strictHighRequiresRed = opts.strictHighRequiresRed ?? false;
    this.mwInitCount = opts.mwInitCount ?? 50;

    // "Awaiting" state — always starts looking for a LOW, then alternates.
    this.awaiting = "low";
    this.lastPivotBar = null;
    this.lastPivotPrice = null;
    this.lastConfirmBar = null;
    this.prevHigh = null;
    this.prevLow = null;
    this.prevWaveType = "";

    this.pivots = [];
    this.segments = []; // every confirmed wave, chronological, unbounded
    this.waveCounter = 0;

    this.mw = { seg: null, fibLevels: null };
    this.dw = { seg: null, fibLevels: null };
    this.mwHistory = []; // [{ seg, fibLevels, reason }] — INIT once, then S1/S2/S3
    this.waveLog = [];
  }

  run(candles, emaH, emaL, atr) {
    for (let i = 0; i < candles.length; i++) {
      // Pine §9: DW invalidation is checked LIVE, every bar (not only when
      // a new wave confirms), using THIS bar's own body/close.
      this._checkDwInvalidation(candles[i].open, candles[i].close, atr[i - 1]);

      const eh = emaH[i], el = emaL[i];
      if (eh == null || el == null || Number.isNaN(eh) || Number.isNaN(el)) continue;

      const c = candles[i];
      const isGreen = c.close > c.open;
      const isRed = c.close < c.open;
      const bodyMid = (c.open + c.close) / 2;
      const enoughBars = this.lastConfirmBar == null
        || (i - this.lastConfirmBar + 1 >= this.minBarsSincePivot);

      if (this.awaiting === "low") {
        if (isGreen && c.close > eh && enoughBars) this._tryConfirm("low", i, candles, atr);
      } else {
        const colorOk = this.strictHighRequiresRed ? isRed : true;
        if (bodyMid < el && colorOk && enoughBars) this._tryConfirm("high", i, candles, atr);
      }
    }
  }

  _extremeAt(candles, j, isLow) {
    return isLow ? candles[j].low : candles[j].high;
  }

  _tryConfirm(kind, signalBar, candles, atr) {
    const isLow = kind === "low";
    const span = this.lastPivotBar == null
      ? Math.min(signalBar, this.firstPivotLookback)
      : Math.max(Math.min(signalBar - this.lastPivotBar - 1, this.pivotLookback), 1);

    let bestPrice = this._extremeAt(candles, signalBar, isLow);
    let bestOffset = 0;
    for (let off = 1; off <= span; off++) {
      const v = this._extremeAt(candles, signalBar - off, isLow);
      if ((isLow && v <= bestPrice) || (!isLow && v >= bestPrice)) {
        bestPrice = v; bestOffset = off;
      }
    }

    // Neighbor check: reject if anything at best_offset +/- d is more extreme.
    let valid = true;
    for (let d = 1; d <= this.neighborRadius; d++) {
      const nearOff = Math.max(bestOffset - d, 0);
      const farOff = Math.min(bestOffset + d, span);
      const nearV = this._extremeAt(candles, signalBar - nearOff, isLow);
      const farV = this._extremeAt(candles, signalBar - farOff, isLow);
      if (isLow && Math.min(nearV, farV) < bestPrice) valid = false;
      if (!isLow && Math.max(nearV, farV) > bestPrice) valid = false;
    }
    if (!valid) return false;

    this._confirmPivot(kind, signalBar - bestOffset, bestPrice, signalBar, candles, atr);
    return true;
  }

  _confirmPivot(kind, pivotBar, price, signalBar, candles, atr) {
    let currWaveType;
    if (kind === "high") {
      currWaveType = this.prevHigh === null ? "HH" : (price > this.prevHigh ? "HH" : "LH");
      this.prevHigh = price;
    } else {
      currWaveType = this.prevLow === null ? "LL" : (price < this.prevLow ? "LL" : "HL");
      this.prevLow = price;
    }

    this.pivots.push({
      barIndex: pivotBar, price, side: kind, waveType: currWaveType,
      time: candles[pivotBar].time,
    });

    if (this.lastPivotBar !== null) {
      const seg = {
        fromBarIndex: this.lastPivotBar, fromPrice: this.lastPivotPrice,
        toBarIndex: pivotBar, toPrice: price, toSide: kind,
        fromTime: candles[this.lastPivotBar].time, toTime: candles[pivotBar].time,
        prevWaveType: this.prevWaveType, currWaveType,
        cut618Dir: null, cut1234Dir: null,
      };
      this.waveCounter += 1;
      seg.waveNum = this.waveCounter;
      this.segments.push(seg);
      this._onNewSegment(seg, candles, atr);
    }

    this.prevWaveType = currWaveType;
    this.lastPivotBar = pivotBar;
    this.lastPivotPrice = price;
    this.lastConfirmBar = signalBar;
    this.awaiting = kind === "low" ? "high" : "low";
  }

  _onNewSegment(w, candles, atr) {
    // Qualifying-cut flags, evaluated at w's TIP CANDLE ONLY, against
    // whichever MW is crowned right now (i.e. BEFORE any succession below
    // potentially replaces it).
    if (this.mw.seg) {
      const tip = candles[w.toBarIndex];
      const atrPrev = atr[w.toBarIndex - 1];
      const lvl618 = priceAtRatio(this.mw.seg, this.mwPromotionPriceRatio);
      const lvl1234 = priceAtRatio(this.mw.seg, this.mwInvalidationPriceRatio);
      w.cut618Dir = isQualifyingCut(tip.open, tip.close, atrPrev, lvl618, this.qualifyingCutAtrMult);
      w.cut1234Dir = isQualifyingCut(tip.open, tip.close, atrPrev, lvl1234, this.qualifyingCutAtrMult);
    }

    if (!this.mw.seg) {
      // Initial MW crowning: wait for mwInitCount waves, then crown the
      // single BIGGEST of exactly those first mwInitCount waves. One-time
      // warm-up/bootstrap only — this branch can never run again once the
      // MW is set.
      if (this.segments.length >= this.mwInitCount) {
        const firstBatch = this.segments.slice(0, this.mwInitCount);
        let biggest = firstBatch[0];
        for (const s of firstBatch) if (sp(s) > sp(biggest)) biggest = s;
        this.mw = { seg: biggest, fibLevels: buildFibLevels(biggest) };
        this.mwHistory.push({ seg: biggest, fibLevels: this.mw.fibLevels, reason: "INIT" });
      }
    } else {
      // MW Succession Rules S1/S2/S3.
      const reason = determineMwSuccession(this.mw.seg, w, this.mwSizePromotionRatio);
      if (reason) {
        // The old MW's current DriverWave (if any) is retired — a fresh
        // DW can only start under the new MW.
        this.dw = { seg: null, fibLevels: null };
        this.mw = { seg: w, fibLevels: buildFibLevels(w) };
        this.mwHistory.push({ seg: w, fibLevels: this.mw.fibLevels, reason });
      }
    }

    // DriverWave candidacy — the newest qualifying wave always wins (only
    // once a MW is crowned). Evaluated using THIS wave regardless of
    // whether the MW section above just changed/crowned the MW this bar.
    if (this.mw.seg && sp(w) >= this.dwMinSizeRatio * sp(this.mw.seg)) {
      this.dw = { seg: w, fibLevels: buildFibLevels(w) };
    }

    this.waveLog.push({
      waveNo: w.waveNum,
      mwNo: this.mw.seg ? this.mw.seg.waveNum : null,
      dwNo: this.dw.seg ? this.dw.seg.waveNum : null,
    });
  }

  // Checked live, every bar. A candle whose body is
  // >= qualifyingCutAtrMult * ATR(14)[one bar before this one] and which
  // closes beyond the DW's own 1.234 extension (opposite side from the
  // DW's direction), having opened on the near side of it, fully clears
  // the DW back to "none".
  _checkDwInvalidation(o, c, atrPrev) {
    if (!this.dw.seg) return;
    const lvlExt = priceAtRatio(this.dw.seg, this.mwInvalidationPriceRatio);
    const dwBull = isBull(this.dw.seg);
    const needDir = dwBull ? "down" : "up";
    const cutDir = isQualifyingCut(o, c, atrPrev, lvlExt, this.qualifyingCutAtrMult);
    if (cutDir === needDir) this.dw = { seg: null, fibLevels: null };
  }
}

// ─── Wave-segment computation (kept for backward-compat callers) ──────────────
// Pivot/segment detection only (no MW/DW) — now runs the same
// StreamingWaveEngine as detectMotherWaveForAPI so there is exactly ONE
// pivot-detection implementation in this file.
function computeSegments(candles) {
  if (!candles || candles.length < 5) return [];
  const emaH = calcEMA(candles.map((c) => c.high), 9);
  const emaL = calcEMA(candles.map((c) => c.low), 9);
  const atr = calcATR(candles, 14);
  const engine = new StreamingWaveEngine();
  engine.run(candles, emaH, emaL, atr);
  return engine.segments;
}

// Build the wave object (public shape) from a segment — unchanged shape.
function buildWaveObj(seg) {
  return {
    dir: isBull(seg) ? "bull" : "bear",
    col1Time: seg.fromTime,
    col1Price: seg.fromPrice,
    col2Time: seg.toTime,
    col2Price: seg.toPrice,
    delta: +sp(seg).toFixed(2),
    waveNum: seg.waveNum,
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

// ─── API-ready MW/DW detection — THE ONE PUBLIC FUNCTION ───────────────────────
//
// Returns:
// {
//   wave, fibLevels, invalidation,        ← current MW (top-level, backward compat)
//   chain: [ { mwNo, wave, fibLevels, invalidation, promotionLevel618,
//              invalidationLevel1234, crownedBy, displacedBy }, ... ],
//   driverWave: { wave, fibLevels, invalidationLevel1234 } | null,   ← NEW
// }
//
// crownedBy:  "INIT" | "S1" | "S2" | "S3" — why THIS entry itself became MW
// displacedBy: same codes — why the NEXT-newer MW replaced this entry
//              (null for the current, not-yet-displaced MW) — kept for
//              backward compat with the previous "displacedBy" field.
//
function detectMotherWaveForAPI(candles) {
  if (!candles || candles.length < 5) return null;

  const emaH = calcEMA(candles.map((c) => c.high), 9);
  const emaL = calcEMA(candles.map((c) => c.low), 9);
  const atr = calcATR(candles, 14);

  const engine = new StreamingWaveEngine();
  engine.run(candles, emaH, emaL, atr);

  if (!engine.mw.seg) return null; // fewer than mwInitCount (50) waves confirmed yet

  // Current-first ordering: mwNo 0 = current, -1 = previous, -2 = older...
  const chainOrdered = [...engine.mwHistory].reverse();
  const chain = chainOrdered.map((entry, idx) => {
    const displacedBy = idx === 0 ? null : chainOrdered[idx - 1].reason;
    return {
      mwNo: -idx,
      wave: buildWaveObj(entry.seg),
      fibLevels: entry.fibLevels,
      // S2 uses the -0.618 continuation level, S3 uses the 1.234 opposite-
      // direction level — two distinct thresholds now (see module
      // docstring), not one "-0.618" key. `invalidation` is kept for
      // backward compat, mapped to the 1.234 level (closest previous
      // meaning: a cut through it is what actually dethrones the MW via S3).
      promotionLevel618: priceAtRatio(entry.seg, -0.618),
      invalidationLevel1234: priceAtRatio(entry.seg, 1.234),
      invalidation: priceAtRatio(entry.seg, 1.234),
      crownedBy: entry.reason,
      displacedBy,
    };
  });

  const current = chain[0];

  return {
    wave: current.wave,
    fibLevels: current.fibLevels,
    invalidation: current.invalidation,
    chain,
    // NEW — Driver Wave (Pine §8-9 / docx spec), ported alongside MW.
    driverWave: engine.dw.seg
      ? {
        wave: buildWaveObj(engine.dw.seg),
        fibLevels: engine.dw.fibLevels,
        invalidationLevel1234: priceAtRatio(engine.dw.seg, 1.234),
      }
      : null,
  };
}

// ─── Fib helpers — unchanged ───────────────────────────────────────────────────
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