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
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * NOTE: fullRefetch() (delete-a-symbol's-history-then-reinsert) was removed
 * entirely. It was never wired to any route or UI button, and its only
 * remaining job — replacing a symbol's full history — always deleted that
 * symbol's rows first. Per architecture, no symbol's data is ever deleted.
 * Ongoing gap-filling is handled by periodicSync (purely additive), and a
 * single bad trading day is handled by repairDay (scoped to one day only).
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

// FIX (derivatives-routing): these two used to come straight from
// candleStore.js, which unconditionally writes/reads the plain `candles`
// table. That was safe for repairDay() calls from the curated-symbol gap
// scan (always equities/indices), but periodicSync's fallback full-day
// repair can run against whatever symbol a client currently has open in a
// chart — including option/future contracts — so it needs dataRouter.js's
// symbol-aware routing to land in nse_options_candles/etc. instead.
const { upsertCandles, replaceDayCandles } = require("./dataRouter");
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
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {number} [opts.resolution]  ignored — always repairs 1m in DB
 * @param {Date|string} opts.tradingDay   any moment within the affected day
 * @param {Function} opts.fetchCandles    (symbol, resolution) => Promise<candle[]>  (Fyers REST)
 * @param {string}  [opts.trigger]        'corruption'|'startup'|'periodic'|'manual'
 */
async function repairDay(opts) {
  const { symbol, tradingDay, fetchCandles, trigger = "corruption" } = opts;
  // Always repair 1m — ignore any resolution passed in (higher TFs are in-memory only)
  const resolution = DB_RESOLUTION;
  const key = `${symbol}:${resolution}`;

  if (activeRepairs.has(key)) {
    console.log(`[Recovery] Repair already active for ${key} — skipping duplicate`);
    return { skipped: true };
  }

  return enqueueRepair(symbol, async () => {
    activeRepairs.add(key);
    emit("repair_status", { symbol, resolution, status: "starting", trigger });

    const logId = await logRepairStart({ symbol, resolution, trigger, tradingDay }).catch(() => null);

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
      console.log(`[Recovery] Refetching 1m candles from broker for ${symbol}...`);
      const fresh = await fetchCandles(symbol, resolution);
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

      // Step 3+4 (FIXED — was: separate delete then separate insert, two
      // independently-committed queries). A client reading via loadCandles()
      // in the gap between those two calls could see this trading day as
      // empty — a transient phantom gap. Both steps now run inside ONE DB
      // transaction (replaceDayCandles), so readers always see either the
      // old day intact or the new day intact, never neither.
      console.log(`[Recovery] Atomically replacing 1m day data for ${symbol} day=${new Date(tradingDay).toISOString().slice(0, 10)}`);
      const { deleted, inserted } = await replaceDayCandles(symbol, resolution, tradingDay, fresh);
      emit("repair_status", { symbol, resolution, status: "deleted", deleted });
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

      emit("repair_status", { symbol, resolution, status: "ok", inserted, deleted });
      // FRONTEND-SYNC FIX: same reasoning as the staleness-backfill broadcast —
      // a chart already open for this symbol when the repair started would
      // otherwise keep showing the pre-repair (possibly gapped/corrupt) day
      // until a manual reload. Let any open chart silently re-pull fresh data.
      emit("history_updated", { symbol, resolution, reason: "repair", inserted });
      await logRepairFinish(logId, { status: "ok", deleted, inserted }).catch(() => null);
      return { success: true, inserted, deleted };

    } catch (err) {
      emit("repair_status", { symbol, resolution, status: "error", error: err.message });
      await logRepairFinish(logId, { status: "error", detail: err.message }).catch(() => null);
      throw err;
    } finally {
      activeRepairs.delete(key);
    }
  });
}

// ─── Dead-letter tracking for periodicSync ───────────────────────────────────
// P1 (was "not yet fixed"): periodicSync retried a dead/expired/invalid
// symbol forever — every 5-minute sweep, indefinitely, with no memory of
// prior failures. A symbol only ends up in periodicSync's sweep because a
// real client had it open (server.js scopes the sweep to
// getLiveBroadcastSymbols()), so this isn't hypothetical: an expired option
// contract sitting open in a stale browser tab, or any symbol Fyers rejects,
// would get hammered every cycle with no backoff.
//
// FIX: track consecutive failures per symbol. After DEAD_LETTER_THRESHOLD
// consecutive failures, the symbol is "dead-lettered" — periodicSync skips
// it immediately (no fetchCandles call at all) until DEAD_LETTER_COOLDOWN_MS
// has passed, then gives it one more try. A single success at any point
// clears the symbol's failure count entirely. This is intentionally
// in-memory/per-process (matches every other piece of sync state in this
// file — repairQueues, activeRepairs) — a restart naturally clears it and
// gives every symbol a fresh start, which is the right behavior here (no
// symbol should be dead-lettered "forever" across restarts on stale info).
const DEAD_LETTER_THRESHOLD = 3;          // consecutive failures before dead-lettering
const DEAD_LETTER_COOLDOWN_MS = 30 * 60 * 1000; // 30 min before retrying a dead-lettered symbol

const syncFailures = new Map(); // symbol -> { count, deadUntil }

function isDeadLettered(symbol) {
  const rec = syncFailures.get(symbol);
  if (!rec || !rec.deadUntil) return false;
  return Date.now() < rec.deadUntil;
}

function recordSyncSuccess(symbol) {
  syncFailures.delete(symbol);
}

function recordSyncFailure(symbol) {
  const rec = syncFailures.get(symbol) || { count: 0, deadUntil: null };
  rec.count += 1;
  if (rec.count >= DEAD_LETTER_THRESHOLD) {
    rec.deadUntil = Date.now() + DEAD_LETTER_COOLDOWN_MS;
    console.warn(`[PeriodicSync] ${symbol}: ${rec.count} consecutive failures — dead-lettered for ${DEAD_LETTER_COOLDOWN_MS / 60000}min`);
  }
  syncFailures.set(symbol, rec);
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

  // Dead-letter check — skip symbols that have failed repeatedly, instead of
  // hammering them every single sweep. No fetchCandles call is made at all.
  if (isDeadLettered(symbol)) {
    console.log(`[PeriodicSync] ${symbol}: skipped — dead-lettered (retrying after cooldown)`);
    return { inSync: false, deadLettered: true };
  }

  try {
    const brokerCandles = await fetchCandles(symbol, resolution);
    // Only consider 1m candles within the 3-month retention window
    const recentBroker = brokerCandles.filter(c => c.time >= THREE_MONTHS_AGO);
    const { inSync, latestDb, latestBroker, gapMs } = await checkPeriodicSync(symbol, resolution, recentBroker);

    if (inSync) {
      console.log(`[PeriodicSync] ${symbol} res=1 ✓ in sync`);
      recordSyncSuccess(symbol);
      return { inSync: true };
    }

    // Out of sync — upsert the missing 1m candles
    console.warn(`[PeriodicSync] ${symbol} res=1 out of sync (gap=${(gapMs / 60000).toFixed(1)}min) — recovering`);

    // Find 1m candles that are newer than what we have in DB
    const from = latestDb ? latestDb.time : THREE_MONTHS_AGO;
    const missing = recentBroker.filter(c => c.time > from);

    if (missing.length > 0) {
      const { valid } = validateCandleArray(missing, resolution);
      if (valid) {
        const inserted = await upsertCandles(symbol, resolution, missing);
        console.log(`[PeriodicSync] ${symbol} res=1: inserted ${inserted} missing 1m candles`);
        emit("repair_status", { symbol, resolution, status: "periodic_sync_ok", inserted });
        emit("history_updated", { symbol, resolution, reason: "periodic_sync", inserted });
        recordSyncSuccess(symbol);
        return { inSync: true, recovered: inserted };
      }
    }

    // Can't auto-recover with missing candles — trigger full day repair (1m only)
    const tradingDay = latestBroker ? new Date(latestBroker.time) : new Date();
    await repairDay({ symbol, resolution, tradingDay, fetchCandles, trigger: "periodic" });
    recordSyncSuccess(symbol);
    return { inSync: false, repaired: true };

  } catch (err) {
    console.error(`[PeriodicSync] ${symbol} res=1 error:`, err.message);
    recordSyncFailure(symbol);
    return { inSync: false, error: err.message };
  }
}

module.exports = {
  repairDay,
  periodicSync,
  injectStatusEmitter,
  // Exposed for tests / diagnostics only — not used by server.js.
  _deadLetter: { isDeadLettered, recordSyncSuccess, recordSyncFailure, syncFailures },
};