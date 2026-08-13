/**
 * database/src/healthcheck.js
 *
 * Quick DB connection test:
 *   node database/src/healthcheck.js
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../backend/.env") });
const { pool, healthCheck } = require("../pool");

(async () => {
  const ok = await healthCheck();
  if (ok) {
    console.log("✅  Database connection OK");
    const res = await pool.query("SELECT version()");
    console.log("   ", res.rows[0].version);
  } else {
    console.error("❌  Database connection FAILED — check DATABASE_URL / PG* vars in backend/.env");
    process.exit(1);
  }
  await pool.end();
})();
