import { pgTable, index, text, timestamp, bigserial, integer, primaryKey, doublePrecision, bigint, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const symbolAccessLog = pgTable("symbol_access_log", {
	symbol: text().primaryKey().notNull(),
	lastAccessed: timestamp("last_accessed", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_symbol_access_log_last_accessed").using("btree", table.lastAccessed.desc().nullsFirst().op("timestamptz_ops")),
]);

export const repairLog = pgTable("repair_log", {
	id: bigserial({ mode: "bigint" }).primaryKey().notNull(),
	symbol: text().notNull(),
	resolution: integer(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	trigger: text().notNull(),
	status: text().default('running').notNull(),
	detail: text(),
	candlesDeleted: integer("candles_deleted").default(0),
	candlesInserted: integer("candles_inserted").default(0),
}, (table) => [
	index("idx_repair_log_symbol_time").using("btree", table.symbol.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("text_ops")),
]);

export const validationState = pgTable("validation_state", {
	symbol: text().notNull(),
	resolution: integer().notNull(),
	lastChecked: timestamp("last_checked", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastOk: timestamp("last_ok", { withTimezone: true, mode: 'string' }),
	status: text().default('unknown').notNull(),
	issue: text(),
}, (table) => [
	primaryKey({ columns: [table.resolution, table.symbol], name: "validation_state_pkey"}),
]);

export const candles = pgTable("candles", {
	symbol: text().notNull(),
	resolution: integer().notNull(),
	time: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	open: doublePrecision().notNull(),
	high: doublePrecision().notNull(),
	low: doublePrecision().notNull(),
	close: doublePrecision().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	volume: bigint({ mode: "number" }).default(0).notNull(),
	validated: boolean().default(true).notNull(),
	insertedAt: timestamp("inserted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("candles_symbol_time_idx").using("btree", table.symbol.asc().nullsLast().op("text_ops"), table.time.desc().nullsFirst().op("text_ops")),
	index("candles_time_idx").using("btree", table.time.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_candles_inserted_at").using("btree", table.insertedAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_candles_symbol_res_time").using("btree", table.symbol.asc().nullsLast().op("text_ops"), table.resolution.asc().nullsLast().op("text_ops"), table.time.desc().nullsFirst().op("int4_ops")),
	primaryKey({ columns: [table.resolution, table.symbol, table.time], name: "candles_pkey"}),
]);
