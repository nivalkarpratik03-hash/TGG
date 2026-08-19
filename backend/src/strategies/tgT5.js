'use strict';

/**
 * TG T5 — Node.js port of "TG T5 — Script A v16.15 BETA" (Pine v6 indicator)
 * ════════════════════════════════════════════════════════════════════════
 * Implements Annexure A · Edition A5 (R33·10-57 + freeze queue Sr. 58-110)
 * exactly as the Pine indicator computes it: the MH/ML morning frame, the
 * 9EMA band, trend hysteresis, pivot detection (fast + slow roads), and
 * the full T5H (double-top/short) and T5L (double-bottom/long) point
 * state machines (points 1-6, caution/dissolution, gate-2 re-anchor,
 * gate-3 room filter, trap-flip invalidation, expiry).
 *
 * This is a *signal engine*, not a drawing script — all chart-only Pine
 * code (labels, boxes, the state panel, the DEBUG origin-touch overlay)
 * is intentionally left out. Every `alertcondition(...)` in the source
 * has a 1:1 event emitted here, plus the cheat-sheet's WAIT/INFO tags
 * (NC, CAUT, done, dissolved, expired, gate-2 re-arm, gate-3 suppression)
 * so downstream code has the same context a chart-watching trader would.
 *
 * Usage
 * ─────
 *   const { TgT5Engine } = require('./tgT5Strategy');
 *   const engine = new TgT5Engine({ timezone: 'Asia/Kolkata' });
 *   for (const candle of closedCandles) {
 *     const { events, state } = engine.addBar(candle);
 *     for (const ev of events) if (ev.actionable) console.log(ev);
 *   }
 *
 * `candle` = { time: <ms epoch, UTC>, open, high, low, close }. Feed only
 * CLOSED candles — every gate in the Pine source is wrapped in
 * `barstate.isconfirmed`, so `addBar()` is that gate; there is no partial/
 * intrabar state mutation here (see `checkIntrabar()` below for the four
 * genuinely-intrabar watchers from Sr. 54, which read but never mutate).
 *
 * NOTE on pivots: `ta.pivothigh/pivotlow` tie-break behaviour is not
 * publicly specified bit-for-bit by TradingView. The implementation below
 * uses the conventional "candidate >= left neighbours, > right neighbours"
 * (mirrored for lows) rule that matches TradingView output in the
 * overwhelming majority of cases. If you see a pivot disagree with the
 * chart on a bar with an exact tied high/low, that tie-break is the place
 * to look.
 * ════════════════════════════════════════════════════════════════════════
 */

// ── small utilities ───────────────────────────────────────────────────
const na = (v) => v === undefined || v === null || Number.isNaN(v);
const nz = (v, fallback) => (na(v) ? fallback : v);

class Series {
  constructor() { this._a = []; }
  push(v) { this._a.push(v); return this._a.length - 1; }
  /** offset 0 = current (just pushed) bar, 1 = previous bar, ... */
  get(offset = 0) {
    const i = this._a.length - 1 - offset;
    return i >= 0 ? this._a[i] : undefined;
  }
  /** value at an absolute bar index (0-based, as assigned by the engine) */
  at(absIndex) {
    return (absIndex >= 0 && absIndex < this._a.length) ? this._a[absIndex] : undefined;
  }
  get length() { return this._a.length; }
}

function pivotHigh(highSeries, leftbars, rightbars) {
  const n = highSeries.length;
  const candIdx = n - 1 - rightbars;
  if (candIdx - leftbars < 0) return undefined;
  const candidate = highSeries.at(candIdx);
  for (let i = 1; i <= leftbars; i++) if (highSeries.at(candIdx - i) > candidate) return undefined;
  for (let i = 1; i <= rightbars; i++) if (highSeries.at(candIdx + i) >= candidate) return undefined;
  return candidate;
}
function pivotLow(lowSeries, leftbars, rightbars) {
  const n = lowSeries.length;
  const candIdx = n - 1 - rightbars;
  if (candIdx - leftbars < 0) return undefined;
  const candidate = lowSeries.at(candIdx);
  for (let i = 1; i <= leftbars; i++) if (lowSeries.at(candIdx - i) < candidate) return undefined;
  for (let i = 1; i <= rightbars; i++) if (lowSeries.at(candIdx + i) <= candidate) return undefined;
  return candidate;
}

/** The 10 tags a trader/consumer should actually ACT on (cheat-sheet rule 1). */
const ACTIONABLE_TAGS = new Set([
  'S T5H4', 'S T5H6', 'S T5H5 FLIP', 'S T5H2 FLIP', 'S T5L FLIP (trap)',
  'L T5L4', 'L T5L6', 'L T5L5 FLIP', 'L T5L2 FLIP', 'L T5H FLIP (trap)',
]);

// ── the engine ───────────────────────────────────────────────────────
class TgT5Engine {
  constructor(opts = {}) {
    // Inputs (mirrors the Pine `input.*` block) ---------------------------
    this.autoScale = opts.autoScale ?? true;
    this.trendMode = opts.trendMode ?? 'Auto'; // Auto | Force UP | Force DOWN | Force SIDEWAYS
    this.t5PendingBars = opts.t5PendingBars ?? 6;
    this.t5FlipFib = opts.t5FlipFib ?? 0.236;
    this.t5RoomToP3In = opts.t5RoomToP3 ?? 30.0;
    this.bandNearIn = opts.bandNear ?? 2.0;
    this.timezone = opts.timezone ?? 'Asia/Kolkata'; // for the session/newDay boundary

    // ── bar history series ────────────────────────────────────────────
    this.O = new Series(); this.H = new Series(); this.L = new Series(); this.C = new Series();
    this.isGreenS = new Series(); this.bodyTopS = new Series(); this.bodyBotS = new Series();
    this.bandHighS = new Series(); this.bandLowS = new Series();
    // timeS mirrors O/H/L/C one-for-one (same push cadence, same absolute
    // bar index) so any point whose bar is discovered *after* the fact
    // (pivot points, which only confirm 1-2 bars later — see pivotHigh/
    // pivotLow) can still be stamped with the time of the candle it
    // actually happened on, not the candle that merely confirmed it.
    this.timeS = new Series();
    this.barIndex = -1;

    // EMA(9) state
    this._emaHighPrev = undefined;
    this._emaLowPrev = undefined;

    // ── session / scaling ─────────────────────────────────────────────
    this.lastDayStamp = undefined;
    this.symScale = 1.0;

    // ── morning frame (MH/ML) ─────────────────────────────────────────
    this.MH = undefined; this.ML = undefined;
    this.frameReady = false; this.mhFired = false; this.mlFired = false;

    // ── trend hysteresis ───────────────────────────────────────────────
    this.trendState = 'SIDEWAYS';
    this.trendConfirmed = false;
    this.structHigh = undefined;
    this.structLow = undefined;

    // ── pivots — rolling anchors ───────────────────────────────────────
    this.lastPH = undefined; this.lastPHBar = undefined;
    this.lastPL = undefined; this.lastPLBar = undefined;
    this.lastPLStrict = false; this.lastPHReach = false;
    this.lastPHTouch = undefined; this.lastPHTouchBar = undefined;
    this.lastPLBelow = undefined; this.lastPLBelowBar = undefined;

    // ── T5H state (double top / short) ─────────────────────────────────
    this.t5hStage = 0;
    this.t5hP1 = undefined; this.t5hP1Bar = undefined;
    this.t5hP2Hi = undefined; this.t5hP2Lo = undefined; this.t5hP2Bar = undefined;
    this.t5hP3 = undefined; this.t5hP3Bar = undefined;
    this.t5hP4 = undefined; this.t5hP4Bar = undefined;
    this.t5hP5Low = undefined; this.t5hP5LW = undefined; this.t5hP5Bar = undefined;
    this.t5hP6 = undefined; this.t5hP6Bar = undefined; // UI-only: point-6 confirm price/bar
    this.t5hPend = 0;
    this.t5hSeedBar = undefined;
    this.t5hCaut = false; this.t5hCautLow = undefined;
    this.t5h3nc = false; this.t5h3ncLow = undefined;
    this.t5h6nc = false; this.t5h6ncClose = undefined; this.t5h6ncHigh = undefined; this.t5h6ncBody = undefined;
    this.t5hApexHi = undefined; this.t5hApexBar = undefined; this.t5hApexPoke = false;
    this.t5h4Sent = false;

    // ── T5L state (double bottom / long) ───────────────────────────────
    this.t5lStage = 0;
    this.t5lP1 = undefined; this.t5lP1Bar = undefined;
    this.t5lP2Lo = undefined; this.t5lP2Hi = undefined; this.t5lP2Bar = undefined;
    this.t5lP3 = undefined; this.t5lP3Bar = undefined;
    this.t5lP4 = undefined; this.t5lP4Bar = undefined;
    this.t5lP5High = undefined; this.t5lP5UW = undefined; this.t5lP5Bar = undefined;
    this.t5lP6 = undefined; this.t5lP6Bar = undefined; // UI-only: point-6 confirm price/bar
    this.t5lPend = 0;
    this.t5lCaut = false; this.t5lCautHigh = undefined;
    this.t5l3nc = false; this.t5l3ncHigh = undefined;
    this.t5l6nc = false; this.t5l6ncClose = undefined; this.t5l6ncLow = undefined; this.t5l6ncBody = undefined;
    this.t5lApexLo = undefined; this.t5lApexBar = undefined; this.t5lApexPoke = false;
    this.t5l4Sent = false;
    this.t5lRoomOK = true; this.t5lRoomVal = undefined;

    // ── cross-machine hand-off seeds (Sr. 66/93) ───────────────────────
    this.seedT5L1 = undefined; this.seedT5L1Bar = undefined;
    this.seedT5H1 = undefined; this.seedT5H1Bar = undefined;
  }

  // ── day-boundary helper ────────────────────────────────────────────
  _dayKey(timeMs) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(timeMs));
  }

  /**
   * Process one CLOSED candle. Returns { events, state }.
   * events: [{ tag, actionable, side, provisional, price, note }]
   */
  addBar(candle) {
    const { time, open, high, low, close } = candle;
    const isGreen = close > open;
    const bodyTop = Math.max(open, close);
    const bodyBot = Math.min(open, close);
    const UW = high - bodyTop;
    const LW = bodyBot - low;

    this.O.push(open); this.H.push(high); this.L.push(low); this.C.push(close);
    this.isGreenS.push(isGreen); this.bodyTopS.push(bodyTop); this.bodyBotS.push(bodyBot);
    this.timeS.push(time);
    this.barIndex++;

    // ── the 9EMA band ────────────────────────────────────────────────
    const alpha = 2 / (9 + 1);
    const bandHigh = na(this._emaHighPrev) ? high : alpha * high + (1 - alpha) * this._emaHighPrev;
    const bandLow = na(this._emaLowPrev) ? low : alpha * low + (1 - alpha) * this._emaLowPrev;
    this._emaHighPrev = bandHigh; this._emaLowPrev = bandLow;
    this.bandHighS.push(bandHigh); this.bandLowS.push(bandLow);

    // Resolves an absolute bar index to the real candle time it happened
    // on (via timeS). Falls back to the current bar's time if the index
    // is missing/out of range, so a bad bar reference degrades to the old
    // (still-correct-most-of-the-time) behaviour instead of throwing/NaN.
    const barTime = (bar) => {
      const t = this.timeS.at(bar);
      return na(t) ? time : t;
    };

    const events = [];
    const emit = (tag, side, opts = {}) => {
      events.push({
        tag, side, actionable: ACTIONABLE_TAGS.has(tag),
        provisional: opts.provisional ?? false,
        price: opts.price ?? undefined,
        note: opts.note ?? '',
        // Every point/flip must be traceable to the exact candle Pine drew
        // it on — never a derived/approximate timestamp, never scan time.
        // Pivot-based points (P1/P2/P3/P5 — see barTime callers below) only
        // become *known* 1-2 bars after they happened, so those calls pass
        // an explicit `opts.time` (the real point bar); everything else
        // (P4 triggers, flips, confirms, NC/CAUT/done/expired) is evaluated
        // directly on the current bar with no lag, so it keeps the ambient
        // `time` via this default.
        time: opts.time ?? time,
        barIndex: this.barIndex,
      });
    };

    // ── session / day ────────────────────────────────────────────────
    const dayStamp = this._dayKey(time);
    const newDay = na(this.lastDayStamp) || dayStamp !== this.lastDayStamp;
    this.lastDayStamp = dayStamp;

    if (newDay && this.autoScale) this.symScale = Math.max(close / 24000.0, 0.000001);
    const bandNear = this.bandNearIn * this.symScale;
    const roomToP3 = this.t5RoomToP3In * this.symScale;

    // ── MH / ML — morning frame ──────────────────────────────────────
    if (newDay) {
      this.MH = high; this.ML = low;
      this.frameReady = false; this.mhFired = false; this.mlFired = false;
      // the frame is set AND ready on the confirm of the day's first bar,
      // since we only ever process closed candles here (barstate.isconfirmed)
      this.frameReady = true;
    }
    const mhBroken = this.frameReady && !na(this.MH) && high > this.MH && !this.mhFired;
    const mlBroken = this.frameReady && !na(this.ML) && low < this.ML && !this.mlFired;
    if (mhBroken) this.mhFired = true;
    if (mlBroken) this.mlFired = true;
    if (mhBroken || mlBroken) emit('MH / ML broken', null, { note: 'Morning frame crossed — observation only.' });

    // ── trend — baseline hysteresis + manual override ───────────────
    if (close > bandHigh && this.trendState !== 'UP') {
      this.trendState = 'UP'; this.trendConfirmed = false; this.structHigh = high;
    } else if (close < bandLow && this.trendState !== 'DOWN') {
      this.trendState = 'DOWN'; this.trendConfirmed = false; this.structLow = low;
    }
    if (this.trendState === 'UP') {
      if (!this.trendConfirmed && isGreen && close > nz(this.structHigh, close)) this.trendConfirmed = true;
      this.structHigh = Math.max(nz(this.structHigh, high), high);
    } else if (this.trendState === 'DOWN') {
      if (!this.trendConfirmed && !isGreen && close < nz(this.structLow, close)) this.trendConfirmed = true;
      this.structLow = Math.min(nz(this.structLow, low), low);
    }
    const effTrend = this.trendMode === 'Auto' ? this.trendState
      : this.trendMode === 'Force UP' ? 'UP'
        : this.trendMode === 'Force DOWN' ? 'DOWN' : 'SIDEWAYS';
    const effConf = this.trendMode === 'Auto' ? this.trendConfirmed : true;
    const huntT5H = effTrend === 'UP' && effConf;
    const huntT5L = effTrend === 'DOWN' && effConf;
    const sidewaysNow = effTrend === 'SIDEWAYS';

    // ── pivots — 2-candle road + rolling retro anchors ───────────────
    const ph = pivotHigh(this.H, 2, 2);
    const pl = pivotLow(this.L, 2, 2);
    if (!na(ph)) {
      this.lastPH = ph; this.lastPHBar = this.barIndex - 2;
      this.lastPHReach = this.H.get(2) >= this.bandHighS.get(2);
    }
    if (!na(pl)) {
      this.lastPL = pl; this.lastPLBar = this.barIndex - 2;
      this.lastPLStrict = pl < this.bandLowS.get(2);
    }
    if (!na(ph) && this.H.get(2) >= this.bandHighS.get(2)) {
      this.lastPHTouch = ph; this.lastPHTouchBar = this.barIndex - 2;
    }
    if (!na(pl) && pl < this.bandLowS.get(2)) {
      this.lastPLBelow = pl; this.lastPLBelowBar = this.barIndex - 2;
    }

    // fast path (Sr. 70): opposite-colour rejection of the poke candle's close
    const fastHiNow = this.C.get(1) > this.O.get(1) && !isGreen && close < this.C.get(1);
    const fastHiPx = Math.max(high, nz(this.H.get(1), high));
    const fastLoNow = this.C.get(1) < this.O.get(1) && isGreen && close > this.C.get(1);
    const fastLoPx = Math.min(low, nz(this.L.get(1), low));

    // ══════════════════════════════════════════════════════════════
    //  T5H — the double top
    // ══════════════════════════════════════════════════════════════
    let t5hArmedNow = false, t5hRean = false, t5hGate2Now = false;
    let t5hP3Now = false, t5hP3ReanNow = false, t5h3ncNow = false, t5hCautNow = false, t5hDissNow = false;
    let t5h4Fire = false, t5hP5Now = false, t5hS5Fire = false;
    let t5h6ncNow = false, t5h6ConfNow = false, t5h6ncFailNow = false;
    let t5hLFlip = false, t5hLFlipName = '', t5hS2Flip = false, t5hExpNow = false;
    let t5hRef = undefined;

    const t5hCeil = (!na(this.t5hP2Hi) && !na(this.t5hP1))
      ? this.t5hP2Hi + this.t5FlipFib * (this.t5hP2Hi - this.t5hP1) : undefined;
    const f_lastLowH = () => (!na(this.t5hP5Low) ? this.t5hP5Low : this.t5hP3);

    {
      if (newDay) {
        this.t5hStage = 0; this.t5hCaut = false; this.t5h3nc = false; this.t5h6nc = false;
        this.t5hP3 = undefined; this.t5hP5Low = undefined; this.t5hP5Bar = undefined;
        this.t5hP6 = undefined; this.t5hP6Bar = undefined;
      }

      if (this.t5hStage === 1 && (sidewaysNow || huntT5L)) this.t5hStage = 0;

      // point 1 candidate — strict pivot low below the band
      const strictNew = !na(pl) && pl < this.bandLowS.get(2);
      if (huntT5H && this.t5lStage === 0 && this.t5hStage === 0 && strictNew) {
        this.t5hStage = 1; this.t5hP1 = pl; this.t5hP1Bar = this.barIndex - 2;
      } else if (this.t5hStage === 1 && strictNew && pl < this.t5hP1) {
        this.t5hP1 = pl; this.t5hP1Bar = this.barIndex - 2;
      }
      // hand-off seed (Sr. 105/108 — must sit strictly below the band at its own bar)
      if (this.t5hStage === 0 && !na(this.seedT5H1) && huntT5H) {
        const bandLowAtSeed = this.bandLowS.at(this.seedT5H1Bar);
        if (this.seedT5H1 < bandLowAtSeed) {
          this.t5hStage = 1; this.t5hP1 = this.seedT5H1; this.t5hP1Bar = this.seedT5H1Bar;
          this.t5hSeedBar = this.seedT5H1Bar;
        }
        this.seedT5H1 = undefined; // consumed either way
      }

      // point 2 — pivot high at/above band bottom; arms (Sr. 71 fast path)
      const p2hFast = fastHiNow && high >= bandLow;
      const p2hSlow = !na(ph) && ph >= this.bandLowS.get(2);
      const p2hPx = p2hFast ? fastHiPx : ph;
      const p2hBar = p2hFast ? (high >= nz(this.H.get(1), -Infinity) ? this.barIndex : this.barIndex - 1) : this.barIndex - 2;
      const p2hCand = p2hFast || p2hSlow;
      if (this.t5hStage === 0 && p2hCand && huntT5H && this.t5lStage === 0 &&
        !na(this.lastPL) && this.lastPLStrict && this.lastPL < p2hPx && this.lastPLBar < p2hBar) {
        this.t5hStage = 1; this.t5hP1 = this.lastPL; this.t5hP1Bar = this.lastPLBar;
      }
      if (this.t5hStage === 1 && p2hCand && this.t5hP1 < p2hPx && this.t5hP1Bar < p2hBar - 1) {
        this.t5hStage = 2;
        this.t5hP2Hi = p2hPx;
        this.t5hP2Lo = p2hFast ? Math.max(this.bodyTopS.get(1), bodyTop) : Math.max(this.O.get(2), this.C.get(2));
        this.t5hP2Bar = p2hBar;
        this.t5hP3 = undefined; this.t5hP4 = undefined; this.t5hP5Low = undefined; this.t5hP5Bar = undefined;
        this.t5h3nc = false; this.t5hCaut = false; this.t5h6nc = false; this.t5h4Sent = false;
        this.t5hPend = 0; t5hArmedNow = true;
      } else if (this.t5hStage === 2 && p2hCand && p2hPx > this.t5hP2Hi && this.t5hP1 < p2hPx) {
        this.t5hP2Hi = p2hPx;
        this.t5hP2Lo = p2hFast ? Math.max(this.bodyTopS.get(1), bodyTop) : Math.max(this.O.get(2), this.C.get(2));
        this.t5hP2Bar = p2hBar; t5hArmedNow = true; t5hRean = true;
      }

      // T5H3NC (Sr. 82)
      if (this.t5hStage === 2 && !this.t5h3nc && !this.t5hCaut && !isGreen && close < bandLow) {
        this.t5h3nc = true; this.t5h3ncLow = low; t5h3ncNow = true;
      }
      if (this.t5hStage === 2 && this.t5h3nc && !this.t5hCaut && !isGreen && close < this.t5h3ncLow) {
        this.t5hCaut = true; this.t5hCautLow = low; t5hCautNow = true;
      }

      // point 3 — pivot low < p2.high AND < bandHigh
      const p3Fast = fastLoNow && fastLoPx < this.t5hP2Hi && fastLoPx < bandHigh;
      const p3Slow = !na(pl) && pl < this.t5hP2Hi && pl < this.bandHighS.get(2);
      const p3Px = p3Fast ? fastLoPx : pl;
      const p3Bar = p3Fast ? (low <= nz(this.L.get(1), Infinity) ? this.barIndex : this.barIndex - 1) : this.barIndex - 2;
      if (this.t5hStage === 2 && (p3Fast || p3Slow) && p3Bar >= this.t5hP2Bar + 2) {
        this.t5hStage = 3; this.t5hP3 = p3Px; this.t5hP3Bar = p3Bar;
        this.t5hApexHi = high; this.t5hApexBar = this.barIndex; this.t5hApexPoke = high >= bandHigh - bandNear;
        this.t5h3nc = false; this.t5hCaut = false; t5hP3Now = true;
      }
      if (this.t5hStage === 3 && (p3Fast || p3Slow) && p3Px < this.t5hP3 && p3Px > this.t5hP1) {
        this.t5hP3 = p3Px; this.t5hP3Bar = p3Bar; t5hP3Now = true; t5hP3ReanNow = true;
      }

      // caution at stage 3 (Sr. 62/73)
      if (this.t5hStage === 3 && !this.t5hCaut && !isGreen && close < this.t5hP3 && close < bandLow) {
        if (this.t5hApexPoke && close < open) {
          this.t5hP4 = this.t5hApexHi; this.t5hP4Bar = this.t5hApexBar;
          t5h4Fire = true; this.t5h4Sent = true; this.t5hStage = 5; this.t5hPend = 0;
        } else {
          this.t5hCaut = true; this.t5hCautLow = low; t5hCautNow = true;
        }
      }
      // dissolution (Sr. 73)
      if ((this.t5hStage === 2 || this.t5hStage === 3) && this.t5hCaut && !t5hCautNow && !isGreen && close < this.t5hCautLow) {
        t5hDissNow = true;
        this.seedT5L1 = !na(this.lastPH) ? this.lastPH : this.t5hP2Hi;
        this.seedT5L1Bar = !na(this.lastPHBar) ? this.lastPHBar : this.t5hP2Bar;
        this.t5hStage = 0; this.t5hCaut = false; this.t5h3nc = false;
      }
      // bounce off the caution -> caution clears
      if (this.t5hStage === 3 && this.t5hCaut && isGreen && close > this.t5hP3) this.t5hCaut = false;

      // apex tracking at stage 3
      if (this.t5hStage === 3 && high > nz(this.t5hApexHi, high - 1)) {
        this.t5hApexHi = high; this.t5hApexBar = this.barIndex; this.t5hApexPoke = high >= bandHigh - bandNear;
      }

      // Sr. 100 — point-4 cap: a pivot ABOVE T5H2 trails T5H2 up
      if ((this.t5hStage === 3 || this.t5hStage === 4) && p2hCand && p2hPx > this.t5hP2Hi) {
        t5hGate2Now = true;
        const guOk = !na(this.lastPLBelow) && this.lastPLBelow < p2hPx;
        this.t5hP1 = guOk ? this.lastPLBelow : this.t5hP3;
        this.t5hP1Bar = guOk ? this.lastPLBelowBar : this.t5hP3Bar;
        this.t5hP2Hi = p2hPx;
        this.t5hP2Lo = p2hFast ? Math.max(this.bodyTopS.get(1), bodyTop) : Math.max(this.O.get(2), this.C.get(2));
        this.t5hP2Bar = p2hBar;
        this.t5hP3 = undefined; this.t5hP4 = undefined; this.t5hPend = 0;
        this.t5h3nc = false; this.t5hCaut = false; this.t5h6nc = false; this.t5h4Sent = false;
        this.t5hStage = 2; t5hArmedNow = true; t5hRean = true;
      }

      // point 4 — poke of the band top, above p3, capped by T5H2
      const h1 = this.H.get(1), c1 = this.C.get(1), o1 = this.O.get(1), bh1 = this.bandHighS.get(1);
      const p4Fast = !na(c1) && c1 > o1 && h1 >= bh1 - bandNear && !isGreen && close < c1 && close < bandHigh &&
        Math.max(high, h1) <= this.t5hP2Hi;
      const p4Slow = !na(ph) && this.H.get(2) >= this.bandHighS.get(2) - bandNear && ph > this.t5hP3 && ph <= this.t5hP2Hi;
      if (this.t5hStage === 3 && p4Fast && Math.max(high, h1) > this.t5hP3 &&
        (high >= h1 ? this.barIndex : this.barIndex - 1) > this.t5hP3Bar) {
        this.t5hP4 = Math.max(high, h1);
        this.t5hP4Bar = high >= h1 ? this.barIndex : this.barIndex - 1;
        t5h4Fire = true; this.t5h4Sent = true; this.t5hStage = 5; this.t5hPend = 0;
      } else if (this.t5hStage === 3 && p4Slow && this.barIndex - 2 > this.t5hP3Bar) {
        this.t5hP4 = ph; this.t5hP4Bar = this.barIndex - 2; this.t5hStage = 4;
      }
      if (this.t5hStage === 4) {
        const red0 = !isGreen && close < bandHigh;
        const red1 = !na(c1) && !this.isGreenS.get(1) && c1 < bh1 && this.barIndex - 1 > this.t5hP4Bar;
        if (red0 || red1) { t5h4Fire = true; this.t5h4Sent = true; this.t5hStage = 5; this.t5hPend = 0; }
      }

      // point 5 — single-candle poke of the far edge
      if (this.t5hStage === 5) {
        if (!isGreen && low <= bandLow + bandNear && low < this.t5hP3) {
          this.t5hStage = 6; this.t5hP5Low = low; this.t5hP5LW = LW; this.t5hP5Bar = this.barIndex; this.t5hPend = 0; t5hP5Now = true;
        } else {
          this.t5hPend += 1;
          if (this.t5hPend > this.t5PendingBars) { t5hExpNow = true; this.t5hStage = 0; }
        }
      }

      // stage 6 — point-6 NC road + S continuation
      if (this.t5hStage === 6) {
        if (low < bandLow && low < this.t5hP3 && low < this.t5hP5Low - this.t5hP5LW) {
          t5hS5Fire = true; this.t5hStage = 0;
        } else {
          if (!this.t5h6nc && isGreen && close > bandHigh && high < this.t5hP4) {
            this.t5h6nc = true; this.t5h6ncClose = close; this.t5h6ncHigh = high; this.t5h6ncBody = bodyTop; t5h6ncNow = true;
          } else if (this.t5h6nc && !t5h6ncNow) {
            if (low < this.t5h6ncClose) { t5h6ConfNow = true; t5hRef = this.t5h6ncBody; this.t5hP6 = this.t5h6ncBody; this.t5hP6Bar = this.barIndex; this.t5hStage = 0; }
            else if (high > this.t5h6ncHigh) { t5h6ncFailNow = true; this.t5h6nc = false; }
          }
          if (this.t5hStage === 6) {
            this.t5hPend += 1;
            if (this.t5hPend > this.t5PendingBars) { t5hExpNow = true; this.t5hStage = 0; }
          }
        }
      }

      // the ONE trap flip (Sr. 92/96)
      if (this.t5hStage >= 3 && this.t5hStage <= 6 && !na(t5hCeil) && high > t5hCeil) {
        t5hLFlip = true;
        t5hLFlipName = (this.t5h6nc || t5h6ConfNow) ? 'L T5H6 FLIP'
          : this.t5hStage === 6 ? 'L T5H5 FLIP'
            : !na(this.t5hP4) ? 'L T5H4 FLIP' : 'L T5H3 FLIP';
        if (this.t5h6nc) { t5h6ncFailNow = true; this.t5h6nc = false; }
        this.seedT5H1 = f_lastLowH();
        this.seedT5H1Bar = this.t5hStage === 6 ? this.barIndex : this.t5hP3Bar;
        this.t5hStage = 0;
      }

      // S T5H2 FLIP (Sr. 60/65/66)
      if (this.t5hStage === 2 && low < this.t5hP1) {
        t5hS2Flip = true;
        this.seedT5L1 = this.t5hP2Hi; this.seedT5L1Bar = this.t5hP2Bar;
        this.t5hStage = 0; this.t5h3nc = false; this.t5hCaut = false;
      }
    }

    // cancel: a trap flip retracting an already-fired T5H4 trigger (R33·20/23)
    if (t5hLFlip && this.t5h4Sent) {
      emit('✕ S T5H4 CANCELLED', 'short', { note: 'Trap ceiling flip retracted the short (R33·20/23).' });
    }

    // ── emit T5H events, in cheat-sheet order ─────────────────────────
    // Point-formation INFO marks — no alertcondition in Pine (these are
    // just drawn labels), but the cheat-sheet lists them as their own INFO
    // row ("T5H1…T5H6 — drawn as they form") and the UI timeline needs a
    // real candle time per point, so we surface them here as non-actionable
    // events (not in ACTIONABLE_TAGS — pure context, same as NC/CAUT/done).
    if (t5hArmedNow && !t5hRean) emit('T5H1', 'short', { price: this.t5hP1, note: 'Point 1 anchor (Sr. 112).', time: barTime(this.t5hP1Bar) });
    if (t5hArmedNow) emit('T5H2', 'short', { price: this.t5hP2Hi, note: 'Point 2 armed (Sr. 99).', time: barTime(this.t5hP2Bar) });
    if (t5hP3Now) emit('T5H3', 'short', { price: this.t5hP3, note: 'Point 3 formed.', time: barTime(this.t5hP3Bar) });
    if (t5hP5Now) emit('T5H5', 'short', { price: this.t5hP5Low, note: 'Point 5 poke of the far edge.', time: barTime(this.t5hP5Bar) });
    if (t5h4Fire) emit('S T5H4', 'short', { provisional: true, price: this.t5hP4, note: 'First red close below 9EMA High (R33·12). Provisional until point 5.' });
    if (t5h6ConfNow) emit('S T5H6', 'short', { price: t5hRef, note: 'Point 6 confirmed by the poke (Sr. 95/97).' });
    if (t5hS5Fire) emit('S T5H5 FLIP', 'short', { note: 'Point-5 break continuation (Sr. 59). Disarmed; manual below.' });
    if (t5hS2Flip) emit('S T5H2 FLIP', 'short', { note: 'Point-1 break — trend reverse (Sr. 60/65/66). Hands off to T5L1.' });
    if (t5hLFlip) emit('L T5H FLIP (trap)', 'long', { note: `${t5hLFlipName} — trap ceiling, intrabar-committed (Sr. 92/96).` });
    if (t5hCautNow) emit('S/L CAUT T5H3 FLIP', null, { note: 'Checkpoint — structure alive (Sr. 73).' });
    if (t5h3ncNow) emit('T5H3NC', null, { note: 'Provisional (Sr. 82) — not a signal.' });
    if (t5h6ncNow) emit('T5H6NC', null, { note: 'Provisional (Sr. 95) — not a signal.' });
    if (t5hDissNow) emit('T5H ✓ dissolved', null, { note: 'Caution resolved against the structure (Sr. 73).' });
    if (t5hGate2Now) emit('T5H gate 2 → re-armed', null, { note: 'Sr. 100/108 — pivot above T5H2 re-anchored the structure.', time: barTime(this.t5hP2Bar) });
    if (t5hExpNow) emit('T5H ✕ expired', null, { note: 'Point 5/6 unresolved within the pending window (R33·14).' });
    if (t5hS2Flip || t5hLFlip || t5hS5Fire || t5h6ConfNow) emit('T5H ✓ done', null, { note: 'Structure resolved and disarmed (Sr. 67).' });

    // ══════════════════════════════════════════════════════════════
    //  T5L — the mirror (double bottom / long), with gates 2/3
    // ══════════════════════════════════════════════════════════════
    let t5lArmedNow = false, t5lRean = false, t5lP3Now = false, t5lP3ReanNow = false;
    let t5l3ncNow = false, t5lCautNow = false, t5lDissNow = false, t5l4Fire = false, t5l4Supp = false;
    let t5lGate2Now = false, t5lP5Now = false, t5lL5Fire = false;
    let t5l6ncNow = false, t5l6ConfNow = false, t5l6ncFailNow = false;
    let t5lSFlip = false, t5lSFlipName = '', t5lL2Flip = false, t5lExpNow = false;
    let t5lRef = undefined;

    const t5lFloor = (!na(this.t5lP2Lo) && !na(this.t5lP1))
      ? this.t5lP2Lo - this.t5FlipFib * (this.t5lP1 - this.t5lP2Lo) : undefined;
    const f_lastHighL = () => (!na(this.t5lP5High) ? this.t5lP5High : this.t5lP3);

    {
      if (newDay) {
        this.t5lStage = 0; this.t5lCaut = false; this.t5l3nc = false; this.t5l6nc = false;
        this.t5lP3 = undefined; this.t5lP5High = undefined; this.t5lP5Bar = undefined;
        this.t5lP6 = undefined; this.t5lP6Bar = undefined;
        this.seedT5L1 = undefined; this.seedT5H1 = undefined;
      }

      if (this.t5lStage === 1 && (sidewaysNow || huntT5H)) this.t5lStage = 0;

      // point 1 — relaxed: pivot high reaching the band
      const reachNew = !na(ph) && this.H.get(2) >= this.bandHighS.get(2);
      if (huntT5L && this.t5hStage === 0 && this.t5lStage === 0 && reachNew) {
        this.t5lStage = 1; this.t5lP1 = ph; this.t5lP1Bar = this.barIndex - 2;
      } else if (this.t5lStage === 1 && reachNew && ph > this.t5lP1) {
        this.t5lP1 = ph; this.t5lP1Bar = this.barIndex - 2;
      }
      // hand-off seeds
      if (this.t5lStage === 0 && !na(this.seedT5L1) && huntT5L) {
        const bandHighAtSeed = this.bandHighS.at(this.seedT5L1Bar);
        if (this.seedT5L1 >= bandHighAtSeed) {
          this.t5lStage = 1; this.t5lP1 = this.seedT5L1; this.t5lP1Bar = this.seedT5L1Bar;
        }
        this.seedT5L1 = undefined;
      }

      // point 2 — pivot low at/below band top; arms
      const p2lFast = fastLoNow && low <= bandHigh;
      const p2lSlow = !na(pl) && pl <= this.bandHighS.get(2);
      const p2lPx = p2lFast ? fastLoPx : pl;
      const p2lBar = p2lFast ? (low <= nz(this.L.get(1), Infinity) ? this.barIndex : this.barIndex - 1) : this.barIndex - 2;
      const p2lCand = p2lFast || p2lSlow;
      if (this.t5lStage === 0 && p2lCand && huntT5L && this.t5hStage === 0 &&
        !na(this.lastPH) && this.lastPHReach && this.lastPH > p2lPx && this.lastPHBar < p2lBar) {
        this.t5lStage = 1; this.t5lP1 = this.lastPH; this.t5lP1Bar = this.lastPHBar;
      }
      if (this.t5lStage === 1 && p2lCand && this.t5lP1 > p2lPx && this.t5lP1Bar < p2lBar - 1) {
        this.t5lStage = 2;
        this.t5lP2Lo = p2lPx;
        this.t5lP2Hi = p2lFast ? Math.min(this.bodyBotS.get(1), bodyBot) : Math.min(this.O.get(2), this.C.get(2));
        this.t5lP2Bar = p2lBar;
        this.t5lP3 = undefined; this.t5lP4 = undefined; this.t5lP5High = undefined; this.t5lP5Bar = undefined;
        this.t5l3nc = false; this.t5lCaut = false; this.t5l6nc = false; this.t5l4Sent = false;
        this.t5lRoomOK = true; this.t5lPend = 0; t5lArmedNow = true;
      } else if (this.t5lStage === 2 && p2lCand && p2lPx < this.t5lP2Lo && this.t5lP1 > p2lPx) {
        this.t5lP2Lo = p2lPx;
        this.t5lP2Hi = p2lFast ? Math.min(this.bodyBotS.get(1), bodyBot) : Math.min(this.O.get(2), this.C.get(2));
        this.t5lP2Bar = p2lBar; t5lArmedNow = true; t5lRean = true;
      }

      // T5L3NC (mirror)
      if (this.t5lStage === 2 && !this.t5l3nc && !this.t5lCaut && isGreen && close > bandHigh) {
        this.t5l3nc = true; this.t5l3ncHigh = high; t5l3ncNow = true;
      }
      if (this.t5lStage === 2 && this.t5l3nc && !this.t5lCaut && isGreen && close > this.t5l3ncHigh) {
        this.t5lCaut = true; this.t5lCautHigh = high; t5lCautNow = true;
      }

      // point 3 — pivot high > p2.low AND > bandLow
      const q3Fast = fastHiNow && fastHiPx > this.t5lP2Lo && fastHiPx > bandLow;
      const q3Slow = !na(ph) && ph > this.t5lP2Lo && ph > this.bandLowS.get(2);
      const q3Px = q3Fast ? fastHiPx : ph;
      const q3Bar = q3Fast ? (high >= nz(this.H.get(1), -Infinity) ? this.barIndex : this.barIndex - 1) : this.barIndex - 2;
      if (this.t5lStage === 2 && (q3Fast || q3Slow) && q3Bar >= this.t5lP2Bar + 2) {
        this.t5lStage = 3; this.t5lP3 = q3Px; this.t5lP3Bar = q3Bar;
        this.t5lApexLo = low; this.t5lApexBar = this.barIndex; this.t5lApexPoke = low <= bandLow + bandNear;
        this.t5l3nc = false; this.t5lCaut = false; t5lP3Now = true;
      }
      if (this.t5lStage === 3 && (q3Fast || q3Slow) && q3Px > this.t5lP3 && q3Px < this.t5lP1) {
        this.t5lP3 = q3Px; this.t5lP3Bar = q3Bar; t5lP3Now = true; t5lP3ReanNow = true;
      }

      // caution at stage 3 (mirror)
      if (this.t5lStage === 3 && !this.t5lCaut && isGreen && close > this.t5lP3 && close > bandHigh) {
        if (this.t5lApexPoke && close > open) {
          this.t5lP4 = this.t5lApexLo; this.t5lP4Bar = this.t5lApexBar;
          this.t5lRoomVal = this.t5lP3 - this.t5lApexLo;
          this.t5lRoomOK = this.t5lRoomVal >= roomToP3;
          if (this.t5lRoomOK) { t5l4Fire = true; this.t5l4Sent = true; } else { t5l4Supp = true; }
          this.t5lStage = 5; this.t5lPend = 0;
        } else {
          this.t5lCaut = true; this.t5lCautHigh = high; t5lCautNow = true;
        }
      }
      if ((this.t5lStage === 2 || this.t5lStage === 3) && this.t5lCaut && !t5lCautNow && isGreen && close > this.t5lCautHigh) {
        t5lDissNow = true;
        this.seedT5H1 = !na(this.lastPL) ? this.lastPL : this.t5lP2Lo;
        this.seedT5H1Bar = !na(this.lastPLBar) ? this.lastPLBar : this.t5lP2Bar;
        this.t5lStage = 0; this.t5lCaut = false; this.t5l3nc = false;
      }
      if (this.t5lStage === 3 && this.t5lCaut && !isGreen && close < this.t5lP3) this.t5lCaut = false;

      if (this.t5lStage === 3 && low < nz(this.t5lApexLo, low + 1)) {
        this.t5lApexLo = low; this.t5lApexBar = this.barIndex; this.t5lApexPoke = low <= bandLow + bandNear;
      }

      // Sr. 100 mirror — a pivot BELOW T5L2 trails T5L2 down
      if ((this.t5lStage === 3 || this.t5lStage === 4) && p2lCand && p2lPx < this.t5lP2Lo) {
        t5lGate2Now = true;
        const g2okA = !na(this.lastPHTouch) && this.lastPHTouch > p2lPx;
        this.t5lP1 = g2okA ? this.lastPHTouch : this.t5lP3;
        this.t5lP1Bar = g2okA ? this.lastPHTouchBar : this.t5lP3Bar;
        this.t5lP2Lo = p2lPx;
        this.t5lP2Hi = p2lFast ? Math.min(this.bodyBotS.get(1), bodyBot) : Math.min(this.O.get(2), this.C.get(2));
        this.t5lP2Bar = p2lBar;
        this.t5lP3 = undefined; this.t5lP4 = undefined; this.t5lPend = 0;
        this.t5l3nc = false; this.t5lCaut = false; this.t5l6nc = false; this.t5l4Sent = false;
        this.t5lRoomOK = true; this.t5lStage = 2; t5lArmedNow = true; t5lRean = true;
      }

      // point 4 — poke of the band bottom, below p3, gates 2/3
      const l1 = this.L.get(1), c1b = this.C.get(1), o1b = this.O.get(1), bl1 = this.bandLowS.get(1);
      const q4Fast = !na(c1b) && c1b < o1b && l1 <= bl1 + bandNear && isGreen && close > c1b && close > bandLow;
      const q4Slow = !na(pl) && this.L.get(2) <= this.bandLowS.get(2) + bandNear && pl < this.t5lP3;
      const q4Px = q4Fast ? Math.min(low, l1) : pl;
      const q4Bar = q4Fast ? (low <= l1 ? this.barIndex : this.barIndex - 1) : this.barIndex - 2;
      // Sr. 110 — point 4 must be a later trough than point 3
      if (this.t5lStage === 3 && (q4Fast || q4Slow) && q4Bar > this.t5lP3Bar) {
        if (q4Px < this.t5lP2Lo) {
          // GATE 2 continuation — hand-off and re-arm (Sr. 53)
          t5lGate2Now = true;
          const g2okB = !na(this.lastPHTouch) && this.lastPHTouch > q4Px;
          this.t5lP1 = g2okB ? this.lastPHTouch : this.t5lP3;
          this.t5lP1Bar = g2okB ? this.lastPHTouchBar : this.t5lP3Bar;
          this.t5lP2Lo = q4Px;
          this.t5lP2Hi = q4Fast ? Math.min(this.bodyBotS.get(1), bodyBot) : Math.min(this.O.get(2), this.C.get(2));
          this.t5lP2Bar = q4Bar;
          this.t5lP3 = undefined; this.t5lP4 = undefined; this.t5lPend = 0;
          this.t5l3nc = false; this.t5lCaut = false; this.t5l6nc = false; this.t5l4Sent = false;
          this.t5lRoomOK = true; this.t5lStage = 2; t5lArmedNow = true; t5lRean = true;
        } else {
          this.t5lP4 = q4Px; this.t5lP4Bar = q4Bar;
          this.t5lRoomVal = this.t5lP3 - q4Px;
          this.t5lRoomOK = this.t5lRoomVal >= roomToP3;
          if (q4Fast) {
            if (this.t5lRoomOK) { t5l4Fire = true; this.t5l4Sent = true; } else { t5l4Supp = true; }
            this.t5lStage = 5; this.t5lPend = 0;
          } else {
            this.t5lStage = 4;
          }
        }
      }
      if (this.t5lStage === 4) {
        const grn0 = isGreen && close > bandLow;
        const grn1 = !na(c1b) && this.isGreenS.get(1) && c1b > bl1 && this.barIndex - 1 > this.t5lP4Bar;
        if (grn0 || grn1) {
          if (this.t5lRoomOK) { t5l4Fire = true; this.t5l4Sent = true; } else { t5l4Supp = true; }
          this.t5lStage = 5; this.t5lPend = 0;
        }
      }

      // point 5 — green high pokes the band top, above p3
      if (this.t5lStage === 5) {
        if (isGreen && high >= bandHigh - bandNear && high > this.t5lP3) {
          this.t5lStage = 6; this.t5lP5High = high; this.t5lP5UW = UW; this.t5lP5Bar = this.barIndex; this.t5lPend = 0; t5lP5Now = true;
        } else {
          this.t5lPend += 1;
          if (this.t5lPend > this.t5PendingBars) { t5lExpNow = true; this.t5lStage = 0; }
        }
      }

      // stage 6 — NC road + L continuation
      if (this.t5lStage === 6) {
        if (high > bandHigh && high > this.t5lP3 && high > this.t5lP5High + this.t5lP5UW) {
          t5lL5Fire = true; this.t5lStage = 0;
        } else {
          if (!this.t5l6nc && !isGreen && close < bandLow && low > this.t5lP4) {
            this.t5l6nc = true; this.t5l6ncClose = close; this.t5l6ncLow = low; this.t5l6ncBody = bodyBot; t5l6ncNow = true;
          } else if (this.t5l6nc && !t5l6ncNow) {
            if (high > this.t5l6ncClose) { t5l6ConfNow = true; t5lRef = this.t5l6ncBody; this.t5lP6 = this.t5l6ncBody; this.t5lP6Bar = this.barIndex; this.t5lStage = 0; }
            else if (low < this.t5l6ncLow) { t5l6ncFailNow = true; this.t5l6nc = false; }
          }
          if (this.t5lStage === 6) {
            this.t5lPend += 1;
            if (this.t5lPend > this.t5PendingBars) { t5lExpNow = true; this.t5lStage = 0; }
          }
        }
      }

      // the ONE trap flip (S side)
      if (this.t5lStage >= 3 && this.t5lStage <= 6 && !na(t5lFloor) && low < t5lFloor) {
        t5lSFlip = true;
        t5lSFlipName = (this.t5l6nc || t5l6ConfNow) ? 'S T5L6 FLIP'
          : this.t5lStage === 6 ? 'S T5L5 FLIP'
            : !na(this.t5lP4) ? 'S T5L4 FLIP' : 'S T5L3 FLIP';
        if (this.t5l6nc) { t5l6ncFailNow = true; this.t5l6nc = false; }
        this.seedT5L1 = f_lastHighL();
        this.seedT5L1Bar = this.t5lStage === 6 ? this.barIndex : this.t5lP3Bar;
        this.t5lStage = 0;
      }

      // L T5L2 FLIP (mirror)
      if (this.t5lStage === 2 && high > this.t5lP1) {
        t5lL2Flip = true;
        this.seedT5H1 = this.t5lP2Lo; this.seedT5H1Bar = this.t5lP2Bar;
        this.t5lStage = 0; this.t5l3nc = false; this.t5lCaut = false;
      }
    }

    // cancel: a trap flip retracting an already-fired T5L4 trigger
    if (t5lSFlip && this.t5l4Sent) {
      emit('✕ L T5L4 CANCELLED', 'long', { note: 'Trap floor flip retracted the long (R33·20/23).' });
    }

    // ── emit T5L events, in cheat-sheet order ─────────────────────────
    if (t5lArmedNow && !t5lRean) emit('T5L1', 'long', { price: this.t5lP1, note: 'Point 1 anchor (Sr. 112).', time: barTime(this.t5lP1Bar) });
    if (t5lArmedNow) emit('T5L2', 'long', { price: this.t5lP2Lo, note: 'Point 2 armed (Sr. 99).', time: barTime(this.t5lP2Bar) });
    if (t5lP3Now) emit('T5L3', 'long', { price: this.t5lP3, note: 'Point 3 formed.', time: barTime(this.t5lP3Bar) });
    if (t5lP5Now) emit('T5L5', 'long', { price: this.t5lP5High, note: 'Point 5 poke of the far edge.', time: barTime(this.t5lP5Bar) });
    if (t5l4Fire) emit('L T5L4', 'long', { provisional: true, price: this.t5lP4, note: 'First green close above 9EMA Low. Provisional until point 5.' });
    if (t5l6ConfNow) emit('L T5L6', 'long', { price: t5lRef, note: 'Point 6 confirmed by the poke (Sr. 95/97).' });
    if (t5lL5Fire) emit('L T5L5 FLIP', 'long', { note: 'Point-5 break continuation (Sr. 59). Disarmed; manual above.' });
    if (t5lL2Flip) emit('L T5L2 FLIP', 'long', { note: 'Point-1 break — trend reverse (Sr. 60/65/66). Hands off to T5H1.' });
    if (t5lSFlip) emit('S T5L FLIP (trap)', 'short', { note: `${t5lSFlipName} — trap floor, intrabar-committed (Sr. 92/96).` });
    if (t5lCautNow) emit('S/L CAUT T5L3 FLIP', null, { note: 'Checkpoint — structure alive (Sr. 73 mirror).' });
    if (t5l3ncNow) emit('T5L3NC', null, { note: 'Provisional (Sr. 82) — not a signal.' });
    if (t5l6ncNow) emit('T5L6NC', null, { note: 'Provisional (Sr. 95) — not a signal.' });
    if (t5l4Supp) emit('L T5L4 ✕ gate 3', null, { note: `R33·26 — room ${this.t5lRoomVal?.toFixed(1)} below the scaled minimum (${roomToP3.toFixed(1)}); alert suppressed, structure continues.` });
    if (t5lDissNow) emit('T5L ✓ dissolved', null, { note: 'Caution resolved against the structure (Sr. 73).' });
    if (t5lGate2Now) emit('T5L gate 2 → re-armed', null, { note: 'Sr. 53/100/108 — pivot below T5L2 re-anchored the structure.', time: barTime(this.t5lP2Bar) });
    if (t5lExpNow) emit('T5L ✕ expired', null, { note: 'Point 5/6 unresolved within the pending window (R33·14).' });
    if (t5lL2Flip || t5lSFlip || t5lL5Fire || t5l6ConfNow) emit('T5L ✓ done', null, { note: 'Structure resolved and disarmed (Sr. 67).' });

    return { events, state: this.getState() };
  }

  /**
   * Intrabar (still-forming candle) watchers — Sr. 54. These READ current
   * state but never mutate it; the committed signal only fires from
   * addBar() once the candle actually closes. Pass the live/streaming
   * candle currently in progress: { open, high, low, close }.
   */
  checkIntrabar(liveCandle) {
    const { high, low } = liveCandle;
    const out = [];
    const t5hCeil = (!na(this.t5hP2Hi) && !na(this.t5hP1))
      ? this.t5hP2Hi + this.t5FlipFib * (this.t5hP2Hi - this.t5hP1) : undefined;
    const t5lFloor = (!na(this.t5lP2Lo) && !na(this.t5lP1))
      ? this.t5lP2Lo - this.t5FlipFib * (this.t5lP1 - this.t5lP2Lo) : undefined;

    if (this.t5hStage >= 3 && this.t5hStage <= 6 && !na(t5hCeil) && high > t5hCeil) {
      out.push({ tag: 'L T5H FLIP (trap)', side: 'long', actionable: false, provisional: true, note: 'INTRABAR — trap ceiling traded (R33·54). Commits at close.' });
    }
    if (this.t5lStage >= 3 && this.t5lStage <= 6 && !na(t5lFloor) && low < t5lFloor) {
      out.push({ tag: 'S T5L FLIP (trap)', side: 'short', actionable: false, provisional: true, note: 'INTRABAR — trap floor traded (R33·54). Commits at close.' });
    }
    if (this.t5hStage === 2 && !na(this.t5hP1) && low < this.t5hP1) {
      out.push({ tag: 'S T5H2 FLIP', side: 'short', actionable: false, provisional: true, note: 'INTRABAR — T5H1 traded through (Sr. 60). Commits at close.' });
    }
    if (this.t5lStage === 2 && !na(this.t5lP1) && high > this.t5lP1) {
      out.push({ tag: 'L T5L2 FLIP', side: 'long', actionable: false, provisional: true, note: 'INTRABAR — T5L1 traded through (Sr. 60). Commits at close.' });
    }
    return out;
  }

  /** Panel-equivalent snapshot of current machine state. */
  getState() {
    return {
      t5h: {
        stage: this.t5hStage, caution: this.t5hCaut, nc3: this.t5h3nc, nc6: this.t5h6nc,
        pending: this.t5hPend, pendingLimit: this.t5PendingBars,
        p1: this.t5hP1, p1Bar: this.t5hP1Bar,
        p2Hi: this.t5hP2Hi, p2Lo: this.t5hP2Lo, p2Bar: this.t5hP2Bar,
        p3: this.t5hP3, p3Bar: this.t5hP3Bar,
        p4: this.t5hP4, p4Bar: this.t5hP4Bar,
        p5: this.t5hP5Low, p5Bar: this.t5hP5Bar,
        p6: this.t5hP6, p6Bar: this.t5hP6Bar,
      },
      t5l: {
        stage: this.t5lStage, caution: this.t5lCaut, nc3: this.t5l3nc, nc6: this.t5l6nc,
        pending: this.t5lPend, pendingLimit: this.t5PendingBars,
        p1: this.t5lP1, p1Bar: this.t5lP1Bar,
        p2Lo: this.t5lP2Lo, p2Hi: this.t5lP2Hi, p2Bar: this.t5lP2Bar,
        p3: this.t5lP3, p3Bar: this.t5lP3Bar,
        p4: this.t5lP4, p4Bar: this.t5lP4Bar,
        p5: this.t5lP5High, p5Bar: this.t5lP5Bar,
        p6: this.t5lP6, p6Bar: this.t5lP6Bar,
        roomOK: this.t5lRoomOK,
      },
      trend: { state: this.trendState, confirmed: this.trendConfirmed },
      scale: this.symScale,
      band: { high: this.bandHighS.get(0), low: this.bandLowS.get(0) },
    };
  }
}

// ── UI shaping helpers (Scanner Results / Upcoming tabs) ───────────────
//
// Turns the pure engine's per-bar events + per-bar state into the
// current-state-per-symbol rows t5-scanner-mockup-v2.html expects:
//   - a "results" row once a side's P4 has fired (Results tab — status
//     live / confirmed / cancelled)
//   - an "upcoming" row while a side is still stage 1-3, P4 not fired
//     (Upcoming tab — stage name + flip-watch)
// One symbol can produce up to one row per side (T5H and T5L run as two
// independent machines), so `results`/`upcoming` are arrays of length 0-2.

const STAGE_NAMES = ['idle', 'candidate', 'armed p1-2', 'dip set p3', 'point-4 forming', 'watching p5', 'watching p6'];
const CONFIRM_TAGS = new Set(['S T5H6', 'L T5L6', 'S T5H5 FLIP', 'L T5L5 FLIP']);

function structureOf(tag) {
  if (tag.includes('T5H')) return 'T5H';
  if (tag.includes('T5L')) return 'T5L';
  return null;
}

// Reads P1-P6 off an engine state slice (state.t5h or state.t5l), resolving
// each point's bar index to its actual candle time — never a fallback.
function extractPoints(stateSlice, candles) {
  const barTime = (bar) => (bar != null && candles[bar] ? candles[bar].time : null);
  const defs = [
    ['p1', 'p1Bar'], ['p2Hi', 'p2Bar'], ['p3', 'p3Bar'],
    ['p4', 'p4Bar'], ['p5', 'p5Bar'], ['p6', 'p6Bar'],
  ];
  // t5l uses p2Lo, not p2Hi, as its point-2 price field
  if (stateSlice.p2Lo !== undefined) defs[1][0] = 'p2Lo';
  return defs.map(([priceKey, barKey]) => {
    const price = stateSlice[priceKey];
    const bar = stateSlice[barKey];
    return price == null ? { done: false, price: null, time: null }
      : { done: true, price, time: barTime(bar) };
  });
}

// scannerRunner / strategyRegistry.js require every strategy to export
// { id, name, description, scan(symbol, candles) } returning a ScanResult
// with at minimum { symbol, found, patternStage, error, scannedAt }.
// The class above (TgT5Engine) is the pure Pine port; this wrapper is the
// only "registry-shape" layer on top of it — no state-machine logic lives
// here.
//
// Purity / no-staleness: a brand-new TgT5Engine is created per scan() call
// and fed the FULL candle history from scratch — nothing is cached or
// carried over between scans (same "pure function of candles" contract
// the rest of the scanner already relies on).
function scan(symbol, candles, context = {}) {
  const result = {
    symbol,
    found: false,
    patternStage: 'none',
    side: null,          // "short" | "long" of the most recent actionable tag
    tag: null,           // e.g. "S T5H4", "L T5L6"
    events: [],          // full replay log — every tag on every candle, each carrying its own candle `time`
    state: null,         // final engine.getState() snapshot (stage/caution/NC/trend/band)
    results: [],         // UI Results-tab rows (0-2: T5H side, T5L side) — P4 has fired
    upcoming: [],        // UI Upcoming-tab rows (0-2) — stage 1-3, P4 not fired yet
    lastCandle: candles && candles.length ? candles[candles.length - 1] : null,
    candleCount: candles ? candles.length : 0,
    scannedAt: new Date().toISOString(),
    error: null,
  };

  try {
    if (!candles || candles.length < 20) {
      result.error = 'insufficient_data';
      return result;
    }

    const engine = new TgT5Engine({
      autoScale: context.autoScale,
      trendMode: context.trendMode,
      t5PendingBars: context.t5PendingBars,
      t5FlipFib: context.t5FlipFib,
      t5RoomToP3: context.t5RoomToP3,
      bandNear: context.bandNear,
      timezone: context.timezone,
    });

    const allEvents = [];
    // Tracks the currently-open (P4 fired, unresolved) cycle per side, so
    // a later confirm/cancel/expiry on the SAME cycle can be matched back
    // to the bar+tag that actually opened it.
    const open = { T5H: null, T5L: null };
    const finalRow = { T5H: null, T5L: null }; // last known Results row per side
    let finalState = null;

    for (const candle of candles) {
      const { events, state } = engine.addBar(candle);
      finalState = state;
      for (const ev of events) {
        allEvents.push(ev);
        const struct = structureOf(ev.tag);
        if (!struct) continue;
        const sideSlice = struct === 'T5H' ? state.t5h : state.t5l;

        if (ev.tag === 'S T5H4' || ev.tag === 'L T5L4') {
          open[struct] = { tag: ev.tag, time: ev.time };
        } else if (CONFIRM_TAGS.has(ev.tag) && open[struct]) {
          finalRow[struct] = {
            side: struct, tag: ev.tag, status: 'confirmed', note: ev.note,
            time: ev.time, points: extractPoints(sideSlice, candles),
          };
          open[struct] = null;
        } else if (ev.tag.includes('CANCELLED') && struct) {
          finalRow[struct] = {
            side: struct, tag: open[struct] ? open[struct].tag : ev.tag, status: 'cancelled', note: ev.note,
            time: ev.time, points: extractPoints(sideSlice, candles),
          };
          open[struct] = null;
        } else if ((ev.tag === 'T5H ✕ expired' || ev.tag === 'T5L ✕ expired') && open[struct]) {
          finalRow[struct] = {
            side: struct, tag: open[struct].tag, status: 'cancelled', note: ev.note,
            time: ev.time, points: extractPoints(sideSlice, candles),
          };
          open[struct] = null;
        }
      }
    }
    result.events = allEvents;
    result.state = finalState;

    // Any cycle still open at the end of the candle history is the live,
    // still-unresolved structure (P4 fired, watching P5/P6).
    for (const struct of ['T5H', 'T5L']) {
      if (open[struct] && finalState) {
        const sideSlice = struct === 'T5H' ? finalState.t5h : finalState.t5l;
        finalRow[struct] = {
          side: struct, tag: open[struct].tag, status: 'live', note: 'watching P5/P6',
          time: open[struct].time, points: extractPoints(sideSlice, candles),
        };
      }
      if (finalRow[struct]) result.results.push(finalRow[struct]);
    }

    // Upcoming — only the sides that never reached P4 this cycle (no
    // Results row) AND are currently sitting at stage 1-3.
    //
    // The row's `time` is the candle the side's *last-formed* point
    // actually happened on (p3Bar at stage 3, p2Bar at stage 2, p1Bar at
    // stage 1) — never `lastCandle.time` (the most recently scanned
    // candle), which is wrong the moment a point formed even one bar
    // before the scan's current candle and made every symbol's row show
    // the same, most-recent scan time instead of its own point time.
    if (finalState) {
      const stageBarKey = { 1: 'p1Bar', 2: 'p2Bar', 3: 'p3Bar' };
      for (const struct of ['T5H', 'T5L']) {
        if (finalRow[struct]) continue; // already a Results row — not "upcoming"
        const sideSlice = struct === 'T5H' ? finalState.t5h : finalState.t5l;
        if (sideSlice.stage >= 1 && sideSlice.stage <= 3) {
          const barKey = stageBarKey[sideSlice.stage];
          const bar = barKey ? sideSlice[barKey] : null;
          const pointTime = (bar != null && candles[bar]) ? candles[bar].time : null;
          result.upcoming.push({
            side: struct,
            stage: sideSlice.stage,
            stageName: STAGE_NAMES[sideSlice.stage] || `stage ${sideSlice.stage}`,
            flipWatch: !!(sideSlice.caution || sideSlice.nc3),
            flipName: sideSlice.caution
              ? `${struct === 'T5H' ? 'S/L CAUT T5H3 FLIP' : 'S/L CAUT T5L3 FLIP'} watch`
              : null,
            // Falls back to the last scanned candle only if the stage's
            // own point bar is somehow unavailable (defensive; should not
            // happen in practice once stage >= 1).
            time: pointTime ?? (result.lastCandle ? result.lastCandle.time : null),
          });
        }
      }
    }

    // "found" / patternStage mirror the cheat-sheet's own rule 1 — act
    // ONLY on the actionable tags, everything else (NC/CAUT/done/dissolved/
    // expired/gate-2/cancelled) is context. Walk backwards for the most
    // recent actionable tag across the whole replay, same way S1/S2/S3
    // reports "found" once its final stage has actually fired.
    for (let i = allEvents.length - 1; i >= 0; i--) {
      if (allEvents[i].actionable) {
        const last = allEvents[i];
        result.found = true;
        result.side = last.side;
        result.tag = last.tag;
        result.patternStage = last.tag;
        break;
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

module.exports = {
  id: 'tg-t5',
  name: 'TG T5 (Double Top / Bottom)',
  description: 'Direct Pine port of TG T5 — Script A v16.15 BETA: 9EMA trend hysteresis + double-top(T5H)/double-bottom(T5L) point structure (P1–P6), trap-flip invalidation, gate-2/gate-3.',
  scan,
  // Also exported for direct/standalone use and testing.
  TgT5Engine, ACTIONABLE_TAGS, Series, pivotHigh, pivotLow,
};