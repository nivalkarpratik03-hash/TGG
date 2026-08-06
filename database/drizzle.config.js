/**
 * drizzle.config.js
 *
 * Used only by `drizzle-kit` (npm run db:generate / db:studio) — NOT by the
 * running application, which connects via src/db/client.js.
 *
 * The current schema (src/db/schema.js) mirrors tables that already exist,
 * created by the hand-written SQL files in ./migrations (run via
 * `npm run migrate`, see src/migrate.js). That runner remains how the
 * *existing* 001/002/003 migrations get applied.
 *
 * From here on, make schema changes in src/db/schema.js first, then run
 * `npm run db:generate` to produce a new SQL migration file, and apply it
 * with `npm run db:migrate` (drizzle-kit's own runner) — this keeps schema
 * and SQL history in sync going forward instead of hand-writing new .sql
 * files in ./migrations.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../backend/.env") });

/** @type {import('drizzle-kit').Config} */
module.exports = {
  schema: "./src/db/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      `postgres://${process.env.PGUSER || "postgres"}:${process.env.PGPASSWORD || ""}@${
        process.env.PGHOST || "localhost"
      }:${process.env.PGPORT || "5432"}/${process.env.PGDATABASE || "tgg"}`,
  },
};