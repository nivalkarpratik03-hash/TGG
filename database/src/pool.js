/**
 * database/src/pool.js
 *
 * Shared PostgreSQL connection pool.
 * All other DB modules import { pool, query } from here.
 * Reads DATABASE_URL (or individual PG* vars) from environment.
 *
 * FIX: pg driver requires password to be a string, never undefined.
 * When DATABASE_URL is set, pg parses it directly — individual PG* vars
 * are ignored. When DATABASE_URL is missing, individual vars are used.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../backend/.env") });

const { Pool } = require("pg");

// Build connection config carefully — password MUST be a string or pg throws
// "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"
let poolConfig;

// ── Production-tunable pool settings (all optional env vars) ─────────────────
//   PG_POOL_MAX              max clients (default 20). Keep (instances x max) well below RDS max_connections.
//   PG_SSL                   "true" → TLS (required by RDS when rds.force_ssl=1, the default on PG15+).
//   PG_SSL_REJECT_UNAUTHORIZED "false" only if you cannot ship the RDS CA bundle (not recommended).
//   PG_SSL_CA_FILE           path to the AWS RDS global CA bundle (global-bundle.pem) for full verification.
//   PG_STATEMENT_TIMEOUT_MS  server-side kill for runaway queries (default 60000).
const common = {
  max: parseInt(process.env.PG_POOL_MAX || "20", 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,                       // detect dead NAT/ALB-style idle drops
  keepAliveInitialDelayMillis: 10000,
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "60000", 10),
  idle_in_transaction_session_timeout: 120000,
  application_name: process.env.PG_APP_NAME || "tgg-backend",
};
let ssl;
if (process.env.PG_SSL === "true") {
  ssl = { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false" };
  if (process.env.PG_SSL_CA_FILE) ssl.ca = require("fs").readFileSync(process.env.PG_SSL_CA_FILE, "utf8");
}

if (process.env.DATABASE_URL) {
  // Use connection string directly — pg handles parsing
  poolConfig = { connectionString: process.env.DATABASE_URL, ...common, ...(ssl ? { ssl } : {}) };
} else {
  // Build from individual vars — guarantee password is always a string
  poolConfig = {
    host:     process.env.PGHOST     || "localhost",
    port:     parseInt(process.env.PGPORT || "5432"),
    database: process.env.PGDATABASE || "tgg",
    user:     process.env.PGUSER     || "postgres",
    password: String(process.env.PGPASSWORD || ""),  // MUST be string
    ...common,
    ...(ssl ? { ssl } : {}),
  };
}

const pool = new Pool(poolConfig);

pool.on("error", (err) => {
  console.error("[DB Pool] Unexpected client error:", err.message);
});

pool.on("connect", () => {
  // Uncomment for debugging:
  // console.log("[DB Pool] New client connected");
});

/**
 * Convenience wrapper: run a parameterized query and return rows.
 */
async function query(text, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Run multiple statements in a single transaction.
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    // A failed ROLLBACK (e.g. connection already dead) must not mask the original error.
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Verify the connection is alive. Returns true on success, false on failure.
 */
async function healthCheck() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

module.exports = { pool, query, transaction, healthCheck };