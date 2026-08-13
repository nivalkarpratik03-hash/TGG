/**
 * database/src/index.js
 *
 * Public entry point for the database layer.
 * Import this from backend: const db = require("../../database/src");
 */

const pool = require("./pool");
const candleStore = require("./store/candleStore");
const validationEngine = require("./integrity/validationEngine");
const recoveryEngine = require("./integrity/recoveryEngine");
const repairLog = require("./integrity/repairLog");
const derivativesStore = require("./store/derivativesStore");
const symbolParser = require("./parsing/symbolParser");
const dataRouter = require("./store/dataRouter");
const { db, schema } = require("./db/client");

module.exports = {
  ...pool,
  ...candleStore,
  ...validationEngine,
  ...recoveryEngine,
  ...repairLog,
  ...derivativesStore,   // exposed directly too — used by backfillDerivatives.js
  ...symbolParser,        // parseDerivativeSymbol() exposed for scripts/tests
  // dataRouter spread LAST so its upsertCandles/getLatestCandle/loadCandles
  // OVERRIDE candleStore's versions app-wide (see dataRouter.js header).
  ...dataRouter,
  // Drizzle escape hatch — for callers that want direct query-builder
  // access (e.g. a new API route doing an ad-hoc read) instead of going
  // through one of the store modules above. Nothing existing uses this yet;
  // it's purely additive.
  db,
  schema,
};