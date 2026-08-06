/**
 * database/src/derivativesStore.js
 *
 * Persistence layer for the 4 derivatives tables added in
 * migrations/003_derivatives_tables.sql:
 *   nse_options_candles, mcx_options_candles,
 *   nse_futures_candles, mcx_futures_candles
 *
 * Mirrors candleStore.js's style: Drizzle ORM over the shared pool (see
 * src/db/client.js), batched multi-row INSERT ... ON CONFLICT upserts via
 * .values([...]).onConflictDoUpdate(...), same 500-row batch size
 * rationale (PG's 65535 bind-parameter limit).
 *
 * Row shape in/out of every function here is the object returned by
 * symbolParser.parseDerivativeSymbol(), plus OHLCV:
 *   { symbol, exchange, underlying, instrument_type, expiry_date,
 *     expiry_type, strike, option_type, time, open, high, low, close, volume }
 * `time` is epoch ms (same convention as candleStore.js).
 */

const { db } = require("./db/client");
const {
  nseOptionsCandles,
  mcxOptionsCandles,
  nseFuturesCandles,
  mcxFuturesCandles,
} = require("./db/schema");
const { and, eq, gte, lte, lt, sql, desc, asc } = require("drizzle-orm");
const { isValidCandle } = require("./candleValidation");

const TABLES = {
  option: { NSE: nseOptionsCandles, MCX: mcxOptionsCandles },
  future: { NSE: nseFuturesCandles, MCX: mcxFuturesCandles },
};

const TABLE_NAMES = {
  option: { NSE: "nse_options_candles", MCX: "mcx_options_candles" },
  future: { NSE: "nse_futures_candles", MCX: "mcx_futures_candles" },
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
function tableFor(instrumentType, exchange) {
  return instrumentType === "option" ? optionsTable(exchange) : futuresTable(exchange);
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
  return upsertRows(db, rows, "option");
}

/** Upsert a batch of parsed future candle rows. */
async function upsertFutureCandles(rows) {
  return upsertRows(db, rows, "future");
}

/**
 * Map one parsed+OHLCV row to the shape a given table's Drizzle insert expects.
 */
function toInsertRow(c, kind, exchange) {
  const base = {
    underlying: c.underlying,
    expiryDate: c.expiry_date,
    time: new Date(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? 0,
    symbol: c.symbol,
  };
  if (kind === "option") {
    base.strike = c.strike;
    base.optionType = c.option_type;
    if (exchange === "NSE") base.expiryType = c.expiry_type;
  }
  return base;
}

/**
 * Run one batched upsert (INSERT ... ON CONFLICT DO UPDATE) against the
 * correct table for `kind`+`exchange`. `execDb` is either the module-level
 * `db` or a transaction's `tx`, mirroring candleStore.js's upsertCandleBatch.
 */
async function upsertBatch(execDb, batch, kind, exchange) {
  const table = tableFor(kind, exchange);
  const values = batch.map((c) => toInsertRow(c, kind, exchange));

  const conflictTarget =
    kind === "option"
      ? [table.underlying, table.expiryDate, table.strike, table.optionType, table.time]
      : [table.underlying, table.expiryDate, table.time];

  const set = {
    open: sql`excluded.open`,
    high: sql`excluded.high`,
    low: sql`excluded.low`,
    close: sql`excluded.close`,
    volume: sql`excluded.volume`,
    symbol: sql`excluded.symbol`,
    insertedAt: sql`now()`,
  };

  await execDb.insert(table).values(values).onConflictDoUpdate({ target: conflictTarget, set });
  return batch.length;
}

async function upsertRows(execDb, rows, kind) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r && r.instrument_type === kind && isValidCandle(r));
  if (valid.length === 0) return 0;

  const exchanges = new Set(valid.map((r) => r.exchange));
  if (exchanges.size > 1) {
    throw new Error(
      `upsert${kind === "option" ? "Option" : "Future"}Candles: mixed exchanges in one call (${[...exchanges].join(
        ","
      )}) — call once per exchange`
    );
  }
  const exchange = [...exchanges][0];

  let totalInserted = 0;
  for (let offset = 0; offset < valid.length; offset += UPSERT_BATCH_SIZE) {
    const batch = valid.slice(offset, offset + UPSERT_BATCH_SIZE);
    totalInserted += await upsertBatch(execDb, batch, kind, exchange);
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
  const table = tableFor(instrumentType, exchange);
  const kind = instrumentType;

  const d = new Date(tradingDay);
  const dayStart = new Date(d);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const valid = (rows || []).filter((r) => r && r.instrument_type === kind && isValidCandle(r));

  let deleted = 0;
  let inserted = 0;

  await db.transaction(async (tx) => {
    const delRows = await tx
      .delete(table)
      .where(and(eq(table.symbol, symbol), gte(table.time, dayStart), lt(table.time, dayEnd)))
      .returning({ symbol: table.symbol });
    deleted = delRows.length;

    if (valid.length === 0) return;

    for (let offset = 0; offset < valid.length; offset += UPSERT_BATCH_SIZE) {
      const batch = valid.slice(offset, offset + UPSERT_BATCH_SIZE);
      inserted += await upsertBatch(tx, batch, kind, exchange);
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
  const table = tableFor(instrumentType, exchange);
  const conditions = [eq(table.symbol, symbol)];
  if (from) conditions.push(gte(table.time, new Date(from)));
  if (to) conditions.push(lte(table.time, new Date(to)));

  const rows = await db
    .select({
      time: sql`extract(epoch from ${table.time}) * 1000`.mapWith(Number),
      open: table.open,
      high: table.high,
      low: table.low,
      close: table.close,
      volume: table.volume,
    })
    .from(table)
    .where(and(...conditions))
    .orderBy(asc(table.time))
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

/** Most recent candle for a contract, by exact symbol. */
async function getLatestCandleBySymbol(exchange, instrumentType, symbol) {
  const table = tableFor(instrumentType, exchange);
  const rows = await db
    .select({
      time: sql`extract(epoch from ${table.time}) * 1000`.mapWith(Number),
      open: table.open,
      high: table.high,
      low: table.low,
      close: table.close,
      volume: table.volume,
    })
    .from(table)
    .where(eq(table.symbol, symbol))
    .orderBy(desc(table.time))
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

/** Row count for a given table, optionally filtered by exact symbol. Used by verification/backfill scripts. */
async function countDerivativeCandles(exchange, instrumentType, symbol = null) {
  const table = tableFor(instrumentType, exchange);
  const rows = await db
    .select({ cnt: sql`count(*)`.mapWith(Number) })
    .from(table)
    .where(symbol ? eq(table.symbol, symbol) : undefined);
  return rows[0]?.cnt ?? 0;
}

/** Distinct symbols currently stored in a given table. Used by verification/backfill scripts. */
async function listDerivativeSymbols(exchange, instrumentType) {
  const table = tableFor(instrumentType, exchange);
  const rows = await db.selectDistinct({ symbol: table.symbol }).from(table).orderBy(asc(table.symbol));
  return rows.map((r) => r.symbol);
}

module.exports = {
  upsertOptionCandles,
  upsertFutureCandles,
  replaceDayCandlesBySymbol,
  loadCandlesBySymbol,
  getLatestCandleBySymbol,
  countDerivativeCandles,
  listDerivativeSymbols,
  isValidCandle,
  // Kept signature-compatible with the pre-Drizzle version: returns the
  // table NAME (string), not the Drizzle table object used internally above.
  optionsTable(exchange) {
    const name = TABLE_NAMES.option[exchange];
    if (!name) throw new Error(`No options table for exchange "${exchange}"`);
    return name;
  },
  futuresTable(exchange) {
    const name = TABLE_NAMES.future[exchange];
    if (!name) throw new Error(`No futures table for exchange "${exchange}"`);
    return name;
  },
};