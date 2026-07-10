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

// FIX (derivatives-routing): getLatestCandle is used by checkPeriodicSync()
// below, which server.js's periodicSync loop can call with whatever symbol
// a client currently has open — including option/future contracts. Routing
// it through dataRouter.js means that lookup lands on the correct
// nse_options_candles/etc. table for a derivative symbol instead of always
// reading the plain `candles` table. The other three imports here
// (loadCandles, countCandles, upsertValidationState) stay on candleStore.js
// directly — they're only ever called by validateHistorical/
// validateCurrentDay, which run exclusively against the curated no-expiry
// symbol list (see runCuratedSymbolCatchUp in server.js), so there's no
// derivative-symbol case to route for those.
const { loadCandles, countCandles, upsertValidationState } = require("./candleStore");
const { getLatestCandle } = require("./dataRouter");

// ─── IST helpers ─────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MARKET_OPEN_H = 9;
const MARKET_OPEN_M = 15;
const MARKET_CLOSE_H = 15;
const MARKET_CLOSE_M = 30;

function toIST(utcMs) {
  return new Date(utcMs + IST_OFFSET_MS);
}

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
  const sessionEndMs = istMidnightMs + (MARKET_CLOSE_H * 60 + MARKET_CLOSE_M) * 60000;
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
      !Number.isFinite(c.low) || c.low <= 0 ||
      !Number.isFinite(c.close) || c.close <= 0) {
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
      const actualStep = sorted[i].time - sorted[i - 1].time;
      if (actualStep > expectedStep * 1.5) {
        const prevIST = toIST(sorted[i - 1].time);
        const currIST = toIST(sorted[i].time);
        const sameDay = prevIST.getUTCDate() === currIST.getUTCDate() &&
          prevIST.getUTCMonth() === currIST.getUTCMonth();

        const prevMinOfDay = prevIST.getUTCHours() * 60 + prevIST.getUTCMinutes();
        const currMinOfDay = currIST.getUTCHours() * 60 + currIST.getUTCMinutes();
        const CLOSE_MIN = MARKET_CLOSE_H * 60 + MARKET_CLOSE_M;
        const OPEN_MIN = MARKET_OPEN_H * 60 + MARKET_OPEN_M;

        // BOUNDARY_TOLERANCE_MIN: how close to official close/open a candle
        // needs to be to count as "the day basically ended/started normally
        // here". Real exchange feeds routinely have their last print a few
        // minutes before 15:30 (thin closing volume) or first print a few
        // minutes after 09:15 (slow opening tick). The previous tolerance
        // was only `expectedStep/60000 + 1` — for 1m candles that's ~2
        // minutes — which was tight enough to misclassify this completely
        // normal pattern as a real GAP on the exact same day-boundary every
        // single day, which is what was driving symbols like
        // NSE:NIFTY50-INDEX to get "repaired" again on every server restart
        // even though nothing was actually wrong. 10 minutes gives real
        // headroom for normal session edge behavior while still catching
        // genuine multi-hour/overnight outages (which this code path never
        // even reaches anyway, since isRealGap only fires when actualStep
        // already exceeds 1.5x the expected step).
        const BOUNDARY_TOLERANCE_MIN = 10;
        const prevReachedClose = prevMinOfDay >= CLOSE_MIN - BOUNDARY_TOLERANCE_MIN;
        const currAtOpen = currMinOfDay <= OPEN_MIN + BOUNDARY_TOLERANCE_MIN;

        const isRealGap = sameDay || !prevReachedClose || !currAtOpen;

        if (isRealGap) {
          const gapMinutes = actualStep / 60000;
          issues.push({
            type: "GAP",
            time: sorted[i - 1].time,
            message: `Gap of ${gapMinutes.toFixed(0)}min between ${new Date(sorted[i - 1].time).toISOString()} and ${new Date(sorted[i].time).toISOString()}`,
          });
        }
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
  const sessionEnd = Math.min(now, istMidnightMs + (MARKET_CLOSE_H * 60 + MARKET_CLOSE_M) * 60000);

  // Only validate if we are within or past the session
  if (now < sessionStart) return { valid: true, issues: [], candlesChecked: 0 };

  const candles = await loadCandles(symbol, resolution, { from: sessionStart, to: sessionEnd });
  const { valid, issues } = validateCandleArray(candles, resolution);

  console.log(`[Validator] Live ${symbol} res=${resolution}: ${candles.length} candles, ${issues.length} issues`);
  try { await upsertValidationState(symbol, resolution, { valid, issues }); }
  catch (err) { console.warn(`[Validator] Failed to persist validation_state for ${symbol}: ${err.message}`); }
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
 * @param {string} symbol
 * @param {number} [resolution]  ignored — always validates 1m in DB
 * @param {object} [opts]
 * @param {Date|string} [opts.from]  defaults to 90 days ago
 * @param {Date|string} [opts.to]
 * @returns {Promise<{valid, issues, candlesChecked}>}
 */
async function validateHistorical(symbol, resolution, opts = {}) {
  // Always validate 1m — only 1m candles are stored in DB
  const DB_RESOLUTION = 1;
  const RETENTION_DAYS = 90;
  const defaultFrom = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000).toISOString();
  const from = opts.from || defaultFrom;

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

  const candles = await loadCandles(symbol, DB_RESOLUTION, { limit: 100000, ...opts, from, to: opts.to || safeTo });
  const { valid, issues } = validateCandleArray(candles, DB_RESOLUTION);

  // Only log when issues found — clean symbols are silent to keep startup logs readable
  if (issues.length > 0) {
    console.log(`[Validator] ${symbol}: ${candles.length} candles, ${issues.length} issue(s) found`);
  }
  // DB_RESOLUTION (always 1) — matches what was actually checked, not the
  // caller's requested `resolution`, since only 1m is ever stored.
  try { await upsertValidationState(symbol, DB_RESOLUTION, { valid, issues }); }
  catch (err) { console.warn(`[Validator] Failed to persist validation_state for ${symbol}: ${err.message}`); }
  return { valid, issues, candlesChecked: candles.length };
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
  const latestDb = await getLatestCandle(symbol, resolution);
  const latestBroker = brokerCandles && brokerCandles.length > 0
    ? brokerCandles[brokerCandles.length - 1]
    : null;

  if (!latestBroker) return { inSync: true, latestDb, latestBroker: null, gapMs: 0 };
  if (!latestDb) return { inSync: false, latestDb: null, latestBroker, gapMs: Infinity };

  const gapMs = latestBroker.time - latestDb.time;
  const toleranceMs = resolution * 60 * 1000 * 1.5; // 1.5× resolution

  const inSync = gapMs <= toleranceMs;
  if (!inSync) {
    console.warn(`[PeriodicSync] ${symbol} res=${resolution} DRIFT detected: DB=${new Date(latestDb.time).toISOString()} Broker=${new Date(latestBroker.time).toISOString()} gap=${(gapMs / 60000).toFixed(1)}min`);
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