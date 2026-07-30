/**
 * backend/src/derivatives/derivativesGapFill.js
 *
 * The checkpoint job — runs at 3 points (startup, NSE/BSE close, MCX
 * close): for every curated underlying, discover real ATM+-N strikes via
 * fetchOptionChain, union them into what's already tracked, then use
 * fetchCandles to backfill any newly-discovered symbol's FULL available
 * history (retroactive backfill, agreed earlier — only works while the
 * contract is still live).
 *
 * CONFIRMED SPLIT (verified directly against this codebase, not assumed):
 *   fetchCandles      -> all candle storage/backfill, every existing
 *                        caller in this project uses it this way
 *                        (backfill.js, server.js's refresh paths).
 *   fetchOptionChain  -> the ONLY thing that discovers real strike
 *                        symbols. Used today in exactly one place
 *                        (chartRouter.js's /api/options/chain, triggered
 *                        by chart-open). This job is the second caller,
 *                        triggered by checkpoints instead of chart-open.
 *
 * KNOWN, ACCEPTED LIMITATION (not a bug — a deliberate trade-off):
 * fetchOptionChain only ever reports ATM as of THE EXACT MOMENT it's
 * called — there is no way to ask it "what was ATM 2 hours ago." A
 * strike that briefly became ATM between two checkpoints and reverted
 * before the next one runs will not be discovered. If this ever needs
 * closing, the fix is running checkpoints more often — the mechanism
 * here doesn't change, only the schedule would.
 *
 * MCX COMMODITY BRANCH — now enabled, confirmed via the real Fyers app
 * (not this codebase's own docs, which only showed index examples).
 * Evidence: the Fyers mobile app's own live option-chain screen for
 * CRUDEOILM (real strikes 8250-8950, real bid/ask/OI, expiry selector)
 * opens directly off the bare root, and searching "MCX:CRUDEOILM" in the
 * same app surfaces both its futures AND its options family under that
 * one root — the same parent/child relationship "NSE:NIFTY50-INDEX" has
 * to its own chain. Treated as strong, real, first-party confirmation —
 * not a captured getOptionChain API response line-by-line, so if the
 * live sweep ever comes back empty/wrong for a commodity, re-check this
 * assumption before anything else.
 */

const { fetchOptionChain, fetchCandles } = require("../fyers/client");
const derivativesStore = require("../../../database/src/derivativesStore");
const { lastTuesdayOfMonth, lastThursdayOfMonth, parseDerivativeSymbol } = require("../../../database/src/symbolParser");
const symbolsRouter = require("../routes/symbolsRouter");
const { loadCuratedUnderlyings } = require("./curatedUnderlyingsLoader");

const RESOLUTION = "1"; // 1-minute candles, same convention as every other fetchCandles caller in this repo
const OPTION_LOOKBACK_DAYS_DEFAULT = 5; // for an already-tracked symbol, just catch up recent gaps
const RETROACTIVE_BACKFILL_LOOKBACK_DAYS = 90; // for a BRAND NEW symbol, pull as much real history as the broker will give (contract is still live — confirmed elsewhere this only works pre-expiry)

/**
 * Which fixed spot symbol (or, for MCX, which bare-root lookup string) to
 * pass to fetchOptionChain for a given curated underlying entry.
 *
 * Index/equity: entry.spotSymbol is already the real, documented-format
 * string ("NSE:NIFTY50-INDEX", "NSE:RELIANCE-EQ") — use it directly.
 *
 * Commodity (spotSymbol is null, by design — no fixed spot exists):
 * uses the bare "{exchange}:{underlying}" root (e.g. "MCX:CRUDEOILM"),
 * confirmed via the real Fyers app — see file header for the exact
 * evidence and its confidence level.
 */
function resolveChainLookupSymbol(entry) {
  if (entry.spotSymbol) return entry.spotSymbol;
  if (entry.assetClass === "COMMODITY") {
    return `${entry.exchange}:${entry.underlying}`;
  }
  throw new Error(`resolveChainLookupSymbol: no spotSymbol and not a commodity — unexpected entry shape for "${entry.underlying}"`);
}

/**
 * Given the real expiry dates Fyers actually returned, classify which one
 * is "the monthly" (only relevant for NIFTY/SENSEX, which can have both
 * weekly+monthly alive at once). Classification, not computation: every
 * candidate date already came from the broker — this only asks "does
 * this REAL date happen to fall on last Tuesday/Thursday of its month,"
 * using the exact same lastTuesdayOfMonth/lastThursdayOfMonth already
 * tested in symbolParser.js. Never invents a date.
 */
function classifyMonthlyExpiry(realExpiryDates, exchange) {
  const lastDayFn = exchange === "BSE" ? lastThursdayOfMonth : lastTuesdayOfMonth;
  for (const dateStr of realExpiryDates) {
    const d = new Date(dateStr + "T00:00:00");
    const expected = lastDayFn(d.getFullYear(), d.getMonth());
    if (d.getFullYear() === expected.getFullYear() && d.getMonth() === expected.getMonth() && d.getDate() === expected.getDate()) {
      return dateStr;
    }
  }
  return null; // none of the returned dates matched — caller decides what to do
}

/**
 * Discovers real ATM+-N strikes for one underlying, for every expiry type
 * it needs (1 or 2 fetchOptionChain calls, per entry.expiryTypes).
 * @returns {Promise<Array<{symbol, strike_price, option_type, expiryType}>>}
 */
async function discoverStrikes(entry, atmBandWidth, deps = {}) {
  const chainFn = deps.fetchOptionChain || fetchOptionChain;
  const lookupSymbol = resolveChainLookupSymbol(entry);

  // First call, no timestamp -> nearest expiry's chain + the REAL list of
  // available expiry dates (needed to find "the monthly one" if this
  // underlying needs both).
  const nearest = await chainFn(lookupSymbol, { strikeCount: atmBandWidth });
  if (!nearest.strikes.length && !nearest.expiries.length) {
    return []; // broker gave nothing back this call — token issue or genuinely no data; caller's sweep just continues to the next underlying
  }

  if (entry.expiryTypes.length === 1) {
    return nearest.strikes.map((s) => ({ ...s, expiryType: entry.expiryTypes[0] }));
  }

  // Dual-cycle (NIFTY/SENSEX): classify + fetch monthly separately if the
  // nearest call didn't happen to already return the monthly one.
  const realDates = nearest.expiries.map((e) => e.date);
  const monthlyDate = classifyMonthlyExpiry(realDates, entry.exchange);

  const nearestIsMonthly = monthlyDate && nearest.expiries[0] && nearest.expiries[0].date === monthlyDate;
  const results = nearest.strikes.map((s) => ({ ...s, expiryType: nearestIsMonthly ? "monthly" : "weekly" }));

  if (monthlyDate && !nearestIsMonthly) {
    const monthlyEntry = nearest.expiries.find((e) => e.date === monthlyDate);
    const monthlyChain = await chainFn(lookupSymbol, { strikeCount: atmBandWidth, timestamp: monthlyEntry.expiry });
    results.push(...monthlyChain.strikes.map((s) => ({ ...s, expiryType: "monthly" })));
  }

  return results;
}

/**
 * For one real, broker-confirmed option symbol: check what's already
 * stored, and either do a normal recent-gap catch-up (already-tracked
 * symbol) or a full retroactive backfill (brand new symbol — the
 * agreed-on behavior for new strikes, only valid pre-expiry).
 */
async function backfillOptionSymbol(entry, optionSymbol, deps = {}) {
  const fetchFn = deps.fetchCandles || fetchCandles;
  const existing = await derivativesStore.countDerivativeCandles(entry.exchange, "option", optionSymbol);
  const lookbackDays = existing === 0 ? RETROACTIVE_BACKFILL_LOOKBACK_DAYS : OPTION_LOOKBACK_DAYS_DEFAULT;

  const candles = await fetchFn(optionSymbol, RESOLUTION, 200000, lookbackDays);
  if (!candles || candles.length === 0) return { symbol: optionSymbol, isNew: existing === 0, stored: 0 };

  // upsertOptionCandles requires the FULL parsed shape (exchange,
  // underlying, expiry_date, expiry_type, strike, option_type,
  // instrument_type) on every row — not just symbol+OHLCV — see
  // upsertRows()'s isValidCandle filter in derivativesStore.js, which
  // silently drops anything missing these fields. Parse once, reuse for
  // every candle row of this symbol.
  const parsed = parseDerivativeSymbol(optionSymbol);
  if (!parsed) {
    throw new Error(`backfillOptionSymbol: "${optionSymbol}" (real, broker-returned symbol) no longer parses — refusing to store with unknown contract fields`);
  }

  const rows = candles.map((c) => ({ ...parsed, ...c, symbol: optionSymbol }));
  const stored = await derivativesStore.upsertOptionCandles(rows);
  return { symbol: optionSymbol, isNew: existing === 0, stored };
}

/**
 * Resolves current+next month futures symbols for one underlying, using
 * the already-tested near-month resolvers exposed from symbolsRouter.js
 * — not re-implemented here.
 */
function resolveFuturesSymbols(entry) {
  const codes =
    entry.exchange === "MCX"
      ? symbolsRouter.monthCodesFromOffset(2, symbolsRouter.mcxNearMonthOffset(entry.underlying))
      : symbolsRouter.monthCodesFromOffset(2, symbolsRouter.nseNearMonthOffset());
  return codes.map((code) => `${entry.exchange}:${entry.underlying}${code}FUT`);
}

async function backfillFuturesSymbol(entry, futSymbol, deps = {}) {
  const fetchFn = deps.fetchCandles || fetchCandles;
  const existing = await derivativesStore.countDerivativeCandles(entry.exchange, "future", futSymbol);
  const lookbackDays = existing === 0 ? RETROACTIVE_BACKFILL_LOOKBACK_DAYS : OPTION_LOOKBACK_DAYS_DEFAULT;

  const candles = await fetchFn(futSymbol, RESOLUTION, 200000, lookbackDays);
  if (!candles || candles.length === 0) return { symbol: futSymbol, isNew: existing === 0, stored: 0 };

  const parsed = parseDerivativeSymbol(futSymbol);
  if (!parsed) {
    throw new Error(`backfillFuturesSymbol: "${futSymbol}" (built from resolveFuturesSymbols) does not parse — refusing to store with unknown contract fields`);
  }

  const rows = candles.map((c) => ({ ...parsed, ...c, symbol: futSymbol }));
  const stored = await derivativesStore.upsertFutureCandles(rows);
  return { symbol: futSymbol, isNew: existing === 0, stored };
}

/**
 * Runs one full checkpoint sweep across every curated underlying.
 * @param {string} label  "startup" | "nse_bse_close" | "mcx_close" — used
 *   to decide which asset classes this particular checkpoint covers (see
 *   runGapFillCheckpoint's filtering below).
 */
async function runGapFillCheckpoint(label, deps = {}) {
  const { all, atmBandWidth } = loadCuratedUnderlyings();

  // NSE/BSE close only covers index+equity; MCX close only covers
  // commodities; startup covers everything.
  const scoped = all.filter((entry) => {
    if (label === "nse_bse_close") return entry.assetClass !== "COMMODITY";
    if (label === "mcx_close") return entry.assetClass === "COMMODITY";
    return true; // startup
  });

  let optionsDiscovered = 0, optionsBackfilled = 0, futuresBackfilled = 0;
  const skipped = [];
  const failed = [];

  for (const entry of scoped) {
    // Futures — every underlying that has any (all indices/equities; only
    // the 4 opt+fut commodities AND the 2 fut-only ones, i.e. everything
    // except entries explicitly marked hasOptions:false with no futures —
    // in this curated list that's none, every commodity has futures).
    if (entry.assetClass !== "COMMODITY" || entry.hasFutures !== false) {
      try {
        const futSymbols = resolveFuturesSymbols(entry);
        for (const sym of futSymbols) {
          const r = await backfillFuturesSymbol(entry, sym, deps);
          if (r.stored > 0) futuresBackfilled++;
        }
      } catch (err) {
        failed.push({ underlying: entry.underlying, stage: "futures", error: err.message });
      }
    }

    // Options — only underlyings that actually have listed options
    // (excludes SILVERMIC/GOLDPETAL automatically via hasOptions:false).
    if (entry.hasOptions === false) continue;

    try {
      const strikes = await discoverStrikes(entry, atmBandWidth, deps);
      optionsDiscovered += strikes.length;
      for (const s of strikes) {
        const r = await backfillOptionSymbol(entry, s.symbol, deps);
        if (r.stored > 0) optionsBackfilled++;
      }
    } catch (err) {
      // resolveChainLookupSymbol's deliberate throw for unconfirmed MCX
      // format lands here — tracked as "skipped", not "failed", since
      // it's a known, intentional gap, not an unexpected error.
      if (err.message.includes("UNCONFIRMED")) {
        skipped.push({ underlying: entry.underlying, reason: err.message });
      } else {
        failed.push({ underlying: entry.underlying, stage: "options", error: err.message });
      }
    }
  }

  return {
    label,
    scanned: scoped.length,
    optionsDiscovered,
    optionsBackfilled,
    futuresBackfilled,
    skipped,
    failed,
  };
}

module.exports = {
  runGapFillCheckpoint,
  discoverStrikes,
  classifyMonthlyExpiry,
  resolveChainLookupSymbol,
  resolveFuturesSymbols,
  backfillOptionSymbol,
  backfillFuturesSymbol,
};
