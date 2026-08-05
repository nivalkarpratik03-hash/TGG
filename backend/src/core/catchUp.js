// ─── catchUp.js ─────────────────────────────────────────────────────────────
// Extracted from server.js (Chunk 12, 2026-08-05) — see TGG-project-plan.md
// Section 4k.
//
// Curated-symbol gap scan + staleness sweep. Validates every curated
// (no-expiry) symbol against the broker, repairs any gap, then proactively
// runs the same staleness/delta-fetch check ensureFreshOneMinData() does —
// but for EVERY curated symbol, not just whichever one a client happens to
// have open. Callable from two places: once at boot (trigger="startup"),
// and from the /api/auth/token route right after a token is successfully
// (re)generated (trigger="reauth" — see chartRouter.js).
//
// Factory function createCatchUp({ dataFetch }) — needs dataFetch's
// ensureFreshOneMinData for the staleness-sweep half. One-directional:
// catchUp requires dataFetch (and dataFetch requires tickEngine), dataFetch
// and tickEngine never require catchUp back.
const { fetchCandles } = require("../fyers/client");
const { loadIndexSpotSymbols, loadStockSpotSymbols } = require("../derivatives/curatedUnderlyingsLoader");
const state = require("./state");

function createCatchUp({ dataFetch }) {
  // An in-flight guard prevents the two triggers from ever running the sweep
  // concurrently (e.g. someone re-auths a few seconds after boot, while the
  // startup sweep is still in progress).
  let _catchUpInFlight = false;

  async function runCuratedSymbolCatchUp(trigger = "startup") {
    if (!state.recoveryEngine || !state.dbEnabled || !state.db) return;

    if (_catchUpInFlight) {
      console.log(`[Recovery] Catch-up already running — skipping duplicate ${trigger} trigger`);
      return;
    }
    _catchUpInFlight = true;

    try {
      // REPOINTED 2026-07-30 (confirmed, Option 1): used to read
      // ./data/noExpirySymbols.json directly. Now builds the same flat
      // 205-symbol list (3 indices + ~202 equities) from the new
      // symbols/index.json + symbols/stocks.json files via
      // curatedUnderlyingsLoader.js, so noExpirySymbols.json has no
      // remaining readers anywhere in the codebase and can be safely
      // deleted (curatedUnderlyingsLoader.js was the other former reader,
      // also repointed).
      let curatedSymbols = [];
      try {
        const indexSpot = loadIndexSpotSymbols();
        const stockSpot = loadStockSpotSymbols();
        curatedSymbols = [...indexSpot, ...stockSpot].map((s) => s.symbol).filter(Boolean);
      } catch (e) {
        console.warn("[Recovery] Could not load symbols/index.json + symbols/stocks.json for catch-up scan:", e.message);
        return;
      }

      if (trigger === "startup") {
        // Wait for initialRestFetch to finish (it runs right before the boot call)
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Skip if token is invalid — repairs need Fyers, pointless without auth.
      // On the "reauth" trigger this should basically always pass, since the
      // caller only invokes this after a token was just successfully saved —
      // but re-check anyway rather than assume, in case it expired again
      // between save and this call.
      const tokenOk = await state.validateToken().catch(() => false);
      if (!tokenOk) {
        console.log(`[Recovery] Catch-up (${trigger}) skipped — token invalid. Will repair after re-auth.`);
        return;
      }

      console.log(`[Recovery] Catch-up (${trigger}): checking ${curatedSymbols.length} curated symbols...`);
      let repaired = 0;
      let clean = 0;
      let skippedKnown = 0;
      const CONCURRENCY = 3;
      const BATCH_DELAY_MS = 1000;

      for (let i = 0; i < curatedSymbols.length; i += CONCURRENCY) {
        const batch = curatedSymbols.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (symbol) => {
          try {
            const { valid, issues } = await state.db.validateHistorical(symbol, 1);
            if (!valid && issues.length > 0) {
              // Find the earliest gap and repair that day
              const gapIssue = issues.find((iss) => iss.type === "GAP" || iss.type === "CORRUPT_OHLC");
              if (gapIssue) {
                const tradingDay = new Date(gapIssue.time || Date.now());
                // Skip today — an in-progress trading day always looks incomplete
                const todayStr = new Date().toISOString().slice(0, 10);
                if (tradingDay.toISOString().slice(0, 10) >= todayStr) {
                  console.log(`[Recovery] ${symbol}: skipping today's in-progress candles (not a real gap)`);
                  clean++;
                  return;
                }

                // CIRCUIT BREAKER — fixes the infinite repeat-repair loop
                // (e.g. NSE:NIFTY50-INDEX getting "repaired" for the same
                // day on every single restart, forever). If this exact
                // symbol+day already had a successful repair logged
                // recently and the validator is STILL flagging it, the
                // broker's own data for that day is almost certainly
                // just genuinely short (thin closing volume, etc.) — not
                // something another refetch will fix. Skip it, log once,
                // and let it become eligible again after the cooldown
                // window in case the broker backfills better data later.
                const alreadyRepaired = await state.db.wasDayAlreadyRepaired(symbol, tradingDay, 3).catch(() => false);
                if (alreadyRepaired) {
                  console.log(`[Recovery] ${symbol}: ${tradingDay.toISOString().slice(0, 10)} already repaired recently and still flagged — likely a genuine short broker day, skipping re-repair`);
                  skippedKnown++;
                  return;
                }

                console.log(`[Recovery] ${symbol}: ${issues.length} issue(s) — repairing gap at ${tradingDay.toISOString().slice(0, 10)}`);
                await state.recoveryEngine.repairDay({
                  symbol,
                  tradingDay,
                  fetchCandles: (sym, res) => fetchCandles(sym, res),
                  trigger,
                });
                repaired++;
              }
            } else {
              clean++;
              // Silent for clean symbols — only log summary at end
            }
          } catch (e) {
            console.warn(`[Recovery] ${symbol} scan error:`, e.message);
          }
        }));
        if (i + CONCURRENCY < curatedSymbols.length) {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
      }
      console.log(`[Recovery] Catch-up (${trigger}) gap scan complete — ${clean} clean, ${repaired} repaired, ${skippedKnown} skipped (known short day) out of ${curatedSymbols.length} symbols`);

      // ── Proactive staleness sweep ──────────────────────────────────────
      // PROBLEM: ensureFreshOneMinData() only fires REACTIVELY — the moment
      // a client actually requests that exact symbol's chart. Nothing swept
      // the curated symbol list proactively, so a symbol nobody happened to
      // open yet could sit with a silent gap until someone finally loaded
      // its chart.
      // FIX 4: reuse the exact same ensureFreshOneMinData() logic (same
      // throttle map, same 3-min tolerance, same cheap 2-day delta fetch)
      // but drive it here for every curated symbol.
      //
      // GATING (2026-07-07, confirmed): removed the `if (!isTradingDay(symbol))
      // return;` early-out that used to sit here. Fetching history from Fyers
      // works the same whether today happens to be a trading day for this
      // symbol or not, so this sweep is no longer skipped on weekends/
      // holidays. The only gate left is the token-valid check that already
      // lives inside ensureFreshOneMinData() itself.
      console.log(`[Staleness] Catch-up (${trigger}) sweep: checking ${curatedSymbols.length} curated symbols for staleness...`);
      let staleFound = 0;
      // Concurrency=3 / 1200ms between batches to stay comfortably under
      // Fyers' rate limit across the whole sweep (a faster 5/500ms setting
      // was seen failing near the tail end of a 205-symbol list in
      // production with "request limit reached" errors).
      const SWEEP_CONCURRENCY = 3;
      for (let i = 0; i < curatedSymbols.length; i += SWEEP_CONCURRENCY) {
        const batch = curatedSymbols.slice(i, i + SWEEP_CONCURRENCY);
        await Promise.all(batch.map(async (symbol) => {
          try {
            const latest = await state.db.getLatestCandle(symbol, 1);
            if (!latest) return; // symbol has no 1m data yet — nothing to check staleness against
            const before = latest.time;
            await dataFetch.ensureFreshOneMinData(symbol, [latest]);
            // ensureFreshOneMinData logs its own [Staleness] line when it
            // actually backfills something; we just tally here for the summary.
            const after = await state.db.getLatestCandle(symbol, 1).catch(() => null);
            if (after && after.time > before) staleFound++;
          } catch (e) {
            console.warn(`[Staleness] Catch-up sweep error for ${symbol}:`, e.message);
          }
        }));
        if (i + SWEEP_CONCURRENCY < curatedSymbols.length) {
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
      console.log(`[Staleness] Catch-up (${trigger}) sweep complete — ${staleFound} symbol(s) backfilled`);
    } finally {
      _catchUpInFlight = false;
    }
  }

  return { runCuratedSymbolCatchUp };
}

module.exports = createCatchUp;
