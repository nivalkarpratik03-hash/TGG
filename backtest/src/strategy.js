"use strict";

const { ema, atr, sma, vwapWithBand } = require("./indicators");

// Locked defaults — every value here is taken directly from the Pine
// script's `input.*` defaults, confirmed against the source, not chosen.
const PARAMS = {
  pivLeft: 1,
  pivRight: 1, // Mode A: Consecutive (Mode B: Swing would be 3/3 — not used, defaults win)
  reqRedGrn: true,
  reqBelowEma: true,
  maxGap: 0, // 0 = no limit
  minHLpct: 0.1, // percent
  vwapMult: 1.0,
  zoneMode: "Lower Band (Normal)",
  belowBandOk: true,
  atrLen: 14,
  atrMult: 0.6,
  reqReclaim: true,
  reqBcvc: true,
  volPeriod: 20,
  volProp: 1.25, // irrelevant while volume-leg is off (Fyers gives 0 real index volume)
  bcLook: 7,
  bcProp: 1.3,
  useLiq: true,
  minVolX: 0.5,
  maxRngAtr: 3.0,
  emaLen: 9,
  rr: 2.0,
};

// ── Pivot low detection, generic left/right (Mode A uses left=1,right=1) ──
// A bar at index k is a confirmed pivot low once `right` bars have printed
// after it, if low[k] is strictly lower than every low in [k-left, k+right]
// excluding itself. Mirrors ta.pivotlow(low, left, right).
function findPivotLows(bars, left, right) {
  const pivotAt = new Array(bars.length).fill(false);
  for (let k = left; k < bars.length - right; k++) {
    let isPivot = true;
    for (let j = k - left; j <= k + right; j++) {
      if (j === k) continue;
      if (bars[j].low <= bars[k].low) { isPivot = false; break; }
    }
    pivotAt[k] = isPivot;
  }
  return pivotAt;
}

// ── BCVC — matches the Pine strategy's own block exactly:
//      avgVol   = ta.sma(volume, volPeriod)
//      avgRange = ta.sma(high-low, bcLook)
//      isBigVol    = volume     > avgVol   * volProp
//      isBigCandle = (high-low) > avgRange * bcProp
//      bcvcWhite = isBigCandle and greenBar
//      bcvcBlue  = not isBigCandle and isBigVol and greenBar
//      isBCVCbull = bcvcWhite or bcvcBlue
//    `avgVol` is passed in so this reuses the SAME sma(volumes, volPeriod)
//    series the liquidity gate uses below — one series, not a second guess.
function computeBcvc(bars, avgVol, bcLook, bcProp, volProp) {
  const ranges = bars.map((b) => b.high - b.low);
  const avgRange = sma(ranges, bcLook);
  return bars.map((b, i) => {
    if (avgRange[i] == null) return { bcvcWhite: false, bcvcBlue: false, isBCVCbull: false };
    const isBigCandle = ranges[i] > avgRange[i] * bcProp;
    const isBigVol = avgVol[i] != null && b.volume > avgVol[i] * volProp;
    const isGreen = b.close > b.open;
    const bcvcWhite = isBigCandle && isGreen;
    const bcvcBlue = !isBigCandle && isBigVol && isGreen;
    return { bcvcWhite, bcvcBlue, isBCVCbull: bcvcWhite || bcvcBlue };
  });
}

const EOD_WINDOW_START = "15:00:00"; // sessEnd = "1500-1530" default, matches backtestEngine's old constant

/**
 * Runs the full P1/P2/armed/entry-candle/exit logic as ONE sequential
 * bar-by-bar pass over a strike's COMPLETE multi-day series — not one
 * call per day.
 *
 * FIX #2 (indicator continuity): confirmed against the Pine source —
 * ta.ema, ta.atr (=ta.rma), and ta.sma are NOT session-scoped. Only
 * ta.vwap(vwapSrc, newSession, mult1) explicitly resets on newSession.
 * Calling this once per day (the old runStrategyForDay) silently
 * re-ran every indicator's warm-up period every single morning, which
 * is not what the Pine script does. ema9Low/atr/avgVol/avgRange are now
 * computed ONCE over the whole `bars` array passed in; vwapWithBand
 * (indicators.js) does its own internal per-date reset, matching Pine's
 * explicit ta.vwap(..., newSession, ...) behavior.
 *
 * Session-scoped STRATEGY state — P1/P2/prevPiv/armed — is instead
 * reset INSIDE this loop on every date change, mirroring Pine's own
 * `if newSession ... p1:=na ... prevPiv:=na ... armed:=false` block
 * exactly. An OPEN POSITION is deliberately NOT force-closed on a date
 * change: the pasted Pine source has no such rule — only the intrabar
 * Stop/Target/RedExit checks and the sessEnd time-window check ever
 * close a trade. Carrying an open position across a session boundary
 * is correct-per-source, not a bug, for the rare case a contract's data
 * has no bar in the 15:00–15:30 flat window on a given day.
 *
 * Entry fill timing is UNCHANGED from the earlier fix (#1, already
 * confirmed correct): fills at the confirmation candle's own close,
 * matching the Pine script's `process_orders_on_close = true`.
 *
 * `bars` must already have a real `.volume` field for VWAP/BCVC — if it
 * doesn't, this throws (via indicators.vwapWithBand), same fail-loud
 * behavior as before.
 *
 * Returns { indicators, trades } where trades are fully formed
 * entry+exit pairs (position-gated, one at a time), ready for
 * backtestEngine.computeTradeResult to map to real fills.
 */
function runStrategyForSeries(bars, params = PARAMS) {
  const p = params;
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);

  // ── Computed ONCE over the full multi-day series (fix #2) ────────────
  const ema9High = ema(highs, p.emaLen);
  const ema9Low = ema(lows, p.emaLen);
  const atrArr = atr(bars, p.atrLen); // now Wilder-RMA-accurate (fix #3, see indicators.js)
  const { vwap, upper, lower } = vwapWithBand(bars, p.vwapMult); // resets internally per date
  const pivotAt = findPivotLows(bars, p.pivLeft, p.pivRight);

  const volumes = bars.map((b) => b.volume);
  const avgVol = sma(volumes, p.volPeriod);
  const bcvc = computeBcvc(bars, avgVol, p.bcLook, p.bcProp, p.volProp);

  // ── VWAP zone test at a given pivot bar index ────────────────────────
  function pivotZoneOk(k) {
    const pvP = lows[k];
    const pvV = vwap[k];
    const pvLo = lower[k];
    if (p.zoneMode === "All") return true;
    if (p.zoneMode === "Upper Band") return pvP >= pvV && pvP <= upper[k];
    // "Lower Band (Normal)", Inside Band Zone proximity (default):
    return pvP <= pvV && (p.belowBandOk || pvP >= pvLo);
  }

  // ── Rolling P1/P2 structure state — reset on every date change below,
  // exactly like Pine's `if newSession` block ───────────────────────────
  let p1 = null, p1Idx = null;
  let prevPiv = null, prevPivIdx = null, prevZone = false;
  let armed = false;
  let p2 = null, p2Idx = null;

  // ── Position state — NOT reset on date change (see doc comment above).
  // Pivot rolling below runs every bar unconditionally (matches Pine).
  // Unarm-on-break and new entries are gated by !positionOpen (matches
  // Pine's `strategy.position_size == 0` on both). ─────────────────────
  let positionOpen = false;
  let openEntry = null;   // the entry currently in the market
  let curStop = null;
  let peakHi = null;

  const trades = []; // { entry, exitInfo } pairs, one per closed trade

  for (let i = 0; i < bars.length; i++) {
    // ── 0. Session boundary — reset ONLY the pivot/armed structure,
    // exactly the fields Pine's `if newSession` block resets. Position
    // state deliberately untouched. ────────────────────────────────────
    const newSession = i === 0 || bars[i].date !== bars[i - 1].date;
    if (newSession) {
      p1 = null; p1Idx = null;
      p2 = null; p2Idx = null;
      prevPiv = null; prevPivIdx = null; prevZone = false;
      armed = false;
    }

    // ── 1. Pivot / structure update — unconditional, same as Pine ──────
    const k = i - p.pivRight; // the actual pivot bar this candle confirms, if any
    if (k >= 0 && pivotAt[k]) {
      const pivBarRed = bars[k].close < bars[k].open;
      const confGreen = k + 1 < bars.length ? bars[k + 1].close > bars[k + 1].open : false;
      const redGrnOk = !p.reqRedGrn || (pivBarRed && confGreen);

      if (redGrnOk) {
        const pivBelowEma = ema9Low[k] != null && lows[k] < ema9Low[k];
        const belowEmaOk = !p.reqBelowEma || pivBelowEma;
        const curZone = pivotZoneOk(k);
        const gapOk = p.maxGap <= 0 || (prevPivIdx == null ? true : k - prevPivIdx <= p.maxGap);
        const higherLow = prevPiv != null && lows[k] >= prevPiv * (1 + p.minHLpct / 100);
        const isSetup = prevPiv != null && higherLow && belowEmaOk && curZone && prevZone && gapOk;

        if (isSetup) {
          p1 = prevPiv; p1Idx = prevPivIdx;
          p2 = lows[k]; p2Idx = k;
          armed = true;
        } else {
          armed = false; p2 = null; p2Idx = null;
        }
        prevPiv = lows[k]; prevPivIdx = k; prevZone = curZone;
      }
    }

    // ── 2. Unarm if price trades below P2 before an entry fires ────────
    // Gated by !positionOpen — matches Pine's `strategy.position_size == 0`
    // guard on this exact check.
    if (!positionOpen && armed && p2 != null && lows[i] < p2 && i > p2Idx) {
      armed = false; p2 = null; p2Idx = null;
    }

    // ── 3. If a trade is open, check this bar's exit first ─────────────
    if (positionOpen && i > openEntry.entryIndex) {
      peakHi = Math.max(peakHi, bars[i].high);

      if (p.useRTrail !== false) {
        const trailRef = p.trailRef ?? "Entry";
        const base = trailRef === "Peak" ? peakHi : openEntry.entryPx;
        const trailAfterR = p.trailAfterR ?? 0.5;
        const activated = trailRef === "Entry" || (peakHi - openEntry.entryPx) >= trailAfterR * openEntry.risk;
        if (activated) {
          const candidate = base - (p.trailDistR ?? 0.25) * openEntry.risk;
          curStop = Math.max(curStop, candidate);
        }
      }

      const hitStop = bars[i].low <= curStop;
      const hitTarget = bars[i].high >= openEntry.targetPx;

      let exitInfo = null;
      if (hitStop && hitTarget) {
        exitInfo = { exitIndex: i, exitReason: "Target", exitPx: openEntry.targetPx, bigCandleTag: true };
      } else if (hitTarget) {
        exitInfo = { exitIndex: i, exitReason: "Target", exitPx: openEntry.targetPx, bigCandleTag: false };
      } else if (hitStop) {
        exitInfo = { exitIndex: i, exitReason: "Stop", exitPx: curStop, bigCandleTag: false };
      } else {
        const redBelowEma = bars[i].close < bars[i].open && ema9Low[i] != null && bars[i].close < ema9Low[i];
        if (redBelowEma) {
          exitInfo = { exitIndex: i, exitReason: "RedExit", exitPx: bars[i].close, bigCandleTag: false };
        } else if (bars[i].time >= EOD_WINDOW_START) {
          exitInfo = { exitIndex: i, exitReason: "EOD", exitPx: bars[i].close, bigCandleTag: false };
        }
      }

      if (exitInfo) {
        trades.push({ entry: openEntry, exitInfo });
        positionOpen = false; openEntry = null; curStop = null; peakHi = null;
      }
    }

    // ── 4. Entry candle test — gated by !positionOpen (matches Pine's
    // `strategy.position_size == 0` in longCond) ────────────────────────
    if (!positionOpen && armed && p2 != null && p1 != null && p2 > p1 && i > p2Idx) {
      const isGreen = closes[i] > bars[i].open;
      const bodyRaw = closes[i] - bars[i].open;
      const bigBody = atrArr[i] != null && bodyRaw >= p.atrMult * atrArr[i];
      const bcvcOk = !p.reqBcvc || bcvc[i].isBCVCbull;
      const entryCandleOk = isGreen && bigBody && bcvcOk;

      const prevClose = i > 0 ? closes[i - 1] : null;
      const prevEmaLow = i > 0 ? ema9Low[i - 1] : null;
      const crossUp = prevClose != null && prevEmaLow != null && ema9Low[i] != null &&
        prevClose <= prevEmaLow && closes[i] > ema9Low[i];
      const aboveEma = p.reqReclaim ? crossUp : (ema9Low[i] != null && closes[i] > ema9Low[i]);

      const rangeOk = atrArr[i] != null && (highs[i] - lows[i]) <= p.maxRngAtr * atrArr[i];
      const volOk = avgVol[i] == null || volumes[i] >= p.minVolX * avgVol[i]; // trivially true while volume is uniform/zero-safe
      const liqOk = !p.useLiq || (volOk && rangeOk);

      const longCond = entryCandleOk && aboveEma && liqOk;

      if (longCond) {
        const risk = closes[i] - p2;
        if (risk > 0) {
          const entry = {
            entryIndex: i,
            entryTime: bars[i].time,
            entryDate: bars[i].date,
            entryPx: closes[i],
            p1, p1Idx, p2, p2Idx,
            risk,
            targetPx: closes[i] + p.rr * risk,
            initialStop: p2,
          };

          // Same-bar stop tightening at entry (trailRef="Entry" default) —
          // matches backtestEngine's old immediate-tighten behavior.
          curStop = p2;
          peakHi = bars[i].high;
          if (p.useRTrail !== false) {
            const tightened = entry.entryPx - (p.trailDistR ?? 0.25) * entry.risk;
            curStop = Math.max(curStop, tightened);
          }

          openEntry = entry;
          positionOpen = true;
          armed = false; p2 = null; p2Idx = null; // consume the setup
        }
      }
    }
  }

  // Series ended with a trade still open (thinly-traded contract, or a
  // genuine session-boundary carry that never hit an exit condition
  // afterward either) — force-close at the last available bar rather
  // than throwing.
  if (positionOpen) {
    const last = bars.length - 1;
    trades.push({
      entry: openEntry,
      exitInfo: { exitIndex: last, exitReason: "EOD_NO_LATE_BAR", exitPx: bars[last].close, bigCandleTag: false },
    });
  }

  return {
    indicators: { ema9High, ema9Low, atr: atrArr, vwap, upper, lower, bcvc },
    trades,
  };
}

module.exports = { runStrategyForSeries, findPivotLows, computeBcvc, PARAMS };