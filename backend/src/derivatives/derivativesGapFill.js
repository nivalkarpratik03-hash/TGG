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
 *
 * EQUITIES EXCLUDED — CONFIRMED 2026-07-30, NOT A GUESS: this app tracks
 * stock SPOT prices only. No stock futures, no stock options, ever. This
 * checkpoint only ever covers index F&O (NIFTY/BANKNIFTY/FINNIFTY/
 * MIDCPNIFTY/SENSEX) and MCX commodity F&O. The scoped filter below
 * excludes assetClass==="EQUITY" outright, not via the hasOptions/
 * hasFutures flags alone (those are also explicitly false on every equity
 * in curatedUnderlyingsLoader.js, belt-and-suspenders, but the outright
 * exclusion is the real guarantee).
 *
 * TWO ROOT CAUSES FIXED HERE (2026-07-30) — both required to actually
 * stop the "freeze after NIFTY" symptom, not just one:
 *
 *   #1 — INTER-UNDERLYING throttling. The old loop ran straight through
 *   every underlying with zero delay between them. Now scoped to just
 *   indices (5) + commodities (6) = 11 underlyings (equities excluded, see
 *   above), each fully logged, with INTER_UNDERLYING_DELAY_MS between them.
 *
 *   #2 — INTER-STRIKE throttling, the deeper cause that #1 alone does NOT
 *   fix. NIFTY is dual-cycle (weekly+monthly), so discoverStrikes() can
 *   return 30-40+ real strike symbols for NIFTY alone. The old strike loop
 *   (inside runGapFillCheckpoint, calling backfillOptionSymbol per strike)
 *   had zero delay AND zero progress logging between individual strikes —
 *   30-40 fully sequential broker calls with total silence in between is
 *   what looked exactly like a frozen process, immediately after the last
 *   visible "NSE:NIFTY50-INDEX: 18 expiries, 19 real strike symbols" log
 *   line. Fixed with INTER_STRIKE_DELAY_MS between each strike's backfill
 *   plus a per-strike progress log, inside backfillStrikesForEntry() below.
 */

const { fetchOptionChain, fetchCandles } = require("../fyers/client");
const derivativesStore = require("../../../database/src/derivativesStore");
const { lastTuesdayOfMonth, lastThursdayOfMonth, parseDerivativeSymbol } = require("../../../database/src/symbolParser");
const symbolsRouter = require("../routes/symbolsRouter");
const { loadCuratedUnderlyings } = require("./curatedUnderlyingsLoader");

const RESOLUTION = "1"; // 1-minute candles, same convention as every other fetchCandles caller in this repo
const OPTION_LOOKBACK_DAYS_DEFAULT = 5; // for an already-tracked symbol, just catch up recent gaps
const RETROACTIVE_BACKFILL_LOOKBACK_DAYS = 90; // for a BRAND NEW symbol, pull as much real history as the broker will give (contract is still live — confirmed elsewhere this only works pre-expiry)

// INTER-UNDERLYING DELAY — same conservative spirit as server.js's
// curatedSymbolCatchUp (3-concurrent / 1000ms batches). This checkpoint
// only ever covers indices (5) + MCX commodities (6) — equities are
// excluded (see file header) — so it doesn't need batching, just a small
// stagger between underlyings so one underlying's burst of futures+options
// calls doesn't land on the broker in the same instant as the next one's.
const INTER_UNDERLYING_DELAY_MS = 400;

// INTER-STRIKE DELAY — root cause #2 (see file header). A single
// dual-cycle underlying (NIFTY) can have 30-40+ real strikes; without a
// pause and a log line between each one, that many fully sequential
// broker calls produces several minutes of total silence — indistinguishable
// from a hang on screen even though it's technically still working. 300ms
// is deliberately smaller than INTER_UNDERLYING_DELAY_MS (this fires far
// more often, inside a single underlying, so it needs to be cheap) but
// still real spacing, not zero.
const INTER_STRIKE_DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Parses a date string that could be either ISO ("YYYY-MM-DD") or the
 * other common broker format ("DD-MM-YYYY") into a real Date, or null if
 * neither parses to a valid date.
 *
 * ROOT-CAUSE FIX (2026-07-30, CRITICAL): classifyMonthlyExpiry used to
 * blindly do `new Date(dateStr + "T00:00:00")`, assuming ISO format. If
 * Fyers' real expiryData.date string is NOT ISO (a well-known real risk —
 * this codebase has no captured live sample to confirm which format it
 * actually sends), that produces Invalid Date silently (no throw), which
 * then fed NaN year/month straight into lastTuesdayOfMonth/
 * lastThursdayOfMonth — the two functions that used to have zero guard
 * against exactly that, causing the infinite loop that froze the entire
 * server. This function no longer assumes a format — it tries ISO first,
 * then DD-MM-YYYY, and returns null (never an Invalid Date) if neither
 * parses, so the caller can skip gracefully instead of ever reaching the
 * date-math functions with bad input.
 */
function parseExpiryDateString(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;

  // Try ISO (YYYY-MM-DD) first.
  const iso = new Date(dateStr + "T00:00:00");
  if (!isNaN(iso.getTime())) return iso;

  // Try DD-MM-YYYY (Fyers' commonly-documented format for this field).
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dateStr);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!isNaN(d.getTime())) return d;
  }

  return null; // neither format parsed — caller must skip, not guess further
}

/**
 * Given the real expiry dates Fyers actually returned, classify which one
 * is "the monthly" (only relevant for NIFTY/SENSEX, which can have both
 * weekly+monthly alive at once). Classification, not computation: every
 * candidate date already came from the broker — this only asks "does
 * this REAL date happen to fall on last Tuesday/Thursday of its month,"
 * using the exact same lastTuesdayOfMonth/lastThursdayOfMonth already
 * tested in symbolParser.js. Never invents a date.
 *
 * Dates that don't parse (see parseExpiryDateString above) are skipped,
 * not treated as a crash — one unparseable expiry shouldn't take down
 * the whole checkpoint.
 */
function classifyMonthlyExpiry(realExpiryDates, exchange) {
  const lastDayFn = exchange === "BSE" ? lastThursdayOfMonth : lastTuesdayOfMonth;
  for (const dateStr of realExpiryDates) {
    const d = parseExpiryDateString(dateStr);
    if (!d) continue; // unparseable — skip this candidate, don't guess
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
  const log = deps.log || ((msg) => console.log(msg));
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
    log(`[GapFill] ${entry.underlying} — nearest expiry wasn't monthly, fetching monthly chain separately (expiry=${monthlyDate})`);
    const monthlyChain = await chainFn(lookupSymbol, { strikeCount: atmBandWidth, timestamp: monthlyEntry.expiry });
    log(`[GapFill] ${entry.underlying} — monthly chain fetch returned ${monthlyChain.strikes.length} strike(s)`);
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
 * ROOT CAUSE #2 FIX — backfills every discovered strike for one underlying
 * with a real delay AND a progress log between each one, instead of a
 * silent, zero-delay sequential loop. This is what actually stops a
 * dual-cycle underlying (NIFTY) with 30-40+ strikes from producing minutes
 * of total silence that looks exactly like a hang.
 * @returns {Promise<{found: number, stored: number}>}
 */
async function backfillStrikesForEntry(entry, strikes, label, log, delayFn, deps) {
  let storedRows = 0;
  let symbolsBackfilled = 0;
  for (let i = 0; i < strikes.length; i++) {
    const s = strikes[i];
    const r = await backfillOptionSymbol(entry, s.symbol, deps);
    if (r.stored > 0) {
      storedRows += r.stored;
      symbolsBackfilled++;
    }
    log(`[GapFill] ${label}: ${entry.underlying} — strike (${i + 1}/${strikes.length}) ${s.symbol}: ${r.isNew ? "new, retroactive backfill" : "existing, gap catch-up"}, ${r.stored} candle row(s) stored`);
    if (i < strikes.length - 1) await delayFn(INTER_STRIKE_DELAY_MS);
  }
  return { found: strikes.length, storedRows, symbolsBackfilled };
}

/**
 * Runs one full checkpoint sweep across every curated underlying.
 * @param {string} label  "startup" | "nse_bse_close" | "mcx_close" — used
 *   to decide which asset classes this particular checkpoint covers (see
 *   runGapFillCheckpoint's filtering below).
 */
async function runGapFillCheckpoint(label, deps = {}) {
  const { all, atmBandWidth } = loadCuratedUnderlyings();
  const log = deps.log || ((msg) => console.log(msg));
  const delayFn = deps.sleep || sleep;

  // NSE/BSE close only covers indices; MCX close only covers commodities;
  // startup covers both, indices fully before commodities (curated JSON
  // order is already indices-then-commodities, and `all` preserves it).
  // EQUITIES EXCLUDED OUTRIGHT — confirmed 2026-07-30, spot-only, see file
  // header — not left to the hasOptions/hasFutures checks below alone.
  const scoped = all.filter((entry) => {
    if (entry.assetClass === "EQUITY") return false;
    if (label === "nse_bse_close") return entry.assetClass === "INDEX";
    if (label === "mcx_close") return entry.assetClass === "COMMODITY";
    return true; // startup — indices, then commodities
  });

  let optionsDiscovered = 0, optionsBackfilled = 0, futuresBackfilled = 0;
  const skipped = [];
  const failed = [];

  log(`[GapFill] ${label}: starting checkpoint — ${scoped.length} underlying(s) (${scoped.filter((e) => e.assetClass === "INDEX").length} index, ${scoped.filter((e) => e.assetClass === "COMMODITY").length} commodity; equities excluded — spot-only)`);

  for (let idx = 0; idx < scoped.length; idx++) {
    const entry = scoped[idx];
    log(`[GapFill] ${label}: (${idx + 1}/${scoped.length}) ${entry.underlying} — starting`);
    let entryOptionsFound = 0, entryOptionsStored = 0, entryFuturesStored = 0;

    // Futures — respected for EVERY remaining asset class (index, commodity).
    if (entry.hasFutures !== false) {
      try {
        const futSymbols = resolveFuturesSymbols(entry);
        for (const sym of futSymbols) {
          const r = await backfillFuturesSymbol(entry, sym, deps);
          if (r.stored > 0) { futuresBackfilled++; entryFuturesStored += r.stored; }
        }
      } catch (err) {
        failed.push({ underlying: entry.underlying, stage: "futures", error: err.message });
        log(`[GapFill] ${label}: ${entry.underlying} — futures FAILED: ${err.message}`);
      }
    }

    // Options — only underlyings that actually have listed options
    // (excludes SILVERMIC/GOLDPETAL via hasOptions:false).
    if (entry.hasOptions !== false) {
      try {
        const strikes = await discoverStrikes(entry, atmBandWidth, deps);
        entryOptionsFound = strikes.length;
        optionsDiscovered += strikes.length;
        log(`[GapFill] ${label}: ${entry.underlying} — ${strikes.length} real strike(s) discovered, backfilling one at a time (${INTER_STRIKE_DELAY_MS}ms apart)`);
        const result = await backfillStrikesForEntry(entry, strikes, label, log, delayFn, deps);
        entryOptionsStored = result.storedRows;
        optionsBackfilled += result.symbolsBackfilled;
      } catch (err) {
        // resolveChainLookupSymbol's deliberate throw for unconfirmed MCX
        // format lands here — tracked as "skipped", not "failed", since
        // it's a known, intentional gap, not an unexpected error.
        if (err.message.includes("UNCONFIRMED")) {
          skipped.push({ underlying: entry.underlying, reason: err.message });
          log(`[GapFill] ${label}: ${entry.underlying} — options SKIPPED (${err.message})`);
        } else {
          failed.push({ underlying: entry.underlying, stage: "options", error: err.message });
          log(`[GapFill] ${label}: ${entry.underlying} — options FAILED: ${err.message}`);
        }
      }
    }

    log(`[GapFill] ${label}: (${idx + 1}/${scoped.length}) ${entry.underlying} — done (futures candle-rows stored ${entryFuturesStored}, strikes discovered ${entryOptionsFound}, option candle-rows stored ${entryOptionsStored})`);

    if (idx < scoped.length - 1) await delayFn(INTER_UNDERLYING_DELAY_MS);
  }

  log(`[GapFill] ${label}: checkpoint complete — ${scoped.length} scanned, ${optionsDiscovered} strikes discovered, ${optionsBackfilled} option symbols backfilled, ${futuresBackfilled} futures symbols backfilled${failed.length ? `, FAILED ${failed.length}` : ""}${skipped.length ? `, SKIPPED ${skipped.length}` : ""}`);

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
  backfillStrikesForEntry,
};