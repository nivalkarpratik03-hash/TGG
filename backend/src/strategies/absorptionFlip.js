/**
 * strategies/absorptionFlip.js
 * ─────────────────────────────────────────────────────────────────
 * Strategy: 9EMA Pivot S/R — Absorption break + Regime-flip break scanner
 *
 * SOURCE: direct port of SR_Absorption_Pinaka_22_Augh.txt (Pine v5 indicator
 * "9EMA Pivot S/R Bands"), default input values only — this is a SCANNER
 * detector, not a chart drawing; it walks the full candle history bar-by-bar
 * and logs every occurrence of two Pine alertconditions:
 *
 *   1. "Absorbing RESISTANCE/SUPPORT broken"
 *        alertcondition(absResNow and not na(absResLvl) and close > absResLvl, ...)
 *        alertcondition(absSupNow and not na(absSupLvl) and close < absSupLvl, ...)
 *      → emitted here as { type: "absorption_break" }
 *
 *   2. "TREND FLIPPED UP/DOWN"
 *        alertcondition(flippedUp, ...)  /  alertcondition(flippedDn, ...)
 *      → emitted here as { type: "flip_break" }
 *
 * KNOWN PINE QUIRK (found + fixed during porting, not a guess — verified by
 * direct unit test): under literal same-bar ordering, a band's `broken` flag
 * flips true the instant `close` clears the band's OWN edge (b.top / b.bot),
 * which is always <= the band's absHi/absLo (the poke-wick extreme) once
 * absorption is flagged. So `close > absHi` can never be evaluated against a
 * band still showing `not b.broken` in the SAME bar — the Pine alert as
 * literally written is structurally unreachable. Fix: snapshot each band's
 * absorb/absHi/absLo/broken state as it stood ENTERING the bar (before this
 * bar's poke/hold/break mutation), and check the break condition against
 * that pre-mutation snapshot instead. This changes nothing about *when* a
 * band is flagged absorbing or *when* it breaks — only makes the "absorption
 * extreme got closed through" event actually observable, which is what the
 * sketches (image 1 / image 2) call for.
 *
 * Everything NOT needed to detect these two event types — LONG/SHORT trade
 * markers, veto logic, score-based band pruning display, the stats/legend
 * tables — is intentionally omitted. Band lifecycle (poke/hold/break),
 * clustering, the trend state machine, step numbering, and maxBands
 * score-based eviction ARE kept, because dropping/evicting a band changes
 * whether it's still alive to break later — omitting them would silently
 * change which events fire on longer candle histories.
 *
 * ADDED FILTER — post-breakthrough Doji confirmation (not in the Pine
 * source, added on top of the port): BOTH event types —
 *   - "TREND FLIPPED UP/DOWN"        (shown as "Flip UP/DOWN")
 *   - "Absorbing RESISTANCE/SUPPORT broken" (shown as "Absorption R/S Broken")
 * are only emitted if a Doji candle appears within the 2 candles immediately
 * following the triggering candle (the flip candle, or the absorption-break
 * candle respectively). This is a pure gate on whether the alert/event is
 * surfaced — the underlying regime flip / band absorb-break state (legNo,
 * refSWH/refSWL, b.absorb, b.broken) still advances exactly as before
 * regardless of the Doji outcome, since later absorption/flip detection
 * depends on that state staying faithful to the Pine port. Because scan()
 * always runs over the full historical candle array in one pass (see
 * "Purity" note below), the 2-candle lookahead is simply read from the same
 * O/H/L/C arrays already in scope — no separate buffering or incremental
 * state is needed. The two event types check the lookahead independently
 * (a resistance break and support break on the same bar, from different
 * bands, each get their own dojiWithinLookahead() call).
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const { calcEMA, trueRanges, wilderATR, pivotHigh, pivotLow } = require("../services/indicatorMath");

// ─── Pine input defaults (kept as literally shipped in the .txt) ──────────
const emaLen = 9;
const pivL = 2;
const pivR = 2;
const tolTouch = 0.25;
const clusterTol = 0.50;
const clusterSpan = 2;
const minHeight = 0.20;

const flipNeedsTouch = false;
const scanTopsOn = true;
const maxScanN = 4;
const ceilOn = true;
const ceilTol = 0.25;
// sideGate = "Also allow in-band pivots on the other side" (default) → bothWays = true

const brkBuffer = 0.0;
const keepBroken = true;
const expireBars = 500;
const maxBandsPerSide = 10;
// extMode = "Until broken" (default) → no Fixed-bars / N-touches extension branch

const pokeBonus = 12.0;
const stepPenalty = 3.0;
const zoneBonus = 6.0;
const trendLen = 50;
const minScore = 0; // → the score-based drop clause is a no-op at default settings

const absorbOn = true;
const weakBodyATR = 0.40;
const absN = 3;
const absMinPokes = 1;
const resetBodyATR = 0.80;
const rejAway = 0.50;
const absDecay = true;
const absMaxATR = 6.0;

// ─── post-breakthrough Doji confirmation (added filter, not from Pine) ───
// Standard candlestick Doji definition: real body is small relative to the
// candle's total high-low range. 0.10 (10%) is the conventional threshold.
const dojiBodyRatio = 0.10;
const dojiLookahead = 2; // candles after the breakthrough candle to check

// ─── small numeric helpers ──────────────────────────────────────────────
function sma(values, i, len) {
  if (i < len - 1) return null;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += values[k];
  return s / len;
}
function highestOfWindow(values, hiExclusive, len) {
  // highest of `values` over the `len` bars strictly BEFORE index hiExclusive
  const lo = Math.max(0, hiExclusive - len);
  const hi = hiExclusive - 1;
  if (hi < lo) return null;
  let m = -Infinity;
  for (let k = lo; k <= hi; k++) if (values[k] > m) m = values[k];
  return m === -Infinity ? null : m;
}
function lowestOfWindow(values, hiExclusive, len) {
  const lo = Math.max(0, hiExclusive - len);
  const hi = hiExclusive - 1;
  if (hi < lo) return null;
  let m = Infinity;
  for (let k = lo; k <= hi; k++) if (values[k] < m) m = values[k];
  return m === Infinity ? null : m;
}
// Doji test: tiny real body relative to the candle's own high-low range.
function isDoji(o, h, l, c) {
  const range = h - l;
  if (!(range > 0)) return false;
  const body = Math.abs(c - o);
  return body <= dojiBodyRatio * range;
}

// ─────────────────────────────────────────────────────────────────────────
//  ENGINE
// ─────────────────────────────────────────────────────────────────────────
class AbsorptionFlipEngine {
  constructor() {
    this.lib = []; // live/dead Band objects (kept until dropped, mirrors Pine `lib`)
    this.regime = 0; // 0 not yet established, 1 up, -1 down
    this.legNo = 1;
    this.refSWH = null;
    this.refSWL = null;

    this.pRTop = null; this.pRBot = null; this.pRHigh = null;
    this.pRPierce = 0.0; this.pRBar = null; this.pRPivLow = null; this.pRZone = "E";

    this.lastPH = null; this.lastPL = null;
    this.pSTop = null; this.pSBot = null; this.pSLow = null;
    this.pSPierce = 0.0; this.pSBar = null; this.pSZone = "E";

    this.phTop = []; this.phBot = []; this.phPx = []; this.phPrc = []; this.phBar = []; this.phZn = [];
    this.plTop = []; this.plBot = []; this.plPx = []; this.plPrc = []; this.plBar = []; this.plZn = [];
    this.legStartBar = 0;

    this.events = []; // { type, direction, side, level, weak, stepNo, time, price, barIndex }
  }

  // ── addBand — cluster into an existing live band on this leg, or publish new
  addBand(nTop, nBot, isRes, pierce, leftBar, forceStep1, zone, i, bw, atr, dnOK, upOK) {
    let hit = -1;
    let st = 1;
    for (let k = 0; k < this.lib.length; k++) {
      const b = this.lib[k];
      if (b.isRes === isRes && !b.broken && b.leg === this.legNo) {
        const ov = Math.min(nTop, b.top) - Math.max(nBot, b.bot);
        const minH = Math.min(nTop - nBot, b.top - b.bot);
        if (ov > 0 && minH > 0 && ov >= 0.5 * minH) { hit = k; break; }
        const prior = isRes ? b.bot >= nTop : b.top <= nBot;
        if (prior && b.stepNo >= st) st = b.stepNo + 1;
      }
    }
    if (forceStep1) st = 1;
    if (hit >= 0) {
      const b = this.lib[hit];
      b.bot = Math.min(b.bot, nBot);
      b.top = Math.max(b.top, nTop);
      b.lastSeen = i;
      b.pierce = Math.max(b.pierce, pierce);
    } else {
      const bwBirth = Math.max(bw != null ? bw : atr, atr * 0.1);
      this.lib.push({
        top: nTop, bot: nBot, isRes, zone, stepNo: st, leg: this.legNo,
        born: leftBar, lastSeen: i,
        touches: 0, pokes: 0, weak: 0, absorb: false, absHi: null, absLo: null,
        broken: false, frozen: false, bwBirth, maxAway: 0.0, pierce,
        trend: isRes ? dnOK : upOK,
      });
    }
  }

  scanAbove(refPx, fromBar, cap, i, bw, atr, dnOK, upOK) {
    const n = this.phPx.length;
    if (n > 0 && cap > 0) {
      const used = new Array(n).fill(false);
      for (let r = 0; r < cap; r++) {
        let best = -1, bv = -1e18;
        for (let k = 0; k < n; k++) {
          if (!used[k] && this.phBar[k] >= fromBar && this.phPx[k] > refPx && this.phPx[k] > bv) { bv = this.phPx[k]; best = k; }
        }
        if (best >= 0) {
          used[best] = true;
          this.addBand(this.phTop[best], this.phBot[best], true, this.phPrc[best], this.phBar[best], false, this.phZn[best], i, bw, atr, dnOK, upOK);
        }
      }
    }
  }

  scanBelow(refPx, fromBar, cap, i, bw, atr, dnOK, upOK) {
    const n = this.plPx.length;
    if (n > 0 && cap > 0) {
      const used = new Array(n).fill(false);
      for (let r = 0; r < cap; r++) {
        let best = -1, bv = 1e18;
        for (let k = 0; k < n; k++) {
          if (!used[k] && this.plBar[k] >= fromBar && this.plPx[k] < refPx && this.plPx[k] < bv) { bv = this.plPx[k]; best = k; }
        }
        if (best >= 0) {
          used[best] = true;
          this.addBand(this.plTop[best], this.plBot[best], false, this.plPrc[best], this.plBar[best], false, this.plZn[best], i, bw, atr, dnOK, upOK);
        }
      }
    }
  }

  scoreOf(b, i) {
    const sFresh = b.touches === 0 ? 22.0 : Math.max(0.0, 22.0 - 8.0 * b.touches);
    const sPoke = Math.min(b.pokes, 3) * pokeBonus;
    const sDepth = Math.min(b.maxAway / 3.0, 1.0) * 23.0;
    const sAge = Math.max(0.0, 1.0 - (i - b.born) / expireBars) * 13.0;
    const sTrend = b.trend ? 18.0 : 0.0;
    const sWick = Math.min(Math.max(b.pierce, 0.0) / 0.75, 1.0) * 12.0;
    const sStep = Math.max(0, b.stepNo - 1) * stepPenalty;
    const sZone = b.zone === "E" ? zoneBonus : 0.0;
    return Math.max(0.0, Math.min(100.0, Math.round(sFresh + sPoke + sDepth + sAge + sTrend + sWick + sZone - sStep)));
  }

  /**
   * Run the full engine over `candles` (oldest-first, {time,open,high,low,close}).
   * Returns { events, finalState }.
   */
  run(candles) {
    const n = candles.length;
    const O = new Array(n), H = new Array(n), L = new Array(n), C = new Array(n), T = new Array(n);
    for (let i = 0; i < n; i++) {
      O[i] = candles[i].open; H[i] = candles[i].high; L[i] = candles[i].low; C[i] = candles[i].close; T[i] = candles[i].time;
    }
    const emaH = calcEMA(H, emaLen);
    const emaL = calcEMA(L, emaLen);
    const bw = new Array(n);
    for (let i = 0; i < n; i++) bw[i] = (emaH[i] != null && emaL[i] != null) ? emaH[i] - emaL[i] : null;
    const atrArr = wilderATR(trueRanges(H, L, C), 14);
    const smaArr = new Array(n);
    for (let i = 0; i < n; i++) smaArr[i] = sma(C, i, trendLen);

    const pivHighArr = pivotHigh(H, pivL, pivR);
    const pivLowArr = pivotLow(L, pivL, pivR);

    // Looks at the `dojiLookahead` candles right after the breakthrough
    // candle at `fromIndex` and returns the index of the first Doji found,
    // or -1 if none of those candles are a Doji (or they don't exist yet in
    // this candle history). Safe to call mid-loop because `run()` always
    // receives the full historical candle array up front — nothing here is
    // "future" data relative to the scan as a whole.
    const dojiWithinLookahead = (fromIndex) => {
      for (let j = fromIndex + 1; j <= fromIndex + dojiLookahead && j < n; j++) {
        if (isDoji(O[j], H[j], L[j], C[j])) return j;
      }
      return -1;
    };

    for (let i = 0; i < n; i++) {
      const open = O[i], high = H[i], low = L[i], close = C[i];
      // ATR/EMA not yet seeded this early — Pine's ta.* would be na too;
      // skip band/absorption logic on bars before both are available.
      const atr = atrArr[i] != null ? atrArr[i] : (i > 0 ? Math.abs(H[i] - L[i]) : Math.abs(high - low)) || 0.0001;
      const bodyN = Math.abs(close - open);

      const upOK = smaArr[i] != null && i >= 5 && smaArr[i - 5] != null ? (close > smaArr[i] && smaArr[i] > smaArr[i - 5]) : false;
      const dnOK = smaArr[i] != null && i >= 5 && smaArr[i - 5] != null ? (close < smaArr[i] && smaArr[i] < smaArr[i - 5]) : false;

      // ── pivots ──────────────────────────────────────────────────────
      const pl = pivLowArr[i];
      const ph = pivHighArr[i];
      const newPL = pl != null;
      const newPH = ph != null;
      const pivBI = i - pivR;

      if (newPL || newPH) {
        const bwPivSrc = bw[pivBI] != null ? bw[pivBI] : atr;
        const bwP = Math.max(bwPivSrc, atr * 0.1);

        if (newPL) {
          const windowLo = Math.max(0, pivBI - clusterSpan);
          const windowHi = Math.min(i, pivBI + clusterSpan);
          let b1 = L[pivBI], t1 = Math.min(O[pivBI], C[pivBI]);
          for (let j = windowLo; j <= windowHi; j++) {
            if (L[j] <= L[pivBI] + clusterTol * bwP) {
              b1 = Math.min(b1, L[j]);
              t1 = Math.min(t1, Math.min(O[j], C[j]));
            }
          }
          if (t1 - b1 < minHeight * bwP) t1 = b1 + minHeight * bwP;
          this.pSTop = t1; this.pSBot = b1; this.pSLow = L[pivBI];
          this.pSPierce = (emaL[pivBI] - b1) / bwP;
          this.pSBar = pivBI;
          const eL = emaL[pivBI], eH = emaH[pivBI];
          this.pSZone = L[pivBI] <= eL + tolTouch * bwP ? "E" : L[pivBI] <= eH + tolTouch * bwP ? "M" : "X";
          this.plZn.push(this.pSZone); this.plTop.push(t1); this.plBot.push(b1);
          this.plPx.push(L[pivBI]); this.plPrc.push(this.pSPierce); this.plBar.push(pivBI);
          if (this.plPx.length > 80) { this.plZn.shift(); this.plTop.shift(); this.plBot.shift(); this.plPx.shift(); this.plPrc.shift(); this.plBar.shift(); }
        }

        if (newPH) {
          const windowLo = Math.max(0, pivBI - clusterSpan);
          const windowHi = Math.min(i, pivBI + clusterSpan);
          let t2 = H[pivBI], b2 = Math.max(O[pivBI], C[pivBI]);
          for (let j = windowLo; j <= windowHi; j++) {
            if (H[j] >= H[pivBI] - clusterTol * bwP) {
              t2 = Math.max(t2, H[j]);
              b2 = Math.max(b2, Math.max(O[j], C[j]));
            }
          }
          if (t2 - b2 < minHeight * bwP) b2 = t2 - minHeight * bwP;
          this.pRTop = t2; this.pRBot = b2; this.pRHigh = H[pivBI]; this.pRPivLow = L[pivBI];
          this.pRPierce = (t2 - emaH[pivBI]) / bwP;
          this.pRBar = pivBI;
          const eL = emaL[pivBI], eH = emaH[pivBI];
          this.pRZone = H[pivBI] >= eH - tolTouch * bwP ? "E" : H[pivBI] >= eL - tolTouch * bwP ? "M" : "X";
          this.phZn.push(this.pRZone); this.phTop.push(t2); this.phBot.push(b2);
          this.phPx.push(H[pivBI]); this.phPrc.push(this.pRPierce); this.phBar.push(pivBI);
          if (this.phPx.length > 80) { this.phZn.shift(); this.phTop.shift(); this.phBot.shift(); this.phPx.shift(); this.phPrc.shift(); this.phBar.shift(); }
        }
      }

      const touchSup = this.pSZone === "E" || this.pSZone === "M";
      const touchRes = this.pRZone === "E" || this.pRZone === "M";

      // ── STATE MACHINE ──────────────────────────────────────────────
      let flippedDn = false, flippedUp = false;
      const prevRefSWL = this.refSWL, prevRefSWH = this.refSWH;

      if (this.regime === 0) {
        if (newPL && this.pSLow != null) { this.regime = 1; this.refSWL = this.pSLow; }
        else if (newPH && this.pRHigh != null) { this.regime = -1; this.refSWH = this.pRHigh; }
      }

      if (this.regime === 1 && this.refSWL != null && close < this.refSWL) {
        this.regime = -1; this.legNo += 1; flippedDn = true;
        if (scanTopsOn) this.scanAbove(this.pRHigh != null ? this.pRHigh : close, this.legStartBar, maxScanN, i, bw[i], atr, dnOK, upOK);
        if (this.pRTop != null && (!flipNeedsTouch || touchRes)) {
          this.addBand(this.pRTop, this.pRBot, true, this.pRPierce, this.pRBar, false, this.pRZone, i, bw[i], atr, dnOK, upOK);
          this.refSWH = this.pRHigh;
        } else {
          this.refSWH = this.pRHigh != null ? this.pRHigh : highestOfWindow(H, i, 20);
        }
        this.legStartBar = i;

        // Only surface the "Breakthrough" event if a Doji shows up within
        // the next `dojiLookahead` candles. The regime/band state above has
        // already advanced either way — this only gates the emitted event.
        const dojiBarDn = dojiWithinLookahead(i);
        if (dojiBarDn !== -1) {
          this.events.push({
            type: "flip_break", direction: "down", side: "support",
            level: prevRefSWL, time: T[i], price: close, barIndex: i,
            dojiConfirmed: true, dojiBarIndex: dojiBarDn, dojiTime: T[dojiBarDn],
          });
        }
      } else if (this.regime === -1 && this.refSWH != null && close > this.refSWH) {
        this.regime = 1; this.legNo += 1; flippedUp = true;
        if (scanTopsOn) this.scanBelow(this.pSLow != null ? this.pSLow : close, this.legStartBar, maxScanN, i, bw[i], atr, dnOK, upOK);
        if (this.pSTop != null && (!flipNeedsTouch || touchSup)) {
          this.addBand(this.pSTop, this.pSBot, false, this.pSPierce, this.pSBar, false, this.pSZone, i, bw[i], atr, dnOK, upOK);
          this.refSWL = this.pSLow;
        } else {
          this.refSWL = this.pSLow != null ? this.pSLow : lowestOfWindow(L, i, 20);
        }
        this.legStartBar = i;

        // Same Doji gate as the down-flip branch above.
        const dojiBarUp = dojiWithinLookahead(i);
        if (dojiBarUp !== -1) {
          this.events.push({
            type: "flip_break", direction: "up", side: "resistance",
            level: prevRefSWH, time: T[i], price: close, barIndex: i,
            dojiConfirmed: true, dojiBarIndex: dojiBarUp, dojiTime: T[dojiBarUp],
          });
        }
      }

      // ── ceiling / floor + fire gates ────────────────────────────────
      const ceilNow = ceilOn && this.lastPH != null && newPH && H[pivBI] <= this.lastPH + ceilTol * atr;
      const floorNow = ceilOn && this.lastPL != null && newPL && L[pivBI] >= this.lastPL - ceilTol * atr;
      const bothWays = true; // sideGate default
      const supFires = newPL && !flippedUp && ((touchSup && (this.regime === 1 || (bothWays && this.pSZone === "M"))) || floorNow);
      const resFires = newPH && !flippedDn && ((touchRes && (this.regime === -1 || (bothWays && this.pRZone === "M"))) || ceilNow);

      if (supFires) {
        this.addBand(this.pSTop, this.pSBot, false, this.pSPierce, this.pSBar, false, this.pSZone, i, bw[i], atr, dnOK, upOK);
        this.refSWL = this.refSWL == null ? this.pSLow : Math.max(this.refSWL, this.pSLow);
      }
      if (resFires) {
        this.addBand(this.pRTop, this.pRBot, true, this.pRPierce, this.pRBar, false, this.pRZone, i, bw[i], atr, dnOK, upOK);
      }

      if (newPL) this.lastPL = L[pivBI];
      if (newPH) {
        this.lastPH = H[pivBI];
        this.refSWH = this.refSWH == null ? this.pRHigh : Math.min(this.refSWH, this.pRHigh);
      }

      // ── LIFECYCLE — poke / hold / break / absorption ────────────────
      let nSup = 0, nRes = 0;
      for (let k = 0; k < this.lib.length; k++) {
        const b = this.lib[k];
        const brkLevel = b.isRes ? b.top + brkBuffer * atr : b.bot - brkBuffer * atr;

        if (!b.broken) {
          // pre-mutation snapshot — the fix. State as it stood ENTERING this bar.
          const wasAbsorb = b.absorb, prevAbsHi = b.absHi, prevAbsLo = b.absLo;

          if (b.isRes && low < b.bot) b.maxAway = Math.max(b.maxAway, (b.bot - low) / b.bwBirth);
          if (!b.isRes && high > b.top) b.maxAway = Math.max(b.maxAway, (high - b.top) / b.bwBirth);

          const reached = low <= b.top && high >= b.bot;
          const deepPoke = b.isRes ? (high > brkLevel && close <= b.top) : (low < brkLevel && close >= b.bot);
          const softPoke = b.isRes ? (reached && close < b.bot) : (reached && close > b.top);
          const pokeNow = deepPoke; // pokeMode default: "Wick beyond the far edge"
          const heldNow = softPoke && !pokeNow;
          const brkNow = b.isRes ? (close > brkLevel) : (close < brkLevel);

          // ── absorption-break check against the PRE-mutation snapshot ──
          // `pokes` is captured here alongside `weak` — both are read BEFORE
          // this bar's poke/hold/break mutation block below runs, same as
          // `weak`/`wasAbsorb` already were, so it's the correct pre-mutation
          // value, not double-counting this bar's own poke if one occurs.
          // Two distinct Pine-verified numbers, not the same thing twice:
          // `weak` = the weak-test count that flagged ABSORBING (the amber
          // "ABSORBING R ×3" alert box), `pokes` = the band's own wick-through
          // count (the "POKED ×N" band-state label). Scanner UI shows both.
          // Same Doji gate as flip_break (see dojiWithinLookahead above):
          // the underlying absorb/absHi/absLo/broken state has already
          // advanced above regardless — this only gates whether the event
          // is surfaced. Checked once per candidate break so a resistance
          // break and a support break (different bands, same bar) each get
          // their own independent lookahead.
          if (wasAbsorb) {
            if (b.isRes && prevAbsHi != null && close > prevAbsHi) {
              const dojiBarAbsR = dojiWithinLookahead(i);
              if (dojiBarAbsR !== -1) {
                this.events.push({
                  type: "absorption_break", direction: "up", side: "resistance",
                  level: prevAbsHi, weak: b.weak, pokes: b.pokes, stepNo: b.stepNo, time: T[i], price: close, barIndex: i,
                  dojiConfirmed: true, dojiBarIndex: dojiBarAbsR, dojiTime: T[dojiBarAbsR],
                });
              }
            }
            if (!b.isRes && prevAbsLo != null && close < prevAbsLo) {
              const dojiBarAbsS = dojiWithinLookahead(i);
              if (dojiBarAbsS !== -1) {
                this.events.push({
                  type: "absorption_break", direction: "down", side: "support",
                  level: prevAbsLo, weak: b.weak, pokes: b.pokes, stepNo: b.stepNo, time: T[i], price: close, barIndex: i,
                  dojiConfirmed: true, dojiBarIndex: dojiBarAbsS, dojiTime: T[dojiBarAbsS],
                });
              }
            }
          }

          if (pokeNow) {
            b.pokes += 1; b.lastSeen = i;
          } else if (heldNow) {
            b.touches += 1; b.lastSeen = i;
          } else if (brkNow) {
            b.broken = true; b.lastSeen = i; b.frozen = true;
          } else if (reached) {
            b.lastSeen = i;
          }

          // ── absorption weak/decisive tracking ──────────────────────
          if (absorbOn && (pokeNow || heldNow || reached)) {
            const drove = b.isRes ? close < b.bot - rejAway * atr : close > b.top + rejAway * atr;
            const decisive = bodyN >= resetBodyATR * atr && drove && (b.isRes ? close < open : close > open);
            if (decisive) {
              b.weak = absDecay ? Math.max(0, b.weak - 1) : 0;
              if (b.weak < absN) b.absorb = false;
            } else if (bodyN < weakBodyATR * atr) {
              b.weak += 1;
              b.absHi = (b.absHi == null || high > b.absHi) ? high : b.absHi;
              b.absLo = (b.absLo == null || low < b.absLo) ? low : b.absLo;
              if (b.weak >= absN && b.pokes >= absMinPokes && !b.absorb) {
                b.absorb = true;
              }
            }
          }
        }

        if (!b.broken) { if (b.isRes) nRes++; else nSup++; }
      }

      // ── drop stale bands (only clause live at default settings: age) ──
      for (let k = this.lib.length - 1; k >= 0; k--) {
        const b = this.lib[k];
        const drop = (b.broken && !keepBroken) || (i - b.lastSeen > expireBars) || (!b.broken && this.scoreOf(b, i) < minScore);
        if (drop) this.lib.splice(k, 1);
      }

      // ── maxBands score-based eviction (matches Pine, runs after the loop) ──
      if (nSup > maxBandsPerSide || nRes > maxBandsPerSide) {
        let worst = -1, ws = 1e9;
        for (let k = 0; k < this.lib.length; k++) {
          const bd = this.lib[k];
          const over = bd.isRes ? nRes > maxBandsPerSide : nSup > maxBandsPerSide;
          const s = this.scoreOf(bd, i);
          if (over && !bd.broken && s < ws) { ws = s; worst = k; }
        }
        if (worst >= 0) this.lib.splice(worst, 1);
      }
    }

    // ── final snapshot: currently-live absorbing bands + flip level ─────
    const liveAbsorbing = this.lib
      .filter((b) => !b.broken && b.absorb)
      .map((b) => ({
        side: b.isRes ? "resistance" : "support",
        level: b.isRes ? b.absHi : b.absLo,
        weak: b.weak, stepNo: b.stepNo, top: b.top, bot: b.bot,
      }));

    // Current ATR (most recent non-null value) — a single scalar for the
    // whole symbol, not per-band. Deliberate: what matters for "how close
    // is price to breaking this, right now" is TODAY's volatility regime,
    // not the ATR from whenever each band happened to form.
    let lastAtr = null;
    for (let k = n - 1; k >= 0; k--) {
      if (atrArr[k] != null) { lastAtr = atrArr[k]; break; }
    }

    const finalState = {
      regime: this.regime === 1 ? "up" : this.regime === -1 ? "down" : "none",
      flipLevel: this.regime === 1 ? this.refSWL : this.regime === -1 ? this.refSWH : null,
      liveAbsorbing,
      atr: lastAtr,
    };

    return { events: this.events, finalState };
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  strategyRegistry.js contract: { id, name, description, scan(symbol, candles) }
//  returning a ScanResult with at minimum { symbol, found, patternStage, error, scannedAt }.
//
//  Purity: a brand-new AbsorptionFlipEngine is created per scan() call and
//  fed the full candle history from scratch — no cached/carried-over state.
// ─────────────────────────────────────────────────────────────────────────
function scan(symbol, candles /*, context = {} */) {
  const result = {
    symbol,
    found: false,
    patternStage: "none",
    side: null,            // "support" | "resistance" of the most recent event
    direction: null,        // "up" | "down" of the most recent event
    level: null,            // level broken, most recent event
    events: [],              // full chronological history — every absorption_break / flip_break
    results: [],              // same events, MOST-RECENT-FIRST — for a scanner table
    state: null,               // final regime / flip level / live-absorbing snapshot
    lastCandle: candles && candles.length ? candles[candles.length - 1] : null,
    candleCount: candles ? candles.length : 0,
    scannedAt: new Date().toISOString(),
    error: null,
  };

  try {
    if (!candles || candles.length < 30) {
      result.error = "insufficient_data";
      return result;
    }

    const engine = new AbsorptionFlipEngine();
    const { events, finalState } = engine.run(candles);

    result.events = events;
    result.results = events.slice().reverse();
    result.state = finalState;

    if (events.length > 0) {
      const last = events[events.length - 1];
      result.found = true;
      result.patternStage = last.type;
      result.side = last.side;
      result.direction = last.direction;
      result.level = last.level;
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = {
  id: "absorption-flip",
  name: "9EMA Absorption / Flip Break",
  description: "Direct Pine port of the 9EMA Pivot S/R Bands' ABSORPTION watch-state + trend-flip step-line — flags every symbol where an absorbing band's extreme got closed through, or the regime's refSWL/refSWH flip level broke, across the full candle history. Both absorption-break and flip signals additionally require a Doji candle within 2 candles after the triggering candle.",
  scan,
  // Also exported for direct/standalone use and testing.
  AbsorptionFlipEngine,
};