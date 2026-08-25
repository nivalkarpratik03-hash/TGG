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
 * EQUITIES — REVERSED 2026-08-11, EXPLICIT USER GO-AHEAD, NOT A SILENT
 * FLIP: this checkpoint now also covers all ~202 equities' stock F&O, in
 * addition to index F&O (NIFTY/BANKNIFTY/FINNIFTY/MIDCPNIFTY/SENSEX/
 * BANKEX) and MCX commodity F&O. Previously excluded outright (spot-only,
 * confirmed 2026-07-30) — that decision is superseded here, not deleted;
 * see symbols/derivatives-config.json's equities block for the full
 * history. Equities are now included purely via the same hasOptions/
 * hasFutures flag check every other asset class already goes through
 * below — no separate equity-specific branch, same code path as indices
 * and commodities.
 *
 * SCALE WARNING (not yet benchmarked): adding ~202 underlyings on top of
 * the previous 11 (5 indices + 6 commodities) materially increases both
 * checkpoint runtime (INTER_UNDERLYING_DELAY_MS x ~200 more underlyings,
 * plus INTER_STRIKE_DELAY_MS x however many strikes each one discovers)
 * and live Fyers call volume per checkpoint. Worth watching the first few
 * real checkpoint logs closely — if this turns out too slow or too heavy
 * on the broker, consider scoping to a curated liquid-equity subset rather
 * than all 202 at once, rather than reverting the whole feature.
 *
 * TWO ROOT CAUSES FIXED HERE (2026-07-30) — both required to actually
 * stop the "freeze after NIFTY" symptom, not just one:
 *
 *   #1 — INTER-UNDERLYING throttling. The old loop ran straight through
 *   every underlying with zero delay between them. At the time of this fix
 *   (2026-07-30) that meant indices (5) + commodities (6) = 11 underlyings;
 *   equities were added later (2026-08-11, see above) and go through this
 *   same throttling unmodified — each underlying fully logged, with
 *   INTER_UNDERLYING_DELAY_MS between them.
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
const state = require("../core/state");
const derivativesStore = require("../../../database/src/store/derivativesStore");
const { lastTuesdayOfMonth, lastThursdayOfMonth, parseDerivativeSymbol } = require("../../../database/src/parsing/symbolParser");
const { isDerivativeStorageEnabled } = require("../../../database/src/storageFlags");
const symbolsRouter = require("../routes/symbolsRouter");
const { loadCuratedUnderlyings } = require("./curatedUnderlyingsLoader");
const { VERBOSE, vlog, vwarn } = require("../utils/verboseLog");

const RESOLUTION = "1"; // 1-minute candles, same convention as every other fetchCandles caller in this repo
const OPTION_LOOKBACK_DAYS_DEFAULT = 5; // for an already-tracked symbol, just catch up recent gaps
const RETROACTIVE_BACKFILL_LOOKBACK_DAYS = 90; // for a BRAND NEW symbol, pull as much real history as the broker will give (contract is still live — confirmed elsewhere this only works pre-expiry)

// INTER-UNDERLYING DELAY — same conservative spirit as server.js's
// curatedSymbolCatchUp (3-concurrent / 1000ms batches). Originally sized for
// indices (5) + MCX commodities (6) = 11 underlyings; equities were added
// 2026-08-11 (see file header) bringing startup/nse_bse_close up to ~208-214
// — this delay applies per-underlying regardless of asset class, so it
// doesn't need batching, just a small stagger so one underlying's burst of
// futures+options calls doesn't land on the broker in the same instant as
// the next one's. SCALE WARNING (file header): not yet benchmarked at the
// new ~200-underlying count.
// UPDATED 2026-08-14: raised from 400ms — this checkpoint's dense
// back-to-back REST calls (same Fyers account/token as the live tick
// WebSocket) line up too closely with the tick socket repeatedly
// closing/reconnecting during startup runs to be coincidence. Not confirmed
// against Fyers' own rate-limit docs/logs, but this is the one lever we
// control — easing the call rate is the safe first thing to try. Revert if
// it turns out unrelated once observed over a few real runs.
const INTER_UNDERLYING_DELAY_MS = 800;

// INTER-STRIKE DELAY — root cause #2 (see file header). A single
// dual-cycle underlying (NIFTY) can have 30-40+ real strikes; without a
// pause and a log line between each one, that many fully sequential
// broker calls produces several minutes of total silence — indistinguishable
// from a hang on screen even though it's technically still working.
// UPDATED 2026-08-14: raised from 300ms alongside INTER_UNDERLYING_DELAY_MS
// above — same reasoning, easing this checkpoint's total REST call rate
// against the same Fyers account/token the live tick WebSocket uses.
const INTER_STRIKE_DELAY_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Which fixed spot symbol (or, for MCX, which bare-root lookup string) to
 * pass to fetchOptionChain for a given curated underlying entry.
 *
 * Index/equity: entry.spotSymbol is already the real, documented-format
 * string ("NSE:NIFTY50-INDEX", "NSE:RELIANCE-EQ") — use it directly.
 *
 * Commodity: the bare "{exchange}:{underlying}" root (e.g. "MCX:CRUDEOILM")
 * — what entry.spotSymbol actually holds for every commodity, since
 * commodity.json's "symbol" field IS that bare root — does NOT work for
 * Fyers' option-chain endpoint. LIVE-CONFIRMED 2026-08-07 (retestFlags.js
 * run): fetchOptionChain("MCX:GOLDM") -> "Please provide a valid symbol"
 * for all 4 commodities tested (CRUDEOILM, NATGASMINI, SILVERM, GOLDM);
 * fetchOptionChain() against each root's live near-month FUTURES symbol
 * (e.g. "MCX:GOLDM26SEPFUT") returned real strikes every time. So for
 * commodities this now builds and returns the near-month futures symbol
 * via resolveFuturesSymbols(entry) instead of the bare root — same
 * near-month resolution derivativesGapFill.js already uses for the
 * futures leg, reused here rather than reimplemented.
 */
function resolveChainLookupSymbol(entry) {
  if (entry.assetClass === "COMMODITY") {
    const [nearMonthFut] = resolveFuturesSymbols(entry);
    if (!nearMonthFut) {
      throw new Error(`resolveChainLookupSymbol: resolveFuturesSymbols() returned no symbol for "${entry.underlying}" — cannot build an option-chain lookup symbol without a near-month future`);
    }
    return nearMonthFut;
  }
  if (entry.spotSymbol) return entry.spotSymbol;
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
 * Extracts the real strike gap directly from a live chain response — the
 * spacing between two adjacent real strikes Fyers just returned. NEVER a
 * hardcoded/remembered number: derivatives-config.json's strikeGap field is
 * null for all 6 indices (confirmed 2026-08-11, not guessed) — guessing a
 * remembered value here (e.g. "NIFTY is 50") would repeat the exact class
 * of mistake that caused the GOLDM expiry-day bug. This is self-correcting:
 * if an exchange ever changes its strike interval, the next live call just
 * derives the new one automatically, no config file to go stale.
 * @returns {number|null} the gap, or null if fewer than 2 strikes came back
 */
function deriveStrikeGap(strikes) {
  const unique = [...new Set(strikes.map((s) => s.strike_price))].sort((a, b) => a - b);
  if (unique.length < 2) return null;
  let minGap = Infinity;
  for (let i = 1; i < unique.length; i++) {
    const gap = unique[i] - unique[i - 1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  return Number.isFinite(minGap) ? minGap : null;
}

// How far back each checkpoint label scans the price-reference series for
// ATM history. Bounded/session-based on purpose — no persistent
// "last checkpoint ran at X" state needed. "startup" gets a generous 3-day
// buffer (covers overnight + a full weekend in one number, cheap to ask
// for since it's just 1-min candles). nse_bse_close/mcx_close only ever
// need "since this same day's own session open", so 1 day is always enough
// and keeps the ask small.
const STRIKE_WINDOW_LOOKBACK_DAYS = { startup: 3, nse_bse_close: 1, mcx_close: 1 };

/**
 * Discovers every real ATM+-N strike that was EVER within band-width of
 * ATM at any point since this checkpoint label's own window start — not
 * just "ATM right now" (see discoverStrikes() above, which this replaces
 * as the checkpoint loop's discovery call). Fixes the exact gap the user
 * identified: a strike that briefly entered ATM+-N range between two
 * checkpoints and reverted before the next one ran was previously never
 * discovered at all. This reconstructs the whole window's ATM history from
 * the price-reference symbol's own real 1-min candles (which Fyers always
 * has complete, regardless of whether THIS server was running) — same
 * technique already proven in backend/src/scripts/backtestOptionDataFetch.js
 * for a whole month, just applied per-checkpoint instead.
 *
 * Falls back to point-in-time discoverStrikes() if the price-reference
 * series has no data in this window (e.g. a brand-new underlying with no
 * prior candles) or if a live strike gap can't be derived this call.
 *
 * @returns {Promise<Array<{symbol, strike_price, option_type, expiryType}>>}
 */
async function discoverStrikesSinceCheckpoint(entry, atmBandWidth, label, deps = {}) {
  const chainFn = deps.fetchOptionChain || fetchOptionChain;
  const fetchFn = deps.fetchCandles || fetchCandles;
  const log = deps.log || ((msg) => console.log(msg));
  // Same delayFn construction as runGapFillCheckpoint (deps.sleep || sleep)
  // — reused here, not reimplemented, to pace this function's own up-to-4
  // back-to-back broker calls per underlying (probe chain, price history,
  // wide chain, optional monthly chain). Uses the existing INTER_STRIKE_DELAY_MS
  // constant (same one backfillStrikesForEntry already uses for same-underlying
  // pacing) rather than a new number.
  const delayFn = deps.sleep || sleep;
  const lookupSymbol = resolveChainLookupSymbol(entry);

  // Step A — one narrow live call, purely to derive today's real strike
  // gap (see deriveStrikeGap's own comment for why this is never a config
  // value). Also doubles as the existing "no data this call" bail-out.
  const probe = await chainFn(lookupSymbol, { strikeCount: atmBandWidth });
  if (!probe.strikes.length && !probe.expiries.length) {
    return [];
  }
  const gap = deriveStrikeGap(probe.strikes);
  if (!gap) {
    vlog(`[GapFill] ${entry.underlying} — fewer than 2 strikes in the live chain, can't derive a real strike gap this call — falling back to point-in-time discovery for this checkpoint`);
    return discoverStrikes(entry, atmBandWidth, deps);
  }

  // Step B — the price-reference series to scan for ATM history. Indices
  // use their own spot symbol. Commodities have no separate tradeable spot
  // quote — derivatives-config.json's mcxAtmReference:"own_futures" says
  // to use the near-month FUTURES price instead, which is exactly what
  // resolveChainLookupSymbol(entry) already resolves to for commodities.
  const priceSymbol = entry.assetClass === "COMMODITY" ? lookupSymbol : entry.spotSymbol;
  const lookbackDays = STRIKE_WINDOW_LOOKBACK_DAYS[label] ?? STRIKE_WINDOW_LOOKBACK_DAYS.startup;
  const sinceMs = Date.now() - lookbackDays * 86400000;

  await delayFn(INTER_STRIKE_DELAY_MS);

  let priceCandles;
  try {
    priceCandles = await fetchFn(priceSymbol, 1, 200000, lookbackDays);
  } catch (err) {
    vlog(`[GapFill] ${entry.underlying} — couldn't fetch ${priceSymbol} price history (${err.message}) — falling back to point-in-time discovery for this checkpoint`);
    return discoverStrikes(entry, atmBandWidth, deps);
  }
  const inWindow = (priceCandles || []).filter((c) => c.time >= sinceMs);
  if (inWindow.length === 0) {
    vlog(`[GapFill] ${entry.underlying} — no ${priceSymbol} candles in the last ${lookbackDays}d, nothing to derive strike history from — falling back to point-in-time discovery for this checkpoint`);
    return discoverStrikes(entry, atmBandWidth, deps);
  }

  // Step C — union every strike that was ever within atmBandWidth steps of
  // ATM at ANY minute in the window, not just the most recent one. This is
  // the actual fix: a strike that was ATM+-4 for 20 minutes mid-session and
  // reverted before the next checkpoint is now still caught here, because
  // every minute's own ATM gets its own band added to the set.
  const wanted = new Set();
  for (const c of inWindow) {
    const atm = Math.round(c.close / gap) * gap;
    for (let i = -atmBandWidth; i <= atmBandWidth; i++) {
      wanted.add(atm + i * gap);
    }
  }
  const wantedArr = [...wanted];
  const currentAtm = Math.round(inWindow[inWindow.length - 1].close / gap) * gap;
  const minW = Math.min(...wantedArr);
  const maxW = Math.max(...wantedArr);
  // How many strikes-each-side the follow-up chain call needs to guarantee
  // covering the full derived range, not just the current atmBandWidth.
  const strikesEachSide = Math.max(atmBandWidth, Math.ceil(Math.max(currentAtm - minW, maxW - currentAtm) / gap) + 2);

  vlog(`[GapFill] ${entry.underlying} — ${inWindow.length} price candle(s) since last checkpoint, ATM ranged across ${wantedArr.length} strike(s) (gap=${gap}, strikeCount=${strikesEachSide} for follow-up chain call)`);

  // Step D — one wide-enough chain call, filtered down to only the strikes
  // actually in `wanted`. Reuses the exact same dual-cycle (weekly+monthly)
  // classification discoverStrikes() already does — not reimplemented.
  await delayFn(INTER_STRIKE_DELAY_MS);
  const wide = await chainFn(lookupSymbol, { strikeCount: strikesEachSide });
  if (!wide.strikes.length && !wide.expiries.length) {
    return [];
  }

  function filterAndTag(chainResult, expiryType) {
    return chainResult.strikes.filter((s) => wanted.has(s.strike_price)).map((s) => ({ ...s, expiryType }));
  }

  if (entry.expiryTypes.length === 1) {
    const results = filterAndTag(wide, entry.expiryTypes[0]);
    logMissingStrikes(entry, wantedArr, results, log);
    return results;
  }

  // Dual-cycle (NIFTY/SENSEX) — same classify-then-fetch-monthly-separately
  // pattern as discoverStrikes(), just filtered against `wanted` instead of
  // returned as-is.
  const realDates = wide.expiries.map((e) => e.date);
  const monthlyDate = classifyMonthlyExpiry(realDates, entry.exchange);
  const nearestIsMonthly = monthlyDate && wide.expiries[0] && wide.expiries[0].date === monthlyDate;
  const results = filterAndTag(wide, nearestIsMonthly ? "monthly" : "weekly");

  if (monthlyDate && !nearestIsMonthly) {
    const monthlyEntry = wide.expiries.find((e) => e.date === monthlyDate);
    vlog(`[GapFill] ${entry.underlying} — nearest expiry wasn't monthly, fetching monthly chain separately (expiry=${monthlyDate})`);
    await delayFn(INTER_STRIKE_DELAY_MS);
    const monthlyChain = await chainFn(lookupSymbol, { strikeCount: strikesEachSide, timestamp: monthlyEntry.expiry });
    results.push(...filterAndTag(monthlyChain, "monthly"));
  }

  logMissingStrikes(entry, wantedArr, results, log);
  return results;
}

function logMissingStrikes(entry, wantedArr, results, log) {
  const found = new Set(results.map((r) => r.strike_price));
  const missing = wantedArr.filter((w) => !found.has(w));
  if (missing.length) {
    vlog(`[GapFill] ${entry.underlying} — ${missing.length} derived strike(s) not returned by the live chain (likely outside what's currently listed, or already expired within the window): ${missing.join(", ")}`);
  }
}

/**
 * Discovers real ATM+-N strikes for one underlying, for every expiry type
 * it needs (1 or 2 fetchOptionChain calls, per entry.expiryTypes), at THIS
 * EXACT MOMENT only. Kept as the fallback path discoverStrikesSinceCheckpoint
 * above uses when it can't derive a real strike gap or has no price history
 * to scan — the checkpoint loop itself calls discoverStrikesSinceCheckpoint,
 * not this, directly (see runGapFillCheckpoint below).
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
    vlog(`[GapFill] ${entry.underlying} — nearest expiry wasn't monthly, fetching monthly chain separately (expiry=${monthlyDate})`);
    const monthlyChain = await chainFn(lookupSymbol, { strikeCount: atmBandWidth, timestamp: monthlyEntry.expiry });
    vlog(`[GapFill] ${entry.underlying} — monthly chain fetch returned ${monthlyChain.strikes.length} strike(s)`);
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
 *
 * ROOT-CAUSE FIX (2026-08-01): for MCX this used to call the unrestricted
 * monthCodesFromOffset(), which generates every calendar month in
 * sequence — wrong for SILVERM/SILVERMIC/SILVER, which only ever list
 * Feb/Apr/Jun/Aug/Nov/Dec contracts (RESTRICTED_MONTH_CYCLE in
 * symbolsRouter.js). That mismatch is the confirmed cause of
 * "MCX:SILVERM26SEPFUT ... Invalid symbol provided" — September was never
 * a real listed contract for this root. Now mirrors the exact same
 * offset-then-restricted-walk pattern symbolsRouter.js's buildFutures()
 * already uses for the identical purpose — not new logic, the same
 * already-tested one, just reused here too.
 *
 * ROOT-CAUSE FIX (2026-08-03): the non-MCX branch used to call
 * nseNearMonthOffset() unconditionally for every remaining exchange,
 * including BSE — silently assuming SENSEX/BANKEX roll on NSE's last-Tuesday
 * schedule. BSE F&O actually expires on the last THURSDAY of the month (the
 * same convention this file's own classifyMonthlyExpiry() already applies
 * via lastThursdayOfMonth() for BSE). Near the end of a month this could
 * roll SENSEX's "current" future a day or two early/late relative to its
 * real expiry. Now branches on entry.exchange === "BSE" and uses the new
 * symbolsRouter.bseNearMonthOffset() (same structure as nseNearMonthOffset,
 * Thursday instead of Tuesday) for that case specifically.
 */
function resolveFuturesSymbols(entry) {
  let codes;
  if (entry.exchange === "MCX") {
    const offset = symbolsRouter.mcxNearMonthOffset(entry.underlying);
    const fromMonth = new Date();
    fromMonth.setMonth(fromMonth.getMonth() + offset);
    codes = symbolsRouter.nextValidMonthCodes(entry.underlying, 2, fromMonth);
  } else if (entry.exchange === "BSE") {
    codes = symbolsRouter.monthCodesFromOffset(2, symbolsRouter.bseNearMonthOffset());
  } else {
    codes = symbolsRouter.monthCodesFromOffset(2, symbolsRouter.nseNearMonthOffset());
  }
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
 *
 * ROOT CAUSE #3 FIX (2026-08-02): each strike's backfillOptionSymbol call
 * is now wrapped in its own try/catch. Previously, one strike throwing
 * (most commonly fetchCandles's "no candles" error for a genuinely
 * illiquid strike — not a real problem) aborted this entire loop before
 * its `return` ran, discarding storedRows/symbolsBackfilled already
 * accumulated for every strike processed before it — even though those
 * rows were already durably written to the DB via upsertOptionCandles.
 * Confirmed against real logs: MIDCPNIFTY's 18th/last strike threw this
 * way and the "done" summary line reported 0 stored despite 17 real
 * successful strikes logged individually just above it; same pattern for
 * SENSEX (1 real success, then a throw on strike 2). Now: one strike
 * failing is logged and skipped, the loop continues through the
 * remaining strikes, and the final count reflects every strike that
 * actually succeeded — never zeroed out by the one that didn't.
 * @returns {Promise<{found: number, storedRows: number, symbolsBackfilled: number, strikesFailed: number}>}
 */
async function backfillStrikesForEntry(entry, strikes, label, log, delayFn, deps) {
  let storedRows = 0;
  let symbolsBackfilled = 0;
  let strikesFailed = 0;
  // FIX (Blocker 2, 2026-08-06): collect the real symbol string for every
  // strike DISCOVERED this run (not just the ones that got new candles
  // stored) — a symbol with r.stored===0 still genuinely exists right now,
  // it just didn't need any new candles this pass. Item 2 of the ongoing
  // cleanup plan needs "which option contracts currently exist" to hand to
  // Validator/Recovery, which is a different question than "which ones
  // changed this run" — so this list is built from `strikes` up front,
  // independent of each symbol's backfill outcome below.
  const discoveredSymbols = strikes.map((s) => s.symbol).filter(Boolean);
  for (let i = 0; i < strikes.length; i++) {
    const s = strikes[i];
    try {
      const r = await backfillOptionSymbol(entry, s.symbol, deps);
      if (r.stored > 0) {
        storedRows += r.stored;
        symbolsBackfilled++;
      }
      // Per-strike success line — noisy at full scale (can be hundreds per
      // checkpoint), gated behind VERBOSE_LOGS. Failures below stay always-on.
      if (VERBOSE) vlog(`[GapFill] ${label}: ${entry.underlying} — strike (${i + 1}/${strikes.length}) ${s.symbol}: ${r.isNew ? "new, retroactive backfill" : "existing, gap catch-up"}, ${r.stored} candle row(s) stored`);
    } catch (err) {
      strikesFailed++;
      vlog(`[GapFill] ${label}: ${entry.underlying} — strike (${i + 1}/${strikes.length}) ${s.symbol}: FAILED (${err.message}) — skipping, continuing to remaining strikes`);
    }
    if (i < strikes.length - 1) await delayFn(INTER_STRIKE_DELAY_MS);
  }
  return { found: strikes.length, storedRows, symbolsBackfilled, strikesFailed, discoveredSymbols };
}

/**
 * Runs one full checkpoint sweep across every curated underlying.
 * @param {string} label  "startup" | "nse_bse_close" | "mcx_close" — used
 *   to decide which asset classes this particular checkpoint covers (see
 *   runGapFillCheckpoint's filtering below).
 */
async function runGapFillCheckpoint(label, deps = {}) {
  const log = deps.log || ((msg) => console.log(msg));

  // Added 2026-08-14 — GapFill previously had no token gate at all, unlike
  // Staleness (core/dataFetch.js's sweepStalenessForSymbols, which bails via
  // ensureFreshOneMinData's validateToken() check). Confirmed in production
  // logs: with an expired/missing token, this ran through all ~214
  // underlyings anyway, producing 600+ doomed "Could not authenticate the
  // user" / "Invalid symbol provided" calls to Fyers per checkpoint — same
  // failure, just repeated at full scale for nothing. Mirrors Staleness's
  // exact gate and log style so both halves of the chain behave identically
  // when the token is invalid, and returns the same zeroed shape the normal
  // completion returns so gapFillScheduler.js's logging (r.scanned,
  // r.optionsDiscovered, etc.) and any other caller don't need to change.
  //
  // Follows this file's existing deps-override convention (same as
  // deps.fetchOptionChain/deps.fetchCandles below) so the integration test
  // can inject a mock instead of hitting the real Fyers client — without
  // this, the test would start failing since there's no live token in a
  // test environment.
  const validateTokenFn = deps.validateToken || state.validateToken;
  const tokenOk = await validateTokenFn().catch(() => false);
  if (!tokenOk) {
    log(`[GapFill] ${label}: skipped — token invalid. Will run after re-auth.`);
    return {
      label,
      scanned: 0,
      optionsDiscovered: 0,
      optionsBackfilled: 0,
      futuresBackfilled: 0,
      skipped: [],
      failed: [],
      discoveredSymbols: { futures: [], options: [] },
    };
  }

  const { all, atmBandWidth } = loadCuratedUnderlyings();
  const delayFn = deps.sleep || sleep;

  // NSE/BSE close covers indices AND equities (both NSE-listed, same real
  // close ~15:30); MCX close only covers commodities; startup covers all
  // three (curated JSON order is indices-then-commodities, equities appended
  // separately below — see loadCuratedUnderlyings()).
  // EQUITIES INCLUDED as of 2026-08-11 (see file header) — scoped purely by
  // asset class + checkpoint label here; the hasOptions/hasFutures flag
  // checks further down in this loop still gate whether each entry actually
  // does anything, same as every index/commodity entry already goes through.
  const scoped = all.filter((entry) => {
    if (label === "nse_bse_close") return entry.assetClass === "INDEX" || entry.assetClass === "EQUITY";
    if (label === "mcx_close") return entry.assetClass === "COMMODITY";
    return true; // startup — indices, equities, then commodities
  });

  // STORAGE FLAG SHORT-CIRCUIT — if all 6 derivative categories are off
  // (STORE_*_OPTIONS / STORE_*_FUTURES, see storageFlags.js), there is
  // nothing this checkpoint could possibly do: every entry's futures leg
  // and options leg would individually skip anyway (see the per-entry
  // gates further down), so walking all `scoped.length` entries just to
  // find that out — and printing a "(50/214)" progress counter for work
  // that never happens — is pure noise. One line and done. Spot isn't
  // part of this checkpoint at all (that's catchUp.js's staleness sweep),
  // so it's unaffected either way.
  const anyDerivativeStorageOn = ["NSE", "MCX", "BSE"].some(
    (ex) => isDerivativeStorageEnabled(ex, "option") || isDerivativeStorageEnabled(ex, "future")
  );
  if (!anyDerivativeStorageOn) {
    console.log(`[GapFill] ${label}: all options/futures storage disabled (STORE_* flags) — nothing to do, skipping ${scoped.length} underlying(s)`);
    return {
      label,
      scanned: 0,
      optionsDiscovered: 0,
      optionsBackfilled: 0,
      futuresBackfilled: 0,
      skipped: [],
      failed: [],
      discoveredSymbols: { futures: [], options: [] },
    };
  }

  let optionsDiscovered = 0, optionsBackfilled = 0, futuresBackfilled = 0;
  const skipped = [];
  const failed = [];
  // FIX (Blocker 2, 2026-08-06): real symbol strings, not just counts —
  // needed by item 2 of the ongoing cleanup plan (Validator/Recovery scope
  // expansion to fut/opt), which has no other way to know which specific
  // option/future contracts currently exist. Futures symbols come straight
  // from resolveFuturesSymbols(entry) (already real symbol strings, no
  // discovery step needed the way options have). Options symbols come from
  // backfillStrikesForEntry's new discoveredSymbols return (see above).
  const discoveredFuturesSymbols = [];
  const discoveredOptionsSymbols = [];

  // Summary with details now logged with start/end timestamps (see new "started" line below)
  const startTime = new Date().toISOString();
  console.log(`[GapFill] ${label}: started ${startTime} — ${scoped.length} underlying(s) (${scoped.filter((e) => e.assetClass === "INDEX").length} index, ${scoped.filter((e) => e.assetClass === "EQUITY").length} equity, ${scoped.filter((e) => e.assetClass === "COMMODITY").length} commodity)`);

  for (let idx = 0; idx < scoped.length; idx++) {
    const entry = scoped[idx];
    // Progress line every 50, not per-underlying detail
    if ((idx + 1) % 50 === 0 || idx === scoped.length - 1) {
      console.log(`[GapFill] ${label}: (${idx + 1}/${scoped.length})`);
    }
    let entryOptionsFound = 0, entryOptionsStored = 0, entryFuturesStored = 0, entryStrikesFailed = 0;

    // Futures — respected for EVERY remaining asset class (index, commodity).
    //
    // ROOT-CAUSE FIX (2026-08-07): each futures symbol (near-month,
    // next-month) now gets its own try/catch, mirroring the exact fix
    // already applied to the options loop (ROOT CAUSE #3 above). Before
    // this, one symbol throwing (most commonly fetchCandles's "no
    // candles" error for a next-month contract that's real but has zero
    // volume yet, OR a next/near-month contract that isn't actually
    // listed) aborted the whole entry's futures stage — discarding an
    // ALREADY-SUCCESSFUL sibling symbol's stored candles from this run's
    // summary and mislabeling the entry "FAILED" in the log even though
    // real data was written. Confirmed against real runs (retestFlags.js,
    // 2026-08-07): FINNIFTY/BANKEX's near-month (AUG) succeeded (1790 /
    // 380 candles) but their next-month (SEP) legitimately has no candles
    // yet — an empty new contract, not a bug — which was previously
    // enough to fail the entire entry. GOLDM showed the same bug in the
    // opposite direction: near-month (AUG) is an invalid/delisted symbol,
    // next-month (SEP) works (3741 candles), but AUG's throw aborted the
    // loop before SEP was ever attempted. Now: one symbol failing is
    // logged and skipped, its sibling symbols still get their own chance.
    // STORAGE FLAG GATE (STORE_*_FUTURES, see storageFlags.js) — checked
    // BEFORE calling resolveFuturesSymbols/Fyers, not just before the DB
    // write (derivativesStore.js gates the write too, as a second/lower
    // safety net). When this category is off, skip the whole futures leg's
    // broker calls and per-symbol log lines for this entry — this is what
    // actually saves API calls and reduces terminal noise, not just a
    // silent DB no-op after the fact.
    if (entry.hasFutures !== false && isDerivativeStorageEnabled(entry.exchange, "future")) {
      let futSymbols = [];
      try {
        futSymbols = resolveFuturesSymbols(entry);
        discoveredFuturesSymbols.push(...futSymbols);
      } catch (err) {
        failed.push({ underlying: entry.underlying, stage: "futures-resolve", error: err.message });
        vlog(`[GapFill] ${label}: ${entry.underlying} — could not resolve futures symbols: ${err.message}`);
      }
      for (const sym of futSymbols) {
        try {
          const r = await backfillFuturesSymbol(entry, sym, deps);
          if (r.stored > 0) { futuresBackfilled++; entryFuturesStored += r.stored; }
        } catch (err) {
          failed.push({ underlying: entry.underlying, stage: "futures", symbol: sym, error: err.message });
          vlog(`[GapFill] ${label}: ${entry.underlying} — futures ${sym} FAILED: ${err.message}`);
        }
      }
    }

    // Options — only underlyings that actually have listed options
    // (excludes SILVERMIC/GOLDPETAL via hasOptions:false). Same
    // STORE_*_OPTIONS pre-fetch gate reasoning as the futures leg above —
    // skips the whole discovery+backfill broker-call chain for this entry
    // when off, not just the final DB write.
    if (entry.hasOptions !== false && isDerivativeStorageEnabled(entry.exchange, "option")) {
      try {
        const strikes = await discoverStrikesSinceCheckpoint(entry, atmBandWidth, label, deps);
        entryOptionsFound = strikes.length;
        optionsDiscovered += strikes.length;
        vlog(`[GapFill] ${label}: ${entry.underlying} — ${strikes.length} real strike(s) discovered, backfilling one at a time (${INTER_STRIKE_DELAY_MS}ms apart)`);
        const result = await backfillStrikesForEntry(entry, strikes, label, log, delayFn, deps);
        entryOptionsStored = result.storedRows;
        entryStrikesFailed = result.strikesFailed;
        optionsBackfilled += result.symbolsBackfilled;
        discoveredOptionsSymbols.push(...result.discoveredSymbols);
      } catch (err) {
        // resolveChainLookupSymbol's deliberate throw for unconfirmed MCX
        // format lands here — tracked as "skipped", not "failed", since
        // it's a known, intentional gap, not an unexpected error.
        if (err.message.includes("UNCONFIRMED")) {
          skipped.push({ underlying: entry.underlying, reason: err.message });
          vwarn(`[GapFill] ${label}: ${entry.underlying} — options SKIPPED (${err.message})`);
        } else {
          failed.push({ underlying: entry.underlying, stage: "options", error: err.message });
          vwarn(`[GapFill] ${label}: ${entry.underlying} — options FAILED: ${err.message}`);
        }
      }
    }

    if (idx < scoped.length - 1) await delayFn(INTER_UNDERLYING_DELAY_MS);
  }

  const endTime = new Date().toISOString();
  console.log(`[GapFill] ${label}: ended ${endTime} — options ${optionsBackfilled}, futures ${futuresBackfilled}${failed.length ? `, FAILED ${failed.length} (${failed.map((f) => f.underlying).join(", ")})` : ""}`);

  return {
    label,
    scanned: scoped.length,
    optionsDiscovered,
    optionsBackfilled,
    futuresBackfilled,
    skipped,
    failed,
    startTime,
    endTime,
    discoveredSymbols: {
      futures: discoveredFuturesSymbols,
      options: discoveredOptionsSymbols,
    },
  };
}

module.exports = {
  runGapFillCheckpoint,
  discoverStrikes,
  discoverStrikesSinceCheckpoint,
  deriveStrikeGap,
  classifyMonthlyExpiry,
  resolveChainLookupSymbol,
  resolveFuturesSymbols,
  backfillOptionSymbol,
  backfillFuturesSymbol,
  backfillStrikesForEntry,
};