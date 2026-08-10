/**
 * database/src/derivativesStore.js
 *
 * Persistence layer for the 6 derivatives tables:
 *   nse_options_candles, mcx_options_candles, bse_options_candles,
 *   nse_futures_candles, mcx_futures_candles, bse_futures_candles
 * (bse_* added in migrations/004_bse_tables_and_oi.sql, same migration
 * that added the `oi` column to all 4 pre-existing tables.)
 *
 * Mirrors candleStore.js's style: imports query/transaction from pool.js,
 * batched multi-row INSERT ... ON CONFLICT upserts, same 500-row batch
 * size rationale (PG's 65535 bind-parameter limit).
 *
 * Row shape in/out of every function here is the object returned by
 * symbolParser.parseDerivativeSymbol(), plus OHLCV + oi:
 *   { symbol, exchange, underlying, instrument_type, expiry_date,
 *     expiry_type, strike, option_type, time, open, high, low, close,
 *     volume, oi }
 * `time` is epoch ms (same convention as candleStore.js). `oi` is
 * optional on the way in — rows without it (e.g. anything written before
 * OI capture existed) store NULL, same as any already-existing row.
 *
 * expiry_type column presence: NSE and BSE options both carry it (both
 * can have weekly+monthly alive at once — NIFTY and SENSEX respectively).
 * MCX options are the only ones without it (single active cycle, no
 * weekly/monthly split) — the branch below keys off "MCX or not", not
 * "NSE specifically", for exactly this reason.
 */

const { query, transaction } = require("../pool");
const { isValidCandle } = require("./candleValidation");

const TABLES = {
  option: { NSE: "nse_options_candles", MCX: "mcx_options_candles", BSE: "bse_options_candles" },
  future: { NSE: "nse_futures_candles", MCX: "mcx_futures_candles", BSE: "bse_futures_candles" },
};

function optionsTable(exchange) {
  const t = TABLES.option[exchange];
  if (!t) throw new Error(`No options table for exchange "${exchange}"`);
  return t;
}
function futuresTable(exchange) {
  const t = TABLES.future[exchange];
  if (!t) throw new Error(`No futures table for exchange "${exchange}"`);
  return t;
}

// P3 #12 — isValidCandle() now lives in ./candleValidation.js (single
// source of truth, shared with candleStore.js). See that file for the
// full validity rules.

const UPSERT_BATCH_SIZE = 500; // matches candleStore.js — headroom under PG's 65535 bind-param limit

// ─── Write: options ─────────────────────────────────────────────────────────

/**
 * Upsert a batch of parsed option candle rows (all must share the same
 * exchange — mixed NSE+MCX rows in one call will throw).
 * @param {Array<object>} rows  parseDerivativeSymbol() output + OHLCV fields
 * @returns {Promise<number>} total rows upserted
 */
async function upsertOptionCandles(rows) {
  return upsertRows(rows, "option");
}

/** Upsert a batch of parsed future candle rows. */
async function upsertFutureCandles(rows) {
  return upsertRows(rows, "future");
}

/**
 * Build the batched INSERT ... ON CONFLICT DO UPDATE statement for one
 * batch of rows. Pure function — no I/O — so it can be reused by both the
 * standalone upsert (runs each batch through the shared pool) and
 * replaceDayCandlesBySymbol (runs each batch through a transaction's
 * client, so the delete + insert land atomically).
 */
function buildBatchInsert(batch, kind, exchange, table) {
  const isOption = kind === "option";
  const values = [];
  const params = [];
  let p = 1;

  // NSE and BSE options both carry expiry_type (both can have
  // weekly+monthly alive at once). MCX is the only options exchange
  // without it — keying off "not MCX", not "is NSE", so BSE options
  // correctly take the expiry_type-bearing shape too.
  if (isOption && exchange !== "MCX") {
    for (const c of batch) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},to_timestamp($${p++}/1000.0),$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(c.underlying, c.expiry_date, c.expiry_type, c.strike, c.option_type, c.time, c.open, c.high, c.low, c.close, c.volume ?? 0, c.oi ?? null, c.symbol);
    }
    return {
      sql: `
        INSERT INTO ${table} (underlying, expiry_date, expiry_type, strike, option_type, time, open, high, low, close, volume, oi, symbol)
        VALUES ${values.join(",")}
        ON CONFLICT (underlying, expiry_date, strike, option_type, time) DO UPDATE SET
          open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
          close = EXCLUDED.close, volume = EXCLUDED.volume, oi = EXCLUDED.oi,
          symbol = EXCLUDED.symbol, inserted_at = NOW()
      `,
      params,
    };
  } else if (isOption) { // MCX options — no expiry_type column
    for (const c of batch) {
      values.push(`($${p++},$${p++},$${p++},$${p++},to_timestamp($${p++}/1000.0),$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(c.underlying, c.expiry_date, c.strike, c.option_type, c.time, c.open, c.high, c.low, c.close, c.volume ?? 0, c.oi ?? null, c.symbol);
    }
    return {
      sql: `
        INSERT INTO ${table} (underlying, expiry_date, strike, option_type, time, open, high, low, close, volume, oi, symbol)
        VALUES ${values.join(",")}
        ON CONFLICT (underlying, expiry_date, strike, option_type, time) DO UPDATE SET
          open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
          close = EXCLUDED.close, volume = EXCLUDED.volume, oi = EXCLUDED.oi,
          symbol = EXCLUDED.symbol, inserted_at = NOW()
      `,
      params,
    };
  } else { // futures — NSE, MCX, or BSE, identical shape
    for (const c of batch) {
      values.push(`($${p++},$${p++},to_timestamp($${p++}/1000.0),$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(c.underlying, c.expiry_date, c.time, c.open, c.high, c.low, c.close, c.volume ?? 0, c.oi ?? null, c.symbol);
    }
    return {
      sql: `
        INSERT INTO ${table} (underlying, expiry_date, time, open, high, low, close, volume, oi, symbol)
        VALUES ${values.join(",")}
        ON CONFLICT (underlying, expiry_date, time) DO UPDATE SET
          open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
          close = EXCLUDED.close, volume = EXCLUDED.volume, oi = EXCLUDED.oi,
          symbol = EXCLUDED.symbol, inserted_at = NOW()
      `,
      params,
    };
  }
}

async function upsertRows(rows, kind) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r && r.instrument_type === kind && isValidCandle(r));
  if (valid.length === 0) return 0;

  const exchanges = new Set(valid.map((r) => r.exchange));
  if (exchanges.size > 1) {
    throw new Error(`upsert${kind === "option" ? "Option" : "Future"}Candles: mixed exchanges in one call (${[...exchanges].join(",")}) — call once per exchange`);
  }
  const exchange = [...exchanges][0];
  const table = kind === "option" ? optionsTable(exchange) : futuresTable(exchange);

  let totalInserted = 0;

  for (let offset = 0; offset < valid.length; offset += UPSERT_BATCH_SIZE) {
    const batch = valid.slice(offset, offset + UPSERT_BATCH_SIZE);
    const { sql, params } = buildBatchInsert(batch, kind, exchange, table);
    await query(sql, params);
    totalInserted += batch.length;
  }

  return totalInserted;
}

/**
 * Atomically replace one contract's candles for a single trading day:
 * delete the old day's rows from the correct derivatives table and insert
 * the freshly fetched ones inside ONE transaction — same atomicity
 * guarantee as candleStore.js's replaceDayCandles (see that file's
 * comment for why the delete+insert needs to be one transaction, not two
 * separate committed queries).
 *
 * This is what makes repairDay() (recoveryEngine.js) safe to call on an
 * option/future symbol — previously repairDay() always went through
 * candleStore.replaceDayCandles(), which unconditionally writes to the
 * plain `candles` table regardless of symbol type. A derivative symbol's
 * "repair" would silently insert into the wrong table while the real
 * gap in nse_options_candles/etc. stayed open.
 *
 * @param {string} exchange        "NSE" | "MCX"
 * @param {"option"|"future"} instrumentType
 * @param {string} symbol          exact contract symbol
 * @param {Date|string} tradingDay
 * @param {Array<object>} rows     parseDerivativeSymbol() output + OHLCV, same shape upsertOptionCandles/upsertFutureCandles expect
 * @returns {Promise<{deleted:number, inserted:number}>}
 */
async function replaceDayCandlesBySymbol(exchange, instrumentType, symbol, tradingDay, rows) {
  const table = instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
  const kind = instrumentType;

  const d = new Date(tradingDay);
  const dayStart = new Date(d);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const valid = (rows || []).filter((r) => r && r.instrument_type === kind && isValidCandle(r));

  let deleted = 0;
  let inserted = 0;

  await transaction(async (client) => {
    const delRows = await client.query(
      `DELETE FROM ${table}
       WHERE symbol=$1 AND time >= $2 AND time < $3
       RETURNING 1`,
      [symbol, dayStart.toISOString(), dayEnd.toISOString()]
    );
    deleted = delRows.rows.length;

    if (valid.length === 0) return;

    for (let offset = 0; offset < valid.length; offset += UPSERT_BATCH_SIZE) {
      const batch = valid.slice(offset, offset + UPSERT_BATCH_SIZE);
      const { sql, params } = buildBatchInsert(batch, kind, exchange, table);
      await client.query(sql, params);
      inserted += batch.length;
    }
  });

  return { deleted, inserted };
}

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Load candles for one contract by its exact symbol (indexed lookup —
 * no need to know underlying/expiry/strike separately since `symbol`
 * uniquely identifies the contract).
 */
async function loadCandlesBySymbol(exchange, instrumentType, symbol, { limit = 10000, from, to } = {}) {
  const table = instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
  const params = [symbol];
  let where = "symbol=$1";
  let p = 2;
  if (from) { where += ` AND time >= $${p++}`; params.push(new Date(from).toISOString()); }
  if (to) { where += ` AND time <= $${p++}`; params.push(new Date(to).toISOString()); }

  const rows = await query(
    `SELECT extract(epoch from time)*1000 AS time, open, high, low, close, volume, oi
     FROM ${table}
     WHERE ${where}
     ORDER BY time ASC
     LIMIT $${p}`,
    [...params, limit]
  );

  return rows.map((r) => ({
    time: Math.round(Number(r.time)),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    oi: r.oi == null ? null : Number(r.oi),
  }));
}

/** Most recent candle for a contract, by exact symbol. */
async function getLatestCandleBySymbol(exchange, instrumentType, symbol) {
  const table = instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
  const rows = await query(
    `SELECT extract(epoch from time)*1000 AS time, open, high, low, close, volume, oi
     FROM ${table}
     WHERE symbol=$1
     ORDER BY time DESC LIMIT 1`,
    [symbol]
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
    oi: r.oi == null ? null : Number(r.oi),
  };
}

/** Row count for a given table, optionally filtered by exact symbol. Used by verification/backfill scripts. */
async function countDerivativeCandles(exchange, instrumentType, symbol = null) {
  const table = instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
  const rows = symbol
    ? await query(`SELECT COUNT(*) AS cnt FROM ${table} WHERE symbol=$1`, [symbol])
    : await query(`SELECT COUNT(*) AS cnt FROM ${table}`, []);
  return parseInt(rows[0]?.cnt || "0", 10);
}

/** Distinct symbols currently stored in a given table. Used by verification/backfill scripts. */
async function listDerivativeSymbols(exchange, instrumentType) {
  const table = instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
  const rows = await query(`SELECT DISTINCT symbol FROM ${table} ORDER BY symbol`, []);
  return rows.map((r) => r.symbol);
}

/**
 * Distinct (symbol, underlying, expiry_date) contracts currently stored in
 * a table — the input expiryLifecycle.js needs to decide what's expired.
 * Unlike listDerivativeSymbols(), this also returns expiry_date because
 * that's a first-class stored column here (unlike the legacy `candles`
 * table, which has no such column and has to regex-derive it from the
 * symbol string in candleStore.js's extractContractExpiry() — we don't
 * need that approach at all since expiry_date is already stored directly).
 */
async function listDistinctContracts(exchange, instrumentType) {
  const table = instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
  const rows = await query(
    `SELECT DISTINCT symbol, underlying, expiry_date::text AS expiry_date FROM ${table} ORDER BY expiry_date, symbol`,
    []
  );
  return rows;
}

/**
 * Delete ALL stored rows for one exact contract symbol, from the correct
 * derivatives table. Used only by pruneExpiredDerivatives.js, and only
 * after a confirmed-successful archive write for that same symbol —
 * never called standalone. This is intentionally separate from
 * candleStore.js's pruneExpiredContracts()/deleteAllCandles(), which only
 * ever touch the legacy `candles` table — no overlap, no duplicate logic,
 * different tables entirely.
 * @returns {Promise<number>} rows deleted
 */
async function deleteCandlesBySymbol(exchange, instrumentType, symbol) {
  const table = instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
  const rows = await query(`DELETE FROM ${table} WHERE symbol=$1 RETURNING 1`, [symbol]);
  return rows.length;
}

module.exports = {
  upsertOptionCandles,
  upsertFutureCandles,
  replaceDayCandlesBySymbol,
  loadCandlesBySymbol,
  getLatestCandleBySymbol,
  countDerivativeCandles,
  listDerivativeSymbols,
  listDistinctContracts,
  deleteCandlesBySymbol,
  isValidCandle,
  optionsTable,
  futuresTable,
};