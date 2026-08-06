/**
 * database/src/candleStore.js
 *
 * CENTRALIZED SOURCE OF TRUTH — all candle persistence lives here.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ARCHITECTURE RULE — 1m-ONLY DB STORAGE                            ║
 * ║                                                                      ║
 * ║  The database stores ONLY resolution=1 (1-minute) candles.          ║
 * ║  All higher timeframes (3m, 5m, 15m, 1h, 1D, 1W) are derived        ║
 * ║  in-memory from 1m data by CandleBuilder / deriveTimeframe.         ║
 * ║                                                                      ║
 * ║  upsertCandles MUST always be called with resolution=1.             ║
 * ║  loadCandles MUST always be called with resolution=1.               ║
 * ║  Other resolutions passed here will silently store/read nothing     ║
 * ║  useful because no such rows exist in the DB.                       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Rules enforced here (matching architecture diagram):
 *  • Only FINALIZED 1m candles are stored (no forming / live candles).
 *  • Only VALIDATED candles enter the DB.
 *  • Broker-synchronized 1m timeline is maintained.
 *  • The frontend reads candles ONLY from this module (via the API).
 *  • WebSocket never writes here.
 *
 * DRIZZLE NOTE: this module now runs on Drizzle ORM (src/db/client.js +
 * src/db/schema.js) instead of hand-written SQL strings over pg directly.
 * The bulk upsert path (upsertCandleBatch) still builds one batched
 * `INSERT ... VALUES (...),(...) ON CONFLICT DO UPDATE` per 500 rows —
 * same batching rationale as before (PG's 65535 bind-param limit) — it's
 * just expressed through Drizzle's query builder (.values([...]).
 * onConflictDoUpdate(...)) instead of a manually built SQL string, so it
 * stays type-checked and composable while keeping the exact same
 * single-round-trip-per-batch performance characteristics.
 */

const { db } = require("./db/client");
const { candles, validationState, symbolAccessLog } = require("./db/schema");
const { and, eq, gte, lte, lt, sql, desc, asc } = require("drizzle-orm");
const { isValidCandle } = require("./candleValidation");

// ─── Write ─────────────────────────────────────────────────────────────────

// PostgreSQL hard-limits a single query to 65535 bind parameters.
// Each candle uses 8 params → max safe batch = floor(65535/8) = 8191.
// 500 rows (4000 params) leaves plenty of headroom.
const UPSERT_BATCH_SIZE = 500;

/**
 * P3 #14 — shared batch-upsert core. Previously upsertCandles(),
 * replaceDayCandles(), and replaceAllCandles() each had their own
 * independent copy of this exact batching/SQL-building loop. Now all
 * three call this one function.
 *
 * `execDb` is whatever executes the query — either the module-level `db`
 * (plain, un-transacted connection) or a transaction's bound `tx`, so this
 * works identically inside or outside a transaction.
 *
 * @param {typeof db} execDb
 * @param {string} symbol
 * @param {number} resolution
 * @param {Array<{time,open,high,low,close,volume}>} validCandles  already isValidCandle()-filtered
 * @returns {Promise<number>} rows upserted
 */
async function upsertCandleBatch(execDb, symbol, resolution, validCandles) {
  let inserted = 0;

  for (let offset = 0; offset < validCandles.length; offset += UPSERT_BATCH_SIZE) {
    const batch = validCandles.slice(offset, offset + UPSERT_BATCH_SIZE);
    const values = batch.map((c) => ({
      symbol,
      resolution,
      time: new Date(c.time), // epoch ms → timestamptz, same as old to_timestamp($/1000.0)
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    }));

    await execDb
      .insert(candles)
      .values(values)
      .onConflictDoUpdate({
        target: [candles.symbol, candles.resolution, candles.time],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          volume: sql`excluded.volume`,
          validated: true,
          insertedAt: sql`now()`,
        },
      });

    inserted += batch.length;
  }

  return inserted;
}

/**
 * Upsert a batch of finalized, validated 1m candles.
 * Uses INSERT … ON CONFLICT DO UPDATE so re-fetching the same candle
 * is idempotent (broker resync safe).
 *
 * ARCHITECTURE NOTE: Only call this with resolution=1. Higher timeframes
 * (3m, 5m, 15m, 1h, 1D, 1W) are derived in-memory and never persisted.
 *
 * @param {string} symbol
 * @param {number} resolution  must be 1 (1-minute)
 * @param {Array<{time,open,high,low,close,volume}>} candleRows  time in ms (epoch)
 * @returns {Promise<number>}  total rows upserted
 */
async function upsertCandles(symbol, resolution, candleRows) {
  if (!candleRows || candleRows.length === 0) return 0;

  const valid = candleRows.filter(isValidCandle);
  if (valid.length === 0) return 0;

  return upsertCandleBatch(db, symbol, resolution, valid);
}

function dayBounds(tradingDay) {
  const d = new Date(tradingDay);
  const dayStart = new Date(d);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  return { dayStart, dayEnd };
}

/**
 * Delete all candles for a symbol+resolution on a specific trading day (IST).
 * Used by the repair engine before re-fetching clean data.
 *
 * @param {string} symbol
 * @param {number} resolution
 * @param {Date|string} tradingDay  any moment within the trading day (UTC or ISO string)
 */
async function deleteDayCandles(symbol, resolution, tradingDay) {
  // A trading day in IST runs 09:15–15:30. We delete the full UTC day that
  // contains the IST trading session (safe: IST = UTC+5:30).
  const { dayStart, dayEnd } = dayBounds(tradingDay);

  const rows = await db
    .delete(candles)
    .where(
      and(
        eq(candles.symbol, symbol),
        eq(candles.resolution, resolution),
        gte(candles.time, dayStart),
        lt(candles.time, dayEnd)
      )
    )
    .returning({ symbol: candles.symbol });
  return rows.length;
}

/**
 * Atomically replace a single trading day's candles: delete the old day's
 * rows and insert the freshly fetched ones inside ONE database transaction.
 *
 * RACE FIXED: repairDay() previously called deleteDayCandles() and then
 * upsertCandles() as two separate, independently-committed queries. Any
 * client reading via loadCandles() in the window between those two calls
 * would see that trading day as empty/partial — a transient phantom gap.
 * Wrapping both in one Drizzle transaction makes the replacement atomic:
 * readers either see the old day intact or the new day intact, never neither.
 *
 * @param {string} symbol
 * @param {number} resolution
 * @param {Date|string} tradingDay
 * @param {Array<{time,open,high,low,close,volume}>} candleRows  the replacement rows
 * @returns {Promise<{deleted:number, inserted:number}>}
 */
async function replaceDayCandles(symbol, resolution, tradingDay, candleRows) {
  const { dayStart, dayEnd } = dayBounds(tradingDay);
  const valid = (candleRows || []).filter(isValidCandle);

  let deleted = 0;
  let inserted = 0;

  await db.transaction(async (tx) => {
    const delRows = await tx
      .delete(candles)
      .where(
        and(
          eq(candles.symbol, symbol),
          eq(candles.resolution, resolution),
          gte(candles.time, dayStart),
          lt(candles.time, dayEnd)
        )
      )
      .returning({ symbol: candles.symbol });
    deleted = delRows.length;

    if (valid.length === 0) return;

    inserted = await upsertCandleBatch(tx, symbol, resolution, valid);
  });

  return { deleted, inserted };
}

/**
 * Delete ALL candles for a symbol (full refetch / nuke).
 */
async function deleteAllCandles(symbol, resolution = null) {
  const where =
    resolution !== null
      ? and(eq(candles.symbol, symbol), eq(candles.resolution, resolution))
      : eq(candles.symbol, symbol);

  const rows = await db.delete(candles).where(where).returning({ symbol: candles.symbol });
  return rows.length;
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Load candles from the DB.  This is the ONLY source the frontend should use
 * for historical chart data.
 *
 * @param {string} symbol
 * @param {number} resolution  minutes
 * @param {object} opts
 * @param {number} [opts.limit=10000]
 * @param {Date|string} [opts.from]
 * @param {Date|string} [opts.to]
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>}  time in ms
 */
async function loadCandles(symbol, resolution, { limit = 10000, from, to } = {}) {
  const conditions = [eq(candles.symbol, symbol), eq(candles.resolution, resolution)];
  if (from) conditions.push(gte(candles.time, new Date(from)));
  if (to) conditions.push(lte(candles.time, new Date(to)));

  const rows = await db
    .select({
      time: sql`extract(epoch from ${candles.time}) * 1000`.mapWith(Number),
      open: candles.open,
      high: candles.high,
      low: candles.low,
      close: candles.close,
      volume: candles.volume,
    })
    .from(candles)
    .where(and(...conditions))
    .orderBy(asc(candles.time))
    .limit(limit);

  return rows.map((r) => ({
    time: Math.round(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

/**
 * Get the latest (most recent) candle stored for a symbol+resolution.
 * Used by the periodic sync to detect silent drift from broker.
 */
async function getLatestCandle(symbol, resolution) {
  const rows = await db
    .select({
      time: sql`extract(epoch from ${candles.time}) * 1000`.mapWith(Number),
      open: candles.open,
      high: candles.high,
      low: candles.low,
      close: candles.close,
      volume: candles.volume,
    })
    .from(candles)
    .where(and(eq(candles.symbol, symbol), eq(candles.resolution, resolution)))
    .orderBy(desc(candles.time))
    .limit(1);

  if (!rows.length) return null;
  const r = rows[0];
  return {
    time: Math.round(r.time),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  };
}

/**
 * Count candles stored for a symbol+resolution within a date range.
 */
async function countCandles(symbol, resolution, from, to) {
  const rows = await db
    .select({ cnt: sql`count(*)`.mapWith(Number) })
    .from(candles)
    .where(
      and(
        eq(candles.symbol, symbol),
        eq(candles.resolution, resolution),
        gte(candles.time, new Date(from)),
        lte(candles.time, new Date(to))
      )
    );
  return rows[0]?.cnt ?? 0;
}

// ─── Pruning ────────────────────────────────────────────────────────────────

/**
 * Atomically replace a symbol's ENTIRE 1m timeline: delete everything and
 * insert the freshly fetched full history inside ONE database transaction.
 *
 * RACE FIXED: fullRefetch() previously called deleteAllCandles() and then
 * upsertCandles() as two separate, independently-committed queries — same
 * class of bug as the single-day repair race, just symbol-wide. A chart
 * read landing in that window could see the whole symbol as empty during
 * a manual "Full Refetch" click. Wrapped in one Drizzle transaction for the
 * same all-or-nothing guarantee as replaceDayCandles().
 *
 * @param {string} symbol
 * @param {number} resolution
 * @param {Array<{time,open,high,low,close,volume}>} candleRows  the full replacement set
 * @returns {Promise<{deleted:number, inserted:number}>}
 */
async function replaceAllCandles(symbol, resolution, candleRows) {
  const valid = (candleRows || []).filter(isValidCandle);

  let deleted = 0;
  let inserted = 0;

  await db.transaction(async (tx) => {
    const delRows = await tx
      .delete(candles)
      .where(and(eq(candles.symbol, symbol), eq(candles.resolution, resolution)))
      .returning({ symbol: candles.symbol });
    deleted = delRows.length;

    if (valid.length === 0) return;

    inserted = await upsertCandleBatch(tx, symbol, resolution, valid);
  });

  return { deleted, inserted };
}

/**
 * Delete 1m candles older than RETENTION_DAYS (default 90 = 3 months).
 * Called once at startup and optionally on a nightly schedule.
 *
 * ARCHITECTURE NOTE: Only 1m candles are stored in the DB. By default this
 * function prunes only resolution=1 rows. Pass resolution=null only when you
 * need a safety-net sweep (e.g. after a schema change that may have written
 * other resolutions by mistake).
 *
 * @param {string|null} symbol      null = prune ALL symbols
 * @param {number|null} resolution  1 (default) = prune 1m only; null = prune ALL resolutions
 * @param {number} [retentionDays=90]
 * @returns {Promise<number>}  rows deleted
 */
async function pruneOldCandles(symbol = null, resolution = 1, retentionDays = 365) {
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

  const conditions = [lt(candles.time, cutoff)];
  if (symbol !== null) conditions.push(eq(candles.symbol, symbol));
  if (resolution !== null) conditions.push(eq(candles.resolution, resolution));

  const rows = await db.delete(candles).where(and(...conditions)).returning({ symbol: candles.symbol });
  return rows.length;
}

/**
 * Identify a Fyers option/futures ticker and extract its contract expiry,
 * without needing a holiday calendar (see architecture note below).
 *
 * Recognized formats (ticker = symbol with "EXCH:" prefix stripped):
 *   Monthly future : ROOT + YY + MON(3-letter) + "FUT"        e.g. RELIANCE26JUNFUT
 *   Monthly option : ROOT + YY + MON(3-letter) + STRIKE + CE/PE  e.g. NIFTY26JUL24000CE
 *   Weekly option  : ROOT + YY + monthChar(1) + DD + STRIKE + CE/PE  e.g. NIFTY26712000CE
 *                    (Fyers weekly month char: 1-9, O=Oct, N=Nov, D=Dec)
 *
 * Returns null for anything that doesn't match (equities, indices, EQ
 * chains, MCX -I style tickers, malformed symbols) — those are never
 * touched by pruneExpiredContracts().
 *
 * @returns {null | {kind:'monthly', year:number, month:number} | {kind:'weekly', year:number, month:number, day:number}}
 */
const EXPIRY_MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const EXPIRY_WEEKLY_MONTH_CHAR = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];

function extractContractExpiry(fullSymbol) {
  if (!fullSymbol) return null;
  const colonIdx = fullSymbol.indexOf(":");
  const ticker = colonIdx >= 0 ? fullSymbol.slice(colonIdx + 1) : fullSymbol;

  // Monthly future: ...YYMONFUT
  let m = ticker.match(/^[A-Z0-9]+?(\d{2})([A-Z]{3})FUT$/);
  if (m && EXPIRY_MONTH_CODES.includes(m[2])) {
    return { kind: "monthly", year: 2000 + parseInt(m[1], 10), month: EXPIRY_MONTH_CODES.indexOf(m[2]) };
  }

  // Monthly option: ...YYMON<strike>CE/PE
  m = ticker.match(/^[A-Z0-9]+?(\d{2})([A-Z]{3})\d+(?:\.\d+)?(CE|PE)$/);
  if (m && EXPIRY_MONTH_CODES.includes(m[2])) {
    return { kind: "monthly", year: 2000 + parseInt(m[1], 10), month: EXPIRY_MONTH_CODES.indexOf(m[2]) };
  }

  // Weekly option (Fyers date-coded): ...YY<monthChar><DD><strike>CE/PE
  m = ticker.match(/^[A-Z0-9]+?(\d{2})([1-9OND])(\d{2})\d+(?:\.\d+)?(CE|PE)$/);
  if (m) {
    const year = 2000 + parseInt(m[1], 10);
    const month = EXPIRY_WEEKLY_MONTH_CHAR.indexOf(m[2]);
    const day = parseInt(m[3], 10);
    if (month >= 0 && day >= 1 && day <= 31) return { kind: "weekly", year, month, day };
  }

  return null;
}

/**
 * True if a parsed contract is GUARANTEED expired, with zero dependency on
 * an NSE/BSE/MCX holiday calendar. (A holiday calendar now exists —
 * backend/src/data/holidays.js — and is used by symbolsRouter.js and the
 * frontend options-chain display for exact-day expiry calculations. This
 * function intentionally does NOT use it: pruning is safety-critical, so
 * it stays at month/day granularity on purpose — see below.)
 *
 *   monthly — actual expiry always falls ON OR BEFORE the last trading day
 *             of its contract month (holidays can only push it EARLIER in
 *             the month, never into the next month). So once the calendar
 *             has fully rolled past that month, expiry is 100% guaranteed
 *             — no day-of-week / holiday math needed at all.
 *   weekly  — same logic at day granularity: the coded date is the latest
 *             possible expiry (a holiday can only move it to an earlier
 *             trading day), so once that calendar date has passed, expiry
 *             is guaranteed.
 *
 * This trades a little lateness (a contract that actually expired a few
 * days early due to a holiday stays in the DB a few extra days) for zero
 * risk of ever deleting a still-live contract's data.
 */
function isContractExpired(info, now = new Date()) {
  if (!info) return false;
  if (info.kind === "monthly") {
    const nowKey = now.getFullYear() * 12 + now.getMonth();
    const infoKey = info.year * 12 + info.month;
    return infoKey < nowKey;
  }
  if (info.kind === "weekly") {
    const expiryDay = new Date(info.year, info.month, info.day);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return expiryDay < todayStart;
  }
  return false;
}

/**
 * Delete ALL stored 1m candles for option/futures contracts whose expiry
 * has definitely passed (see isContractExpired for the safety rule).
 * Equities, indices, and anything not matching a recognized option/futures
 * ticker format are left completely untouched.
 *
 * Safe to call repeatedly (idempotent) — called once at server startup and
 * again on a periodic sweep so contracts get cleaned up mid-session too,
 * not just after a restart.
 *
 * @returns {Promise<{symbolsPruned:number, candlesDeleted:number, symbols:string[]}>}
 */
async function pruneExpiredContracts(now = new Date()) {
  const rows = await db.selectDistinct({ symbol: candles.symbol }).from(candles);

  let symbolsPruned = 0;
  let candlesDeleted = 0;
  const symbols = [];

  for (const row of rows) {
    const symbol = row.symbol;
    const info = extractContractExpiry(symbol);
    if (!info || !isContractExpired(info, now)) continue;

    const deleted = await deleteAllCandles(symbol);
    if (deleted > 0) {
      symbolsPruned++;
      candlesDeleted += deleted;
      symbols.push(symbol);
    }
  }

  return { symbolsPruned, candlesDeleted, symbols };
}

// ─── Symbol access log ──────────────────────────────────────────────────────
//
// BUG FIX (found while wiring up Drizzle): retentionCleanup.js has always
// imported listSymbols, getSymbolAccessMap, and deleteSymbolAccess from
// this module, but none of the three previously existed here — calling
// runRetentionCleanup() would have thrown immediately. There was also no
// writer for symbol_access_log anywhere in the codebase, so even once
// callable, isOptionStale() would treat every option as "never accessed"
// (immediately stale) since accessMap would always be empty. All four are
// implemented below now, backed by the symbol_access_log table that
// migration 001 already created for exactly this purpose.
//
// recordSymbolAccess() isn't wired into any call site yet — call it from
// wherever a symbol is loaded/viewed (e.g. the options-chain / chart-open
// API route) so the 2-trading-day staleness rule has real data to work from.

/**
 * Record (or bump) the last-accessed timestamp for a symbol.
 * Call this wherever a symbol is loaded/viewed by a client.
 */
async function recordSymbolAccess(symbol) {
  await db
    .insert(symbolAccessLog)
    .values({ symbol, lastAccessed: new Date() })
    .onConflictDoUpdate({
      target: symbolAccessLog.symbol,
      set: { lastAccessed: new Date() },
    });
}

/** Distinct symbols currently stored in the `candles` table. */
async function listSymbols() {
  const rows = await db.selectDistinct({ symbol: candles.symbol }).from(candles);
  return rows.map((r) => r.symbol);
}

/** Map of symbol → last_accessed Date, for every row in symbol_access_log. */
async function getSymbolAccessMap() {
  const rows = await db.select().from(symbolAccessLog);
  const map = new Map();
  for (const r of rows) map.set(r.symbol, r.lastAccessed);
  return map;
}

/** Remove a symbol's row from symbol_access_log (called after its candles are deleted). */
async function deleteSymbolAccess(symbol) {
  const rows = await db
    .delete(symbolAccessLog)
    .where(eq(symbolAccessLog.symbol, symbol))
    .returning({ symbol: symbolAccessLog.symbol });
  return rows.length;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Persist the result of a validation pass to validation_state.
 * This table existed in the schema since the initial migration but nothing
 * ever wrote to it — validateHistorical()/validateCurrentDay() only
 * console.log'd their results, so the table sat permanently empty (found
 * via direct DB inspection: 0 rows despite the validator actively running
 * and finding issues every boot). This closes that gap.
 *
 * @param {string} symbol
 * @param {number} resolution
 * @param {{valid:boolean, issues:Array}} result
 */
async function upsertValidationState(symbol, resolution, { valid, issues }) {
  const status = valid ? "ok" : "issues_found";
  const issueSummary =
    issues && issues.length > 0
      ? issues.slice(0, 5).map((i) => i.type || i.message || String(i)).join("; ")
      : null;

  await db
    .insert(validationState)
    .values({
      symbol,
      resolution,
      lastChecked: new Date(),
      lastOk: valid ? new Date() : null,
      status,
      issue: issueSummary,
    })
    .onConflictDoUpdate({
      target: [validationState.symbol, validationState.resolution],
      set: {
        lastChecked: new Date(),
        lastOk: valid ? new Date() : sql`${validationState.lastOk}`,
        status,
        issue: issueSummary,
      },
    });
}

// P3 #12 — isValidCandle() now lives in ./candleValidation.js (single
// source of truth, also used by derivativesStore.js). Still re-exported
// below from this module for backward compatibility with existing callers.

module.exports = {
  upsertCandles,
  deleteDayCandles,
  replaceDayCandles,
  replaceAllCandles,
  deleteAllCandles,
  pruneOldCandles,
  pruneExpiredContracts,
  extractContractExpiry,
  isContractExpired,
  loadCandles,
  getLatestCandle,
  countCandles,
  isValidCandle,
  upsertValidationState,
  // symbol_access_log (see "Symbol access log" section above)
  recordSymbolAccess,
  listSymbols,
  getSymbolAccessMap,
  deleteSymbolAccess,
};