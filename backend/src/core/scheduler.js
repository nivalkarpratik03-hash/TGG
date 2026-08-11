// ─── scheduler.js ───────────────────────────────────────────────────────────
// Extracted from server.js (Chunk 12, 2026-08-05) — see TGG-project-plan.md
// Section 4k.
//
// The boot-time wiring block that used to live directly inside
// server.listen()'s callback: DB health-check + derivatives prune sweep,
// recoveryEngine status-emitter wiring, periodic broker-drift sync,
// GapFill scheduler wiring, the curated-catchup→GapFill startup chain, and
// scanner/backtest symbol loading + Socket.IO event forwarding.
//
// Split into two functions (wireDbJobs, wireScannerAndBacktest) called from
// server.js's listen callback in the exact same order the original inline
// code ran them — this file changes WHERE the code lives, not WHEN it runs.
const { fetchCandles } = require("../fyers/client");
const { isTradingDay, isLiveMarket } = require("../fyers/tickStream");
const { wireGapFillScheduler } = require("../derivatives/gapFillScheduler");
const symbolsRouter = require("../routes/symbolsRouter");
const { scanner } = require("../services/scannerRunner");
const { backtestRunner } = require("../services/backtestRunner");
const state = require("./state");

// ── DB: connect, health-check, wire every DB-dependent periodic job ────────
// UPDATED 2026-08-06 (items 2, 3, 4, 6): now takes sweepCuratedStaleness +
// runValidatorRecovery (both from catchUp.js's createCatchUp()) instead of
// the old single runCuratedSymbolCatchUp. Both get handed straight into
// wireGapFillScheduler() as deps — gapFillScheduler.js's fire() now runs
// all three (Staleness → GapFill → Validator/Recovery, in that order) at
// every one of its checkpoints, so this function no longer needs its own
// separate startup chain for catch-up before GapFill — there's only one
// chain now, and gapFillScheduler.js owns all of it.
async function wireDbJobs({ io, sweepCuratedStaleness, runValidatorRecovery }) {
  if (!state.dbEnabled) return;
  try {
    const ok = await state.db.healthCheck();
    if (ok) {
      console.log("[DB] ✅  PostgreSQL connection healthy");

      // ── PRUNING DISABLED (2026-07-03) — legacy `candles`-table pruning ──
      // Both pruneOldCandles() and pruneExpiredContracts() hard-DELETE rows
      // from `candles` with no archive anywhere else — every expired
      // option/future contract they touch is gone permanently, which
      // breaks backtesting (confirmed: they had already deleted 3 SENSEX
      // option contracts / 3420 candles by the time this was caught).
      // Still turned off, still untouched, still applies ONLY to the
      // legacy `candles` table (see database/src/candleStore.js) — this
      // has NOTHING to do with the new derivatives archive/prune below,
      // which targets the 6 separate derivatives tables and always
      // archives to a real local Parquet file before ever deleting.
      //
      // const pruned = await db.pruneOldCandles(null, 1, 365);
      // if (pruned > 0) console.log(`[DB] Pruned ${pruned} old candles (>365 days)`);
      //
      // const expiredResult = await db.pruneExpiredContracts();
      // if (expiredResult.symbolsPruned > 0) {
      //   console.log(`[DB] Pruned ${expiredResult.symbolsPruned} expired contract(s), ${expiredResult.candlesDeleted} candles: ${expiredResult.symbols.slice(0, 10).join(", ")}${expiredResult.symbols.length > 10 ? ", ..." : ""}`);
      // }
      // setInterval(async () => {
      //   try {
      //     const r = await db.pruneExpiredContracts();
      //     if (r.symbolsPruned > 0) {
      //       console.log(`[DB] Periodic sweep: pruned ${r.symbolsPruned} expired contract(s), ${r.candlesDeleted} candles`);
      //     }
      //   } catch (e) {
      //     console.warn("[DB] Periodic expired-contract prune failed:", e.message);
      //   }
      // }, 6 * 60 * 60 * 1000); // every 6 hours

      // ── NEW: derivatives archive + prune (nse/mcx/bse options+futures) ──
      // Unlike the legacy block above, this ALWAYS archives a contract's
      // full row history to a local Parquet file (see
      // backend/src/archive/parquetExport.js — writes under
      // {DATASET_ROOT or ./dataset}/{ASSET_CLASS}/{UNDERLYING}/...) and
      // ONLY deletes from Postgres after that archive write is confirmed
      // successful. A failed archive leaves the contract's rows
      // untouched, retried on the next sweep — see
      // backend/src/derivatives/pruneExpiredDerivatives.js for the exact
      // ordering guarantee.
      //
      // Deliberately NOT gated by isTradingDay() — unlike periodicSync
      // and the Staleness/GapFill/Validator chain below, this makes zero
      // Fyers/broker calls (archiving reads only from Postgres, and
      // expiry is a pure calendar comparison against the already-stored
      // expiry_date column) — so it's harmless and correct to run on any
      // day, including weekends/holidays, not just trading days.
      //
      // Scheduling note: runs once at startup, then every 24h. This does
      // NOT yet implement the more precise "run at NSE close (~15:40) /
      // MCX close (~23:30) separately" timing discussed during design —
      // that precision matters for the (not-yet-built) EOD
      // reconciliation job, which needs that day's data specifically.
      // It doesn't matter here: pruning only ever acts on contracts
      // whose expiry_date has ALREADY passed as of a prior calendar day,
      // so which hour of the day this runs at has no effect on
      // correctness — a daily cadence is enough.
      try {
        const { runPruneSweep } = require("../derivatives/pruneExpiredDerivatives");
        const runSweep = async (label) => {
          try {
            const r = await runPruneSweep();
            if (r.scanned > 0 || r.archived > 0) {
              console.log(`[Prune] ${label}: scanned ${r.scanned} expired contract(s) — archived ${r.archived}, pruned ${r.pruned}, already-empty ${r.alreadyEmpty}${r.failed.length ? `, FAILED ${r.failed.length} (left in DB, retried next sweep: ${r.failed.map(f => `${f.group} [${f.error}]`).join("; ")})` : ""}`);
            }
          } catch (e) {
            console.warn(`[Prune] ${label} sweep error:`, e.message);
          }
        };
        setImmediate(() => runSweep("startup"));
        setInterval(() => runSweep("daily"), 24 * 60 * 60 * 1000);
        console.log("[Prune] Derivatives archive+prune wired — runs at startup, then every 24h (any day, not gated to trading days)");
      } catch (e) {
        console.warn("[Prune] Failed to wire derivatives archive+prune:", e.message);
      }


      // ── Wire up recovery engine WebSocket emitter ──────────────────────
      if (state.recoveryEngine) {
        state.recoveryEngine.injectStatusEmitter((event, data) => io.emit(event, data));
        console.log("[Recovery] Status emitter connected to WebSocket");
      }

      // ── Periodic broker-drift sync (was dead code — never called) ──────
      // recoveryEngine.periodicSync() was fully implemented (compares DB's
      // latest 1m candle vs the broker's, upserts any gap, or falls back
      // to a full day repair) but nothing anywhere ever called it — grepped
      // the entire backend/src and found zero callers. Wiring it here,
      // scoped to only the symbols someone actually has open right now
      // (getLiveBroadcastSymbols(), same TTL-expiring set used for tick
      // subscriptions) so this can't turn into a Fyers-hammering loop —
      // it only ever checks charts a real client is looking at. Unrelated
      // to the Staleness/GapFill/Validator chain below — this is a
      // separate, narrower, much more frequent check.
      //
      // NOTE: NOT touched by the "no day-type gating" change — this loop's
      // own isTradingDay()/isLiveMarket() gates were not part of the
      // confirmed scope. Say the word if you want the same token-only
      // rule applied to periodicSync too.
      if (state.recoveryEngine) {
        setInterval(async () => {
          try {
            if (!isTradingDay()) return;
            const activeSymbols = state.getLiveBroadcastSymbols();
            if (activeSymbols.length === 0) return;
            for (const symbol of activeSymbols) {
              if (!isLiveMarket(symbol)) continue;
              await state.recoveryEngine.periodicSync({
                symbol,
                fetchCandles: (sym, res) => fetchCandles(sym, res),
              });
            }
          } catch (e) {
            console.warn("[PeriodicSync] Sweep error:", e.message);
          }
        }, 5 * 60 * 1000); // every 5 minutes
        console.log("[PeriodicSync] Wired — checking actively-viewed symbols every 5 minutes during market hours");
      }

      // ── Staleness → GapFill → Validator/Recovery chain, 3x/day ──────────
      // RESTRUCTURED 2026-08-06 (items 2, 3, 4, 6): this used to be a
      // one-time boot chain — runCuratedSymbolCatchUp("startup") (spot-only
      // Recovery+Validator, then a spot-only staleness sweep, curated list
      // only) followed by a single GapFill startup checkpoint, both firing
      // exactly once, ever. That whole shape is gone.
      //
      // gapFillScheduler.js now owns the full chain — Staleness sweep,
      // then GapFill, then the (now DB-sourced, spot+fut/opt) Validator/
      // Recovery pass — and fires all three together at startup,
      // nse_bse_close, and mcx_close (see gapFillScheduler.js for the full
      // explanation). This file's job is just to construct it with the
      // right dependencies and fire the startup checkpoint once boot is
      // otherwise ready — no separate catch-up chain to sequence in front
      // of it anymore.
      let gapFillScheduler = null;
      try {
        gapFillScheduler = wireGapFillScheduler({ sweepCuratedStaleness, runValidatorRecovery });
      } catch (e) {
        console.warn("[GapFill] Failed to wire scheduler:", e.message);
      }

      if (gapFillScheduler) {
        setImmediate(() => {
          gapFillScheduler.fireStartupCheckpoint().catch((e) => {
            console.warn("[GapFill] Startup checkpoint chain failed:", e.message);
          });
        });
      }

      // Returned so server.js can wire fireReauthCheckpoint into
      // chartRouter.js's /api/auth/token route (item 6/4 follow-through —
      // re-auth now re-triggers the SAME full 3-step chain, not just the
      // old spot-only catch-up).
      return { gapFillScheduler };

    } else {
      console.warn("[DB] ⚠️  PostgreSQL health check failed — DB writes disabled");
      state.dbEnabled = false;
    }
  } catch (err) {
    console.warn("[DB] ⚠️  PostgreSQL startup error — DB writes disabled:", err.message);
    state.dbEnabled = false;
  }
}

// ─── Scanner + Backtest symbol loading ──────────────────────────────────────
// REPOINTED 2026-07-31 — this used to be its own duplicate loadScanSymbols(),
// re-parsing frontend/src/symbols.json, mcx.json, stocks.xlsx, and
// NIFTY.xlsx independently, with its own simpler dedup logic. Deleted —
// Scanner/backtest symbol loading now calls symbolsRouter.js's own
// getSymbols(), the exact same parser (and 1-hour cache) GET /api/symbols
// uses, so there is only ever one symbol parser in the codebase. That
// parser already reads the root symbols/ master (index.json, equity.json,
// commodity.json) instead of frontend/src/ — see symbolsRouter.js.
function wireScannerAndBacktest({ io }) {
  setImmediate(() => {
    const allSymbols = symbolsRouter.getSymbols().map((s) => s.symbol);
    console.log(`[Scanner] Loaded ${allSymbols.length} symbols for scanning`);
    scanner.setSymbols(allSymbols);
    backtestRunner.setSymbols(allSymbols);

    // Forward scanner events to all connected clients via Socket.IO
    scanner.on("scan_start", (data) => io.emit("scanner_start", data));
    scanner.on("scan_progress", (data) => io.emit("scanner_progress", data));
    scanner.on("scan_complete", (data) => io.emit("scanner_complete", data));
    scanner.on("signal_found", (data) => io.emit("scanner_signal", data));
    scanner.on("signal_partial", (data) => io.emit("scanner_partial", data));

    // Forward backtest events
    backtestRunner.on("backtest_start", (data) => io.emit("backtest_start", data));
    backtestRunner.on("backtest_progress", (data) => io.emit("backtest_progress", data));
    backtestRunner.on("backtest_complete", (data) => io.emit("backtest_complete", data));
    backtestRunner.on("backtest_hit", (data) => io.emit("backtest_hit", data));

    // No auto-start — scan is triggered manually from the UI or POST /api/scanner/trigger
  });
}

module.exports = { wireDbJobs, wireScannerAndBacktest };