/**
 * database/src/repairLog.js
 *
 * Audit trail for all repair / refetch operations.
 * Non-critical — errors here are swallowed so they never block a repair.
 *
 * CHANGED: logRepairStart now accepts an optional `tradingDay` and stores
 * it in the repair_log.trading_day column (migration 002). This adds
 * a new helper, wasDayAlreadyRepaired(), used by the startup gap scan to
 * stop re-repairing the exact same symbol+day on every single restart —
 * fixes the NSE:NIFTY50-INDEX-style infinite repeat-repair loop.
 *
 * Backward compatible: tradingDay is optional everywhere. Existing callers
 * that don't pass it keep working exactly as before (column stores NULL).
 *
 * Runs on Drizzle ORM now (see src/db/client.js, src/db/schema.js).
 */

const { db } = require("./db/client");
const { repairLog } = require("./db/schema");
const { and, eq, gt, sql, desc } = require("drizzle-orm");

/**
 * Insert a new repair_log entry and return its id.
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {number} [opts.resolution]
 * @param {string} opts.trigger
 * @param {Date|string} [opts.tradingDay]  the trading day being repaired (optional)
 */
async function logRepairStart({ symbol, resolution, trigger, tradingDay = null }) {
  try {
    const dayStr = tradingDay ? new Date(tradingDay).toISOString().slice(0, 10) : null;
    const rows = await db
      .insert(repairLog)
      .values({
        symbol,
        resolution: resolution ?? null,
        trigger,
        status: "running",
        tradingDay: dayStr,
      })
      .returning({ id: repairLog.id });
    return rows[0]?.id ?? null;
  } catch (err) {
    console.warn("[RepairLog] logRepairStart error:", err.message);
    return null;
  }
}

/**
 * Update an existing repair_log row with the outcome.
 */
async function logRepairFinish(id, { status, detail, deleted = 0, inserted = 0 }) {
  if (!id) return;
  try {
    await db
      .update(repairLog)
      .set({
        finishedAt: new Date(),
        status,
        detail: detail ?? null,
        candlesDeleted: deleted,
        candlesInserted: inserted,
      })
      .where(eq(repairLog.id, id));
  } catch (err) {
    console.warn("[RepairLog] logRepairFinish error:", err.message);
  }
}

/**
 * Fetch the most recent repair entries for a symbol.
 */
async function getRepairHistory(symbol, limit = 20) {
  try {
    return await db
      .select()
      .from(repairLog)
      .where(eq(repairLog.symbol, symbol))
      .orderBy(desc(repairLog.startedAt))
      .limit(limit);
  } catch (err) {
    console.warn("[RepairLog] getRepairHistory error:", err.message);
    return [];
  }
}

/**
 * wasDayAlreadyRepaired — circuit breaker for the repeat-repair loop.
 *
 * Returns true if this exact symbol+trading_day already had a SUCCESSFUL
 * ("ok") repair logged within the last `withinDays` days. If so, the caller
 * should skip re-repairing it — a day that keeps getting flagged again
 * right after a successful repair almost always means the underlying
 * broker data for that day is genuinely short/incomplete (e.g. thin
 * end-of-session volume), not a bug that another refetch will fix.
 *
 * Deliberately time-boxed (not "forever") so that if the broker backfills
 * better data later, or this really was a transient issue, the symbol
 * becomes eligible for repair again after the window passes.
 *
 * @param {string} symbol
 * @param {Date|string} tradingDay
 * @param {number} [withinDays=3]
 * @returns {Promise<boolean>}
 */
async function wasDayAlreadyRepaired(symbol, tradingDay, withinDays = 3) {
  try {
    const dayStr = new Date(tradingDay).toISOString().slice(0, 10);
    const rows = await db
      .select({ id: repairLog.id })
      .from(repairLog)
      .where(
        and(
          eq(repairLog.symbol, symbol),
          eq(repairLog.tradingDay, dayStr),
          eq(repairLog.status, "ok"),
          gt(repairLog.startedAt, sql`now() - (${withinDays} || ' days')::interval`)
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    console.warn("[RepairLog] wasDayAlreadyRepaired error:", err.message);
    return false; // fail open — never block a real repair just because this check errored
  }
}

module.exports = { logRepairStart, logRepairFinish, getRepairHistory, wasDayAlreadyRepaired };