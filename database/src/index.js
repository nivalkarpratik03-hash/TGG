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
};