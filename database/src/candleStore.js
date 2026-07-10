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
 */

const { query, transaction } = require("./pool");
const { isValidCandle } = require("./candleValidation");

// ─── Write ─────────────────────────────────────────────────────────────────

// PostgreSQL hard-limits a single query to 65535 bind parameters.
// Each candle uses 8 params → max safe batch = floor(65535/8) = 8191.
// 500 rows (4000 params) leaves plenty of headroom.
const UPSERT_BATCH_SIZE = 500;
const UPSERT_SQL_SUFFIX = `
  ON CONFLICT (symbol, resolution, time) DO UPDATE SET
    open        = EXCLUDED.open,
    high        = EXCLUDED.high,
    low         = EXCLUDED.low,
    close       = EXCLUDED.close,
    volume      = EXCLUDED.volume,
    validated   = TRUE,
    inserted_at = NOW()
`;

/**
 * P3 #14 — shared batch-upsert core. Previously upsertCandles(),
 * replaceDayCandles(), and replaceAllCandles() each had their own
 * independent copy of this exact batching/SQL-building loop. Now all
 * three call this one function.
 *
 * `exec` is whatever executes the query — either the module-level query()
 * (plain, un-transacted connection) or a transaction client's bound
 * `client.query`, so this works identically inside or outside a transaction.
 * Only requirement: `exec(sql, params)` — the return value isn't used here,
 * each caller already tracks its own row counts via batch.length.
 *
 * @param {(sql: string, params: any[]) => Promise<any>} exec
 * @param {string} symbol
 * @param {number} resolution
 * @param {Array<{time,open,high,low,close,volume}>} validCandles  already isValidCandle()-filtered
 * @returns {Promise<number>} rows upserted
 */
async function upsertCandleBatch(exec, symbol, resolution, validCandles) {
  let inserted = 0;

  for (let offset = 0; offset < validCandles.length; offset += UPSERT_BATCH_SIZE) {
    const batch = validCandles.slice(offset, offset + UPSERT_BATCH_SIZE);
    const values = [];
    const params = [];
    let p = 1;

    for (const c of batch) {
      values.push(`($${p++},$${p++},to_timestamp($${p++}/1000.0),$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(symbol, resolution, c.time, c.open, c.high, c.low, c.close, c.volume ?? 0);
    }

    const sql = `
      INSERT INTO candles (symbol, resolution, time, open, high, low, close, volume)
      VALUES ${values.join(",")}
      ${UPSERT_SQL_SUFFIX}
    `;

    await exec(sql, params);
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
 * PostgreSQL hard-limits a single query to 65535 bind parameters.
 * Each candle uses 8 params → max safe batch = floor(65535/8) = 8191.
 * We use UPSERT_BATCH_SIZE = 500 rows (4000 params) for headroom.
 *
 * @param {string} symbol
 * @param {number} resolution  must be 1 (1-minute)
 * @param {Array<{time,open,high,low,close,volume}>} candles  time in ms (epoch)
 * @returns {Promise<number>}  total rows upserted
 */
async function upsertCandles(symbol, resolution, candles) {
  if (!candles || candles.length === 0) return 0;

  // Filter valid candles first
  const valid = candles.filter(isValidCandle);
  if (valid.length === 0) return 0;

  return upsertCandleBatch(query, symbol, resolution, valid);
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
  const d = new Date(tradingDay);
  const dayStart = new Date(d);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const rows = await query(
    `DELETE FROM candles
     WHERE symbol=$1 AND resolution=$2
       AND time >= $3 AND time < $4
     RETURNING 1`,
    [symbol, resolution, dayStart.toISOString(), dayEnd.toISOString()]
  );
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
 * Wrapping both in BEGIN/COMMIT makes the replacement atomic: readers either
 * see the old day intact or the new day intact, never neither.
 *
 * @param {string} symbol
 * @param {number} resolution
 * @param {Date|string} tradingDay
 * @param {Array<{time,open,high,low,close,volume}>} candles  the replacement rows
 * @returns {Promise<{deleted:number, inserted:number}>}
 */
async function replaceDayCandles(symbol, resolution, tradingDay, candles) {
  const d = new Date(tradingDay);
  const dayStart = new Date(d);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const valid = (candles || []).filter(isValidCandle);

  let deleted = 0;
  let inserted = 0;

  await transaction(async (client) => {
    const delRows = await client.query(
      `DELETE FROM candles
       WHERE symbol=$1 AND resolution=$2
         AND time >= $3 AND time < $4
       RETURNING 1`,
      [symbol, resolution, dayStart.toISOString(), dayEnd.toISOString()]
    );
    deleted = delRows.rows.length;

    if (valid.length === 0) return;

    inserted = await upsertCandleBatch(client.query.bind(client), symbol, resolution, valid);
  });

  return { deleted, inserted };
}

/**
 * Delete ALL candles for a symbol (full refetch / nuke).
 */
async function deleteAllCandles(symbol, resolution = null) {
  if (resolution !== null) {
    const rows = await query(
      "DELETE FROM candles WHERE symbol=$1 AND resolution=$2 RETURNING 1",
      [symbol, resolution]
    );
    return rows.length;
  }
  const rows = await query(
    "DELETE FROM candles WHERE symbol=$1 RETURNING 1",
    [symbol]
  );
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
  const params = [symbol, resolution];
  let whereClauses = "symbol=$1 AND resolution=$2";
  let p = 3;

  if (from) { whereClauses += ` AND time >= $${p++}`; params.push(new Date(from).toISOString()); }
  if (to) { whereClauses += ` AND time <= $${p++}`; params.push(new Date(to).toISOString()); }

  const rows = await query(
    `SELECT extract(epoch from time)*1000 AS time,
            open, high, low, close, volume
     FROM candles
     WHERE ${whereClauses}
     ORDER BY time ASC
     LIMIT $${p}`,
    [...params, limit]
  );

  return rows.map(r => ({
    time: Math.round(Number(r.time)),
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
  const rows = await query(
    `SELECT extract(epoch from time)*1000 AS time, open, high, low, close, volume
     FROM candles
     WHERE symbol=$1 AND resolution=$2
     ORDER BY time DESC LIMIT 1`,
    [symbol, resolution]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    time: Math.round(Number(r.time)),
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
  const rows = await query(
    `SELECT COUNT(*) AS cnt FROM candles
     WHERE symbol=$1 AND resolution=$2 AND time >= $3 AND time <= $4`,
    [symbol, resolution, new Date(from).toISOString(), new Date(to).toISOString()]
  );
  return parseInt(rows[0]?.cnt || "0", 10);
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
 * a manual "Full Refetch" click. Wrapped in BEGIN/COMMIT for the same
 * all-or-nothing guarantee as replaceDayCandles().
 *
 * @param {string} symbol
 * @param {number} resolution
 * @param {Array<{time,open,high,low,close,volume}>} candles  the full replacement set
 * @returns {Promise<{deleted:number, inserted:number}>}
 */
async function replaceAllCandles(symbol, resolution, candles) {
  const valid = (candles || []).filter(isValidCandle);

  let deleted = 0;
  let inserted = 0;

  await transaction(async (client) => {
    const delRows = await client.query(
      "DELETE FROM candles WHERE symbol=$1 AND resolution=$2 RETURNING 1",
      [symbol, resolution]
    );
    deleted = delRows.rows.length;

    if (valid.length === 0) return;

    inserted = await upsertCandleBatch(client.query.bind(client), symbol, resolution, valid);
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
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString();

  let sql = "DELETE FROM candles WHERE time < $1";
  const params = [cutoff];
  let p = 2;

  if (symbol !== null) { sql += ` AND symbol=$${p++}`; params.push(symbol); }
  if (resolution !== null) { sql += ` AND resolution=$${p++}`; params.push(resolution); }
  sql += " RETURNING 1";

  const rows = await query(sql, params);
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
  const rows = await query("SELECT DISTINCT symbol FROM candles", []);

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
  const issueSummary = issues && issues.length > 0
    ? issues.slice(0, 5).map(i => i.type || i.message || String(i)).join("; ")
    : null;
  await query(
    `INSERT INTO validation_state (symbol, resolution, last_checked, last_ok, status, issue)
     VALUES ($1, $2, NOW(), CASE WHEN $3 THEN NOW() ELSE NULL END, $4, $5)
     ON CONFLICT (symbol, resolution) DO UPDATE SET
       last_checked = NOW(),
       last_ok = CASE WHEN $3 THEN NOW() ELSE validation_state.last_ok END,
       status = $4,
       issue = $5`,
    [symbol, resolution, !!valid, status, issueSummary]
  );
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
};