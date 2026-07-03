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

// ─── Write ─────────────────────────────────────────────────────────────────

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

  // 500 rows x 8 params = 4000 params per batch — well under PG's 65535 limit
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

  let totalInserted = 0;

  for (let offset = 0; offset < valid.length; offset += UPSERT_BATCH_SIZE) {
    const batch = valid.slice(offset, offset + UPSERT_BATCH_SIZE);
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

    await query(sql, params);
    totalInserted += batch.length;
  }

  return totalInserted;
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
 * Delete ALL candles for a symbol (full refetch / nuke / retention cleanup).
 *
 * Deletes in batches to keep any single statement's footprint small and
 * predictable. If a batch still fails (e.g. OOM), the batch size is
 * shrunk and retried rather than repeating the exact same failing
 * statement — and the FULL Postgres error (code/detail/hint), not just
 * `.message`, is attached to the thrown error so callers can log the real
 * diagnostic instead of the truncated "out of memory" string.
 */
async function deleteAllCandles(symbol, resolution = null) {
  let batchSize = 5000;
  const MIN_BATCH_SIZE = 100;
  let totalDeleted = 0;

  // Diagnostic: know the actual row count going in, so if this fails again
  // the logs show whether these symbols genuinely have an outsized number
  // of rows or not — that's the difference between "batching needs to be
  // smaller" and "something else is wrong."
  try {
    const countRows = resolution !== null
      ? await query("SELECT COUNT(*) AS n FROM candles WHERE symbol=$1 AND resolution=$2", [symbol, resolution])
      : await query("SELECT COUNT(*) AS n FROM candles WHERE symbol=$1", [symbol]);
    console.log(`[CandleStore] deleteAllCandles(${symbol}): ${countRows[0]?.n ?? "?"} row(s) to delete`);
  } catch (err) {
    console.warn(`[CandleStore] deleteAllCandles(${symbol}): row-count check failed: ${err.message}`);
  }

  while (true) {
    try {
      const rows = resolution !== null
        ? await query(
            `DELETE FROM candles WHERE ctid IN (
               SELECT ctid FROM candles WHERE symbol=$1 AND resolution=$2 LIMIT $3
             ) RETURNING 1`,
            [symbol, resolution, batchSize]
          )
        : await query(
            `DELETE FROM candles WHERE ctid IN (
               SELECT ctid FROM candles WHERE symbol=$1 LIMIT $2
             ) RETURNING 1`,
            [symbol, batchSize]
          );
      totalDeleted += rows.length;
      if (rows.length < batchSize) break; // fewer than a full batch = done
    } catch (err) {
      // Surface the FULL Postgres error, not just err.message — `code`,
      // `detail`, and `hint` are set by the pg driver from the server's
      // actual ErrorResponse and normally get discarded by callers that
      // only log err.message.
      console.error(
        `[CandleStore] deleteAllCandles(${symbol}): batch of ${batchSize} failed — ` +
        `code=${err.code} detail=${err.detail || "(none)"} hint=${err.hint || "(none)"} ` +
        `where=${err.where || "(none)"}`
      );
      if (batchSize <= MIN_BATCH_SIZE) throw err;
      // Shrink and retry rather than repeating the identical failing statement.
      batchSize = Math.max(MIN_BATCH_SIZE, Math.floor(batchSize / 10));
      console.warn(`[CandleStore] deleteAllCandles(${symbol}): shrinking batch size to ${batchSize} and retrying`);
    }
  }

  return totalDeleted;
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
  if (to)   { whereClauses += ` AND time <= $${p++}`; params.push(new Date(to).toISOString()); }

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
    time:   Math.round(Number(r.time)),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
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
    time:   Math.round(Number(r.time)),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
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
async function pruneOldCandles(symbol = null, resolution = 1, retentionDays = 90) {
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString();

  let sql = "DELETE FROM candles WHERE time < $1";
  const params = [cutoff];
  let p = 2;

  if (symbol !== null)     { sql += ` AND symbol=$${p++}`;     params.push(symbol); }
  if (resolution !== null) { sql += ` AND resolution=$${p++}`; params.push(resolution); }
  sql += " RETURNING 1";

  const rows = await query(sql, params);
  return rows.length;
}

/**
 * List every distinct symbol currently stored in the candles table.
 *
 * ROOT-CAUSE NOTE: scheduled historical validation (server.js) used to only
 * check symbols currently attached to a connected socket — a symbol with
 * data sitting in the DB from an earlier session (e.g. you switched a panel
 * away from it, or it loaded before any socket connected at boot) would
 * never get re-validated again, even though its data could still be
 * corrupted. This lets the scheduler cover every symbol that actually HAS
 * data, regardless of whether anyone is currently looking at it.
 *
 * @returns {Promise<string[]>}
 */
async function listSymbols() {
  const rows = await query("SELECT DISTINCT symbol FROM candles ORDER BY symbol ASC");
  return rows.map((r) => r.symbol);
}

// ─── Symbol Access Log (options/futures retention) ──────────────────────────

/**
 * Record that an option or future symbol was just loaded/viewed.
 * Call this whenever fetchAndProcess / getOrCreateBuilder is invoked for a
 * CE/PE/FUT symbol so retentionCleanup knows when it was last seen.
 *
 * Underlying equity/index symbols should NOT be passed here — the 2-day
 * staleness rule only applies to option and future contract symbols.
 *
 * @param {string} symbol  e.g. "NSE:NIFTY26JUN24000CE" or "NSE:RELIANCE26JUNFUT"
 */
async function touchSymbolAccess(symbol) {
  await query(
    `INSERT INTO symbol_access_log (symbol, last_accessed)
     VALUES ($1, NOW())
     ON CONFLICT (symbol) DO UPDATE SET last_accessed = NOW()`,
    [symbol]
  );
}

/**
 * Return a Map of symbol → last_accessed Date for all entries in symbol_access_log.
 * Used by retentionCleanup.js to decide which option/future symbols are stale.
 *
 * @returns {Promise<Map<string, Date>>}
 */
async function getSymbolAccessMap() {
  const rows = await query("SELECT symbol, last_accessed FROM symbol_access_log");
  const map = new Map();
  for (const r of rows) {
    map.set(r.symbol, new Date(r.last_accessed));
  }
  return map;
}

/**
 * Delete the access log entry for a symbol (called when its candle data is deleted).
 *
 * @param {string} symbol
 */
async function deleteSymbolAccess(symbol) {
  await query("DELETE FROM symbol_access_log WHERE symbol=$1", [symbol]);
}

// ─── Validation state (persistent skip-cache) ────────────────────────────────
// The `validation_state` table already existed in the schema but was never
// read or written anywhere — every historical validation pass re-scanned
// the FULL 90-day window from scratch, every 10 minutes, for every symbol,
// even for symbols that were already confirmed clean minutes earlier.
// These helpers let validationEngine.js persist "last checked / last known
// good" per symbol so periodic runs can validate only what's actually new
// since the last check instead of repeating the same historical sweep
// forever.

/**
 * Fetch the persisted validation state for a symbol+resolution.
 * @returns {Promise<{lastChecked: Date, lastOk: Date|null, status: string, issue: string|null} | null>}
 */
async function getValidationState(symbol, resolution = 1) {
  const rows = await query(
    `SELECT last_checked, last_ok, status, issue
     FROM validation_state
     WHERE symbol=$1 AND resolution=$2`,
    [symbol, resolution]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    lastChecked: new Date(r.last_checked),
    lastOk: r.last_ok ? new Date(r.last_ok) : null,
    status: r.status,
    issue: r.issue,
  };
}

/**
 * Upsert the validation state for a symbol+resolution after a check.
 * @param {string} symbol
 * @param {number} resolution
 * @param {object} state
 * @param {boolean} state.ok
 * @param {string} [state.issueSummary]  short human-readable summary of issues found (if any)
 */
async function setValidationState(symbol, resolution, { ok, issueSummary = null } = {}) {
  await query(
    `INSERT INTO validation_state (symbol, resolution, last_checked, last_ok, status, issue)
     VALUES ($1, $2, NOW(), CASE WHEN $3 THEN NOW() ELSE NULL END, $4, $5)
     ON CONFLICT (symbol, resolution) DO UPDATE SET
       last_checked = NOW(),
       last_ok      = CASE WHEN $3 THEN NOW() ELSE validation_state.last_ok END,
       status       = $4,
       issue        = $5`,
    [symbol, resolution, ok, ok ? "ok" : "issues", issueSummary]
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidCandle(c) {
  return (
    c &&
    Number.isFinite(c.time) && c.time > 0 &&
    Number.isFinite(c.open)  && c.open  > 0 &&
    Number.isFinite(c.high)  && c.high  > 0 &&
    Number.isFinite(c.low)   && c.low   > 0 &&
    Number.isFinite(c.close) && c.close > 0 &&
    c.high >= c.low &&
    c.high >= c.open &&
    c.high >= c.close &&
    c.low  <= c.open &&
    c.low  <= c.close
  );
}

module.exports = {
  upsertCandles,
  deleteDayCandles,
  deleteAllCandles,
  pruneOldCandles,
  loadCandles,
  getLatestCandle,
  countCandles,
  listSymbols,
  isValidCandle,
  touchSymbolAccess,
  getSymbolAccessMap,
  deleteSymbolAccess,
  getValidationState,
  setValidationState,
};