/**
 * database/src/validationEngine.js
 *
 * DATA VALIDATION & INTEGRITY ENGINE
 *
 * Implements all checks described in the architecture diagram:
 *  • Detect missing candles
 *  • Detect duplicate candles
 *  • Detect corrupt OHLC (high < low, zero prices, etc.)
 *  • Detect broken sequence
 *  • Live validation (current trading day)
 *  • Historical validation (startup / manual)
 *  • Periodic synchronization (compare latest DB vs broker)
 */

const { loadCandles, getLatestCandle, countCandles, getValidationState, setValidationState } = require("./candleStore");

// ─── IST helpers ─────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MARKET_OPEN_H  = 9;
const MARKET_OPEN_M  = 15;
const MARKET_CLOSE_H = 15;
const MARKET_CLOSE_M = 30;

function toIST(utcMs) {
  return new Date(utcMs + IST_OFFSET_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pacing between per-day repairDay() calls within a single symbol's
// validation pass. Each repairDay() triggers its own Fyers getHistory call
// (client.js already retries/paces WITHIN a call), but back-to-back calls
// here with zero delay — e.g. a symbol needing 15 day-repairs — was exactly
// the burst pattern that exhausted Fyers' per-second rate limit and cascaded
// into failures for other symbols' concurrent fetches too.
const INTER_DAY_REPAIR_DELAY_MS = 700;

/** Expected number of candles per trading day for a given resolution (minutes). */
function expectedCandlesPerDay(resolution) {
  const sessionMinutes = (MARKET_CLOSE_H * 60 + MARKET_CLOSE_M) - (MARKET_OPEN_H * 60 + MARKET_OPEN_M);
  return Math.floor(sessionMinutes / resolution);
}

/**
 * Returns the expected candle timestamps (in ms UTC) for a trading session.
 * resolution must be an intraday value (< 1440).
 */
function expectedCandlesForDay(tradingDayMs, resolution) {
  // tradingDayMs = any UTC ms within that IST trading day
  const istDate = toIST(tradingDayMs);
  const istMidnightMs = new Date(
    Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate())
  ).getTime() - IST_OFFSET_MS;

  const sessionStartMs = istMidnightMs + (MARKET_OPEN_H * 60 + MARKET_OPEN_M) * 60000;
  const sessionEndMs   = istMidnightMs + (MARKET_CLOSE_H * 60 + MARKET_CLOSE_M) * 60000;
  const stepMs = resolution * 60000;

  const times = [];
  for (let t = sessionStartMs; t < sessionEndMs; t += stepMs) {
    times.push(t);
  }
  return times;
}

// ─── Core validation logic ───────────────────────────────────────────────────

/**
 * Validate a candle array (already loaded from DB or API).
 * Returns { valid, issues }
 */
function validateCandleArray(candles, resolution) {
  const issues = [];

  if (!candles || candles.length === 0) {
    issues.push({ type: "EMPTY", message: "No candles found" });
    return { valid: false, issues };
  }

  // Sorted ascending by time
  const sorted = [...candles].sort((a, b) => a.time - b.time);

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];

    // Corrupt OHLC
    if (!Number.isFinite(c.open) || c.open <= 0 ||
        !Number.isFinite(c.high) || c.high <= 0 ||
        !Number.isFinite(c.low)  || c.low  <= 0 ||
        !Number.isFinite(c.close)|| c.close<= 0) {
      issues.push({ type: "CORRUPT_OHLC", time: c.time, message: `Zero or non-finite OHLC at ${new Date(c.time).toISOString()}` });
      continue;
    }

    if (c.high < c.low) {
      issues.push({ type: "CORRUPT_OHLC", time: c.time, message: `high(${c.high}) < low(${c.low}) at ${new Date(c.time).toISOString()}` });
    }
    if (c.high < c.open || c.high < c.close) {
      issues.push({ type: "CORRUPT_OHLC", time: c.time, message: `high not highest at ${new Date(c.time).toISOString()}` });
    }
    if (c.low > c.open || c.low > c.close) {
      issues.push({ type: "CORRUPT_OHLC", time: c.time, message: `low not lowest at ${new Date(c.time).toISOString()}` });
    }

    // Duplicate (same time as previous)
    if (i > 0 && sorted[i].time === sorted[i - 1].time) {
      issues.push({ type: "DUPLICATE", time: c.time, message: `Duplicate candle at ${new Date(c.time).toISOString()}` });
    }

    // Broken sequence (gap larger than expected for intraday) — INCLUDING
    // gaps that straddle a calendar-day boundary.
    //
    // ROOT-CAUSE NOTE: the old "sameDay" check treated ANY gap that crossed
    // midnight as a normal overnight market-closed gap and skipped it
    // unconditionally. That is correct for a real end-of-day → next-open
    // transition, but it also silently hid the most common real-world outage
    // pattern: server goes down mid-afternoon (e.g. 12:30) and only comes
    // back the next morning after market open (e.g. 09:45) — losing the
    // rest of day N AND the start of day N+1. Because the two surviving
    // candles around that hole are on different calendar dates, the old
    // check waved it through as "fine" and the deep validator/auto-repair
    // never even saw it as an issue.
    //
    // Fix: only treat a cross-midnight gap as expected if the PREVIOUS
    // candle is at (or very near) the market close AND the NEXT candle is
    // at (or very near) the market open. Otherwise — even though it crosses
    // a date boundary — it's real missing data and must be flagged.
    if (i > 0 && resolution < 1440) {
      const expectedStep = resolution * 60 * 1000;
      const actualStep   = sorted[i].time - sorted[i - 1].time;
      if (actualStep > expectedStep * 1.5) {
        const prevIST = toIST(sorted[i - 1].time);
        const currIST = toIST(sorted[i].time);
        const sameDay = prevIST.getUTCDate() === currIST.getUTCDate() &&
                        prevIST.getUTCMonth() === currIST.getUTCMonth();

        const prevMinOfDay = prevIST.getUTCHours() * 60 + prevIST.getUTCMinutes();
        const currMinOfDay = currIST.getUTCHours() * 60 + currIST.getUTCMinutes();
        const CLOSE_MIN = MARKET_CLOSE_H * 60 + MARKET_CLOSE_M;
        const OPEN_MIN  = MARKET_OPEN_H * 60 + MARKET_OPEN_M;

        // Previous candle should be within one resolution step of close;
        // next candle should be within one resolution step of open.
        const prevReachedClose = prevMinOfDay >= CLOSE_MIN - (expectedStep / 60000) - 1;
        const currAtOpen       = currMinOfDay <= OPEN_MIN + (expectedStep / 60000) + 1;

        const isRealGap = sameDay || !prevReachedClose || !currAtOpen;

        if (isRealGap) {
          const gapMinutes = actualStep / 60000;
          issues.push({
            type: "GAP",
            time: sorted[i - 1].time,
            message: `Gap of ${gapMinutes.toFixed(0)}min between ${new Date(sorted[i-1].time).toISOString()} and ${new Date(sorted[i].time).toISOString()}`,
          });
        }
      }
    }
  }

  // ── Range outlier check (NEW, v2 — isolated-spike detector) ───────────────
  // ROOT-CAUSE NOTE: none of the checks above catch the exact corruption
  // pattern that was causing the chart-vs-broker mismatch reported by the
  // user — a single 1m candle whose OHLC range is wildly larger than its
  // immediate neighbors (the "cliff candle" produced by the old gap-filler
  // bug before it was fixed in candleBuilder.js, or any other source of a
  // bad single print). There's no timing GAP (timestamps are unbroken) and
  // OHLC is internally consistent (high IS the max, low IS the min) — so it
  // sails through every check above. It only looks wrong relative to its
  // immediate NEIGHBORS, which none of the per-candle checks above can see.
  //
  // FIRST ATTEMPT (symmetric local-median window) caused false positives on
  // genuine multi-candle volatility bursts (e.g. an RBI policy print moving
  // the index hard for 5-6 consecutive bars) — each candle in the burst saw
  // mostly-calm neighbors on its far side and got flagged. Real volatility
  // does not look like an isolated spike; it looks like several elevated
  // candles in a row.
  //
  // FIX: only flag a candle as an outlier if it is an ISOLATED spike — i.e.
  // both the candle immediately before AND the candle immediately after are
  // back near the pre-spike baseline. This is the actual signature of a
  // single bad print/synthetic cliff: one bar jumps, the very next bar is
  // calm again. A genuine volatility burst fails this test because the
  // following candle is usually still elevated, not back to baseline — so
  // real news-driven moves are deliberately left untouched here, even at
  // the cost of occasionally missing a genuinely freak single-bar print
  // (rare for liquid index/equity instruments, and VALIDATE can still be
  // run manually / visually spotted in that case).
  const SPIKE_BASELINE_WINDOW = 10;      // candles strictly before the spike, for the baseline
  const SPIKE_MULTIPLE = 8;              // spike range must exceed 8x that baseline
  const SPIKE_REVERSION_MULTIPLE = 2.5;  // next candle's range must be back under 2.5x baseline
  const SPIKE_MIN_PCT = 0.0005;          // and the spike itself must be >0.05% of price (ignore noise)

  // Intraday only — daily/weekly bars naturally span a much wider range and
  // this pattern (single bad print vs neighbors) doesn't apply to them.
  if (resolution < 1440 && sorted.length >= SPIKE_BASELINE_WINDOW + 2) {
    const ranges = sorted.map((c) => Math.max(0, c.high - c.low));
    for (let i = SPIKE_BASELINE_WINDOW; i < sorted.length - 1; i++) {
      // Skip if the baseline window or the reversion check would cross a
      // calendar-day boundary — comparing a 09:16 candle's range against
      // yesterday's last 10 candles (different session, different
      // volatility regime) is not a meaningful baseline and could produce
      // either false positives or false negatives right at session edges.
      const candleDayKey = toIST(sorted[i].time).toISOString().slice(0, 10);
      const baselineStartDayKey = toIST(sorted[i - SPIKE_BASELINE_WINDOW].time).toISOString().slice(0, 10);
      const nextDayKey = toIST(sorted[i + 1].time).toISOString().slice(0, 10);
      if (baselineStartDayKey !== candleDayKey || nextDayKey !== candleDayKey) continue;

      const baselineSlice = [...ranges.slice(i - SPIKE_BASELINE_WINDOW, i)].sort((a, b) => a - b);
      const mid = Math.floor(baselineSlice.length / 2);
      const baseline = baselineSlice.length % 2 === 0
        ? (baselineSlice[mid - 1] + baselineSlice[mid]) / 2
        : baselineSlice[mid];

      const c = sorted[i];
      const spikeRange = ranges[i];
      const nextRange = ranges[i + 1];
      const absFloor = c.close * SPIKE_MIN_PCT;
      const safeBaseline = Math.max(baseline, absFloor / SPIKE_MULTIPLE);

      const isSpike = spikeRange > absFloor && spikeRange > safeBaseline * SPIKE_MULTIPLE;
      const reverted = nextRange <= safeBaseline * SPIKE_REVERSION_MULTIPLE;

      if (isSpike && reverted) {
        issues.push({
          type: "RANGE_OUTLIER",
          time: c.time,
          message: `Isolated range spike at ${new Date(c.time).toISOString()}: range=${spikeRange.toFixed(2)} ` +
            `vs trailing baseline=${baseline.toFixed(2)} (${(spikeRange / Math.max(baseline, 0.01)).toFixed(1)}x), ` +
            `next candle reverted to range=${nextRange.toFixed(2)}`,
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

// ─── Live validation (current trading day) ──────────────────────────────────

/**
 * Validate candles for today's trading session in the DB.
 * Stops once the current day is confirmed valid.
 *
 * @param {string} symbol
 * @param {number} resolution  (intraday only, < 1440)
 * @returns {Promise<{valid, issues, candlesChecked}>}
 */
async function validateCurrentDay(symbol, resolution) {
  if (resolution >= 1440) return { valid: true, issues: [], candlesChecked: 0 };

  const now = Date.now();
  const istNow = toIST(now);
  const istMidnightMs = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())
  ).getTime() - IST_OFFSET_MS;

  const sessionStart = istMidnightMs + (MARKET_OPEN_H * 60 + MARKET_OPEN_M) * 60000;
  const sessionEnd   = Math.min(now, istMidnightMs + (MARKET_CLOSE_H * 60 + MARKET_CLOSE_M) * 60000);

  // Only validate if we are within or past the session
  if (now < sessionStart) return { valid: true, issues: [], candlesChecked: 0 };

  const candles = await loadCandles(symbol, resolution, { from: sessionStart, to: sessionEnd });
  const { valid, issues } = validateCandleArray(candles, resolution);

  console.log(`[Validator] Live ${symbol} res=${resolution}: ${candles.length} candles, ${issues.length} issues`);
  return { valid, issues, candlesChecked: candles.length };
}

// ─── Historical validation ───────────────────────────────────────────────────

/**
 * Validate stored 1m candles for a symbol within the last 3 months.
 * Used at startup, on corruption trigger, or on manual request.
 * Scoped to 90-day retention window — no point validating pruned data.
 *
 * ARCHITECTURE NOTE: Only 1m candles are stored in the DB. The resolution
 * param is accepted for API compatibility but is always overridden to 1.
 * Higher TF candles exist only in-memory and are never validated here.
 *
 * ROOT-CAUSE NOTE: this function accepted `opts.fetchCandles` / `opts.onRepair`
 * for a long time but never actually called either of them — it only
 * computed and returned issues. That meant clicking "VALIDATE" in the UI (or
 * any caller passing onRepair, expecting auto-repair per the architecture
 * doc's "VALIDATE button → validateHistorical → repairDay if issues" flow)
 * silently did nothing beyond logging issue counts; no repair ever ran.
 * Now, when issues are found AND a repair function is available, this
 * groups the affected candle-times into trading days and triggers one
 * repairDay() per affected day (deduped), same as the architecture intends.
 *
 * @param {string} symbol
 * @param {number} [resolution]  ignored — always validates 1m in DB
 * @param {object} [opts]
 * @param {Date|string} [opts.from]  defaults to 90 days ago
 * @param {Date|string} [opts.to]
 * @param {Function} [opts.onRepair]  ({symbol, tradingDay, fetchCandles, trigger}) => Promise
 *                                     Called once per affected trading day when issues are found.
 * @param {Function} [opts.fetchCandles]  (symbol, resolution) => Promise<candle[]>
 *                                         Forwarded to onRepair as part of its opts.
 * @returns {Promise<{valid, issues, candlesChecked, repairedDays}>}
 */
async function validateHistorical(symbol, resolution, opts = {}) {
  // Always validate 1m — only 1m candles are stored in DB
  const DB_RESOLUTION = 1;
  const RETENTION_DAYS = 90;
  const defaultFrom = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000).toISOString();
  const trigger = opts.trigger || "manual";

  // ── Persistent skip-cache (validation_state) ────────────────────────────
  // ROOT-CAUSE FIX: every periodic run used to re-scan the FULL 90-day
  // window from scratch — even for a symbol confirmed completely clean
  // minutes earlier — because nothing persisted "this history was already
  // checked." On a 10-minute cycle across dozens of symbols, that's tens
  // of thousands of already-validated candles getting re-loaded and
  // re-checked forever, and it's why the same "fixed" symbols kept
  // appearing in every validator pass. Once a symbol has been fully swept
  // and found clean, subsequent PERIODIC runs only validate what's NEW
  // since that check (with a small overlap so nothing at the boundary is
  // missed). A full re-sweep still always runs on startup/manual triggers,
  // or automatically falls back to full if the last check is stale
  // (>24h) or the symbol wasn't clean last time — so this narrows repeat
  // work without ever giving up on eventually re-checking everything.
  const FULL_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h safety-net full sweep
  const OVERLAP_MS = 2 * 60 * 60 * 1000;                // 2h overlap so boundary candles are never skipped

  let from = opts.from;
  let incremental = false;
  if (!from) {
    if (trigger === "periodic") {
      const state = await getValidationState(symbol, DB_RESOLUTION).catch(() => null);
      const staleness = state ? Date.now() - state.lastChecked.getTime() : Infinity;
      if (state && state.status === "ok" && staleness < FULL_RESCAN_INTERVAL_MS) {
        from = new Date(state.lastChecked.getTime() - OVERLAP_MS).toISOString();
        incremental = true;
      }
    }
    if (!from) from = defaultFrom;
  }

  // Exclude the currently-forming minute from validation.
  // The live write path (onFinalize) writes a closed candle immediately after the
  // minute rolls. If validateHistorical runs within the same event-loop tick as
  // the upsert, the DB may have the candle or may not — this race causes the
  // validator to report 21749 when 21750 exist, or flag a spurious GAP.
  // Solution: cap `to` at the start of the current IST minute so we only
  // validate candles that have been fully closed AND had time to persist.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const istNowMs = nowMs + IST_OFFSET_MS;
  // Floor to the previous full IST minute (current minute is still forming or just closed)
  const currentIstMinuteStartMs = Math.floor(istNowMs / 60000) * 60000;
  // Subtract one more minute to give the DB write time to commit
  const safeTo = new Date(currentIstMinuteStartMs - 60000 - IST_OFFSET_MS).toISOString();

  const candles = await loadCandles(symbol, DB_RESOLUTION, { limit: 100000, from, to: opts.to || safeTo });

  // An incremental (narrowed) window with zero new candles just means
  // nothing has been written since the last check (e.g. market closed) —
  // NOT corruption. validateCandleArray([]) returns invalid/EMPTY by
  // design for the full-sweep case (an actually-empty symbol IS a real
  // problem), so that must not be reused here or every quiet periodic tick
  // would look like a fresh outage and re-trigger a same-day "repair".
  if (incremental && candles.length === 0) {
    console.log(`[Validator] Historical ${symbol} res=1 (1m only, incremental): 0 new candles since last check — nothing to validate`);
    await setValidationState(symbol, DB_RESOLUTION, { ok: true }).catch((err) => {
      console.warn(`[Validator] setValidationState failed for ${symbol}:`, err.message);
    });
    return { valid: true, issues: [], candlesChecked: 0, repairedDays: 0 };
  }

  const { valid, issues } = validateCandleArray(candles, DB_RESOLUTION);

  console.log(`[Validator] Historical ${symbol} res=1 (1m only${incremental ? ", incremental" : ""}): ${candles.length} candles, ${issues.length} issues`);

  let repairedDays = 0;
  if (!valid && typeof opts.onRepair === "function" && issues.length > 0) {
    // Dedupe issues into one IST trading-day key per affected timestamp,
    // so a day with 10 issues triggers exactly one repairDay() call.
    const affectedDays = new Map(); // "YYYY-MM-DD" → representative time (ms)
    for (const issue of issues) {
      if (issue.time == null) continue;
      const istMs = issue.time + IST_OFFSET_MS;
      const dayKey = new Date(istMs).toISOString().slice(0, 10);
      if (!affectedDays.has(dayKey)) affectedDays.set(dayKey, issue.time);
    }

    if (affectedDays.size === 0) {
      console.warn(`[Validator] Historical ${symbol}: ${issues.length} issue(s) found but none carry a usable timestamp — skipping auto-repair`);
    } else {
      console.log(`[Validator] Historical ${symbol}: triggering repair for ${affectedDays.size} affected trading day(s)`);
      const dayEntries = [...affectedDays];
      for (let i = 0; i < dayEntries.length; i++) {
        const [dayKey, repTime] = dayEntries[i];
        try {
          console.log(`[Validator] Historical ${symbol}: repairing day ${dayKey}...`);
          await opts.onRepair({
            symbol,
            tradingDay: repTime,
            fetchCandles: opts.fetchCandles,
            trigger: "validation",
          });
          repairedDays++;
        } catch (err) {
          console.error(`[Validator] Historical ${symbol}: repair for ${dayKey} failed —`, err.message);
        }
        // Pace between day-repairs so a symbol needing many repairs doesn't
        // fire them back-to-back and exhaust the Fyers rate limit.
        if (i < dayEntries.length - 1) await sleep(INTER_DAY_REPAIR_DELAY_MS);
      }
    }
  }

  // Persist validation state — this is what lets the NEXT periodic run
  // skip straight to an incremental window instead of another full sweep.
  // Best-effort: never let a logging failure affect the validation result.
  await setValidationState(symbol, DB_RESOLUTION, {
    ok: valid,
    issueSummary: valid ? null : issues.slice(0, 5).map((i) => i.type).join(", "),
  }).catch((err) => {
    console.warn(`[Validator] setValidationState failed for ${symbol}:`, err.message);
  });

  return { valid, issues, candlesChecked: candles.length, repairedDays };
}

// ─── Periodic sync — detect silent drift ────────────────────────────────────

/**
 * Compare the latest 1m candle in DB vs. the latest 1m candle from the broker.
 * Returns { inSync, latestDb, latestBroker, gapMs }
 *
 * ARCHITECTURE NOTE: Only 1m candles are stored in the DB. This function should
 * always be called with resolution=1 and 1m broker candles. Passing a higher
 * resolution will compare against an empty DB (those TFs are never stored).
 *
 * @param {string} symbol
 * @param {number} resolution  should always be 1 (1m) — see architecture note
 * @param {Array<{time,...}>} brokerCandles  freshly fetched 1m candles from Fyers REST
 */
async function checkPeriodicSync(symbol, resolution, brokerCandles) {
  const latestDb     = await getLatestCandle(symbol, resolution);
  const latestBroker = brokerCandles && brokerCandles.length > 0
    ? brokerCandles[brokerCandles.length - 1]
    : null;

  if (!latestBroker) return { inSync: true, latestDb, latestBroker: null, gapMs: 0 };
  if (!latestDb)     return { inSync: false, latestDb: null, latestBroker, gapMs: Infinity };

  const gapMs = latestBroker.time - latestDb.time;
  const toleranceMs = resolution * 60 * 1000 * 1.5; // 1.5× resolution

  const inSync = gapMs <= toleranceMs;
  if (!inSync) {
    console.warn(`[PeriodicSync] ${symbol} res=${resolution} DRIFT detected: DB=${new Date(latestDb.time).toISOString()} Broker=${new Date(latestBroker.time).toISOString()} gap=${(gapMs/60000).toFixed(1)}min`);
  }

  return { inSync, latestDb, latestBroker, gapMs };
}

module.exports = {
  validateCandleArray,
  validateCurrentDay,
  validateHistorical,
  checkPeriodicSync,
  expectedCandlesPerDay,
  expectedCandlesForDay,
};