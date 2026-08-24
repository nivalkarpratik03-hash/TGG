/**
 * EMA9PivotSRIndicator.js
 *
 * JS port of the Pine Script "9EMA Pivot S/R Bands" (EMA9_Pivot_SR_Bands_3.pine).
 *
 * Ports, bar-by-bar, exactly like the Pine script runs on each new bar:
 *   - 9EMA-high / 9EMA-low band (subtle blue fill, mirrors `fill(pHi, pLo, ...)`)
 *   - Pivot detection (pivL/pivR) with cluster merging, same math as the script
 *   - The TREND STATE MACHINE (regime = UP/DOWN, refSWL / refSWH, leg counter)
 *   - Support / Resistance "staircase" bands with POKE / HELD / BROKEN lifecycle
 *   - Regime pivot ▲ / ▼ triangles, poke ✕ marks, armed-at-resistance ○ marks
 *   - The trend-flip step-line + "SWL/SWH … flips on close" label
 *   - LONG / SHORT rejection-entry tags (hoverable, mirrors the tooltip)
 *   - The top-right readout table + bottom-right break-rate-by-step table
 *
 * All Pine `input.*` values are baked in at their SCRIPT DEFAULTS (this
 * indicator has a single on/off toggle in the dashboard, like the other
 * simple indicators — see indicatorRegistry.js) so behaviour matches what
 * you'd see opening the .pine file on TradingView with no inputs touched.
 *
 * Public API (mirrors SRZonesIndicator.js / WavesIndicator.js):
 *   createEMA9PivotSRIndicator(chart, container, candleSeries)
 *   updateEMA9PivotSRIndicator(candles, emaHighs, emaLows, chart)
 *   removeEMA9PivotSRIndicator(fullTeardown, chart)
 *   setEMA9PivotSRSeries(chart, candleSeries)
 */

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG — Pine script defaults, baked in (see EMA9_Pivot_SR_Bands_3.pine)
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  emaLen: 9,
  pivL: 2,
  pivR: 2,
  touchMode: "edgeOrInside",     // "Edge or inside the band" (default)
  tolTouch: 0.25,
  clusterTol: 0.50,
  clusterSpan: 2,
  minHeight: 0.20,

  refMode: "ratchet",            // "Ratchet to latest band" (default)
  flipNeedsTouch: false,
  scanTops: true,
  maxScan: 4,
  bothWays: true,                // sideGate default = "Also allow in-band pivots on the other side"
  showFlipLine: true,
  showTris: true,

  // Ceiling/floor fire-gate + ABSORPTION watch-state — ported from the
  // newer "SR_Absorption_Pinaka_22_Augh" Pine source, same defaults as
  // backend/src/strategies/absorptionFlip.js's AbsorptionFlipEngine, so
  // the chart and the scanner compute IDENTICAL bands/events/timestamps
  // off the same candle history. See absorptionFlip.js's file header for
  // the "pre-mutation snapshot" Pine-quirk note this mirrors exactly.
  ceilOn: true,
  ceilTol: 0.25,
  absorbOn: true,
  weakBodyATR: 0.40,
  absN: 3,
  absMinPokes: 1,
  resetBodyATR: 0.80,
  rejAway: 0.50,
  absDecay: true,
  absMaxATR: 6.0,                // declared for parity — unused in the engine, same as backend

  extMode: "untilBroken",        // "Until broken" (default)
  pokeMode: "farEdge",           // "Wick beyond the far edge" (default)
  brkBuffer: 0.0,
  keepBroken: true,
  expireBars: 500,
  maxBands: 10,

  warnStep: 5,
  pokeBonus: 12.0,
  stepPenalty: 3.0,
  zoneBonus: 6.0,
  trendLen: 50,
  minScore: 0,
  showZone: true,

  // short entry
  shortsOn: true,
  needGreenPoke: true,
  armBrk: false,
  armPoke: true,
  armSwing: false,
  swingWin: 5,
  swingNeedPivLow: true,
  swingMinBody: 1.0,
  swingNeedEmaL: true,
  allNeedEmaL: false,
  coolBars: 2,
  grnWin: 3,
  maxPokeStep: 2,
  trigWin: 3,
  wickRatio: 1.0,
  shortNeedDown: false,
  blockS1: true,
  minRiskATR: 0.0,
  rMultS: 2.0,

  // long entry
  longsOn: true,
  needRedPoke: true,
  maxPokeStepL: 2,
  redWin: 3,
  blockR1: true,
  rMultL: 2.0,

  pokeMarks: true,
  dimBroken: true,
};

const COLORS = {
  supFresh: "#26A96C",
  supPoked: "#7B61FF",
  resFresh: "#E4574C",
  resPoked: "#FF7BD5",
  emaBand: "#2962FF",
  gray: "#787B86",
  amber: "#E0A32E",
};

// ─────────────────────────────────────────────────────────────────────────────
//  Small numeric helpers
// ─────────────────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}
// Pine's color.new(hex, transparencyPct) → opacity = (100 - transparency) / 100
function rgba(hex, transparencyPct = 0) {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, (100 - transparencyPct) / 100));
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function _calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const out = new Array(prices.length).fill(null);
  let ema = null;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p == null || isNaN(p)) continue;
    ema = ema === null ? p : p * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function _calcATR(candles, period = 14) {
  const n = candles.length;
  const tr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (i === 0) tr[i] = c.high - c.low;
    else {
      const pc = candles[i - 1].close;
      tr[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    }
  }
  const out = new Array(n).fill(null);
  let prev = null;
  for (let i = 0; i < n; i++) {
    if (i === 0) { prev = tr[i]; out[i] = prev; continue; }
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

function _calcSMA(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PURE CALCULATION — bar-by-bar port of the Pine script's runtime
// ─────────────────────────────────────────────────────────────────────────────

function scoreOf(b, curI) {
  const sFresh = b.touches === 0 ? 22.0 : Math.max(0.0, 22.0 - 8.0 * b.touches);
  const sPoke = Math.min(b.pokes, 3) * CFG.pokeBonus;
  const sDepth = Math.min(b.maxAway / 3.0, 1.0) * 23.0;
  const sAge = Math.max(0.0, 1.0 - (curI - b.born) / CFG.expireBars) * 13.0;
  const sTrend = b.trend ? 18.0 : 0.0;
  const sWick = Math.min(Math.max(b.pierce, 0.0) / 0.75, 1.0) * 12.0;
  const sStep = Math.max(0, b.stepNo - 1) * CFG.stepPenalty;
  const sZone = b.zone === "E" ? CFG.zoneBonus : 0.0;
  return Math.max(0, Math.min(100, Math.round(sFresh + sPoke + sDepth + sAge + sTrend + sWick + sZone - sStep)));
}

function stateOf(b) {
  const tag = (b.isRes ? "R" : "S") + b.stepNo + (CFG.showZone ? "·" + b.zone : "");
  const hist = b.pokes > 0 ? ` ✕${b.pokes}` : "";
  const st = b.broken ? "BROKEN" + hist
    : b.pokes > 0 ? `POKED ×${b.pokes}`
    : b.touches === 0 ? "FRESH"
    : `HELD ×${b.touches}`;
  return `${tag}  ${st}`;
}

export function calcEMA9PivotSRPure(candles, emaHighsIn, emaLowsIn) {
  const n = candles?.length || 0;
  const empty = {
    bands: [], triangles: [], pokeMarks: [], armedMarks: [], entries: [],
    flip: null, flipSteps: [], readout: null, stepStats: [],
    emaHighs: [], emaLows: [],
  };
  if (!n) return empty;

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const emaH = emaHighsIn && emaHighsIn.length === n ? emaHighsIn : _calcEMA(highs, CFG.emaLen);
  const emaL = emaLowsIn && emaLowsIn.length === n ? emaLowsIn : _calcEMA(lows, CFG.emaLen);
  const bw = emaH.map((h, i) => (h != null && emaL[i] != null ? h - emaL[i] : null));
  const atr = _calcATR(candles, 14);
  const sma = _calcSMA(closes, CFG.trendLen);
  const upOK = new Array(n).fill(false);
  const dnOK = new Array(n).fill(false);
  for (let i = 5; i < n; i++) {
    if (sma[i] == null || sma[i - 5] == null) continue;
    upOK[i] = closes[i] > sma[i] && sma[i] > sma[i - 5];
    dnOK[i] = closes[i] < sma[i] && sma[i] < sma[i - 5];
  }

  // ── persistent state (Pine `var`) ──────────────────────────────────────────
  const lib = [];                 // live Band objects
  const supPub = new Array(13).fill(0), supBrk = new Array(13).fill(0);
  const resPub = new Array(13).fill(0), resBrk = new Array(13).fill(0);
  let regime = 0, legNo = 1;
  let refSWH = null, refSWL = null;
  // Ceiling/floor fire-gate state (see CFG.ceilOn) + the event log this
  // engine now emits — identical shape to absorptionFlip.js's
  // { type, direction, side, level, weak, stepNo, time, price, barIndex }
  // so a symbol's Absorption/Breakthrough signal in the Scanner lines up
  // exactly with what this chart indicator computes for the same candles.
  let lastPH = null, lastPL = null;
  const events = [];
  let pRTop = null, pRBot = null, pRHigh = null, pRPierce = 0, pRBar = null, pRPivLow = null, pRZone = "E";
  let pSTop = null, pSBot = null, pSLow = null, pSPierce = 0, pSBar = null, pSZone = "E";
  const phTop = [], phBot = [], phPx = [], phPrc = [], phBar = [], phZn = [];
  const plTop = [], plBot = [], plPx = [], plPrc = [], plBar = [], plZn = [];
  let legStartBar = 0;
  let peakSup = 0, peakRes = 0;
  let grnLow = null, grnBar = null, redHigh = null, redBar = null;
  let pkBar = null, pkHigh = null, pkStep = null, pkBandTop = null;
  let pkBarL = null, pkLowL = null, pkStepL = null, pkBandBot = null;
  let lastShortBar = null, lastLongBar = null;
  let cShortPat = 0, cShortVeto = 0, cShortFire = 0;
  let cLongPat = 0, cLongVeto = 0, cLongFire = 0;
  let prevArmedPoke = false;

  const triangles = [], pokeMarksOut = [], armedMarks = [], entries = [], flipSteps = [];

  function addBand(nTop, nBot, isRes, pierce, leftBar, forceStep1, zone, curI) {
    let hit = -1, st = 1;
    for (let i = 0; i < lib.length; i++) {
      const b = lib[i];
      if (b.isRes === isRes && !b.broken && b.leg === legNo) {
        const ov = Math.min(nTop, b.top) - Math.max(nBot, b.bot);
        const minH = Math.min(nTop - nBot, b.top - b.bot);
        if (ov > 0 && minH > 0 && ov >= 0.5 * minH) { hit = i; break; }
        const prior = isRes ? b.bot >= nTop : b.top <= nBot;
        if (prior && b.stepNo >= st) st = b.stepNo + 1;
      }
    }
    if (forceStep1) st = 1;
    if (hit >= 0) {
      const b = lib[hit];
      b.bot = Math.min(b.bot, nBot);
      b.top = Math.max(b.top, nTop);
      b.lastSeen = curI;
      b.pierce = Math.max(b.pierce, pierce);
    } else {
      const bwBirth = Math.max(bw[curI] ?? atr[curI], atr[curI] * 0.1);
      lib.push({
        top: nTop, bot: nBot, isRes, zone, stepNo: st, leg: legNo, born: leftBar,
        touches: 0, pokes: 0, lastSeen: curI, broken: false, frozen: false,
        bwBirth, maxAway: 0, pierce, trend: isRes ? dnOK[curI] : upOK[curI],
        rightBar: curI, score: 0, stateText: "",
        // ABSORPTION watch-state — mirrors absorptionFlip.js's Band shape.
        weak: 0, absorb: false, absHi: null, absLo: null,
      });
      const si = Math.min(st, 12);
      if (isRes) resPub[si]++; else supPub[si]++;
    }
  }

  function scanAbove(refPx, fromBar, cap, curI) {
    const m = phPx.length;
    if (m > 0 && cap > 0) {
      const used = new Array(m).fill(false);
      for (let r = 0; r < cap; r++) {
        let best = -1, bv = -Infinity;
        for (let i = 0; i < m; i++) {
          if (!used[i] && phBar[i] >= fromBar && phPx[i] > refPx && phPx[i] > bv) { bv = phPx[i]; best = i; }
        }
        if (best >= 0) { used[best] = true; addBand(phTop[best], phBot[best], true, phPrc[best], phBar[best], false, phZn[best], curI); }
      }
    }
  }
  function scanBelow(refPx, fromBar, cap, curI) {
    const m = plPx.length;
    if (m > 0 && cap > 0) {
      const used = new Array(m).fill(false);
      for (let r = 0; r < cap; r++) {
        let best = -1, bv = Infinity;
        for (let i = 0; i < m; i++) {
          if (!used[i] && plBar[i] >= fromBar && plPx[i] < refPx && plPx[i] < bv) { bv = plPx[i]; best = i; }
        }
        if (best >= 0) { used[best] = true; addBand(plTop[best], plBot[best], false, plPrc[best], plBar[best], false, plZn[best], curI); }
      }
    }
  }

  // ── main bar loop ───────────────────────────────────────────────────────────
  let readout = null;

  for (let i = 0; i < n; i++) {
    const hi = highs[i], lo = lows[i], cl = closes[i], op = candles[i].open;
    if (emaH[i] == null || emaL[i] == null || bw[i] == null || atr[i] == null) continue;
    const bodyN = Math.abs(cl - op); // needed by both the absorption band loop below and the SHORT/LONG entry logic further down

    // ── pivot confirmation (lags pivR bars, like ta.pivotlow/pivothigh) ───────
    const pivotBarIndex = i - CFG.pivR;
    let newPL = false, newPH = false;
    if (pivotBarIndex - CFG.pivL >= 0) {
      let isLow = true, isHigh = true;
      for (let k = pivotBarIndex - CFG.pivL; k <= pivotBarIndex + CFG.pivR; k++) {
        if (lows[k] < lows[pivotBarIndex]) isLow = false;
        if (highs[k] > highs[pivotBarIndex]) isHigh = false;
      }
      newPL = isLow; newPH = isHigh;
    }

    if (newPL) {
      const bwP = Math.max(bw[pivotBarIndex] ?? atr[i], atr[i] * 0.1);
      const hiOff = CFG.pivR + CFG.clusterSpan, loOff = Math.max(0, CFG.pivR - CFG.clusterSpan);
      let b1 = lows[pivotBarIndex], t1 = Math.min(candles[pivotBarIndex].open, candles[pivotBarIndex].close);
      for (let k = loOff; k <= hiOff; k++) {
        const idx = i - k;
        if (idx < 0 || idx >= n) continue;
        if (lows[idx] <= lows[pivotBarIndex] + CFG.clusterTol * bwP) {
          b1 = Math.min(b1, lows[idx]);
          t1 = Math.min(t1, Math.min(candles[idx].open, candles[idx].close));
        }
      }
      if (t1 - b1 < CFG.minHeight * bwP) t1 = b1 + CFG.minHeight * bwP;
      pSTop = t1; pSBot = b1; pSLow = lows[pivotBarIndex];
      pSPierce = (emaL[pivotBarIndex] - b1) / bwP;
      pSBar = pivotBarIndex;
      pSZone = lows[pivotBarIndex] <= emaL[pivotBarIndex] + CFG.tolTouch * bwP ? "E"
        : lows[pivotBarIndex] <= emaH[pivotBarIndex] + CFG.tolTouch * bwP ? "M" : "X";
      plZn.push(pSZone); plTop.push(t1); plBot.push(b1); plPx.push(pSLow); plPrc.push(pSPierce); plBar.push(pSBar);
      if (plPx.length > 80) { plZn.shift(); plTop.shift(); plBot.shift(); plPx.shift(); plPrc.shift(); plBar.shift(); }
    }
    if (newPH) {
      const bwP = Math.max(bw[pivotBarIndex] ?? atr[i], atr[i] * 0.1);
      const hiOff = CFG.pivR + CFG.clusterSpan, loOff = Math.max(0, CFG.pivR - CFG.clusterSpan);
      let t2 = highs[pivotBarIndex], b2 = Math.max(candles[pivotBarIndex].open, candles[pivotBarIndex].close);
      for (let k = loOff; k <= hiOff; k++) {
        const idx = i - k;
        if (idx < 0 || idx >= n) continue;
        if (highs[idx] >= highs[pivotBarIndex] - CFG.clusterTol * bwP) {
          t2 = Math.max(t2, highs[idx]);
          b2 = Math.max(b2, Math.max(candles[idx].open, candles[idx].close));
        }
      }
      if (t2 - b2 < CFG.minHeight * bwP) b2 = t2 - CFG.minHeight * bwP;
      pRTop = t2; pRBot = b2; pRHigh = highs[pivotBarIndex]; pRPivLow = lows[pivotBarIndex];
      pRPierce = (t2 - emaH[pivotBarIndex]) / bwP;
      pRBar = pivotBarIndex;
      pRZone = highs[pivotBarIndex] >= emaH[pivotBarIndex] - CFG.tolTouch * bwP ? "E"
        : highs[pivotBarIndex] >= emaL[pivotBarIndex] - CFG.tolTouch * bwP ? "M" : "X";
      phZn.push(pRZone); phTop.push(t2); phBot.push(b2); phPx.push(pRHigh); phPrc.push(pRPierce); phBar.push(pRBar);
      if (phPx.length > 80) { phZn.shift(); phTop.shift(); phBot.shift(); phPx.shift(); phPrc.shift(); phBar.shift(); }
    }

    const touchSup = CFG.touchMode === "edgeOrInside" ? (pSZone === "E" || pSZone === "M") : pSZone === "E";
    const touchRes = CFG.touchMode === "edgeOrInside" ? (pRZone === "E" || pRZone === "M") : pRZone === "E";

    // ── the state machine ──────────────────────────────────────────────────────
    let flippedDn = false, flippedUp = false;
    const prevRefSWL = refSWL, prevRefSWH = refSWH; // pre-mutation snapshot for the flip_break event's `level`

    if (regime === 0) {
      if (newPL && pSLow != null) { regime = 1; refSWL = pSLow; }
      else if (newPH && pRHigh != null) { regime = -1; refSWH = pRHigh; }
    }

    if (regime === 1 && refSWL != null && cl < refSWL) {
      regime = -1; legNo += 1; flippedDn = true;
      if (CFG.scanTops) scanAbove(pRHigh ?? cl, legStartBar, CFG.maxScan, i);
      if (pRTop != null && (!CFG.flipNeedsTouch || touchRes)) { addBand(pRTop, pRBot, true, pRPierce, pRBar, false, pRZone, i); refSWH = pRHigh; }
      else {
        let hh = -Infinity;
        for (let k = Math.max(0, i - 20); k < i; k++) hh = Math.max(hh, highs[k]);
        refSWH = pRHigh ?? (hh === -Infinity ? hi : hh);
      }
      legStartBar = i;
      events.push({
        type: "flip_break", direction: "down", side: "support",
        level: prevRefSWL, time: candles[i].time, price: cl, barIndex: i,
      });
    } else if (regime === -1 && refSWH != null && cl > refSWH) {
      regime = 1; legNo += 1; flippedUp = true;
      if (CFG.scanTops) scanBelow(pSLow ?? cl, legStartBar, CFG.maxScan, i);
      if (pSTop != null && (!CFG.flipNeedsTouch || touchSup)) { addBand(pSTop, pSBot, false, pSPierce, pSBar, false, pSZone, i); refSWL = pSLow; }
      else {
        let ll = Infinity;
        for (let k = Math.max(0, i - 20); k < i; k++) ll = Math.min(ll, lows[k]);
        refSWL = pSLow ?? (ll === Infinity ? lo : ll);
      }
      legStartBar = i;
      events.push({
        type: "flip_break", direction: "up", side: "resistance",
        level: prevRefSWH, time: candles[i].time, price: cl, barIndex: i,
      });
    }

    // ── ceiling / floor fire-gate — ported from the newer Pine source
    // alongside absorption (absorptionFlip.js's ceilNow/floorNow) ────────────
    const ceilNow = CFG.ceilOn && lastPH != null && newPH && highs[pivotBarIndex] <= lastPH + CFG.ceilTol * atr[i];
    const floorNow = CFG.ceilOn && lastPL != null && newPL && lows[pivotBarIndex] >= lastPL - CFG.ceilTol * atr[i];
    const supFires = newPL && !flippedUp && ((touchSup && (regime === 1 || (CFG.bothWays && pSZone === "M"))) || floorNow);
    const resFires = newPH && !flippedDn && ((touchRes && (regime === -1 || (CFG.bothWays && pRZone === "M"))) || ceilNow);
    if (supFires) {
      addBand(pSTop, pSBot, false, pSPierce, pSBar, false, pSZone, i);
      refSWL = refSWL == null ? pSLow : Math.max(refSWL, pSLow);
    }
    if (resFires) {
      addBand(pRTop, pRBot, true, pRPierce, pRBar, false, pRZone, i);
    }
    // NOTE: refSWH ratchets on EVERY newPH (not just resFires) below — this
    // asymmetry with refSWL (which only ratchets on supFires, above) is
    // intentional and matches absorptionFlip.js's AbsorptionFlipEngine.run()
    // exactly, itself a direct port of the Pine source's own behaviour.
    if (newPL) lastPL = lows[pivotBarIndex];
    if (newPH) {
      lastPH = highs[pivotBarIndex];
      refSWH = refSWH == null ? pRHigh : Math.min(refSWH, pRHigh);
    }

    if (CFG.showTris) {
      if (regime === 1 && newPL && touchSup) triangles.push({ side: "up", barIndex: pivotBarIndex, time: candles[pivotBarIndex].time });
      if (regime === -1 && newPH && touchRes) triangles.push({ side: "down", barIndex: pivotBarIndex, time: candles[pivotBarIndex].time });
    }

    const flipLevel = regime === 1 ? refSWL : regime === -1 ? refSWH : null;
    flipSteps.push({ barIndex: i, time: candles[i].time, level: flipLevel, regime });

    // ── lifecycle: poke / hold / break, walked like the Pine backward loop ────
    let evtPokeS = false, evtPokeR = false, evtBreakS = false;
    let nearSupTop = null, nearSupBot = null, nearSupScr = null, nearSupSt = "";
    let nearResTop = null, nearResBot = null, nearResScr = null, nearResSt = "";
    let nSup = 0, nRes = 0, stepSup = 0, stepRes = 0, resTopMax = null, supBotMin = null;
    let pokeResStep = 99, pokeResTop = null, pokeSupStep = 99, pokeSupBot = null;
    let vetoS1 = false, vetoR1 = false;

    for (let bi = lib.length - 1; bi >= 0; bi--) {
      const b = lib[bi];
      const brkLevel = b.isRes ? b.top + CFG.brkBuffer * atr[i] : b.bot - CFG.brkBuffer * atr[i];

      if (!b.broken) {
        // pre-mutation snapshot — same fix absorptionFlip.js documents in
        // its header: a band's `broken` flag (and absHi/absLo) must be read
        // as they stood ENTERING this bar, BEFORE this bar's poke/hold/break
        // mutation below, or the "absorption extreme got closed through"
        // event is structurally unreachable (see that file's header note).
        const wasAbsorb = b.absorb, prevAbsHi = b.absHi, prevAbsLo = b.absLo;

        if (b.isRes && lo < b.bot) b.maxAway = Math.max(b.maxAway, (b.bot - lo) / b.bwBirth);
        if (!b.isRes && hi > b.top) b.maxAway = Math.max(b.maxAway, (hi - b.top) / b.bwBirth);

        const reached = lo <= b.top && hi >= b.bot;
        const deepPoke = b.isRes ? (hi > brkLevel && cl <= b.top) : (lo < brkLevel && cl >= b.bot);
        const softPoke = b.isRes ? (reached && cl < b.bot) : (reached && cl > b.top);
        const pokeNow = deepPoke || (CFG.pokeMode === "intoBand" && softPoke);
        const heldNow = softPoke && !pokeNow;
        const brkNow = b.isRes ? (cl > brkLevel) : (cl < brkLevel);

        // ── absorption-break check against the PRE-mutation snapshot ──────
        if (wasAbsorb) {
          if (b.isRes && prevAbsHi != null && cl > prevAbsHi) {
            events.push({
              type: "absorption_break", direction: "up", side: "resistance",
              level: prevAbsHi, weak: b.weak, stepNo: b.stepNo, time: candles[i].time, price: cl, barIndex: i,
            });
          }
          if (!b.isRes && prevAbsLo != null && cl < prevAbsLo) {
            events.push({
              type: "absorption_break", direction: "down", side: "support",
              level: prevAbsLo, weak: b.weak, stepNo: b.stepNo, time: candles[i].time, price: cl, barIndex: i,
            });
          }
        }

        if (pokeNow) {
          b.pokes++; b.lastSeen = i;
          if (b.isRes) { evtPokeR = true; if (b.stepNo <= pokeResStep) { pokeResStep = b.stepNo; pokeResTop = b.top; } }
          else { evtPokeS = true; if (b.stepNo <= pokeSupStep) { pokeSupStep = b.stepNo; pokeSupBot = b.bot; } }
          pokeMarksOut.push({ side: b.isRes ? "resistance" : "support", barIndex: i, time: candles[i].time });
        } else if (heldNow) {
          b.touches++; b.lastSeen = i;
        } else if (brkNow) {
          b.broken = true; b.lastSeen = i;
          if (!b.isRes) evtBreakS = true;
          const si = Math.min(b.stepNo, 12);
          if (b.isRes) resBrk[si]++; else supBrk[si]++;
          if (CFG.extMode !== "forever") { b.rightBar = i; b.frozen = true; }
        } else if (reached) {
          b.lastSeen = i;
        }

        // ── absorption weak/decisive tracking — mirrors absorptionFlip.js ──
        if (CFG.absorbOn && (pokeNow || heldNow || reached)) {
          const drove = b.isRes ? cl < b.bot - CFG.rejAway * atr[i] : cl > b.top + CFG.rejAway * atr[i];
          const decisive = bodyN >= CFG.resetBodyATR * atr[i] && drove && (b.isRes ? cl < op : cl > op);
          if (decisive) {
            b.weak = CFG.absDecay ? Math.max(0, b.weak - 1) : 0;
            if (b.weak < CFG.absN) b.absorb = false;
          } else if (bodyN < CFG.weakBodyATR * atr[i]) {
            b.weak += 1;
            b.absHi = (b.absHi == null || hi > b.absHi) ? hi : b.absHi;
            b.absLo = (b.absLo == null || lo < b.absLo) ? lo : b.absLo;
            if (b.weak >= CFG.absN && b.pokes >= CFG.absMinPokes && !b.absorb) {
              b.absorb = true;
            }
          }
        }
      }

      const drop = (b.broken && !CFG.keepBroken) || (i - b.lastSeen > CFG.expireBars) || (!b.broken && scoreOf(b, i) < CFG.minScore);
      if (drop) { lib.splice(bi, 1); continue; }
      if (!b.frozen && CFG.extMode !== "forever") b.rightBar = i;

      if (!b.broken) {
        if (b.isRes) {
          nRes++;
          if (resTopMax == null || b.top > resTopMax) resTopMax = b.top;
          if (b.leg === legNo) stepRes = Math.max(stepRes, b.stepNo);
          if (b.top >= cl && (nearResBot == null || b.bot < nearResBot)) {
            nearResTop = b.top; nearResBot = b.bot; nearResScr = scoreOf(b, i); nearResSt = stateOf(b);
          }
          if (b.leg === legNo && b.stepNo === 1 && b.bot >= cl) vetoR1 = true;
        } else {
          nSup++;
          if (supBotMin == null || b.bot < supBotMin) supBotMin = b.bot;
          if (b.leg === legNo) stepSup = Math.max(stepSup, b.stepNo);
          if (b.bot <= cl && (nearSupTop == null || b.top > nearSupTop)) {
            nearSupTop = b.top; nearSupBot = b.bot; nearSupScr = scoreOf(b, i); nearSupSt = stateOf(b);
          }
          if (b.leg === legNo && b.stepNo === 1 && b.top <= cl) vetoS1 = true;
        }
      }
    }

    peakSup = (flippedDn || flippedUp) ? stepSup : Math.max(peakSup, stepSup);
    peakRes = (flippedDn || flippedUp) ? stepRes : Math.max(peakRes, stepRes);

    if (nSup > CFG.maxBands || nRes > CFG.maxBands) {
      let worst = -1, ws = Infinity;
      for (let idx = 0; idx < lib.length; idx++) {
        const b = lib[idx];
        const over = b.isRes ? nRes > CFG.maxBands : nSup > CFG.maxBands;
        const s = scoreOf(b, i);
        if (over && !b.broken && s < ws) { ws = s; worst = idx; }
      }
      if (worst >= 0) lib.splice(worst, 1);
    }

    // ── SHORT entry (rejection at resistance) ─────────────────────────────────
    const upWk = hi - Math.max(op, cl);
    const dnWk = Math.min(op, cl) - lo;
    const fullRed = cl < op && bodyN > 0 && (upWk + dnWk) <= CFG.wickRatio * bodyN;
    if (cl > op) { grnLow = lo; grnBar = i; }

    if (evtPokeR && resTopMax != null && cl <= resTopMax && (!CFG.needGreenPoke || cl > op) && (CFG.maxPokeStep === 0 || pokeResStep <= CFG.maxPokeStep)) {
      pkBar = i; pkHigh = hi; pkStep = pokeResStep; pkBandTop = pokeResTop;
    }
    const armedPoke = pkBar != null && i - pkBar >= 1 && i - pkBar <= CFG.trigWin;
    if (CFG.shortsOn && armedPoke && !prevArmedPoke) armedMarks.push({ barIndex: i, time: candles[i].time });
    prevArmedPoke = armedPoke;

    const armedBrk = (flippedDn || evtBreakS) && nearResTop != null && cl < nearResTop;
    const belowEmaL = cl < emaL[i];
    const armedSwing = pRBar != null && i - pRBar <= CFG.swingWin && cl < pRHigh
      && (!CFG.swingNeedEmaL || belowEmaL)
      && (!CFG.swingNeedPivLow || (pRPivLow != null && cl < pRPivLow))
      && (CFG.swingMinBody <= 0 || bodyN >= CFG.swingMinBody * atr[i]);

    const armOK = (CFG.armPoke && armedPoke) || (CFG.armBrk && armedBrk) || (CFG.armSwing && armedSwing);
    const armWhy = (CFG.armBrk && armedBrk) ? "support break" : (CFG.armPoke && armedPoke) ? `R${pkStep ?? 1} poke` : "swing high";
    const grnOK = grnBar != null && i - grnBar >= 1 && i - grnBar <= CFG.grnWin && cl < grnLow;

    const swingTop = nearResTop ?? pRHigh ?? pkHigh ?? hi;
    const stopLvl = pkBandTop ?? nearResTop ?? swingTop; // slModeS default "R1 band top"
    const riskRaw = stopLvl - cl;
    const coolOK = lastShortBar == null || i - lastShortBar > CFG.coolBars;
    const s1Veto = CFG.blockS1 && vetoS1;
    const patS = armOK && fullRed && grnOK;
    if (patS) { cShortPat++; if (s1Veto) cShortVeto++; }
    const shortSig = CFG.shortsOn && armOK && fullRed && grnOK && coolOK && !s1Veto && riskRaw > 0
      && (CFG.minRiskATR <= 0 || riskRaw >= CFG.minRiskATR * atr[i])
      && (!CFG.allNeedEmaL || belowEmaL)
      && (!CFG.shortNeedDown || regime === -1);
    if (shortSig) {
      cShortFire++;
      lastShortBar = i;
      const entryS = cl, riskS = stopLvl - cl, tgtS = cl - CFG.rMultS * riskS;
      entries.push({
        type: "short", barIndex: i, time: candles[i].time, high: hi,
        entry: entryS, stop: stopLvl, target: tgtS, risk: riskS,
        armWhy, regime, legNo, pokeStep: pkStep ?? 1,
      });
      pkBar = null;
    }

    // ── LONG entry (reversal at support) ───────────────────────────────────────
    const fullGreen = cl > op && bodyN > 0 && (upWk + dnWk) <= CFG.wickRatio * bodyN;
    if (cl < op) { redHigh = hi; redBar = i; }

    if (evtPokeS && supBotMin != null && cl >= supBotMin && (!CFG.needRedPoke || cl < op) && (CFG.maxPokeStepL === 0 || pokeSupStep <= CFG.maxPokeStepL)) {
      pkBarL = i; pkLowL = lo; pkStepL = pokeSupStep; pkBandBot = pokeSupBot;
    }
    const armedPokeL = pkBarL != null && i - pkBarL >= 1 && i - pkBarL <= CFG.trigWin;
    const redOK = redBar != null && i - redBar >= 1 && i - redBar <= CFG.redWin && cl > redHigh;
    const r1Veto = CFG.blockR1 && vetoR1;

    const stopLvlL = pkBandBot ?? nearSupBot ?? lo; // slModeL default "S1 band bottom"
    const riskRawL = cl - stopLvlL;
    const coolOKL = lastLongBar == null || i - lastLongBar > CFG.coolBars;
    const patL = armedPokeL && fullGreen && redOK;
    if (patL) { cLongPat++; if (r1Veto) cLongVeto++; }
    const longSig = CFG.longsOn && armedPokeL && fullGreen && redOK && coolOKL && !r1Veto && riskRawL > 0
      && (CFG.minRiskATR <= 0 || riskRawL >= CFG.minRiskATR * atr[i]);
    if (longSig) {
      cLongFire++;
      lastLongBar = i;
      const entryL = cl, tgtL = cl + CFG.rMultL * riskRawL;
      entries.push({
        type: "long", barIndex: i, time: candles[i].time, low: lo,
        entry: entryL, stop: stopLvlL, target: tgtL, risk: riskRawL,
        regime, legNo, pokeStep: pkStepL ?? 1,
      });
      pkBarL = null;
    }

    // ── readout snapshot (kept fresh every bar; final value = last bar's) ─────
    const hot = stepSup >= CFG.warnStep || stepRes >= CFG.warnStep;
    const distRes = nearResBot != null ? (nearResBot - cl) / atr[i] : null;
    const distFlip = flipLevel != null ? Math.abs(cl - flipLevel) / atr[i] : null;
    readout = {
      barIndex: i, time: candles[i].time,
      legNo, regime, flipLevel, atr: atr[i], close: cl, distRes, distFlip,
      stepSup, peakSup, stepRes, peakRes,
      nearResTop, nearResBot, nearResScr,
      nearSupTop, nearSupBot, nearSupScr,
      atSup: nearSupTop != null && lo <= nearSupTop && cl >= nearSupBot,
      atRes: nearResTop != null && hi >= nearResBot && cl <= nearResTop,
      nearSupSt, nearResSt, hot,
      cLongPat, cLongVeto, cLongFire,
      cShortPat, cShortVeto, cShortFire,
    };

    // finalize live band score/state text for rendering (cheap; ~<=20 bands)
    for (const b of lib) { b.score = scoreOf(b, i); b.stateText = stateOf(b); }
  }

  const stepStats = [];
  for (let s = 1; s <= 12; s++) {
    const sp = supPub[s], sb = supBrk[s], rp = resPub[s], rb = resBrk[s];
    if (sp > 0 || rp > 0) {
      stepStats.push({
        step: s,
        supN: sp, supBrokePct: sp > 0 ? Math.round((100 * sb) / sp) : null,
        resN: rp, resBrokePct: rp > 0 ? Math.round((100 * rb) / rp) : null,
      });
    }
  }

  return {
    bands: lib,
    triangles: triangles.slice(-1000),
    pokeMarks: pokeMarksOut.slice(-1000),
    armedMarks: armedMarks.slice(-1000),
    entries: entries.slice(-500),
    flip: readout ? { level: readout.flipLevel, regime: readout.regime } : null,
    flipSteps,
    readout,
    stepStats,
    emaHighs: emaH,
    emaLows: emaL,
    // Absorption-break / flip-break event log — SAME shape, SAME values as
    // backend/src/strategies/absorptionFlip.js's scan().events for the same
    // candle history, so the chart and the Scanner never disagree on when
    // an Absorption/Breakthrough signal fired. Most-recent-first for
    // convenience (mirrors absorptionFlip.js's `results` field).
    events,
    results: events.slice().reverse(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Per-instance state (canvas + DOM overlays), same pattern as SRZonesIndicator
// ─────────────────────────────────────────────────────────────────────────────

const _instances = new Map();
const _idMap = new WeakMap();
let _idCounter = 0;

function _instId(inst) {
  if (!_idMap.has(inst.chart)) _idMap.set(inst.chart, ++_idCounter);
  return _idMap.get(inst.chart);
}
function _getInstance(chart) { return _instances.get(chart) ?? null; }

function _createInstance(chart, container, candleSeries) {
  const inst = {
    chart, container, series: candleSeries ?? null,
    canvas: null, ctx: null,
    data: null,
    rafId: null, rangeUnsub: null, resizeObs: null,
    fingerprint: "",
    tableEl: null, statsEl: null, tooltipEl: null,
    hoverHandler: null,
  };
  _instances.set(chart, inst);
  return inst;
}
function _destroyInstance(inst) { _instances.delete(inst.chart); }

function _priceScaleWidth(inst) {
  try {
    const ps = inst.chart.priceScale("right");
    if (ps && typeof ps.width === "function") return ps.width();
  } catch (_) { }
  return 0;
}

function _syncSize(inst) {
  if (!inst.canvas || !inst.container) return;
  const dpr = window.devicePixelRatio || 1;
  const w = inst.container.clientWidth, h = inst.container.clientHeight;
  inst.canvas.width = w * dpr; inst.canvas.height = h * dpr;
  inst.canvas.style.width = `${w}px`; inst.canvas.style.height = `${h}px`;
  if (inst.ctx) inst.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _ensureDom(inst) {
  const cls = "__e9psr_" + _instId(inst);
  if (!inst.canvas || !inst.container.contains(inst.canvas)) {
    const old = inst.container.querySelector(".canvas_" + cls);
    if (old) try { inst.container.removeChild(old); } catch (_) { }
    inst.canvas = document.createElement("canvas");
    inst.canvas.className = "canvas_" + cls;
    inst.canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:5;";
    inst.container.appendChild(inst.canvas);
    inst.ctx = inst.canvas.getContext("2d");
    _syncSize(inst);
    inst.resizeObs = new ResizeObserver(() => { _syncSize(inst); _scheduleRedraw(inst); });
    inst.resizeObs.observe(inst.container);
  }
  if (!inst.tableEl) {
    inst.tableEl = document.createElement("div");
    inst.tableEl.className = "table_" + cls;
    inst.tableEl.style.cssText = "position:absolute;top:8px;right:8px;z-index:6;pointer-events:none;font:11px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;min-width:190px;border-radius:3px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.35);";
    inst.container.appendChild(inst.tableEl);
  }
  if (!inst.statsEl) {
    inst.statsEl = document.createElement("div");
    inst.statsEl.className = "stats_" + cls;
    inst.statsEl.style.cssText = "position:absolute;bottom:8px;right:8px;z-index:6;pointer-events:none;font:10px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;border-radius:3px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.35);";
    inst.container.appendChild(inst.statsEl);
  }
  if (!inst.tooltipEl) {
    inst.tooltipEl = document.createElement("div");
    inst.tooltipEl.className = "tip_" + cls;
    inst.tooltipEl.style.cssText = "position:absolute;z-index:8;pointer-events:none;display:none;font:11px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#151B26;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:8px 10px;white-space:pre;box-shadow:0 4px 14px rgba(0,0,0,0.5);max-width:260px;";
    inst.container.appendChild(inst.tooltipEl);
  }
  if (!inst.hoverHandler) {
    inst.hoverHandler = (e) => _handleHover(inst, e);
    inst.container.addEventListener("mousemove", inst.hoverHandler);
    inst.container.addEventListener("mouseleave", () => { if (inst.tooltipEl) inst.tooltipEl.style.display = "none"; });
  }
}

function _removeDom(inst) {
  if (inst.resizeObs) { inst.resizeObs.disconnect(); inst.resizeObs = null; }
  if (inst.hoverHandler) { try { inst.container.removeEventListener("mousemove", inst.hoverHandler); } catch (_) { } inst.hoverHandler = null; }
  for (const key of ["canvas", "tableEl", "statsEl", "tooltipEl"]) {
    if (inst[key]) { try { inst[key].parentNode?.removeChild(inst[key]); } catch (_) { } inst[key] = null; }
  }
  inst.ctx = null;
}

// ─── coordinate helpers ────────────────────────────────────────────────────
function _toX(inst, timeMs) {
  try { return inst.chart.timeScale().timeToCoordinate(Math.floor(timeMs / 1000)) ?? null; } catch (_) { return null; }
}
function _toY(inst, price) {
  try { return inst.series.priceToCoordinate(price) ?? null; } catch (_) { return null; }
}

// ─── drawing ─────────────────────────────────────────────────────────────────
function _drawTriangle(ctx, x, y, side, size = 5) {
  ctx.beginPath();
  if (side === "up") {
    ctx.moveTo(x, y - size); ctx.lineTo(x - size, y + size); ctx.lineTo(x + size, y + size);
  } else {
    ctx.moveTo(x, y + size); ctx.lineTo(x - size, y - size); ctx.lineTo(x + size, y - size);
  }
  ctx.closePath();
  ctx.fill();
}

function _drawX(ctx, x, y, size = 4) {
  ctx.beginPath();
  ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size);
  ctx.moveTo(x + size, y - size); ctx.lineTo(x - size, y + size);
  ctx.stroke();
}

function _drawChip(ctx, x, y, text, bg, fg, align = "left") {
  ctx.font = "10px -apple-system,Segoe UI,Roboto,sans-serif";
  const padX = 5, padY = 3;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 15;
  const rx = align === "left" ? x : x - w;
  const ry = y - h / 2;
  ctx.fillStyle = bg;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(rx, ry, w, h, 3); else ctx.rect(rx, ry, w, h);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, rx + padX, y + 0.5);
}

function _bandColors(b) {
  const isRes = b.isRes;
  const poked = b.pokes > 0;
  // colOf(b): base fill color (Pine defaults), transparency bumped up when broken
  const base = isRes ? (poked ? COLORS.resPoked : COLORS.resFresh) : (poked ? COLORS.supPoked : COLORS.supFresh);
  const baseTransparency = isRes ? (poked ? 58 : 88) : (poked ? 58 : 86);
  const fillTransparency = (b.broken && CFG.dimBroken)
    ? Math.min(96, baseTransparency + (poked ? 22 : 7))
    : baseTransparency;
  const fill = rgba(base, fillTransparency);
  // border_color: gray when broken, the poke color at full opacity when poked
  // (and still live), otherwise the EMA blue at 40% opacity
  const border = b.broken ? rgba(COLORS.gray, 55) : poked ? rgba(base, 0) : rgba(COLORS.emaBand, 40);
  return { fill, border, poked };
}

function _redraw(inst) {
  if (!inst.ctx || !inst.canvas || !inst.chart || !inst.series || !inst.data) return;
  const cw = inst.canvas.clientWidth, ch = inst.canvas.clientHeight;
  inst.ctx.clearRect(0, 0, cw, ch);

  const { bands, triangles, pokeMarks, armedMarks, entries, flipSteps, readout, emaHighs, emaLows } = inst.data;
  const candles = inst.candles || [];
  if (!candles.length) { _updateTables(inst); return; }

  const scaleW = _priceScaleWidth(inst);
  const plotW = Math.max(cw - scaleW, 0);
  const ctx = inst.ctx;
  // Pine's box.set_right(bar_index) / plot() only ever reach the last bar —
  // never any empty right-margin space — so anchor "live" elements there.
  const lastX = _toX(inst, candles[candles.length - 1]?.time) ?? plotW;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, plotW, ch);
  ctx.clip();

  // ── 1. 9EMA band fill (subtle blue) ────────────────────────────────────────
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < candles.length; i++) {
    if (emaHighs[i] == null) continue;
    const x = _toX(inst, candles[i].time), y = _toY(inst, emaHighs[i]);
    if (x == null || y == null) continue;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  for (let i = candles.length - 1; i >= 0; i--) {
    if (emaLows[i] == null) continue;
    const x = _toX(inst, candles[i].time), y = _toY(inst, emaLows[i]);
    if (x == null || y == null) continue;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  if (started) { ctx.fillStyle = rgba(COLORS.emaBand, 93); ctx.fill(); }

  // ── 2. S/R staircase bands ─────────────────────────────────────────────────
  for (const b of bands) {
    const x0Raw = _toX(inst, candles[b.born]?.time);
    const x0 = x0Raw != null ? Math.max(0, x0Raw) : 0;
    const x1 = b.frozen ? (_toX(inst, candles[Math.min(b.rightBar, candles.length - 1)]?.time) ?? lastX) : lastX;
    const yTop = _toY(inst, b.top), yBot = _toY(inst, b.bot);
    if (yTop == null || yBot == null) continue;

    const rectX = x0, rectY = Math.min(yTop, yBot);
    const rectW = Math.max(x1 - x0, 0), rectH = Math.max(Math.abs(yBot - yTop), 1);
    if (rectW <= 0) continue;

    const { fill, border, poked } = _bandColors(b);
    ctx.fillStyle = fill;
    ctx.fillRect(rectX, rectY, rectW, rectH);
    ctx.strokeStyle = border;
    ctx.lineWidth = poked && !b.broken ? 2 : 1;
    ctx.strokeRect(rectX, rectY, rectW, rectH);

    // chip label at the band's origin (left edge)
    const chipBg = b.broken ? (poked ? rgba(b.isRes ? COLORS.resPoked : COLORS.supPoked, 45) : rgba(COLORS.gray, 45))
      : poked ? rgba(b.isRes ? COLORS.resPoked : COLORS.supPoked, 5)
      : b.isRes ? rgba(COLORS.resFresh, 10) : rgba(COLORS.supFresh, 10);
    const labelY = b.isRes ? yTop : yBot;
    _drawChip(ctx, rectX, labelY, `${b.stateText}  ${b.score}`, chipBg, "#fff", "left");
  }

  // ── 3. regime pivot triangles ▲▼ ───────────────────────────────────────────
  for (const t of triangles) {
    const c = candles[t.barIndex];
    if (!c) continue;
    const x = _toX(inst, c.time);
    if (x == null) continue;
    const y = t.side === "up" ? _toY(inst, c.low) : _toY(inst, c.high);
    if (y == null) continue;
    ctx.fillStyle = t.side === "up" ? COLORS.supFresh : COLORS.resFresh;
    _drawTriangle(ctx, x, t.side === "up" ? y + 9 : y - 9, t.side, 4);
  }

  // ── 4. poke ✕ marks ─────────────────────────────────────────────────────────
  if (CFG.pokeMarks) {
    for (const p of pokeMarks) {
      const c = candles[p.barIndex];
      if (!c) continue;
      const x = _toX(inst, c.time);
      if (x == null) continue;
      const y = p.side === "support" ? _toY(inst, c.low) : _toY(inst, c.high);
      if (y == null) continue;
      ctx.strokeStyle = p.side === "support" ? COLORS.supPoked : COLORS.resPoked;
      ctx.lineWidth = 1.5;
      _drawX(ctx, x, p.side === "support" ? y + 10 : y - 10, 4);
    }
  }

  // ── 5. armed-at-resistance ○ marks ─────────────────────────────────────────
  for (const a of armedMarks) {
    const c = candles[a.barIndex];
    if (!c) continue;
    const x = _toX(inst, c.time), y = _toY(inst, c.high);
    if (x == null || y == null) continue;
    ctx.fillStyle = COLORS.amber;
    ctx.beginPath();
    ctx.arc(x, y - 9, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── 6. trend-flip step-line + label ────────────────────────────────────────
  if (CFG.showFlipLine && flipSteps.length) {
    ctx.beginPath();
    let curColor = null, prevX = null, prevY = null, hasSeg = false;
    for (let i = 0; i < flipSteps.length; i++) {
      const fs = flipSteps[i];
      if (fs.level == null) { hasSeg = false; continue; }
      const x = _toX(inst, fs.time);
      const y = _toY(inst, fs.level);
      if (x == null || y == null) continue;
      const col = fs.regime === 1 ? COLORS.supFresh : COLORS.resFresh;
      if (col !== curColor || !hasSeg) {
        if (hasSeg) ctx.stroke();
        ctx.beginPath();
        curColor = col;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5;
        ctx.moveTo(x, y);
        hasSeg = true;
      } else {
        ctx.lineTo(prevX, y); // step: horizontal then vertical
        ctx.lineTo(x, y);
      }
      prevX = x; prevY = y;
    }
    if (hasSeg) ctx.stroke();
    // extend the final level to the right edge of the plot
    if (readout && readout.flipLevel != null && prevX != null) {
      const y = _toY(inst, readout.flipLevel);
      if (y != null) {
        ctx.beginPath();
        ctx.strokeStyle = readout.regime === 1 ? COLORS.supFresh : COLORS.resFresh;
        ctx.lineWidth = 2.5;
        ctx.moveTo(prevX, y);
        ctx.lineTo(lastX, y);
        ctx.stroke();

        // flip label pinned near the right edge — two lines, matching Pine's
        // label.new(..., "SWH " + level + "\nflips UP on close above", ...)
        const line1 = (readout.regime === 1 ? "SWL " : "SWH ") + readout.flipLevel.toFixed(2);
        const line2 = `flips ${readout.regime === 1 ? "DOWN on close below" : "UP on close above"}`;
        ctx.font = "11px -apple-system,Segoe UI,Roboto,sans-serif";
        const tw = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 14;
        const lx = Math.max(4, plotW - tw - 4);
        const boxH = 34;
        ctx.fillStyle = readout.regime === 1 ? rgba(COLORS.supFresh, 5) : rgba(COLORS.resFresh, 5);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(lx, y + 6, tw, boxH, 3); else ctx.rect(lx, y + 6, tw, boxH);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "middle";
        ctx.fillText(line1, lx + 7, y + 15);
        ctx.fillText(line2, lx + 7, y + 30);
      }
    }
  }

  // ── 7. LONG / SHORT entry tags ─────────────────────────────────────────────
  const entryPositions = [];
  for (const e of entries) {
    const c = candles[e.barIndex];
    if (!c) continue;
    const x = _toX(inst, c.time);
    if (x == null) continue;
    if (e.type === "short") {
      const y = _toY(inst, e.high);
      if (y == null) continue;
      const py = y - 16;
      _drawChip(ctx, x - 20, py, "SHORT", rgba(COLORS.resFresh, 0), "#fff", "left");
      entryPositions.push({ x, y: py, e });
    } else {
      const y = _toY(inst, e.low);
      if (y == null) continue;
      const py = y + 16;
      _drawChip(ctx, x - 18, py, "LONG", rgba(COLORS.supFresh, 0), "#fff", "left");
      entryPositions.push({ x, y: py, e });
    }
  }
  inst.entryPositions = entryPositions;

  ctx.restore();
  _updateTables(inst);
}

function _updateTables(inst) {
  if (!inst.tableEl || !inst.statsEl) return;
  const d = inst.data;
  const ro = d?.readout;
  if (!ro) { inst.tableEl.innerHTML = ""; inst.statsEl.innerHTML = ""; return; }

  const cell = (k, v, color) =>
    `<tr><td style="padding:3px 8px;background:rgba(21,27,38,0.92);color:#9098a8;">${k}</td>` +
    `<td style="padding:3px 8px;background:rgba(21,27,38,0.92);color:${color};text-align:right;">${v}</td></tr>`;

  const rc = ro.regime === 1 ? COLORS.supFresh : ro.regime === -1 ? COLORS.resFresh : COLORS.gray;
  const flipTxt = ro.flipLevel == null ? "-" : `${ro.regime === 1 ? "below " : "above "}${ro.flipLevel.toFixed(2)}   (${ro.distFlip != null ? ro.distFlip.toFixed(2) : "-"} ATR)`;
  const supStepTxt = ro.stepSup === 0 ? "-" : `${ro.stepSup} (peak ${ro.peakSup})`;
  const resStepTxt = ro.stepRes === 0 ? "-" : `${ro.stepRes} (peak ${ro.peakRes})`;
  const resAbove = ro.nearResBot == null ? "clear" : `${ro.nearResBot.toFixed(2)} – ${ro.nearResTop.toFixed(2)}`;
  const supBelow = ro.nearSupTop == null ? "clear" : `${ro.nearSupBot.toFixed(2)} – ${ro.nearSupTop.toFixed(2)}`;
  const scoreDistTxt = ro.nearResScr == null ? "-" : `${Math.round(ro.nearResScr)}  |  ${ro.distRes != null ? ro.distRes.toFixed(2) : "-"} ATR`;
  const atBand = ro.atSup ? `AT SUPPORT ${ro.nearSupSt}` : ro.atRes ? `AT RESISTANCE ${ro.nearResSt}` : ro.hot ? `step ${Math.max(ro.stepSup, ro.stepRes)} — leg getting old` : "no";
  const atBandColor = ro.atSup ? COLORS.supFresh : ro.atRes ? COLORS.resFresh : ro.hot ? COLORS.amber : COLORS.gray;

  inst.tableEl.innerHTML = `<table style="border-collapse:collapse;width:100%;">` +
    `<tr><td style="padding:4px 8px;background:rgba(120,123,134,0.75);color:#fff;font-weight:600;">9EMA S/R BANDS</td>` +
    `<td style="padding:4px 8px;background:rgba(120,123,134,0.75);color:#fff;text-align:right;">leg #${ro.legNo}</td></tr>` +
    cell("TREND", ro.regime === 1 ? "UP — supports only" : ro.regime === -1 ? "DOWN — resistances only" : "not set", rc) +
    cell("flips on close", flipTxt, rc) +
    cell("SUPPORT STEP", supStepTxt, ro.stepSup >= CFG.warnStep ? COLORS.amber : COLORS.supFresh) +
    cell("RESIST STEP", resStepTxt, ro.stepRes >= CFG.warnStep ? COLORS.amber : COLORS.resFresh) +
    cell("resistance above", resAbove, COLORS.resFresh) +
    cell("score / dist", scoreDistTxt, "#ffffff") +
    cell("support below", supBelow, COLORS.supFresh) +
    cell("LONG pat/veto/fire", `${ro.cLongPat} / ${ro.cLongVeto} / ${ro.cLongFire}`, ro.cLongFire > 0 ? COLORS.supFresh : COLORS.amber) +
    cell("SHORT pat/veto/fire", `${ro.cShortPat} / ${ro.cShortVeto} / ${ro.cShortFire}`, ro.cShortFire > 0 ? COLORS.resFresh : COLORS.amber) +
    cell("AT A BAND", atBand, atBandColor) +
    `</table>`;

  const stats = d.stepStats || [];
  if (!stats.length) { inst.statsEl.innerHTML = ""; return; }
  let rows = `<tr>` +
    `<td style="padding:3px 7px;background:rgba(120,123,134,0.75);color:#fff;">step</td>` +
    `<td style="padding:3px 7px;background:rgba(120,123,134,0.75);color:#fff;">S n</td>` +
    `<td style="padding:3px 7px;background:rgba(120,123,134,0.75);color:#fff;">S broke</td>` +
    `<td style="padding:3px 7px;background:rgba(120,123,134,0.75);color:#fff;">R n</td>` +
    `<td style="padding:3px 7px;background:rgba(120,123,134,0.75);color:#fff;">R broke</td></tr>`;
  for (const s of stats) {
    const stepBg = s.step >= CFG.warnStep ? "rgba(224,163,46,0.3)" : "rgba(21,27,38,0.92)";
    const sPctColor = s.supBrokePct == null ? "#9098a8" : s.supBrokePct >= 60 ? COLORS.resFresh : COLORS.supFresh;
    const rPctColor = s.resBrokePct == null ? "#9098a8" : s.resBrokePct >= 60 ? COLORS.resFresh : COLORS.supFresh;
    rows += `<tr>` +
      `<td style="padding:3px 7px;background:${stepBg};color:#9098a8;">${s.step}</td>` +
      `<td style="padding:3px 7px;background:rgba(21,27,38,0.92);color:#9098a8;">${s.supN}</td>` +
      `<td style="padding:3px 7px;background:rgba(21,27,38,0.92);color:${sPctColor};">${s.supBrokePct == null ? "-" : s.supBrokePct + "%"}</td>` +
      `<td style="padding:3px 7px;background:rgba(21,27,38,0.92);color:#9098a8;">${s.resN}</td>` +
      `<td style="padding:3px 7px;background:rgba(21,27,38,0.92);color:${rPctColor};">${s.resBrokePct == null ? "-" : s.resBrokePct + "%"}</td></tr>`;
  }
  inst.statsEl.innerHTML = `<table style="border-collapse:collapse;">${rows}</table>`;
}

function _handleHover(inst, e) {
  if (!inst.tooltipEl || !inst.entryPositions || !inst.entryPositions.length) {
    if (inst.tooltipEl) inst.tooltipEl.style.display = "none";
    return;
  }
  const r = inst.container.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  let hit = null;
  for (const p of inst.entryPositions) {
    if (Math.abs(mx - p.x) <= 24 && Math.abs(my - p.y) <= 10) { hit = p.e; break; }
  }
  if (!hit) { inst.tooltipEl.style.display = "none"; return; }

  const lines = hit.type === "short"
    ? [
      `SHORT  ·  ${hit.armWhy}`,
      "",
      `Entry    ${hit.entry.toFixed(2)}`,
      `Stop     ${hit.stop.toFixed(2)}   (R1 band top)`,
      `Target   ${hit.target.toFixed(2)}   at ${CFG.rMultS.toFixed(1)}R`,
      `Risk     ${hit.risk.toFixed(2)} pts`,
      "",
      `Poke band   R${hit.pokeStep}`,
      `Regime      ${hit.regime === 1 ? "UP" : hit.regime === -1 ? "DOWN" : "-"}   leg #${hit.legNo}`,
    ]
    : [
      `LONG  ·  S${hit.pokeStep} poke`,
      "",
      `Entry    ${hit.entry.toFixed(2)}`,
      `Stop     ${hit.stop.toFixed(2)}   (S1 band bottom)`,
      `Target   ${hit.target.toFixed(2)}   at ${CFG.rMultL.toFixed(1)}R`,
      `Risk     ${hit.risk.toFixed(2)} pts`,
      "",
      `Regime      ${hit.regime === 1 ? "UP" : hit.regime === -1 ? "DOWN" : "-"}   leg #${hit.legNo}`,
    ];
  inst.tooltipEl.textContent = lines.join("\n");
  inst.tooltipEl.style.display = "block";
  inst.tooltipEl.style.left = `${Math.min(mx + 14, inst.container.clientWidth - 230)}px`;
  inst.tooltipEl.style.top = `${Math.max(my - 90, 4)}px`;
}

// ─── scheduling ──────────────────────────────────────────────────────────────
function _scheduleRedraw(inst) {
  if (inst.rafId != null) return;
  inst.rafId = requestAnimationFrame(() => { inst.rafId = null; _redraw(inst); });
}

function _clearOverlay(inst) {
  if (inst.rafId != null) { cancelAnimationFrame(inst.rafId); inst.rafId = null; }
  if (inst.ctx && inst.canvas) inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
  if (inst.tableEl) inst.tableEl.innerHTML = "";
  if (inst.statsEl) inst.statsEl.innerHTML = "";
  if (inst.tooltipEl) inst.tooltipEl.style.display = "none";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────────────────────────────────────

export function createEMA9PivotSRIndicator(chart, container, candleSeries) {
  const existing = _getInstance(chart);
  if (existing) { _clearOverlay(existing); _removeDom(existing); _destroyInstance(existing); }
  const inst = _createInstance(chart, container, candleSeries);
  if (!inst.rangeUnsub) {
    const handler = () => _scheduleRedraw(inst);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    inst.rangeUnsub = () => { try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch (_) { } };
  }
}

export function setEMA9PivotSRSeries(chart, candleSeries) {
  const inst = _getInstance(chart);
  if (inst) inst.series = candleSeries;
}

export function updateEMA9PivotSRIndicator(candles, emaHighs, emaLows, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst || !candles?.length) return;

  const fp = `${candles.length}:${candles[candles.length - 1]?.time}:${candles[candles.length - 1]?.close}`;
  if (fp === inst.fingerprint) { _scheduleRedraw(inst); return; }
  inst.fingerprint = fp;

  const data = calcEMA9PivotSRPure(candles, emaHighs, emaLows);
  inst.data = data;
  inst.candles = candles;

  _ensureDom(inst);
  _scheduleRedraw(inst);
}

export function removeEMA9PivotSRIndicator(fullTeardown = false, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst && _instances.size === 1) inst = _instances.values().next().value;
  if (!inst) return;

  _clearOverlay(inst);
  inst.data = null;
  inst.candles = null;
  inst.fingerprint = "";
  inst.entryPositions = [];

  if (fullTeardown) {
    if (inst.rangeUnsub) { inst.rangeUnsub(); inst.rangeUnsub = null; }
    _removeDom(inst);
    _destroyInstance(inst);
  }
}