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
const { upsertCandles, replaceDayCandles, loadCandles } = require("../store/dataRouter");
const { validateCandleArray, checkPeriodicSync, summarizeGaps, istDateKey, findZeroVolumeDays, VOLUME_HISTORY_DAYS } = require("./validationEngine");
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

const DAY_MS = 86400 * 1000;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** UTC-ms of 00:00 IST for an IST date key "YYYY-MM-DD". */
function istDayStartMs(dayKey) {
  return Date.parse(`${dayKey}T00:00:00+05:30`);
}

/**
 * How many days back a broker fetch must reach to include `earliestMs`.
 * +2 days of padding for timezone-boundary safety. Min 3.
 * (The 2026-06-29 "targeted window" change documented in changes-log.txt
 * was not present in the code — repairDay always fetched the 30-day default.
 * This restores the intent using client.js's existing 4th parameter,
 * lookbackDaysOverride, so no client.js change is needed.)
 */
function lookbackDaysFor(earliestMs) {
  return Math.max(3, Math.ceil((Date.now() - earliestMs) / DAY_MS) + 2);
}


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
      // Targeted window: reach back only as far as the day being repaired.
      // 4th arg = lookbackDaysOverride in client.js's fetchCandles(). Callers'
      // closures that drop extra args fall back to the 30-day default, which
      // is still safe because of the guards below.
      const dayStartUtc = new Date(tradingDay); dayStartUtc.setUTCHours(0, 0, 0, 0);
      const fresh = await fetchCandles(symbol, resolution, undefined, lookbackDaysFor(dayStartUtc.getTime()));
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

      // Step 2b — NEVER-WIPE GUARDS (2026-10-02).
      // replaceDayCandles() deletes the whole UTC day, then inserts whatever
      // was fetched. If the fetched window does not actually contain that
      // day (e.g. the day is older than the fetch lookback — the validator
      // targets the OLDEST flagged day in a 90-day window, the fetch only
      // reached 30 days) the day was deleted and never restored: a silent
      // full-day hole that the validator then cannot even see (a missing
      // whole day looks like a normal overnight gap). Also refuse to replace
      // a day with a SHORTER broker day than what we already hold.
      const dStart = new Date(tradingDay); dStart.setUTCHours(0, 0, 0, 0);
      const dEnd = new Date(dStart.getTime() + DAY_MS);
      const freshOnDay = fresh.filter((c) => c.time >= dStart.getTime() && c.time < dEnd.getTime());
      const existingOnDay = await loadCandles(symbol, resolution, { from: dStart, to: new Date(dEnd.getTime() - 1), limit: 5000 }).catch(() => []);
      if (freshOnDay.length === 0 || freshOnDay.length < existingOnDay.length) {
        const why = freshOnDay.length === 0
          ? "broker response does not contain the target day"
          : `broker day has fewer candles (${freshOnDay.length}) than DB (${existingOnDay.length})`;
        console.warn(`[Recovery] ${symbol} ${dStart.toISOString().slice(0, 10)}: ${why} — NOT deleting; adding any missing candles only`);
        const have = new Set(existingOnDay.map((c) => c.time));
        const additive = freshOnDay.filter((c) => !have.has(c.time));
        const added = additive.length ? await upsertCandles(symbol, resolution, additive) : 0;
        emit("repair_status", { symbol, resolution, status: "ok", inserted: added, deleted: 0 });
        if (added > 0) emit("history_updated", { symbol, resolution, reason: "repair", inserted: added });
        await logRepairFinish(logId, { status: "ok", deleted: 0, inserted: added, detail: why }).catch(() => null);
        return { success: true, inserted: added, deleted: 0, additiveOnly: true };
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

// ─── Additive gap fill (2026-10-02) ───────────────────────────────────────────
/**
 * Fill missing 1m candles on specific IST days from the broker — PURELY
 * ADDITIVE: it never deletes anything and only inserts minutes the DB does
 * not already have. This is what Refresh and the scheduled validator use
 * for GAP issues. (repairDay's delete-and-replace stays for corrupt rows
 * only; it was the wrong tool for "a few minutes are missing" because any
 * partial/short broker response turned a small hole into a bigger one.)
 *
 * One broker call covers all requested days (lookback reaches back to the
 * earliest one). Afterwards the days are re-validated from the DB and the
 * result says which days are STILL gappy — i.e. the broker itself has no
 * data for those minutes. Every day gets a repair_log row with
 * status "ok" either way, so wasDayAlreadyRepaired() can stop a
 * broker-side hole from being re-fetched on every pass — per DAY, so it can
 * no longer shadow other days.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string[]} opts.days    IST date keys "YYYY-MM-DD"
 * @param {Function} opts.fetchCandles  (symbol, resolution, count, lookbackDays) => candle[]
 * @param {string} [opts.trigger]
 * @returns {Promise<{success, inserted, brokerCandles, fixedDays, remainingDays, error?}>}
 */
async function fillGapDays(opts) {
  const { symbol, fetchCandles, trigger = "gapfill" } = opts;
  const days = [...new Set(opts.days || [])].sort();
  const resolution = DB_RESOLUTION;
  const key = `${symbol}:${resolution}`;
  if (days.length === 0) return { success: true, inserted: 0, brokerCandles: 0, fixedDays: [], remainingDays: [] };

  if (activeRepairs.has(key)) {
    console.log(`[Recovery] Repair already active for ${key} — skipping gap fill`);
    return { skipped: true };
  }

  return enqueueRepair(symbol, async () => {
    activeRepairs.add(key);
    emit("repair_status", { symbol, resolution, status: "starting", trigger });
    const logIds = [];
    for (const d of days) {
      logIds.push(await logRepairStart({ symbol, resolution, trigger, tradingDay: new Date(`${d}T12:00:00+05:30`) }).catch(() => null));
    }
    const finishAll = (fn) => Promise.all(logIds.map((id, i) => logRepairFinish(id, fn(days[i])).catch(() => null)));

    try {
      const earliestMs = istDayStartMs(days[0]);
      const fresh = await fetchCandles(symbol, resolution, undefined, lookbackDaysFor(earliestMs));
      emit("repair_status", { symbol, resolution, status: "fetched", count: fresh ? fresh.length : 0 });
      if (!fresh || fresh.length === 0) {
        const errMsg = "Broker returned no candles — nothing changed";
        console.error(`[Recovery] ${symbol} gap fill: ${errMsg}`);
        emit("repair_status", { symbol, resolution, status: "error", error: errMsg });
        await finishAll(() => ({ status: "error", detail: errMsg }));
        return { success: false, error: errMsg, inserted: 0, brokerCandles: 0, fixedDays: [], remainingDays: days };
      }

      const wanted = new Set(days);
      const brokerOnDays = fresh.filter((c) => wanted.has(istDateKey(c.time)));

      // What does the DB already hold over the affected span?
      const existing = await loadCandles(symbol, resolution, {
        from: new Date(earliestMs), to: new Date(), limit: 100000,
      });
      const have = new Set(existing.map((c) => c.time));
      const missingFromDb = brokerOnDays.filter((c) => !have.has(c.time));

      const inserted = missingFromDb.length ? await upsertCandles(symbol, resolution, missingFromDb) : 0;
      console.log(`[Recovery] ${symbol} gap fill: broker had ${brokerOnDays.length} candle(s) on ${days.join(", ")}, DB was missing ${missingFromDb.length}, inserted ${inserted}`);

      // Re-validate from the DB and report what the broker could NOT supply.
      const after = await loadCandles(symbol, resolution, { from: new Date(earliestMs), to: new Date(), limit: 100000 });
      const stillGappy = new Set(summarizeGaps(validateCandleArray(after, resolution).issues).map((g) => g.day));
      // A requested day that still has NO candles (broker has nothing for it)
      // is not visible to validateCandleArray — count it as remaining too.
      const daysWithData = new Set(after.map((c) => istDateKey(c.time)));
      for (const d of days) if (!daysWithData.has(d)) stillGappy.add(d);
      const remainingDays = days.filter((d) => stillGappy.has(d));
      const fixedDays = days.filter((d) => !stillGappy.has(d));

      // Status matters: wasDayAlreadyRepaired() only matches status "ok", and
      // that is deliberately the SUPPRESSION marker — it must be written only
      // for days that are STILL gappy after the broker fetch (the broker has
      // no data for them, so re-fetching every pass is pointless). A day that
      // was fully fixed gets "filled" instead, so that if a NEW hole appears
      // on that same day later (a live tick stall in the afternoon), the next
      // pass is not blocked by this morning's successful fill.
      await finishAll((d) => (stillGappy.has(d)
        ? { status: "ok", inserted: 0, detail: "gap fill: broker has no data for the remaining missing minutes" }
        : { status: "filled", inserted: 0, detail: `gap fill: ${inserted} candle(s) added across ${days.length} day(s)` }));
      emit("repair_status", { symbol, resolution, status: "ok", inserted, deleted: 0 });
      if (inserted > 0) emit("history_updated", { symbol, resolution, reason: "gap_fill", inserted });
      return { success: true, inserted, brokerCandles: brokerOnDays.length, fixedDays, remainingDays };
    } catch (err) {
      emit("repair_status", { symbol, resolution, status: "error", error: err.message });
      await finishAll(() => ({ status: "error", detail: err.message }));
      throw err;
    } finally {
      activeRepairs.delete(key);
    }
  });
}

// ─── Volume heal (2026-10-07) ─────────────────────────────────────────────────
/**
 * PURE: which broker candles should be written to fix volume in the DB?
 *
 * A broker candle is written when it has real volume (> 0) and the DB either
 * has no row for that minute, a zero/NULL volume, or a SMALLER volume (a
 * partial "forming minute" print that was stored before the minute closed).
 * Broker candles with zero volume are never written (nothing to learn), and
 * the still-forming minute is skipped entirely.
 *
 * @param {Array} brokerCandles  1m candles from Fyers REST
 * @param {Array} dbCandles      1m candles currently in the DB for the same span
 * @param {object} [o]
 * @param {Set<string>} [o.days]  restrict to these IST day keys
 * @param {number} [o.nowMs]
 */
function computeVolumeUpdates(brokerCandles, dbCandles, { days = null, nowMs = Date.now() } = {}) {
  const dbByTime = new Map();
  for (const c of dbCandles || []) dbByTime.set(c.time, Number(c.volume) || 0);
  const oldest = nowMs - VOLUME_HISTORY_DAYS * DAY_MS;
  const out = [];
  for (const b of brokerCandles || []) {
    if (!b || b.time < oldest) continue;
    if (b.time + 60000 > nowMs) continue;                    // minute still forming
    if (days && !days.has(istDateKey(b.time))) continue;
    const bv = Number(b.volume);
    if (!Number.isFinite(bv) || bv <= 0) continue;
    const dv = dbByTime.get(b.time);
    if (dv === undefined || dv <= 0 || dv < bv) out.push(b);
  }
  return out;
}

/**
 * Fill volume for specific IST days from the broker. Writes only candles
 * computeVolumeUpdates() selects (real broker volume replaces 0 / partial
 * volume; the broker row's OHLC comes with it, same as any repair). Never
 * deletes. Days older than the broker's volume horizon are dropped.
 *
 * Days that are STILL zero afterwards (the broker itself has no volume for
 * those minutes, e.g. flat pre-close minutes on an index) get a repair_log
 * row with status "ok" and trigger "volume_heal" — the suppression marker
 * read by wasVolumeHealAttempted() — everything else gets "filled".
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string[]} opts.days   IST keys "YYYY-MM-DD"
 * @param {Function} opts.fetchCandles  (symbol, resolution, count, lookbackDays) => candle[]
 * @param {string} [opts.trigger]
 * @returns {Promise<{success, updated, remainingDays, fixedDays, skippedOld, error?}>}
 */
async function healVolumeDays(opts) {
  const { symbol, fetchCandles, trigger = "volume_heal" } = opts;
  const resolution = DB_RESOLUTION;
  const horizon = istDateKey(Date.now() - VOLUME_HISTORY_DAYS * DAY_MS);
  const all = [...new Set(opts.days || [])].sort();
  const days = all.filter((d) => d >= horizon);
  const skippedOld = all.filter((d) => d < horizon);
  if (days.length === 0) return { success: true, updated: 0, fixedDays: [], remainingDays: [], skippedOld };

  const key = `${symbol}:${resolution}`;
  if (activeRepairs.has(key)) {
    console.log(`[Recovery] Repair already active for ${key} — skipping volume heal`);
    return { skipped: true };
  }

  return enqueueRepair(symbol, async () => {
    activeRepairs.add(key);
    const logIds = [];
    for (const d of days) {
      logIds.push(await logRepairStart({ symbol, resolution, trigger, tradingDay: new Date(`${d}T12:00:00+05:30`) }).catch(() => null));
    }
    const finishAll = (fn) => Promise.all(logIds.map((id, i) => logRepairFinish(id, fn(days[i])).catch(() => null)));
    try {
      const earliestMs = istDayStartMs(days[0]);
      const fresh = await fetchCandles(symbol, resolution, undefined, lookbackDaysFor(earliestMs));
      if (!fresh || fresh.length === 0) {
        const errMsg = "Broker returned no candles — volume left as is";
        console.error(`[Recovery] ${symbol} volume heal: ${errMsg}`);
        await finishAll(() => ({ status: "error", detail: errMsg }));
        return { success: false, error: errMsg, updated: 0, fixedDays: [], remainingDays: days, skippedOld };
      }

      const wanted = new Set(days);
      const existing = await loadCandles(symbol, resolution, { from: new Date(earliestMs), to: new Date(), limit: 100000 });
      const brokerOnDays = fresh.filter((c) => wanted.has(istDateKey(c.time)));
      const withVolume = brokerOnDays.filter((c) => Number(c.volume) > 0).length;
      const updates = computeVolumeUpdates(fresh, existing, { days: wanted });
      const zeroBefore = findZeroVolumeDays(symbol, existing.filter((c) => wanted.has(istDateKey(c.time))));
      const zeroRowsBefore = zeroBefore.reduce((a, z) => a + z.count, 0);
      const updated = updates.length ? await upsertCandles(symbol, resolution, updates) : 0;

      const after = await loadCandles(symbol, resolution, { from: new Date(earliestMs), to: new Date(), limit: 100000 });
      const stillZero = new Set(findZeroVolumeDays(symbol, after.filter((c) => wanted.has(istDateKey(c.time)))).map((z) => z.day));
      const remainingDays = days.filter((d) => stillZero.has(d));
      const fixedDays = days.filter((d) => !stillZero.has(d));
      console.log(
        `[Recovery] ${symbol} volume heal: broker had ${brokerOnDays.length} candle(s) on ${days.join(", ")}, ${withVolume} with volume, ` +
        `DB had ${zeroRowsBefore} zero-volume row(s), updated ${updated}` +
        (remainingDays.length ? ` — broker has no volume for the rest on ${remainingDays.join(", ")}` : "")
      );

      await finishAll((d) => (stillZero.has(d)
        ? { status: "ok", inserted: 0, detail: "volume heal: broker has no volume for the remaining zero-volume minutes" }
        : { status: "filled", inserted: 0, detail: `volume heal: ${updated} candle(s) updated across ${days.length} day(s)` }));
      if (updated > 0) emit("history_updated", { symbol, resolution, reason: "volume_heal", inserted: updated });
      return { success: true, updated, fixedDays, remainingDays, skippedOld };
    } catch (err) {
      await finishAll(() => ({ status: "error", detail: err.message }));
      throw err;
    } finally {
      activeRepairs.delete(key);
    }
  });
}

/**
 * Zero-cost volume top-up used by periodicSync: it already holds a fresh
 * broker pull, so compare the last couple of trading days against the DB and
 * write real volume where the DB has 0 / a partial print. Never throws.
 */
async function syncRecentVolumes(symbol, brokerCandles) {
  try {
    const nowMs = Date.now();
    const sinceMs = istDayStartMs(istDateKey(nowMs - 3 * DAY_MS));
    const recent = (brokerCandles || []).filter((c) => c.time >= sinceMs);
    if (recent.length === 0) return 0;
    const existing = await loadCandles(symbol, DB_RESOLUTION, { from: new Date(sinceMs), to: new Date(nowMs), limit: 20000 });
    const updates = computeVolumeUpdates(recent, existing, { nowMs });
    if (updates.length === 0) return 0;
    const n = await upsertCandles(symbol, DB_RESOLUTION, updates);
    console.log(`[PeriodicSync] ${symbol}: volume top-up wrote ${n} candle(s) from the broker pull`);
    emit("history_updated", { symbol, resolution: DB_RESOLUTION, reason: "volume_sync", inserted: n });
    return n;
  } catch (err) {
    console.warn(`[PeriodicSync] ${symbol}: volume top-up failed (${err.message}) — ignored`);
    return 0;
  }
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
    // Free volume top-up from the pull we already paid for (live-built rows have 0).
    await syncRecentVolumes(symbol, recentBroker);
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
  fillGapDays,
  healVolumeDays,
  computeVolumeUpdates,
  periodicSync,
  injectStatusEmitter,
  // Exposed for tests / diagnostics only — not used by server.js.
  _deadLetter: { isDeadLettered, recordSyncSuccess, recordSyncFailure, syncFailures },
};