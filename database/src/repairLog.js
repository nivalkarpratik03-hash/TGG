/**
 * database/src/repairLog.js
 *
 * Audit trail for all repair / refetch operations.
 * Non-critical — errors here are swallowed so they never block a repair.
 */

const { query } = require("./pool");

/**
 * Insert a new repair_log entry and return its id.
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {number} [opts.resolution]
 * @param {string} opts.trigger
 * @param {Date|string|number} [opts.tradingDay]  which IST trading day this repair targets (omit for symbol-wide ops)
 */
async function logRepairStart({ symbol, resolution, trigger, tradingDay = null }) {
  try {
    const rows = await query(
      `INSERT INTO repair_log (symbol, resolution, trigger, status, trading_day)
       VALUES ($1, $2, $3, 'running', $4)
       RETURNING id`,
      [symbol, resolution ?? null, trigger, tradingDay ? new Date(tradingDay).toISOString() : null]
    );
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
    await query(
      `UPDATE repair_log
       SET finished_at = NOW(),
           status = $2,
           detail = $3,
           candles_deleted  = $4,
           candles_inserted = $5
       WHERE id = $1`,
      [id, status, detail ?? null, deleted, inserted]
    );
  } catch (err) {
    console.warn("[RepairLog] logRepairFinish error:", err.message);
  }
}

/**
 * Count failed repair attempts for a specific symbol + trading day within
 * the last `withinHours`. Used by repairDay() to back off from a day that
 * keeps failing (or keeps "succeeding" but re-flagging as an outlier every
 * cycle — refetching the same real broker data can never fix a genuine
 * price move that just happens to look like an isolated spike) instead of
 * re-attempting it every single validator pass, every 10 minutes, forever.
 *
 * @param {string} symbol
 * @param {Date|string|number} tradingDay
 * @param {number} [withinHours=3]
 * @returns {Promise<number>}
 */
async function getRecentFailureCount(symbol, tradingDay, withinHours = 3) {
  try {
    const dayIso = new Date(tradingDay).toISOString().slice(0, 10);
    const rows = await query(
      `SELECT COUNT(*) AS cnt FROM repair_log
       WHERE symbol = $1
         AND trading_day IS NOT NULL
         AND trading_day::date = $2::date
         AND started_at >= NOW() - ($3 || ' hours')::interval
         AND status = 'error'`,
      [symbol, dayIso, withinHours]
    );
    return parseInt(rows[0]?.cnt || "0", 10);
  } catch (err) {
    console.warn("[RepairLog] getRecentFailureCount error:", err.message);
    return 0; // fail open — never let a logging error block a legitimate repair
  }
}

/**
 * Fetch the most recent repair entries for a symbol.
 */
async function getRepairHistory(symbol, limit = 20) {
  try {
    return await query(
      `SELECT * FROM repair_log
       WHERE symbol = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [symbol, limit]
    );
  } catch (err) {
    console.warn("[RepairLog] getRepairHistory error:", err.message);
    return [];
  }
}

module.exports = { logRepairStart, logRepairFinish, getRepairHistory, getRecentFailureCount };