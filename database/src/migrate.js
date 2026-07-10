/**
 * database/src/migrate.js
 *
 * Run once to create / update all tables:
 *   node database/src/migrate.js
 *
 * Safe to re-run (every migration uses IF NOT EXISTS / IF EXISTS throughout).
 *
 * CHANGED: previously this only ever ran migrations/001_init.sql by a
 * hardcoded filename. New migration files (002, 003, ...) were silently
 * never applied no matter how many times this was re-run. Now it reads
 * every *.sql file in the migrations folder, sorts them by filename
 * (001_, 002_, ... so numeric prefix order = execution order), and runs
 * them in sequence.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../backend/.env") });

const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function migrate() {
  const migrationsDir = path.resolve(__dirname, "../migrations");
  if (!fs.existsSync(migrationsDir)) {
    console.error("Migrations folder not found:", migrationsDir);
    process.exit(1);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // "001_init.sql" < "002_xyz.sql" lexically — relies on the zero-padded numeric prefix convention already used in this project

  if (files.length === 0) {
    console.error("No .sql migration files found in", migrationsDir);
    process.exit(1);
  }

  const client = await pool.connect();

  try {
    for (const file of files) {
      const sqlFile = path.join(migrationsDir, file);
      const sql = fs.readFileSync(sqlFile, "utf8");
      console.log(`[Migrate] Running ${file} ...`);
      await client.query(sql);
      console.log(`[Migrate] \u2705  ${file} applied / verified.`);
    }
    console.log("[Migrate] \u2705  All migrations complete.");
  } catch (err) {
    console.error("[Migrate] \u274c  Migration failed:", err.message);
    console.error(
      "\n  If TimescaleDB is not installed, edit migrations/001_init.sql and remove the\n" +
      "  TimescaleDB-specific lines (CREATE EXTENSION and SELECT create_hypertable(...))\n" +
      "  to run on plain PostgreSQL.\n"
    );
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();