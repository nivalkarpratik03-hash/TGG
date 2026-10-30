/**
 * database/src/scripts/migrate.js  (REWRITTEN — production safe)
 *
 * Applies numbered migrations (001_*.sql, 002_*.sql, ...) exactly once each:
 *   - Only files matching /^\d+_.*\.sql$/ are run. Operational psql scripts
 *     (role/grant setup using \set / \connect) live in migrations/ops/ and are NEVER
 *     executed here — previously they were picked up too and aborted the whole run
 *     with `syntax error at or near "\"`.
 *   - Applied files are recorded in schema_migrations (name + sha256). Re-runs skip
 *     them, and a CHANGED already-applied file is reported instead of silently re-run.
 *   - Each file runs in its own transaction; an advisory lock stops two deploys from
 *     migrating concurrently.
 *
 *   node src/scripts/migrate.js            # apply pending
 *   node src/scripts/migrate.js --status   # list applied / pending, change nothing
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../../backend/.env") });

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pool } = require("../pool");

const LOCK_KEY = 727274; // arbitrary constant for pg_advisory_lock
const statusOnly = process.argv.includes("--status");

async function migrate() {
  const dir = path.resolve(__dirname, "../../migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  if (!files.length) { console.error("No numbered .sql migrations found in", dir); process.exit(1); }

  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const applied = new Map((await client.query("SELECT name, sha256 FROM schema_migrations")).rows.map((r) => [r.name, r.sha256]));

    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      const hash = crypto.createHash("sha256").update(sql).digest("hex");
      if (applied.has(file)) {
        if (applied.get(file) !== hash) console.warn(`[Migrate] ⚠  ${file} was modified after being applied (not re-run). Add a NEW migration for the change.`);
        else console.log(`[Migrate] ✓  ${file} already applied`);
        continue;
      }
      if (statusOnly) { console.log(`[Migrate] …  ${file} PENDING`); continue; }
      console.log(`[Migrate] Running ${file} ...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [file, hash]);
        await client.query("COMMIT");
        console.log(`[Migrate] ✅  ${file} applied`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[Migrate] ❌  ${file} failed: ${err.message}`);
        failed = true;
        break;
      }
    }
    if (!failed) console.log(statusOnly ? "[Migrate] status complete." : "[Migrate] ✅  All migrations complete.");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end();
  }
  process.exit(failed ? 1 : 0);
}

migrate().catch((e) => { console.error("[Migrate] fatal:", e.message); process.exit(1); });