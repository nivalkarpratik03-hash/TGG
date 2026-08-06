/**
 * database/src/db/schema.js
 *
 * Drizzle ORM schema — mirrors migrations/001_init.sql, 002_repair_log_trading_day.sql,
 * and 003_derivatives_tables.sql column-for-column, index-for-index.
 *
 * IMPORTANT: this file describes tables that ALREADY EXIST (created by the
 * hand-written SQL migrations, which remain the source of truth for schema
 * history — see migrate.js). It is not used to create these tables from
 * scratch. Any FUTURE schema change should be made here first, then turned
 * into a migration with `npm run db:generate` (see database/README-drizzle.md).
 */

const {
  pgTable,
  text,
  integer,
  bigint,
  bigserial,
  doublePrecision,
  boolean,
  timestamp,
  date,
  primaryKey,
  index,
  check,
} = require("drizzle-orm/pg-core");
const { sql } = require("drizzle-orm");

// ─── candles ────────────────────────────────────────────────────────────────
// Only resolution=1 (1-minute) rows are ever stored — see candleStore.js header.
const candles = pgTable(
  "candles",
  {
    symbol: text("symbol").notNull(),
    resolution: integer("resolution").notNull(),
    time: timestamp("time", { withTimezone: true, mode: "date" }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    validated: boolean("validated").notNull().default(true),
    insertedAt: timestamp("inserted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.symbol, t.resolution, t.time] }),
    index("idx_candles_symbol_res_time").on(t.symbol, t.resolution, t.time.desc()),
    index("idx_candles_inserted_at").on(t.insertedAt.desc()),
    check("candles_resolution_check", sql`${t.resolution} = 1`),
  ]
);

// ─── repair_log ─────────────────────────────────────────────────────────────
const repairLog = pgTable(
  "repair_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    symbol: text("symbol").notNull(),
    resolution: integer("resolution"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("running"),
    detail: text("detail"),
    candlesDeleted: integer("candles_deleted").default(0),
    candlesInserted: integer("candles_inserted").default(0),
    // Added by migration 001 as TIMESTAMPTZ; migration 002's ADD COLUMN IF NOT EXISTS
    // ... DATE is a no-op against the already-existing column, so the real type
    // in the DB is TIMESTAMPTZ. Modeled as a plain date string (YYYY-MM-DD) to
    // match how repairLog.js has always written/read it.
    tradingDay: timestamp("trading_day", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("idx_repair_log_symbol_time").on(t.symbol, t.startedAt.desc()),
    index("idx_repair_log_symbol_day").on(t.symbol, t.tradingDay, t.startedAt.desc()),
  ]
);

// ─── symbol_access_log ──────────────────────────────────────────────────────
const symbolAccessLog = pgTable(
  "symbol_access_log",
  {
    symbol: text("symbol").primaryKey(),
    lastAccessed: timestamp("last_accessed", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_symbol_access_log_last_accessed").on(t.lastAccessed.desc())]
);

// ─── validation_state ───────────────────────────────────────────────────────
const validationState = pgTable(
  "validation_state",
  {
    symbol: text("symbol").notNull(),
    resolution: integer("resolution").notNull().default(1),
    lastChecked: timestamp("last_checked", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastOk: timestamp("last_ok", { withTimezone: true, mode: "date" }),
    status: text("status").notNull().default("unknown"),
    issue: text("issue"),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.resolution] })]
);

// ─── derivatives tables (migration 003) ─────────────────────────────────────
const nseOptionsCandles = pgTable(
  "nse_options_candles",
  {
    underlying: text("underlying").notNull(),
    expiryDate: date("expiry_date", { mode: "string" }).notNull(),
    expiryType: text("expiry_type").notNull(),
    strike: doublePrecision("strike").notNull(),
    optionType: text("option_type").notNull(),
    time: timestamp("time", { withTimezone: true, mode: "date" }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    symbol: text("symbol").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.underlying, t.expiryDate, t.strike, t.optionType, t.time] }),
    index("idx_nse_options_symbol_time").on(t.symbol, t.time.desc()),
    check("nse_options_expiry_type_check", sql`${t.expiryType} IN ('weekly','monthly')`),
    check("nse_options_option_type_check", sql`${t.optionType} IN ('CE','PE')`),
  ]
);

const mcxOptionsCandles = pgTable(
  "mcx_options_candles",
  {
    underlying: text("underlying").notNull(),
    expiryDate: date("expiry_date", { mode: "string" }).notNull(),
    strike: doublePrecision("strike").notNull(),
    optionType: text("option_type").notNull(),
    time: timestamp("time", { withTimezone: true, mode: "date" }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    symbol: text("symbol").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.underlying, t.expiryDate, t.strike, t.optionType, t.time] }),
    index("idx_mcx_options_symbol_time").on(t.symbol, t.time.desc()),
    check("mcx_options_option_type_check", sql`${t.optionType} IN ('CE','PE')`),
  ]
);

const nseFuturesCandles = pgTable(
  "nse_futures_candles",
  {
    underlying: text("underlying").notNull(),
    expiryDate: date("expiry_date", { mode: "string" }).notNull(),
    time: timestamp("time", { withTimezone: true, mode: "date" }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    symbol: text("symbol").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.underlying, t.expiryDate, t.time] }),
    index("idx_nse_futures_symbol_time").on(t.symbol, t.time.desc()),
  ]
);

const mcxFuturesCandles = pgTable(
  "mcx_futures_candles",
  {
    underlying: text("underlying").notNull(),
    expiryDate: date("expiry_date", { mode: "string" }).notNull(),
    time: timestamp("time", { withTimezone: true, mode: "date" }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    symbol: text("symbol").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.underlying, t.expiryDate, t.time] }),
    index("idx_mcx_futures_symbol_time").on(t.symbol, t.time.desc()),
  ]
);

module.exports = {
  candles,
  repairLog,
  symbolAccessLog,
  validationState,
  nseOptionsCandles,
  mcxOptionsCandles,
  nseFuturesCandles,
  mcxFuturesCandles,
};