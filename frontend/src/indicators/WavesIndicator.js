/**
 * WavesIndicator.js
 *
 * Wave lines   → lightweight-charts addLineSeries (move with chart automatically)
 * Labels       → <canvas> overlay redrawn on pan/zoom/resize
 *
 * Key design decisions for stability and smoothness:
 *
 *  1. SINGLE rAF on pan/zoom — not double-rAF.
 *     lightweight-charts fires subscribeVisibleLogicalRangeChange AFTER it has
 *     already updated its own canvas. A single rAF here fires in the very next
 *     frame, syncing the label canvas immediately. Double-rAF added ~32ms lag
 *     making labels visibly trail behind the wave lines during pan.
 *
 *  2. No-op if already queued — _scheduleRedraw() is a no-op when a rAF is
 *     already pending. Rapid pan events collapse into one paint per frame.
 *
 *  3. Crosshair suppressed during pan — _isPanning flag set on range-change,
 *     cleared 150ms after the last one. Crosshair redraws are skipped entirely
 *     while panning so they don't fight the pan redraws.
 *
 *  4. Pivot fingerprinting — line series rebuilt only when pivot structure
 *     changes (new swing). On tick updates where pivots are unchanged, only the
 *     canvas labels are refreshed — no chart series are added or removed.
 *
 *  5. MULTI-INSTANCE — each chart instance gets its own independent state Map
 *     entry, keyed by the chart object itself. Dual-mode panels no longer
 *     share a singleton and therefore cannot overwrite each other's state.
 */

const MAX_WAVES = 50;

// ─── Pure wave calculation ────────────────────────────────────────────────────

function calcEMA(prices, period) {
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

export function updateWavesIndicatorPure(candles, emaHighs, emaLows) {
  if (!candles?.length) return { pivots: [], segments: [] };

  // CHUNK 6 investigation (2026-08-04): this fallback is NOT dead code.
  // On the live socket-driven chart (pages/ChartsPage.js via CandleChart.js),
  // hooks/useSocket.js only updates `candles` on each tick/new-candle event
  // (tick_update/candle_update/new_candle) — it never touches emaHighs/emaLows
  // in those handlers. emaHighs/emaLows are only refreshed on a full chartData
  // replacement (initial load, manual Refresh click, symbol/resolution change,
  // or reconnect resync). So the moment a new candle forms live, emaHighs.length
  // falls 1+ short of candles.length, this ternary's condition goes false, and
  // this local calcEMA runs — routinely, for the rest of that live session,
  // until the next full refresh. Confirmed by tracing useSocket.js end to end;
  // do not delete this fallback without also changing how live ticks update
  // emaHighs/emaLows to keep pace with candles.
  // (On pages/ReportsPage.js's separate, non-socket usage of this function,
  // candles/emaHighs/emaLows are always set together from one REST response,
  // so this fallback should rarely if ever trigger there.)
  const eH = emaHighs?.length === candles.length
    ? emaHighs : calcEMA(candles.map((c) => c.high), 9);
  const eL = emaLows?.length === candles.length
    ? emaLows : calcEMA(candles.map((c) => c.low), 9);

  let state = 0, bestPrice = null, bestBar = null, legTouchedEMA = false;
  let lastPrice = null, lastBar = null, prevWaveType = "";
  let prevHigh = null, prevLow = null, currWaveType = "";

  const pivots = [], segments = [];

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
      if (bestPrice === null || c.high > bestPrice) { bestPrice = c.high; bestBar = i; }
      if (touchHigh) legTouchedEMA = true;
      if (touchLow && legTouchedEMA) {
        const lp = bestPrice, lb = bestBar;
        currWaveType = prevHigh === null ? "HH" : lp > prevHigh ? "HH" : "LH";
        prevHigh = lp;
        pivots.push({ barIndex: lb, price: lp, side: "high", waveType: currWaveType, time: candles[lb].time });
        if (lastPrice !== null) {
          const mbi = Math.floor((lastBar + lb) / 2);
          segments.push({
            fromBarIndex: lastBar, fromPrice: lastPrice,
            toBarIndex: lb, toPrice: lp,
            midBarIndex: mbi, midPrice: (lastPrice + lp) / 2,
            prevWaveType, currWaveType, toSide: "high",
            fromTime: candles[lastBar].time, toTime: candles[lb].time, midTime: candles[mbi].time,
          });
        }
        prevWaveType = currWaveType; lastPrice = lp; lastBar = lb;
        state = -1; bestPrice = c.low; bestBar = i; legTouchedEMA = touchLow;
      }
      continue;
    }

    if (state === -1) {
      if (bestPrice === null || c.low < bestPrice) { bestPrice = c.low; bestBar = i; }
      if (touchLow) legTouchedEMA = true;
      if (touchHigh && legTouchedEMA) {
        const lp = bestPrice, lb = bestBar;
        currWaveType = prevLow === null ? "LL" : lp < prevLow ? "LL" : "HL";
        prevLow = lp;
        pivots.push({ barIndex: lb, price: lp, side: "low", waveType: currWaveType, time: candles[lb].time });
        if (lastPrice !== null) {
          const mbi = Math.floor((lastBar + lb) / 2);
          segments.push({
            fromBarIndex: lastBar, fromPrice: lastPrice,
            toBarIndex: lb, toPrice: lp,
            midBarIndex: mbi, midPrice: (lastPrice + lp) / 2,
            prevWaveType, currWaveType, toSide: "low",
            fromTime: candles[lastBar].time, toTime: candles[lb].time, midTime: candles[mbi].time,
          });
        }
        prevWaveType = currWaveType; lastPrice = lp; lastBar = lb;
        state = 1; bestPrice = c.high; bestBar = i; legTouchedEMA = touchHigh;
      }
      continue;
    }
  }

  const tp = pivots.slice(-MAX_WAVES), np = tp.length;
  const ts = segments.slice(-MAX_WAVES), ns = ts.length;
  return {
    pivots: tp.map((p, i) => ({ ...p, waveNum: -(np - i) })),
    segments: ts.map((s, i) => ({ ...s, waveNum: -(ns - i) })),
  };
}

// ─── Per-instance state ───────────────────────────────────────────────────────
// Each entry in _instances is keyed by the chart object and holds all the
// state that used to be in module-level globals. This means two CandleChart
// instances in dual-mode each manage their own independent waves overlay
// without ever touching the other panel's data.

const _instances = new Map();

function _getInstance(chart) {
  return _instances.get(chart) ?? null;
}

function _createInstance(chart, container, onWaveData, candleSeries) {
  const inst = {
    chart,
    series: candleSeries ?? null,
    container,
    canvas: null,
    ctx: null,
    onWaveData: onWaveData ?? null,
    lines: [],
    pivots: [],
    segments: [],
    rafId: null,
    rangeUnsub: null,
    crosshairUnsub: null,
    resizeObs: null,
    pivotFingerprint: "",
    isPanning: false,
    panClearId: null,
    crosshairDebounceId: null,
  };
  _instances.set(chart, inst);
  return inst;
}

function _destroyInstance(inst) {
  _instances.delete(inst.chart);
}

// ─── Canvas helpers (instance-scoped) ────────────────────────────────────────

function _rrect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

function _priceScaleWidth(inst) {
  if (!inst.chart) return 0;
  try {
    const ps = inst.chart.priceScale('right');
    if (ps && typeof ps.width === 'function') return ps.width();
  } catch (_) { }
  return 0;
}

function _ensureCanvas(inst) {
  if (inst.canvas && inst.container.contains(inst.canvas)) return;
  const old = inst.container.querySelector(".__wc_" + _instId(inst));
  if (old) try { inst.container.removeChild(old); } catch (_) { }
  inst.canvas = document.createElement("canvas");
  inst.canvas.className = "__wc __wc_" + _instId(inst);
  inst.canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;z-index:5;";
  inst.container.appendChild(inst.canvas);
  inst.ctx = inst.canvas.getContext("2d");
  _syncSize(inst);
  inst.resizeObs = new ResizeObserver(() => { _syncSize(inst); _scheduleRedraw(inst); });
  inst.resizeObs.observe(inst.container);
}

// Use a WeakMap to give each chart a stable numeric ID for canvas class names
const _idMap = new WeakMap();
let _idCounter = 0;
function _instId(inst) {
  if (!_idMap.has(inst.chart)) _idMap.set(inst.chart, ++_idCounter);
  return _idMap.get(inst.chart);
}

function _syncSize(inst) {
  if (!inst.canvas || !inst.container) return;
  const dpr = window.devicePixelRatio || 1;
  const w = inst.container.clientWidth, h = inst.container.clientHeight;
  inst.canvas.width = w * dpr; inst.canvas.height = h * dpr;
  inst.canvas.style.width = `${w}px`; inst.canvas.style.height = `${h}px`;
  if (inst.ctx) inst.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _removeCanvas(inst) {
  if (inst.resizeObs) { inst.resizeObs.disconnect(); inst.resizeObs = null; }
  if (inst.canvas) {
    try { inst.canvas.parentNode?.removeChild(inst.canvas); } catch (_) { }
    inst.canvas = null; inst.ctx = null;
  }
}

// ─── Drawing (instance-scoped) ────────────────────────────────────────────────

function _redraw(inst) {
  if (!inst.ctx || !inst.canvas || !inst.chart || !inst.series) return;
  const cw = inst.canvas.clientWidth, ch = inst.canvas.clientHeight;
  inst.ctx.clearRect(0, 0, cw, ch);
  if (!inst.pivots.length) return;

  const scaleW = _priceScaleWidth(inst);
  const plotW = Math.max(cw - scaleW, 0);
  const ts = inst.chart.timeScale();

  function toXY(timeMs, price) {
    try {
      const x = ts.timeToCoordinate(Math.floor(timeMs / 1000));
      const y = inst.series.priceToCoordinate(price);
      return (x == null || y == null) ? null : { x, y };
    } catch (_) { return null; }
  }

  inst.ctx.save();
  inst.ctx.beginPath();
  inst.ctx.rect(0, 0, plotW, ch);
  inst.ctx.clip();

  inst.pivots.forEach((piv) => {
    const pt = toXY(piv.time, piv.price);
    if (!pt) return;
    if (pt.x > plotW) return;
    const color = piv.side === "high" ? "#00d97e" : "#ff4560";
    inst.ctx.save();
    inst.ctx.font = "bold 11px 'JetBrains Mono',monospace";
    inst.ctx.textAlign = "center"; inst.ctx.textBaseline = "middle";
    const tw = inst.ctx.measureText(piv.waveType).width;
    const pad = 4, bw = tw + pad * 2, bh = 16;
    const rawBx = pt.x - bw / 2;
    const bx = Math.min(rawBx, plotW - bw - 2);
    const by = piv.side === "high" ? pt.y - bh - 6 : pt.y + 6;
    inst.ctx.fillStyle = "rgba(10,11,15,0.88)";
    _rrect(inst.ctx, bx, by, bw, bh, 3); inst.ctx.fill();
    inst.ctx.strokeStyle = color; inst.ctx.lineWidth = 1; inst.ctx.stroke();
    inst.ctx.fillStyle = color;
    inst.ctx.fillText(piv.waveType, bx + bw / 2, by + bh / 2);
    inst.ctx.restore();
  });

  inst.segments.forEach((seg) => {
    const p1 = toXY(seg.fromTime, seg.fromPrice);
    const p2 = toXY(seg.toTime, seg.toPrice);
    if (!p1 || !p2) return;
    if (p1.x > plotW && p2.x > plotW) return;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const segPixelLen = Math.sqrt(dx * dx + dy * dy);
    if (segPixelLen < 40) return;
    const angle = Math.atan2(dy, dx);
    const rawMx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const color = seg.toSide === "high" ? "#00d97e" : "#ff4560";
    const text = `${seg.waveNum}`;
    inst.ctx.save();
    inst.ctx.font = "600 10px 'JetBrains Mono',monospace";
    inst.ctx.textAlign = "center"; inst.ctx.textBaseline = "middle";
    const tw = inst.ctx.measureText(text).width;
    const pad = 4, bw = tw + pad * 2, bh = 15, perpOff = -12;
    if (segPixelLen < bw) return;
    const mx = Math.min(rawMx, plotW - bw / 2 - 2);
    inst.ctx.translate(mx, my); inst.ctx.rotate(angle);
    inst.ctx.fillStyle = "rgba(10,11,15,0.82)";
    _rrect(inst.ctx, -bw / 2, perpOff - bh / 2, bw, bh, 3); inst.ctx.fill();
    inst.ctx.fillStyle = color;
    inst.ctx.fillText(text, 0, perpOff);
    inst.ctx.restore();
  });

  inst.ctx.restore();
}

// ─── Scheduling (instance-scoped) ─────────────────────────────────────────────

function _scheduleRedraw(inst) {
  if (inst.rafId != null) return;
  inst.rafId = requestAnimationFrame(() => { inst.rafId = null; _redraw(inst); });
}

function _makeRangeHandler(inst) {
  return function _onRangeChange() {
    inst.isPanning = true;
    if (inst.panClearId != null) clearTimeout(inst.panClearId);
    inst.panClearId = setTimeout(() => { inst.isPanning = false; inst.panClearId = null; }, 150);
    _scheduleRedraw(inst);
  };
}

function _makeCrosshairHandler(inst) {
  return function _onCrosshairMove() {
    if (inst.isPanning) return;
    if (inst.crosshairDebounceId != null) return;
    inst.crosshairDebounceId = setTimeout(() => { inst.crosshairDebounceId = null; _scheduleRedraw(inst); }, 60);
  };
}

// ─── Overlay clear (instance-scoped) ─────────────────────────────────────────

function _clearOverlay(inst) {
  if (inst.rafId != null) { cancelAnimationFrame(inst.rafId); inst.rafId = null; }
  if (inst.chart) inst.lines.forEach((s) => { try { inst.chart.removeSeries(s); } catch (_) { } });
  inst.lines = [];
  if (inst.ctx && inst.canvas) inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createWavesIndicator(chart, container, onWaveData, candleSeries) {
  // If an instance already exists for this chart (e.g. HMR), tear it down first.
  const existing = _getInstance(chart);
  if (existing) {
    _clearOverlay(existing);
    _removeCanvas(existing);
    _destroyInstance(existing);
  }
  _createInstance(chart, container, onWaveData, candleSeries);
}

export function updateWavesIndicator(candles, emaHighs, emaLows, chart) {
  // chart param is the key — fall back to last created if omitted (single-panel mode)
  let inst = chart ? _getInstance(chart) : null;
  if (!inst) {
    // Single-panel mode: use the only instance if exactly one exists
    if (_instances.size === 1) inst = _instances.values().next().value;
  }
  if (!inst || !inst.chart || !candles?.length) return;

  const { pivots, segments } = updateWavesIndicatorPure(candles, emaHighs, emaLows);
  const fp = pivots.map((p) => `${p.barIndex}:${p.price}`).join("|");

  if (fp === inst.pivotFingerprint) {
    _scheduleRedraw(inst);
    return;
  }

  inst.pivotFingerprint = fp;
  _clearOverlay(inst);
  inst.pivots = pivots; inst.segments = segments;

  if (!pivots.length) { if (inst.onWaveData) inst.onWaveData([], []); return; }

  for (let i = 1; i < pivots.length; i++) {
    const from = pivots[i - 1], to = pivots[i];
    try {
      const ls = inst.chart.addLineSeries({
        color: to.side === "high" ? "rgba(0,217,126,0.85)" : "rgba(255,69,96,0.85)",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      ls.setData([
        { time: Math.floor(from.time / 1000), value: from.price },
        { time: Math.floor(to.time / 1000), value: to.price },
      ]);
      inst.lines.push(ls);
    } catch (_) { }
  }

  if (!inst.series && inst.lines.length) inst.series = inst.lines[0];
  _ensureCanvas(inst);

  if (!inst.rangeUnsub && inst.chart) {
    const handler = _makeRangeHandler(inst);
    inst.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    inst.rangeUnsub = () => {
      try { inst.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch (_) { }
    };
  }
  if (!inst.crosshairUnsub && inst.chart) {
    const handler = _makeCrosshairHandler(inst);
    inst.chart.subscribeCrosshairMove(handler);
    inst.crosshairUnsub = () => {
      try { inst.chart.unsubscribeCrosshairMove(handler); } catch (_) { }
    };
  }

  _scheduleRedraw(inst);
  if (inst.onWaveData) inst.onWaveData(pivots, segments);
}

export function removeWavesIndicator(fullTeardown = false, chart) {
  let inst = chart ? _getInstance(chart) : null;
  if (!inst) {
    if (_instances.size === 1) inst = _instances.values().next().value;
  }
  if (!inst) return;

  _clearOverlay(inst);
  inst.pivots = []; inst.segments = []; inst.pivotFingerprint = "";
  if (inst.crosshairDebounceId != null) { clearTimeout(inst.crosshairDebounceId); inst.crosshairDebounceId = null; }
  if (inst.panClearId != null) { clearTimeout(inst.panClearId); inst.panClearId = null; }
  inst.isPanning = false;

  if (fullTeardown) {
    if (inst.rangeUnsub) { inst.rangeUnsub(); inst.rangeUnsub = null; }
    if (inst.crosshairUnsub) { inst.crosshairUnsub(); inst.crosshairUnsub = null; }
    _removeCanvas(inst);
    _destroyInstance(inst);
  } else {
    if (inst.ctx && inst.canvas) inst.ctx.clearRect(0, 0, inst.canvas.clientWidth, inst.canvas.clientHeight);
  }
  if (inst.onWaveData) inst.onWaveData([], []);
}