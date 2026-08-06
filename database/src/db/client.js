/**
 * database/src/db/client.js
 *
 * Drizzle instance bound to the SAME pg Pool used everywhere else
 * (see ../pool.js) — one pool, one set of connections, whether a query
 * goes through Drizzle's query builder or (rarely, see candleStore.js)
 * a raw sql`` escape hatch.
 */

const { drizzle } = require("drizzle-orm/node-postgres");
const { pool } = require("../pool");
const schema = require("./schema");

const db = drizzle(pool, { schema });

module.exports = { db, schema };