// ============================================================
// unifiedAnalyzer.js
//
// ONE API call per symbol. Single O(n) pass produces results
// IDENTICAL to EMAManager.generateEMAReport() + BCVCManager.getHistoricalBCVC().
//
// KEY CORRECTNESS FIXES vs previous attempt:
//   1. EMA-9/100 seeded with SMA of first `period` values — exactly
//      matching EMAManager.calculateSingleEMA() which does:
//        sma = values.slice(0, period).reduce(...) / period
//        then iterates from period → end
//   2. BCVC volEma/rangeEma seeded with first candle's value — exactly
//      matching BCVCManager.calculateEMA() which seeds with values[0]
//   3. Red candles always included in formations (analyzePattern
//      filters them naturally for bullish patterns; bearish needs them)
//   4. Incremental update formula matches both managers exactly
//
// RETURN FORMAT — drop-in for existing main.js:
//   { emadata: { crossover, rawCandles }, bcvc: { formations } }
//   emadata.crossover  → same as EMAManager.generateEMAReport()
//   bcvc.formations    → same as BCVCManager.getHistoricalBCVC()
// ============================================================

const moment = require("moment");

class UnifiedAnalyzer {
  constructor(fyersApi) {
    this.fyers = fyersApi;

    // --- EMA config (must match EMAManager) ---
    this.ema9Period    = 9;
    this.ema100Period  = 100;
    this.ema9Mult      = 2 / (9 + 1);
    this.ema100Mult    = 2 / (100 + 1);

    // --- BCVC config (must match BCVCManager) ---
    this.volumePeriod         = 20;
    this.volumeProportion     = 1.25;
    this.bigCandleLookback    = 7;
    this.bigCandleProportion  = 1.3;
    // BCVCManager.calculateEMA uses values[0] as seed (NOT SMA).
    // The multiplier formula matches: 2 / (period + 1)
    this.volMult   = 2 / (this.volumePeriod + 1);
    this.rangeMult = 2 / (this.bigCandleLookback + 1);

    // --- Fetch config ---
    // 95 days @ 15-min → ~1900 candles — enough for EMA-100 warmup
    // and covers any BCVC lookback the caller might need
    this.FETCH_DAYS = 95;

    // Candle cache: symbol → { candles, lastTs }
    this.candleCache = new Map();
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC: analyze one symbol. Returns null on failure.
  // ─────────────────────────────────────────────────────────
  async analyze(symbol) {
    const candles = await this._fetchCandles(symbol);
    if (!candles || candles.length < this.ema100Period + 2) {
      console.error(`[unified] ${symbol}: not enough candles (${candles?.length ?? 0})`);
      return null;
    }
    return this._runAnalysis(symbol, candles);
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE: fetch with incremental cache
  // ─────────────────────────────────────────────────────────
  async _fetchCandles(symbol) {
    const cached = this.candleCache.get(symbol);
    const now    = moment();

    // ── WARM PATH ─────────────────────────────────────────
    if (cached && cached.candles.length >= this.ema100Period) {
      const fetchFrom = moment.unix(cached.lastTs).subtract(1, "day");

      const res = await this._getHistory({
        symbol,
        resolution:  "15",
        date_format: "1",
        range_from:  fetchFrom.format("YYYY-MM-DD"),
        range_to:    now.format("YYYY-MM-DD"),
        cont_flag:   "1",
      });

      if (!res?.candles?.length) {
        console.log(`[warm-fail] ${symbol}: using cached candles`);
        return cached.candles;
      }

      const seen       = new Set(cached.candles.map((c) => c[0]));
      const newCandles = res.candles.filter((c) => !seen.has(c[0]));

      if (newCandles.length > 0) {
        cached.candles.push(...newCandles);

        // Drop still-forming tail candle
        const tail = cached.candles[cached.candles.length - 1];
        if (tail && this._isForming(tail[0])) cached.candles.pop();

        cached.lastTs = cached.candles[cached.candles.length - 1]?.[0] ?? cached.lastTs;
        console.log(`[cache+] ${symbol}: +${newCandles.length} candles (total: ${cached.candles.length})`);
      } else {
        console.log(`[cache=] ${symbol}: no new candles`);
      }

      return cached.candles;
    }

    // ── COLD PATH ─────────────────────────────────────────
    console.log(`[cold] ${symbol}: fetching ${this.FETCH_DAYS} days...`);

    const res = await this._getHistory({
      symbol,
      resolution:  "15",
      date_format: "1",
      range_from:  now.clone().subtract(this.FETCH_DAYS, "days").format("YYYY-MM-DD"),
      range_to:    now.format("YYYY-MM-DD"),
      cont_flag:   "1",
    });

    if (!res?.candles?.length) {
      console.error(`[cold-empty] ${symbol}: no candles returned`);
      return null;
    }

    let candles = [...res.candles];
    if (this._isForming(candles[candles.length - 1][0])) candles.pop();

    this.candleCache.set(symbol, {
      candles,
      lastTs: candles[candles.length - 1][0],
    });

    console.log(`[cold-ok] ${symbol}: ${candles.length} candles`);
    return candles;
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE: fyers.getHistory with exponential-backoff retry
  // ─────────────────────────────────────────────────────────
  async _getHistory(params, maxRetries = 4) {
    const RL = ["rate limit", "too many", "429", "request limit"];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await this.fyers.getHistory(params);
      } catch (e) {
        const msg = (e.message ?? "").toLowerCase();
        if (RL.some((p) => msg.includes(p)) && attempt < maxRetries) {
          const wait = 2000 * Math.pow(2, attempt);
          console.warn(`[RL-throw] ${params.symbol} retry in ${wait / 1000}s`);
          await this._sleep(wait);
          continue;
        }
        console.error(`[fetch-err] ${params.symbol}: ${e.message}`);
        return null;
      }

      if (res?.candles) return res;

      const msg = (res?.message ?? res?.s ?? "").toLowerCase();
      if (RL.some((p) => msg.includes(p)) && attempt < maxRetries) {
        const wait = 2000 * Math.pow(2, attempt);
        console.warn(`[RL-body] ${params.symbol} retry in ${wait / 1000}s`);
        await this._sleep(wait);
        continue;
      }

      if (msg.includes("invalid") || msg.includes("bad request")) {
        console.error(`[invalid] ${params.symbol}: ${res?.message ?? res?.s}`);
        return null;
      }

      return res;
    }

    console.error(`[give-up] ${params.symbol} after ${maxRetries} retries`);
    return null;
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE: single O(n) pass — EMA crossovers + BCVC
  //
  // EMA seeding:
  //   Accumulates SMA over first `period` candles, then switches
  //   to incremental EMA updates. Matches EMAManager exactly.
  //
  // BCVC seeding:
  //   volEma/rangeEma seeded with first candle's value (values[0]),
  //   then updated incrementally. Matches BCVCManager exactly.
  // ─────────────────────────────────────────────────────────
  _runAnalysis(symbol, candles) {
    const n = candles.length;

    // ── EMA state ──────────────────────────────────────────
    let ema9Sum = 0, ema100Sum = 0;
    let ema9 = null, ema100 = null;
    let prevEma9 = null, prevEma100 = null;

    // ── BCVC state ─────────────────────────────────────────
    let volEma   = null;
    let rangeEma = null;

    const crossovers = [];
    const formations = [];

    // BCVC needs max(volumePeriod, bigCandleLookback) candles before
    // the EMA estimate is meaningful. Matches BCVCManager minRequiredCandles.
    const bcvcWarmup = Math.max(this.volumePeriod, this.bigCandleLookback);

    for (let i = 0; i < n; i++) {
      const c     = candles[i];
      const ts    = c[0];
      const open  = parseFloat(c[1]);
      const high  = parseFloat(c[2]);
      const low   = parseFloat(c[3]);
      const close = parseFloat(c[4]);
      const vol   = parseFloat(c[5]);
      const range = high - low;

      // ══════════════════════════════════════════════════
      // EMA-9 (of lows) — SMA seed, then incremental
      // Mirrors: EMAManager.calculateSingleEMA(lows, 9, mult9)
      // ══════════════════════════════════════════════════
      if (i < this.ema9Period) {
        // Accumulating SMA seed
        ema9Sum += low;
        if (i === this.ema9Period - 1) {
          ema9 = ema9Sum / this.ema9Period; // seed set
        }
      } else {
        // Incremental EMA update (i >= ema9Period)
        prevEma9 = ema9;
        ema9 = (low - ema9) * this.ema9Mult + ema9;
      }

      // ══════════════════════════════════════════════════
      // EMA-100 (of closes) — SMA seed, then incremental
      // Mirrors: EMAManager.calculateSingleEMA(closes, 100, mult100)
      // ══════════════════════════════════════════════════
      if (i < this.ema100Period) {
        // Accumulating SMA seed
        ema100Sum += close;
        if (i === this.ema100Period - 1) {
          ema100 = ema100Sum / this.ema100Period; // seed set
        }
      } else {
        // Incremental EMA update (i >= ema100Period)
        prevEma100 = ema100;
        ema100 = (close - ema100) * this.ema100Mult + ema100;
      }

      // ══════════════════════════════════════════════════
      // Crossover detection
      // Both previous and current EMA values must be available.
      // First valid check: i > ema100Period (i=101 earliest).
      // Mirrors: EMAManager.getHistoricalEMA crossover logic.
      // ══════════════════════════════════════════════════
      if (
        i > this.ema100Period &&
        prevEma9 !== null &&
        prevEma100 !== null
      ) {
        const wasBull = prevEma9 > prevEma100;
        const isBull  = ema9    > ema100;

        if (!wasBull && isBull) {
          crossovers.push({
            type:          "BULLISH_CROSSOVER",
            timestamp:     moment.unix(ts).format("YYYY-MM-DD HH:mm"),
            timestampUnix: ts,
            price:         close,
            ema9Low:       ema9,
            ema100Close:   ema100,
            description:   "🚀 9 EMA crossed above 100 EMA",
          });
        } else if (wasBull && !isBull) {
          crossovers.push({
            type:          "BEARISH_CROSSOVER",
            timestamp:     moment.unix(ts).format("YYYY-MM-DD HH:mm"),
            timestampUnix: ts,
            price:         close,
            ema9Low:       ema9,
            ema100Close:   ema100,
            description:   "🔴 9 EMA crossed below 100 EMA",
          });
        }
      }

      // ══════════════════════════════════════════════════
      // BCVC — volEma/rangeEma seeded with values[0]
      // Mirrors: BCVCManager.calculateEMA(values, period)
      //   let ema = values[0];
      //   for i=1..n: ema = val*mult + ema*(1-mult)
      // ══════════════════════════════════════════════════
      if (volEma === null) {
        // Seed with first candle (matches BCVCManager values[0] seed)
        volEma   = vol;
        rangeEma = range;
      } else {
        volEma   = vol   * this.volMult   + volEma   * (1 - this.volMult);
        rangeEma = range * this.rangeMult + rangeEma * (1 - this.rangeMult);
      }

      // BCVC detection — only after warmup period
      // Matches BCVCManager: starts at i = minRequiredCandles - 1 = max(20,7) = 20
      if (i >= bcvcWarmup && volEma > 0 && rangeEma > 0) {
        const volThresh   = volEma   * this.volumeProportion;
        const rangeThresh = rangeEma * this.bigCandleProportion;

        const isUpBar    = close > open;
        const isDownBar  = open  > close;
        const isHighVol  = vol   > volThresh;
        const isBigCandle = range > rangeThresh;

        let candleColor = null;
        let isBullish   = false;
        let isBearish   = false;

        if      (isUpBar   && isHighVol && isBigCandle)  { candleColor = "white";  isBullish = true;  }
        else if (isDownBar && isHighVol && isBigCandle)  { candleColor = "orange"; isBearish = true;  }
        else if (isDownBar && isHighVol && !isBigCandle) { candleColor = "maroon"; isBearish = true;  }
        else if (isDownBar)                              { candleColor = "red";    isBearish = true;  }
        // Always include red — analyzePattern filters it naturally:
        // bullish patterns only use orange/maroon as bearish reference,
        // bearish patterns need red candles for confirmation.

        if (candleColor) {
          formations.push({
            symbol,
            timestamp:     moment.unix(ts).format("YYYY-MM-DD HH:mm"),
            timestampUnix: ts,
            candleColor,
            isBullish,
            isBearish,
            open, high, low, close,
            volume:      vol,
            volumeRatio: +(vol   / volEma).toFixed(2),
            rangeRatio:  +(range / rangeEma).toFixed(2),
          });
        }
      }
    }

    // ── Return in the exact same shape as the working code ──
    // emadata  → EMAManager.generateEMAReport() shape
    // bcvc     → BCVCManager.getHistoricalBCVC() shape
    return {
      emadata: {
        crossover:  crossovers.slice(-5).reverse(), // most-recent first
        rawCandles: candles,
      },
      bcvc: {
        formations,
      },
    };
  }

  // ─────────────────────────────────────────────────────────
  _isForming(ts) {
    return moment().isBefore(moment.unix(ts).add(15, "minutes"));
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  clearSymbol(symbol) {
    this.candleCache.delete(symbol);
  }

  clearAll() {
    this.candleCache.clear();
  }
}

module.exports = UnifiedAnalyzer;