/**
 * database/src/recoveryEngine.js
 *
 * RECOVERY & SYNCHRONIZATION ENGINE
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ARCHITECTURE RULE — 1m-ONLY DB STORAGE                            ║
 * ║                                                                      ║
 * ║  The database stores ONLY resolution=1 (1-minute) candles.          ║
 * ║  All higher timeframes (3m, 5m, 15m, 1h, 1D, 1W) are derived        ║
 * ║  in-memory from 1m data by CandleBuilder / deriveTimeframe.         ║
 * ║                                                                      ║
 * ║  This means:                                                         ║
 * ║    • fetchCandles is always called with resolution=1                 ║
 * ║    • upsertCandles is always called with resolution=1                ║
 * ║    • repairDay / periodicSync always operate on resolution=1         ║
 * ║    • fullRefetch only fetches & stores 1m — never other TFs          ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Responsibilities (from architecture diagram):
 *  • Fetch latest closed 1m broker candles
 *  • Compare broker vs DB 1m timeline
 *  • Detect and recover missing 1m candle gaps
 *  • Restore corrupted 1m trading days (delete day → refetch → revalidate)
 *  • Serialize repairs with per-symbol mutex (no concurrent writes)
 *  • Store only validated 1m candles into DB
 *  • Emit status events so the frontend can show repair progress
 */

const { upsertCandles, deleteDayCandles, deleteAllCandles } = require("./candleStore");
const { validateCandleArray, checkPeriodicSync } = require("./validationEngine");
const { logRepairStart, logRepairFinish } = require("./repairLog");

// ─── DB resolution constant ───────────────────────────────────────────────────
// Only 1m candles are stored in and read from the DB.
// Higher TFs are always derived in-memory from this 1m base.
const DB_RESOLUTION = 1;

// ─── Per-symbol mutex (serialize repair jobs) ────────────────────────────────

const repairQueues = new Map();   // symbol → Promise chain
const activeRepairs = new Set();  // symbol:resolution pairs currently repairing

function getQueue(symbol) {
  if (!repairQueues.has(symbol)) repairQueues.set(symbol, Promise.resolve());
  return repairQueues.get(symbol);
}

function enqueueRepair(symbol, fn) {
  const next = getQueue(symbol).then(fn).catch((err) => {
    console.error(`[Recovery] Repair error for ${symbol}:`, err.message);
  });
  repairQueues.set(symbol, next);
  return next;
}

// ─── Status emitter (injected by server.js) ──────────────────────────────────

let _emitStatus = null;

/** Call this once from server.js: injectStatusEmitter((event, data) => io.emit(event, data)) */
function injectStatusEmitter(fn) {
  _emitStatus = fn;
}

function emit(event, data) {
  if (_emitStatus) _emitStatus(event, data);
}

// ─── Core repair logic ───────────────────────────────────────────────────────

/**
 * Integrity-First Repair (1m only):
 *   Detect corruption in 1m DB data
 *   → Delete the full affected 1m trading day
 *   → Refetch clean 1m candle data for that day from Fyers REST
 *   → Restore validated 1m candles into DB
 *   → Revalidate 1m integrity
 *
 * NOTE: resolution param is accepted for API compatibility but is IGNORED —
 *       repair always operates on DB_RESOLUTION (1m). Higher TFs are derived
 *       in-memory from the repaired 1m data by the caller (server.js).
 *
 * ROOT-CAUSE NOTE: this used to call fetchCandles(symbol, resolution) with no
 * date range, which always fell back to a 30-day-from-TODAY window — so
 * repairing one bad day from two months ago still pulled the full default
 * lookback from Fyers every time, for every affected symbol, even though
 * only ~375 candles (one trading day) were ever going to be used. With
 * dozens of symbols each needing several day-repairs, a single validation
 * pass could take minutes and hammer the broker far more than necessary.
 * Now `fetchCandles` is called with an explicit {from, to} window padded by
 * one day on each side of `tradingDay`, fetching only what's actually needed.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {number} [opts.resolution]  ignored — always repairs 1m in DB
 * @param {Date|string} opts.tradingDay   any moment within the affected day
 * @param {Function} opts.fetchCandles    (symbol, resolution, rangeOpts?) => Promise<candle[]>
 *                                         rangeOpts = {from, to} — caller (server.js) must
 *                                         forward this through to client.js's fetchCandles
 * @param {string}  [opts.trigger]        'corruption'|'startup'|'periodic'|'manual'
 */
async function repairDay(opts) {
  const { symbol, tradingDay, fetchCandles, trigger = "corruption" } = opts;
  // Always repair 1m — ignore any resolution passed in (higher TFs are in-memory only)
  const resolution = DB_RESOLUTION;
  const key = `${symbol}:${resolution}`;

  // Tight fetch window: one day on either side of the target day, so
  // timezone/session-boundary rounding never clips the actual trading day
  // this repair cares about, while still avoiding a 30-day pull.
  const ONE_DAY_MS = 86400 * 1000;
  const targetMs = new Date(tradingDay).getTime();
  const fetchFrom = new Date(targetMs - ONE_DAY_MS);
  const fetchTo = new Date(targetMs + ONE_DAY_MS);

  if (activeRepairs.has(key)) {
    console.log(`[Recovery] Repair already active for ${key} — skipping duplicate`);
    return { skipped: true };
  }

  return enqueueRepair(symbol, async () => {
    activeRepairs.add(key);
    emit("repair_status", { symbol, resolution, status: "starting", trigger });

    const logId = await logRepairStart({ symbol, resolution, trigger }).catch(() => null);

    try {
      // Step 1 (REORDERED — was: delete first, fetch second):
      // Refetch clean 1m candle data from Fyers REST BEFORE deleting anything.
      //
      // ROOT-CAUSE NOTE: the original order deleted the day FIRST, then
      // fetched + validated, then aborted with NO restore if validateCandleArray
      // flagged ANY issue anywhere in the (always-full-history) refetch. A
      // single GAP/duplicate flag — which is common and often harmless across
      // a 90-day window — silently wiped a trading day forever with no
      // replacement, which is exactly how 1m data went missing mid-day in
      // production. Fetching first means a failed/partial refetch never
      // touches existing DB rows.
      console.log(`[Recovery] Refetching 1m candles from broker for ${symbol} ` +
        `(targeted: ${fetchFrom.toISOString().slice(0,10)} → ${fetchTo.toISOString().slice(0,10)})...`);
      const fresh = await fetchCandles(symbol, resolution, { from: fetchFrom, to: fetchTo });
      emit("repair_status", { symbol, resolution, status: "fetched", count: fresh.length });

      if (!fresh || fresh.length === 0) {
        const errMsg = "Broker returned no candles — aborting repair without touching existing DB data";
        console.error(`[Recovery] ${symbol} res=1: ${errMsg}`);
        emit("repair_status", { symbol, resolution, status: "error", error: errMsg });
        await logRepairFinish(logId, { status: "error", detail: errMsg }).catch(() => null);
        return { success: false, error: errMsg };
      }

      // Step 2: Validate — INFORMATIONAL ONLY, not a hard gate.
      // A single GAP/DUPLICATE flag anywhere across the whole fetched range
      // must never block storing the (overwhelmingly valid) rest of the data.
      // candleStore.upsertCandles() already filters out structurally corrupt
      // rows (isValidCandle) on its own — that's the real safety net, and it
      // is idempotent (INSERT ... ON CONFLICT UPDATE), so it's always safe to
      // write the full fetched range here.
      const { valid, issues } = validateCandleArray(fresh, resolution);
      if (!valid) {
        console.warn(`[Recovery] ${symbol} res=1: refetch has ${issues.length} validation issue(s) ` +
          `(${issues.slice(0, 3).map(i => i.type).join(", ")}) — storing valid rows anyway; ` +
          `corrupt rows are filtered out by upsertCandles()`);
        emit("repair_status", { symbol, resolution, status: "validation_warning", issues: issues.length });
      }

      // Filter fetched range down to ONLY the target trading day before upserting.
      // The fetch window is ±1 day (for timezone safety), but we must not silently
      // rewrite neighbor days' candles as a side-effect of repairing one bad day.
      // Use the same UTC midnight boundary logic as deleteDayCandles() so that
      // deleted and inserted always refer to the exact same set of candles.
      const targetDay = new Date(tradingDay);
      const dayStart = new Date(targetDay);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      const dayStartMs = dayStart.getTime();
      const dayEndMs   = dayEnd.getTime();
      const targetDayCandles = fresh.filter(c => c.time >= dayStartMs && c.time < dayEndMs);

      if (targetDayCandles.length === 0) {
        const errMsg = `Broker returned ${fresh.length} candles but none fall within target day ${new Date(tradingDay).toISOString().slice(0,10)} — aborting repair without touching existing DB data`;
        console.error(`[Recovery] ${symbol} res=1: ${errMsg}`);
        emit("repair_status", { symbol, resolution, status: "error", error: errMsg });
        await logRepairFinish(logId, { status: "error", detail: errMsg }).catch(() => null);
        return { success: false, error: errMsg };
      }

      // Step 3: NOW it's safe to delete the corrupted/affected day — a
      // validated replacement is already in hand and about to be written back.
      console.log(`[Recovery] Deleting 1m day data for ${symbol} day=${new Date(tradingDay).toISOString().slice(0,10)}`);
      const deleted = await deleteDayCandles(symbol, resolution, tradingDay);
      emit("repair_status", { symbol, resolution, status: "deleted", deleted });

      // Step 4: Store only the target day's 1m candles into DB.
      // (neighbor-day candles from the padded fetch window are discarded)
      const inserted = await upsertCandles(symbol, resolution, targetDayCandles);
      console.log(`[Recovery] ${symbol} res=1: inserted ${inserted} 1m candles`);
      emit("repair_status", { symbol, resolution, status: "restored", inserted });

      if (inserted === 0) {
        // Should not happen since we already checked fresh.length > 0 above,
        // but guard against upsertCandles filtering out 100% of rows.
        const errMsg = "Refetch returned candles but none passed basic OHLC sanity checks — day left deleted with no replacement";
        console.error(`[Recovery] ${symbol} res=1: ${errMsg}`);
        emit("repair_status", { symbol, resolution, status: "error", error: errMsg });
        await logRepairFinish(logId, { status: "error", detail: errMsg, deleted, inserted }).catch(() => null);
        return { success: false, error: errMsg, deleted, inserted };
      }

      console.log(`[Recovery] ${symbol} res=1: ✅ COMPLETE — day ${new Date(tradingDay).toISOString().slice(0,10)} repaired (deleted=${deleted}, inserted=${inserted})`);
      emit("repair_status", { symbol, resolution, status: "ok", inserted, deleted });
      await logRepairFinish(logId, { status: "ok", deleted, inserted }).catch(() => null);
      return { success: true, inserted, deleted };

    } catch (err) {
      console.error(`[Recovery] ${symbol} res=1: ❌ FAILED — ${err.message}`);
      emit("repair_status", { symbol, resolution, status: "error", error: err.message });
      await logRepairFinish(logId, { status: "error", detail: err.message }).catch(() => null);
      throw err;
    } finally {
      activeRepairs.delete(key);
    }
  });
}

// ─── Full refetch (nuke + reload 1m only) ────────────────────────────────────

/**
 * Delete ALL stored 1m candles for a symbol and refetch the complete 1m timeline.
 * Triggered by the "Full Refetch" button in the frontend.
 *
 * ARCHITECTURE NOTE: Only 1m candles are fetched from the broker and stored in DB.
 * The `resolutions` option is intentionally removed — higher TFs are always
 * derived in-memory from 1m data by CandleBuilder after this completes.
 * The caller (server.js) must call fetchAndProcess / deriveAllTFs after fullRefetch
 * completes to rebuild the in-memory TF cache.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {Function} opts.fetchCandles   (symbol, resolution) => Promise<candle[]>
 */
async function fullRefetch(opts) {
  const { symbol, fetchCandles } = opts;

  return enqueueRepair(symbol, async () => {
    emit("repair_status", { symbol, status: "full_refetch_start" });

    const logId = await logRepairStart({ symbol, resolution: DB_RESOLUTION, trigger: "manual_full_refetch" }).catch(() => null);

    let totalDeleted = 0;
    let totalInserted = 0;

    // Step 1 (REORDERED — was: delete first, fetch second):
    // Fetch + validate BEFORE deleting the existing timeline. The old order
    // could leave a symbol with ZERO candles permanently if the refetch
    // failed outright or validateCandleArray flagged any issue anywhere in
    // the fetched range (a hard abort that skipped storage entirely after
    // the delete had already run).
    let candles;
    try {
      console.log(`[Recovery] Full refetch ${symbol}: fetching 1m candles from broker...`);
      candles = await fetchCandles(symbol, DB_RESOLUTION);
      emit("repair_status", { symbol, resolution: DB_RESOLUTION, status: "full_refetch_fetched", count: candles.length });
    } catch (err) {
      console.error(`[Recovery] Full refetch ${symbol} res=1 fetch error:`, err.message);
      emit("repair_status", { symbol, resolution: DB_RESOLUTION, status: "full_refetch_error", error: err.message });
      await logRepairFinish(logId, { status: "error", detail: err.message }).catch(() => null);
      return { success: false, error: err.message };
    }

    if (!candles || candles.length === 0) {
      const errMsg = "Broker returned no candles — aborting full refetch without touching existing DB data";
      console.error(`[Recovery] Full refetch ${symbol}: ${errMsg}`);
      emit("repair_status", { symbol, resolution: DB_RESOLUTION, status: "full_refetch_error", error: errMsg });
      await logRepairFinish(logId, { status: "error", detail: errMsg }).catch(() => null);
      return { success: false, error: errMsg };
    }

    // Validation is informational only — see repairDay() for the full
    // rationale. upsertCandles() filters out structurally corrupt rows on
    // its own, so a stray GAP/duplicate flag must never block storage.
    const { valid, issues } = validateCandleArray(candles, DB_RESOLUTION);
    if (!valid) {
      console.warn(`[Recovery] Full refetch ${symbol} res=1: ${issues.length} validation issue(s) — storing valid rows anyway`);
      emit("repair_status", { symbol, resolution: DB_RESOLUTION, status: "full_refetch_validation_warning", issues: issues.length });
    }

    // Step 2: NOW delete the old (possibly corrupted) timeline — a validated
    // replacement is already in hand and about to be written back immediately.
    const deleted = await deleteAllCandles(symbol, DB_RESOLUTION);
    totalDeleted += deleted;
    console.log(`[Recovery] Full refetch ${symbol}: deleted ${deleted} 1m candles`);
    emit("repair_status", { symbol, status: "full_refetch_deleted", deleted });

    // Prune any stale candles >3 months old across all symbols (safety net)
    try {
      const pruned = await require("./candleStore").pruneOldCandles(null, null, 90);
      if (pruned > 0) console.log(`[Recovery] Full refetch: pruned ${pruned} stale candles (>3 months)`);
    } catch { /* non-fatal */ }

    // Step 3: Store the freshly fetched candles — idempotent, always run
    // regardless of the informational validation result above.
    const inserted = await upsertCandles(symbol, DB_RESOLUTION, candles);
    totalInserted += inserted;
    console.log(`[Recovery] Full refetch ${symbol} res=1: ${inserted} 1m candles stored`);
    emit("repair_status", { symbol, resolution: DB_RESOLUTION, status: "full_refetch_res_ok", inserted });

    console.log(`[Recovery] ${symbol}: ✅ COMPLETE — full refetch done (deleted=${totalDeleted}, inserted=${totalInserted})`);
    emit("repair_status", { symbol, status: "full_refetch_complete", totalInserted, totalDeleted });
    await logRepairFinish(logId, {
      status: totalInserted > 0 ? "ok" : "error",
      deleted: totalDeleted,
      inserted: totalInserted,
    }).catch(() => null);

    return { success: totalInserted > 0, totalInserted, totalDeleted };
  });
}

// ─── Periodic sync job ───────────────────────────────────────────────────────

/**
 * Run every 1–5 minutes.
 * Compare latest 1m candle in DB vs latest 1m candle from the broker.
 * If drift detected → upsert missing 1m candles or trigger repairDay.
 *
 * ARCHITECTURE NOTE: periodicSync always operates on resolution=1 (1m) because
 * only 1m candles are stored in the DB. The resolution param is accepted for
 * API compatibility but is ignored — sync is always on 1m.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {number} [opts.resolution]  ignored — always syncs 1m in DB
 * @param {Function} opts.fetchCandles
 */
async function periodicSync(opts) {
  const { symbol, fetchCandles } = opts;
  // Always sync 1m — ignore any resolution passed in
  const resolution = DB_RESOLUTION;
  const THREE_MONTHS_AGO = Date.now() - 90 * 86400 * 1000;

  try {
    const brokerCandles = await fetchCandles(symbol, resolution);
    // Only consider 1m candles within the 3-month retention window
    const recentBroker = brokerCandles.filter(c => c.time >= THREE_MONTHS_AGO);
    const { inSync, latestDb, latestBroker, gapMs } = await checkPeriodicSync(symbol, resolution, recentBroker);

    if (inSync) {
      console.log(`[PeriodicSync] ${symbol} res=1 ✓ in sync`);
      return { inSync: true };
    }

    // Out of sync — upsert the missing 1m candles
    console.warn(`[PeriodicSync] ${symbol} res=1 out of sync (gap=${(gapMs/60000).toFixed(1)}min) — recovering`);

    // Find 1m candles that are newer than what we have in DB
    const from = latestDb ? latestDb.time : THREE_MONTHS_AGO;
    const missing = recentBroker.filter(c => c.time > from);

    if (missing.length > 0) {
      const { valid } = validateCandleArray(missing, resolution);
      if (valid) {
        const inserted = await upsertCandles(symbol, resolution, missing);
        console.log(`[PeriodicSync] ${symbol} res=1: inserted ${inserted} missing 1m candles`);
        emit("repair_status", { symbol, resolution, status: "periodic_sync_ok", inserted });
        return { inSync: true, recovered: inserted };
      }
    }

    // Can't auto-recover with missing candles — trigger full day repair (1m only)
    const tradingDay = latestBroker ? new Date(latestBroker.time) : new Date();
    await repairDay({ symbol, resolution, tradingDay, fetchCandles, trigger: "periodic" });
    return { inSync: false, repaired: true };

  } catch (err) {
    console.error(`[PeriodicSync] ${symbol} res=1 error:`, err.message);
    return { inSync: false, error: err.message };
  }
}

module.exports = {
  repairDay,
  fullRefetch,
  periodicSync,
  injectStatusEmitter,
};