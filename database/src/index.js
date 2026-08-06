/**
 * database/src/index.js
 *
 * Public entry point for the database layer.
 * Import this from backend: const db = require("../../database/src");
 */

const pool = require("./pool");
const candleStore = require("./candleStore");
const validationEngine = require("./validationEngine");
const recoveryEngine = require("./recoveryEngine");
const repairLog = require("./repairLog");
const derivativesStore = require("./derivativesStore");
const symbolParser = require("./symbolParser");
const dataRouter = require("./dataRouter");
const ohlcGuard = require("./ohlcGuard");
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
  // OHLC validation gate — see ohlcGuard.js. validateAndStoreCandles() wraps
  // dataRouter's upsertCandles/replaceDayCandles, so it does NOT get
  // overridden by the dataRouter spread above (different function name).
  ...ohlcGuard,
  // Drizzle escape hatch — for callers that want direct query-builder
  // access (e.g. a new API route doing an ad-hoc read) instead of going
  // through one of the store modules above.
  db,
  schema,
};