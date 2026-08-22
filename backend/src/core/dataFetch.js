// ─── dataFetch.js ───────────────────────────────────────────────────────────
// Extracted from server.js (Chunk 12, 2026-08-05) — see TGG-project-plan.md
// Section 4k.
//
// This is the REST/DB candle-fetching path — the "get me candles for
// symbol+resolution" single source of truth, plus its supporting staleness
// check, the auto-refresh fallback timer (only runs when the tick stream is
// down), and the boot-time pre-warm. Deliberately kept separate from
// tickEngine.js: this group runs whether or not the live WebSocket tick
// stream is even up (startAutoRefresh's entire reason to exist is that the
// tick stream ISN'T up), so bundling it into "tick engine" would blur the
// exact boundary the split is trying to draw.
//
// Factory function createDataFetch({ io, tickEngine }) — needs `io` (same
// reason as tickEngine.js) and `tickEngine` (for getOrCreateBuilder,
// isOptionSymbol — see fetchAndProcess below). One-directional dependency:
// dataFetch requires tickEngine, tickEngine never requires dataFetch back.
const { runSignalEngine } = require("../services/signalEngine");
const { fetchCandles, fetchDailyCandles, FULL_HISTORY_DAILY_LOOKBACK_DAYS } = require("../fyers/client");
const { deriveTimeframe, istDateKey } = require("../services/candleBuilder");
const { DAILY_RESOLUTION, isDailyOrHigher, aggregateDailyCandles } = require("../services/timeframeAggregator");
const { isTradingDay, isAnyMarketLive } = require("../fyers/tickStream");
const state = require("./state");
const { vlog } = require("../utils/verboseLog");

// ─── Derivative-symbol detection (DB optional, same guarded pattern as
// tickEngine.js's isOptionSymbol/deriveUnderlyingSymbol) ────────────────────
// The 1D-storage path below only applies to SPOT symbols (equities, indices,
// MCX continuous roots) — dated option/future contracts route through
// database/src/store/dataRouter.js to 6 separate derivatives tables that
// have no `resolution` column and are 1m-only by design (see dataRouter.js
// header). A short-lived weekly/monthly option contract also doesn't have a
// meaningful "complete historical 1D" to fetch in the first place. Those
// symbols keep the PRE-EXISTING behavior unchanged: Daily/Weekly/Monthly
// derived in-memory from their (already-stored) 1m history, exactly as
// before this change.
let parseDerivativeSymbol = null;
try {
  ({ parseDerivativeSymbol } = require("../../../database/src/parsing/symbolParser"));
} catch (err) {
  console.warn("[DataFetch] symbolParser module not found — treating all symbols as spot for the 1D-storage path:", err.message);
}
function isDerivativeSymbol(symbol) {
  if (!parseDerivativeSymbol) return false;
  try { return !!parseDerivativeSymbol(symbol); } catch { return false; }
}

function createDataFetch({ io, tickEngine }) {
  const { SYMBOL, RESOLUTION, CANDLES_TO_FETCH, CHART_DB_WINDOW_DAYS, REFRESH_MS, candleBuilders, socketSymbols, socketResolutions } = state;

  // ─── Lightweight per-symbol staleness check (boot / reactive) ────────────────
  //
  // PROBLEM THIS SOLVES: previously, once a symbol had ANY 1m rows in DB,
  // loadFromDB() trusted them unconditionally — it never asked "is this
  // actually CURRENT, or did the server just sit down for a while and DB's
  // last candle is hours old?" If the backend was restarted mid-session
  // (e.g. down 09:45→12:00 while the market stayed live), every
  // already-seeded symbol silently kept a hole from 09:45 to 12:00 forever —
  // nothing ever went back to fill it in, because the deep 90-day validator
  // explicitly skips "today" (it's supposed to — today is still in progress)
  // and the live tick stream only produces NEW candles from the moment it
  // reconnects onward.
  //
  // FIX: every time loadFromDB() is about to serve DB data for a symbol, check
  // DB's latest 1m candle against the clock. If it's stale beyond a small
  // tolerance, fetch just the missing delta range from Fyers (cheap — a
  // couple of days lookback at most, not a full year), upsert it, and merge
  // it into the data being returned/seeded so the chart and the candle
  // builder both start from a fully caught-up base instead of carrying a
  // silent hole forward indefinitely.
  //
  // Throttled per symbol (STALENESS_CHECK_COOLDOWN_MS) so this can't turn
  // into a Fyers-hammering loop under the 5s auto-refresh poll — at most one
  // delta-fetch attempt per symbol per cooldown window, regardless of how
  // many chart requests come in during that window.
  //
  // GATING (2026-07-07, confirmed): no day-type check at all here anymore —
  // not weekend, not holiday, not "is today a trading day." The Fyers REST
  // call is cheap and harmless any day (it just returns nothing new on a
  // closed day), and gating on day-type risked silently missing a new
  // contract's first candles landing right after a holiday. The ONLY gate
  // left is "is the Fyers token valid?"
  const STALENESS_TOLERANCE_MS = 3 * 60 * 1000;       // DB allowed to lag "now" by up to 3 minutes before it's considered stale
  const STALENESS_CHECK_COOLDOWN_MS = 60 * 1000;       // don't re-check/re-fetch the same symbol more than once per minute
  const lastStalenessCheckAt = new Map();              // symbol → ms timestamp of last check/attempt

  /**
   * If `oneMinCandles` (already loaded from DB, ascending by time) looks stale
   * relative to "now", fetch just the missing delta from Fyers, upsert it, and
   * return a merged, de-duplicated, sorted array. Otherwise returns the
   * original array unchanged.
   *
   * The only gate is token validity — runs any day (weekend/holiday/trading
   * day), since the API call is cheap and harmless when there's nothing new.
   *
   * Never throws — any failure here just means we fall back to serving the
   * (possibly stale) DB data exactly as before this fix existed, so this can
   * never make things worse than the pre-fix behavior.
   */
  async function ensureFreshOneMinData(symbol, oneMinCandles) {
    try {
      if (!oneMinCandles || oneMinCandles.length === 0) return oneMinCandles;

      const lastCandle = oneMinCandles[oneMinCandles.length - 1];
      const nowMs = Date.now();
      const lagMs = nowMs - lastCandle.time;
      if (lagMs <= STALENESS_TOLERANCE_MS) return oneMinCandles; // already current — nothing to do

      const lastCheck = lastStalenessCheckAt.get(symbol) || 0;
      if (nowMs - lastCheck < STALENESS_CHECK_COOLDOWN_MS) return oneMinCandles; // throttled — already tried recently
      lastStalenessCheckAt.set(symbol, nowMs);

      // Only gate: do we have a working Fyers login right now? No day-type
      // check (weekend/holiday/trading day) — those no longer matter here.
      const tokenOk = await state.validateToken().catch(() => false);
      if (!tokenOk) return oneMinCandles;

      vlog(`[Staleness] ${symbol}: DB latest is ${(lagMs / 60000).toFixed(1)}min behind — fetching delta from Fyers`);

      // Small bounded lookback (2 days) is always enough to cover the gap —
      // even a multi-hour outage never spans more than the current + previous
      // trading day. This keeps the delta-fetch cheap and fast, unlike a full
      // historical refetch.
      const fresh1m = await fetchCandles(symbol, 1, CANDLES_TO_FETCH, 2);
      if (!fresh1m || fresh1m.length === 0) return oneMinCandles;

      // Only keep candles strictly newer than what we already have — avoids
      // re-validating/re-sorting the whole existing range unnecessarily.
      const newOnes = fresh1m.filter((c) => c.time > lastCandle.time);
      if (newOnes.length === 0) return oneMinCandles;

      if (state.dbEnabled && state.db) {
        try {
          const inserted = await state.db.upsertCandles(symbol, 1, newOnes);
          vlog(`[Staleness] ${symbol}: backfilled ${inserted} missing 1m candle(s)`);
          // FRONTEND-SYNC FIX: if a chart for this symbol was already open in a
          // browser tab BEFORE this backfill ran, the page's first render would
          // have shipped with the (then-stale) DB data — and since the live tick
          // stream only appends NEW candles going forward, that earlier render
          // would carry a visual gap forward indefinitely with nothing telling
          // it to re-fetch. Broadcasting this event lets any open chart for this
          // symbol silently re-pull fresh history the moment the backfill lands,
          // instead of requiring a manual page reload to see corrected data.
          io.emit("history_updated", { symbol, reason: "staleness_backfill", count: inserted });
        } catch (err) {
          console.warn(`[Staleness] ${symbol}: upsert of delta candles failed (${err.message}) — still using them in-memory for this response`);
        }
      }

      const merged = [...oneMinCandles, ...newOnes]
        .sort((a, b) => a.time - b.time)
        .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
      return merged;
    } catch (err) {
      console.warn(`[Staleness] ${symbol}: check failed (${err.message}) — serving DB data as-is`);
      return oneMinCandles;
    }
  }

  // ─── Daily (1D) staleness check — mirrors ensureFreshOneMinData above ─────
  //
  // 1D bars only ever change once per trading day (today's bar, while the
  // market is open) plus one final settle after close. So instead of a
  // tight few-minute tolerance like the 1m check, this only re-fetches when
  // the DB's latest daily row is from a PRIOR calendar day (IST) than
  // today's actual/most-recent trading day — i.e. "we don't have today's
  // bar yet" or "yesterday's bar never got its final settle". Throttled the
  // same way (per-symbol cooldown) so this can't turn into a hammering loop
  // across a full symbol list either.
  //
  // Never throws — same guarantee as ensureFreshOneMinData: any failure here
  // just means we serve the (possibly one-day-stale) DB data exactly as
  // before this existed.
  const DAILY_STALENESS_CHECK_COOLDOWN_MS = 5 * 60 * 1000; // at most once per 5 min per symbol
  const lastDailyStalenessCheckAt = new Map();

  async function ensureFreshDailyData(symbol, dailyCandles) {
    try {
      if (!dailyCandles || dailyCandles.length === 0) return dailyCandles;

      const lastCandle = dailyCandles[dailyCandles.length - 1];
      const todayKey = istDateKey(Date.now());
      const lastKey = istDateKey(lastCandle.time);
      if (lastKey === todayKey) return dailyCandles; // already has today's bar — current

      const nowMs = Date.now();
      const lastCheck = lastDailyStalenessCheckAt.get(symbol) || 0;
      if (nowMs - lastCheck < DAILY_STALENESS_CHECK_COOLDOWN_MS) return dailyCandles; // throttled
      lastDailyStalenessCheckAt.set(symbol, nowMs);

      const tokenOk = await state.validateToken().catch(() => false);
      if (!tokenOk) return dailyCandles;

      vlog(`[Staleness] ${symbol}: DB latest daily bar is ${lastKey}, today is ${todayKey} — fetching delta from Fyers`);

      // Small bounded lookback (5 days) always covers the gap — even a
      // multi-day outage or a weekend/holiday never spans more than a
      // handful of calendar days without a new trading-day bar appearing.
      const freshDaily = await fetchDailyCandles(symbol, 5);
      if (!freshDaily || freshDaily.length === 0) return dailyCandles;

      const newOnes = freshDaily.filter((c) => c.time > lastCandle.time);
      if (newOnes.length === 0) return dailyCandles;

      if (state.dbEnabled && state.db) {
        try {
          const inserted = await state.db.upsertCandles(symbol, DAILY_RESOLUTION, newOnes);
          vlog(`[Staleness] ${symbol}: backfilled ${inserted} missing daily candle(s)`);
          io.emit("history_updated", { symbol, resolution: DAILY_RESOLUTION, reason: "daily_staleness_backfill", count: inserted });
        } catch (err) {
          console.warn(`[Staleness] ${symbol}: daily upsert failed (${err.message}) — still using them in-memory for this response`);
        }
      }

      const merged = [...dailyCandles, ...newOnes]
        .sort((a, b) => a.time - b.time)
        .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
      return merged;
    } catch (err) {
      console.warn(`[Staleness] ${symbol}: daily check failed (${err.message}) — serving DB data as-is`);
      return dailyCandles;
    }
  }

  // ─── Staleness SWEEP — proactive, over a full symbol list ─────────────────
  // Added 2026-08-06 (item 3 of the ongoing cleanup plan): this used to be
  // an inline loop inside catchUp.js's runCuratedSymbolCatchUp(), calling
  // ensureFreshOneMinData() per symbol under a name that didn't distinguish
  // it from the REACTIVE call loadFromDB() makes for whatever single symbol
  // a client's chart just requested. Same underlying logic either way
  // (ensureFreshOneMinData does the actual staleness check + delta-fetch) —
  // this function is just the proactive, whole-list-at-once wrapper around
  // it, under its own name, so "sweep a symbol list" and "check one symbol
  // reactively" are no longer the same unnamed pattern living in two
  // different files.
  //
  // Deliberately generic over whatever symbol list the caller passes in —
  // this function itself has no opinion on WHICH symbols belong in the
  // sweep (that's catchUp.js's job, sourcing the spot-only list from root).
  async function sweepStalenessForSymbols(symbols, label = "sweep") {
    console.log(`[Staleness] ${label}: checking ${symbols.length} symbol(s) for staleness...`);
    let staleFound = 0;
    // Concurrency=3 / 1200ms between batches to stay comfortably under
    // Fyers' rate limit across a long sweep (a faster 5/500ms setting was
    // seen failing near the tail end of a 205-symbol list in production
    // with "request limit reached" errors) — same values the inline sweep
    // loop this replaces already used.
    const SWEEP_CONCURRENCY = 3;
    for (let i = 0; i < symbols.length; i += SWEEP_CONCURRENCY) {
      const batch = symbols.slice(i, i + SWEEP_CONCURRENCY);
      await Promise.all(batch.map(async (symbol) => {
        try {
          const latest = await state.db.getLatestCandle(symbol, 1);
          if (!latest) return; // symbol has no 1m data yet — nothing to check staleness against
          const before = latest.time;
          await ensureFreshOneMinData(symbol, [latest]);
          // ensureFreshOneMinData logs its own [Staleness] line when it
          // actually backfills something; we just tally here for the summary.
          const after = await state.db.getLatestCandle(symbol, 1).catch(() => null);
          if (after && after.time > before) staleFound++;
        } catch (e) {
          console.warn(`[Staleness] ${label} sweep error for ${symbol}:`, e.message);
        }
      }));
      if (i + SWEEP_CONCURRENCY < symbols.length) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    console.log(`[Staleness] ${label} sweep complete — ${staleFound} symbol(s) backfilled out of ${symbols.length} checked`);
    return { checked: symbols.length, backfilled: staleFound };
  }

  // SINGLE SOURCE OF TRUTH for "get me candles for symbol+resolution".
  // Every caller — GET /api/chart, POST /api/chart/refresh, /api/motherwave,
  // and initialRestFetch() — goes through this one function. No DB code lives
  // anywhere else in the codebase.
  //
  // `symbol` has no default value — checked every real call site (2026-08-07,
  // dataFetch.js's own 2 internal calls, websocket.js's 1, chartRouter.js's
  // 3): every one always passes either a real symbol string or an explicit
  // `null` (e.g. `state.SYMBOL` is `null`, not `undefined`, when the env var
  // is unset). JS default params only fire on `undefined`, so the old
  // `symbol = SYMBOL || "NSE:NIFTY50-INDEX"` default could never actually
  // execute — confirmed dead, not assumed, removed as part of the project
  // cleanup pass.
  //
  // Order of operations:
  //   1. DB-first  — if DB is enabled and has data for `symbol`, derive the
  //      requested resolution from Postgres. No Fyers call needed. This is the
  //      common case once a symbol has been backfilled at least once.
  //   2. Fyers fallback — only when DB is disabled, DB has zero rows for this
  //      symbol (fresh symbol, never backfilled), or the DB read throws. Fetches
  //      from Fyers REST and write-throughs candles to DB so the *next* call
  //      for this symbol takes the DB-first path.
  //
  // CHANGED (2026-08-21): resolution now splits into two independent
  // storage tiers instead of always deriving everything from 1-minute data:
  //   • 1m – 1h (1/3/5/15/60): UNCHANGED. Reads the last CHART_DB_WINDOW_DAYS
  //     of 1-minute candles and derives via deriveTimeframe(). Exactly the
  //     same logic as before this change, byte-for-byte.
  //   • 1D and higher (1440/10080/43200/…), spot symbols only: reads the
  //     symbol's COMPLETE stored 1-Day history from the `candles` table
  //     (loadDailyFromDB) and derives Weekly/Monthly/etc. from THAT via
  //     timeframeAggregator.js — never touches 1-minute data at all. See
  //     isDerivativeSymbol()'s header comment for why option/future
  //     contracts are excluded from this tier and keep deriving from 1m.
  // Daily and higher (1440/10080/43200/…) now read from the PERSISTED 1D
  // table (see database/migrations/005_daily_candles.sql) instead of
  // deriving from the full 1m history — this is the core of the "fetch
  // complete 1D data, derive Weekly/Monthly from stored 1D, not from 1m"
  // requirement. Applies to spot symbols only; derivative (option/future)
  // symbols keep deriving from 1m exactly as before (see
  // isDerivativeSymbol's header comment above for why).
  //
  // Everything below 1D (1/3/5/15/60) is completely unchanged — still reads
  // the CHART_DB_WINDOW_DAYS slice of 1m and derives via deriveTimeframe().
  async function loadDailyFromDB(symbol) {
    // NEWEST rows first is irrelevant here (unlike the 1m 100000-row cap) —
    // a symbol's full daily history is small enough (a few thousand rows
    // even over 10+ years) that `mostRecent` is mainly about ordering
    // consistency with loadFromDB's other branch, not truncation risk.
    let dailyCandles = await state.db.loadCandles(symbol, DAILY_RESOLUTION, { limit: 20000, mostRecent: true });
    if (!dailyCandles || dailyCandles.length === 0) return null;
    dailyCandles = await ensureFreshDailyData(symbol, dailyCandles);
    return dailyCandles;
  }

  async function loadFromDB(symbol, resolution) {
    if (!state.dbEnabled || !state.db) return null;
    try {
      if (isDailyOrHigher(resolution) && !isDerivativeSymbol(symbol)) {
        const dailyCandles = await loadDailyFromDB(symbol);
        if (!dailyCandles || dailyCandles.length === 0) return null;
        const candles = aggregateDailyCandles(dailyCandles, resolution);
        if (!candles || candles.length === 0) return null;
        // No 1m candles fetched/returned for this path — see fetchAndProcess
        // for why builder-seeding is skipped when oneMinCandles is null.
        return { candles, oneMinCandles: null, dailyCandles };
      }

      const windowMs = CHART_DB_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      let oneMinCandles = await state.db.loadCandles(symbol, 1, {
        from: new Date(Date.now() - windowMs),
        to: new Date(),
        limit: 50000,
      });

      if (!oneMinCandles || oneMinCandles.length === 0) return null;

      oneMinCandles = await ensureFreshOneMinData(symbol, oneMinCandles);

      const candles = resolution === 1 ? oneMinCandles : deriveTimeframe(oneMinCandles, resolution);
      if (!candles || candles.length === 0) return null;

      return { candles, oneMinCandles };
    } catch (err) {
      console.warn(`[DB-first] DB read failed for ${symbol} res=${resolution} (${err.message}) — falling back to Fyers`);
      return null;
    }
  }

  async function fetchAndProcess(symbol, resolution = RESOLUTION) {
    // ── 1. DB-first ──────────────────────────────────────────────────────────
    // CHANGED: previously this skipped the DB entirely for option contracts
    // (CE/PE) because "the DB will always be empty for them" — true when this
    // was written, no longer true now that options are routed into
    // nse_options_candles/mcx_options_candles (see database/src/dataRouter.js)
    // and backfilled from history. loadFromDB() already returns null when the
    // DB genuinely has nothing for a symbol (brand-new contract not yet
    // written), so it falls through to the Fyers path below exactly as
    // before for those — this just stops UNCONDITIONALLY bypassing the DB
    // for every option on every request.
    const dbHit = await loadFromDB(symbol, resolution);
    if (dbHit) {
      const { candles, oneMinCandles, dailyCandles } = dbHit;
      console.log(`[DB-first] ${symbol} res=${resolution}m → ${candles.length} candles from DB`);

      // Seed the candle builder so the live tick stream has 1m continuity for
      // this symbol — same seedHistory() call the Fyers path always made.
      // Safe to call repeatedly: seedHistory() fully replaces _oneMinHistory.
      // SKIPPED when oneMinCandles is null — the new 1D-and-higher DB path
      // (loadDailyFromDB) never fetches 1m data at all (that's the whole
      // point: avoid the duplicate fetch a Daily/Weekly/Monthly request used
      // to trigger). The live "today" bar for Daily+ still ticks correctly
      // without this: tickEngine.js's per-1m-finalize patch reads directly
      // off the builder's live forming-tick state, not off seeded history.
      if (oneMinCandles) {
        tickEngine.getOrCreateBuilder(symbol).seedHistory(oneMinCandles);
      }

      const result = runSignalEngine(candles);
      state.setCache(symbol, resolution, candles, result);
      if (resolution !== 1 && oneMinCandles) {
        try { state.setCache(symbol, 1, oneMinCandles, runSignalEngine(oneMinCandles)); } catch { }
      }
      // Also cache the underlying stored daily candles under DAILY_RESOLUTION
      // itself when we derived a higher timeframe from them (Weekly/Monthly)
      // — mirrors the existing "also cache the 1m source" behavior above, so
      // a follow-up request for plain "1D" on this symbol is a cache hit
      // instead of re-deriving from the same dailyCandles array again.
      if (dailyCandles && resolution !== DAILY_RESOLUTION) {
        try { state.setCache(symbol, DAILY_RESOLUTION, dailyCandles, runSignalEngine(dailyCandles)); } catch { }
      }
      return { candles, result };
    }

    // ── 2. Fyers fallback (DB disabled, empty, or read failed) ───────────────
    console.log(`[Fyers-fallback] ${symbol} res=${resolution}m — no DB data, fetching from Fyers`);

    // ── 2a. Daily and higher, spot symbols ──────────────────────────────────
    // "Fetch the symbol's complete historical 1D data" — this is the ONE
    // place that happens. No raw1m fetch here at all (that was the old
    // behavior's redundant call for every Daily/Weekly request); the 1m
    // candle builder gets seeded lazily the next time an intraday (1-60m)
    // resolution is requested for this symbol, same as any other symbol
    // that's never had an intraday chart opened for it yet.
    if (isDailyOrHigher(resolution) && !isDerivativeSymbol(symbol)) {
      const dailyCandles = await fetchCandles(symbol, DAILY_RESOLUTION, CANDLES_TO_FETCH, FULL_HISTORY_DAILY_LOOKBACK_DAYS);

      if (state.dbEnabled && dailyCandles.length > 0) {
        state.db.getLatestCandle(symbol, DAILY_RESOLUTION).then((latest) => {
          const newCandles = latest ? dailyCandles.filter((c) => c.time > latest.time) : dailyCandles;
          if (newCandles.length === 0) {
            console.log(`[DB] ${symbol} — no new daily candles to upsert (already up to date)`);
            return;
          }
          return state.db.upsertCandles(symbol, DAILY_RESOLUTION, newCandles).then((n) => {
            const since = latest ? new Date(latest.time).toISOString() : "first time";
            console.log(`[DB] Upserted ${n} new daily candles for ${symbol} (${since})`);
          });
        }).catch((err) => {
          console.warn(`[DB] getLatestCandle(daily) failed for ${symbol} (${err.message}) — skipping daily upsert`);
        });
      }

      const candles = aggregateDailyCandles(dailyCandles, resolution);
      const result = runSignalEngine(candles);
      state.setCache(symbol, resolution, candles, result);
      if (resolution !== DAILY_RESOLUTION) {
        try { state.setCache(symbol, DAILY_RESOLUTION, dailyCandles, runSignalEngine(dailyCandles)); } catch { }
      }
      return { candles, result };
    }

    // ── 2b. Everything else (1m–1h, and Daily+ for derivative symbols) ──────
    // UNCHANGED from before this feature — 1-minute through 1-hour always
    // goes through here exactly as it always has. Derivative (option/future)
    // symbols also still take this path even for Daily+ requests, per
    // isDerivativeSymbol's header comment.
    // Option contracts (CE/PE) only exist for days/weeks — using the default
    // 30-day lookback causes Fyers to return empty chunks for dates before the
    // contract was listed. Use a 5-day lookback instead so every chunk is valid.
    const isOptionContract = tickEngine.isOptionSymbol(symbol);
    const raw1m = await fetchCandles(symbol, 1, CANDLES_TO_FETCH, isOptionContract ? 5 : null);

    if (candleBuilders.has(symbol)) {
      const existing = candleBuilders.get(symbol).getOneMinHistory();
      if (existing.length > 0 && raw1m.length > 0) {
        const ratio = existing[0].close > 0 ? Math.abs(raw1m[0].close - existing[0].close) / existing[0].close : 1;
        if (ratio > 0.5) { console.log(`[Server] Price scale mismatch for ${symbol} — resetting builder`); candleBuilders.delete(symbol); }
      }
    }

    const builder = tickEngine.getOrCreateBuilder(symbol);
    builder.seedHistory(raw1m);

    // ── DB: bulk-save REST 1m candles on every fetch ────────────────────────
    // This backfills the DB with historical 1m candles from Fyers REST so the
    // *next* fetchAndProcess() call for this symbol takes the DB-first path.
    // upsertCandles is idempotent (ON CONFLICT DO UPDATE) so re-fetching is safe.
    // ── DB: smart upsert ─ only write candles newer than what's already stored ──
    if (state.dbEnabled && raw1m.length > 0) {
      state.db.getLatestCandle(symbol, 1).then((latest) => {
        const newCandles = latest
          ? raw1m.filter((c) => c.time > latest.time)
          : raw1m;

        if (newCandles.length === 0) {
          console.log(`[DB] ${symbol} — no new candles to upsert (already up to date)`);
          return;
        }

        return state.db.upsertCandles(symbol, 1, newCandles).then((n) => {
          const since = latest ? new Date(latest.time).toISOString() : 'first time';
          console.log(`[DB] Upserted ${n} new 1m candles for ${symbol} (${since})`);
        });
      }).catch((err) => {
        // getLatestCandle failed — skip upsert entirely, do NOT dump all candles.
        // recoveryEngine will detect any gap on its next cycle and re-fetch
        // only the affected day via deleteDayCandles + upsert. repairLog will
        // record it. No blind fallback upsert here.
        console.warn(`[DB] getLatestCandle failed for ${symbol} (${err.message}) — skipping upsert, recoveryEngine will handle gap`);
      });
    }

    let candles;
    if (resolution === 1) { candles = raw1m; }
    else { candles = await fetchCandles(symbol, resolution, CANDLES_TO_FETCH); }

    const result = runSignalEngine(candles);
    state.setCache(symbol, resolution, candles, result);
    if (resolution !== 1) { try { state.setCache(symbol, 1, raw1m, runSignalEngine(raw1m)); } catch { } }
    return { candles, result };
  }

  // Broadcast to room but only to sockets watching this symbol
  async function fetchAndBroadcast(symbol, resolution, isAutoRefresh = true) {
    const { candles, result } = await fetchAndProcess(symbol, resolution);
    const payload = state.buildPayload(candles, result, symbol, resolution, isAutoRefresh);
    const room = `res:${resolution}`;
    const roomSockets = io.sockets.adapter.rooms.get(room);
    if (roomSockets?.size) {
      for (const sid of roomSockets) {
        const sock = io.sockets.sockets.get(sid);
        if (!sock) continue;
        if ((socketSymbols.get(sid) || SYMBOL || symbol) === symbol) sock.emit("chart_update", payload);
      }
    }
    console.log(`[BROADCAST] ${symbol} res=${resolution}m → ${candles.length} candles`);
    return { candles, result };
  }

  // ─── Auto-refresh fallback ────────────────────────────────────────────────────
  function startAutoRefresh() {
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = setInterval(async () => {
      if (!isTradingDay() || !isAnyMarketLive(tickEngine.getActiveTickSymbols()) || tickEngine.tickStream.isConnected()) return;
      const valid = await state.validateToken();
      if (!valid) return;

      // Collect ALL unique (symbol, resolution) pairs across all connected sockets
      // — not just the default SYMBOL. Every panel gets refreshed.
      const pairs = new Map();
      for (const [sid, sym] of socketSymbols) {
        const res = socketResolutions.get(sid) || RESOLUTION;
        const key = `${sym}:${res}`;
        if (!pairs.has(key)) pairs.set(key, { symbol: sym, resolution: res });
      }
      // Always include default (only if a default SYMBOL is configured)
      if (SYMBOL) {
        const dk = `${SYMBOL}:${RESOLUTION}`;
        if (!pairs.has(dk)) pairs.set(dk, { symbol: SYMBOL, resolution: RESOLUTION });
      }

      // Stagger refreshes 600ms apart — prevents Fyers rate storm (Issue #2 fix)
      const pairList = Array.from(pairs.values());
      for (let i = 0; i < pairList.length; i++) {
        const { symbol, resolution } = pairList[i];
        if (i > 0) await new Promise(r => setTimeout(r, 600));
        console.log(`[AUTO] Refreshing ${symbol} res=${resolution}m... (${i + 1}/${pairList.length})`);
        fetchAndBroadcast(symbol, resolution, true).catch((e) => console.error(`[AUTO] Error ${symbol} res=${resolution}:`, e.message));
      }
    }, REFRESH_MS);
    console.log(`[AUTO] Refresh every ${REFRESH_MS / 1000}s (live market + tick stream down only)`);
  }

  // ─── Initial REST fetch ───────────────────────────────────────────────────────
  // Pre-warms the in-process cache for every resolution on startup.
  // NO token check here — fetchAndProcess() handles DB-first internally.
  // If DB has data → loads instantly without any Fyers call.
  // If DB is empty AND token is invalid → Fyers fallback fails gracefully per-res.
  // Either way the site is never fully blocked by an expired token.
  async function initialRestFetch() {
    if (!SYMBOL) {
      console.log("[INIT] No default SYMBOL set — skipping pre-warm. Charts load on first client request.");
      return;
    }
    const dayLabel = isTradingDay() ? (isAnyMarketLive(tickEngine.getActiveTickSymbols()) ? "live market" : "weekday (market closed)") : "weekend/holiday";
    console.log(`[INIT] Pre-warming all resolutions for ${SYMBOL} (${dayLabel})...`);

    const ALL_RESOLUTIONS = [1, 3, 5, 15, 60, 1440, 10080, 43200];

    for (const res of ALL_RESOLUTIONS) {
      const MAX_RETRIES = 3;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try { await fetchAndProcess(SYMBOL, res); console.log(`[INIT] res=${res} ✓`); break; }
        catch (err) {
          console.error(`[INIT] res=${res} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
          if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
    try {
      const cache = state.getCache(SYMBOL, RESOLUTION);
      if (cache.result && cache.candles.length > 0) io.emit("chart_update", state.buildPayload(cache.candles, cache.result, SYMBOL, RESOLUTION, false));
    } catch { }
    console.log("[INIT] All resolutions loaded ✓  Chart is ready.");
  }

  return {
    ensureFreshOneMinData, sweepStalenessForSymbols, loadFromDB, fetchAndProcess, fetchAndBroadcast,
    startAutoRefresh, initialRestFetch,
  };
}

module.exports = createDataFetch;