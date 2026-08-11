# Do NOT run `npm run db:migrate` on 0000_chunky_sersi.sql

This first migration file is a **baseline snapshot**, not something to execute.
It was generated from `src/db/schema.js`, which describes tables that
**already exist** in your database — created by the hand-written SQL files in
`../migrations/` (001_init, 002_repair_log_trading_day, 003_derivatives_tables,
004_bse_tables_and_oi), applied the normal way via `npm run migrate`.

If you run `db:migrate` on this file, it will try to `CREATE TABLE` things
that already exist and fail (or worse, partially apply).

**What this baseline is for:** it's the reference point Drizzle diffs against.
From now on:
1. Change `src/db/schema.js` when you need a real schema change.
2. Run `npm run db:generate` — it will produce a NEW migration file
   containing only the actual diff (verified: running `db:generate` again
   right after this baseline was created produced "No schema changes,
   nothing to migrate").
3. Review that new file, then apply it however you apply schema changes
   today (either `npm run db:migrate`, or copy it into `../migrations/` as
   `005_...sql` and run it through the existing `npm run migrate` runner —
   your call, both work since Drizzle's migrations are plain SQL).

(Note: the version you'd have gotten straight from your teammate's zip has
this same problem — his own shipped `drizzle/` snapshot was already
out of sync with his schema.js/migrations, confirmed by running
`db:generate` on his untouched zip, which produced an unexpected
"recreate everything" migration too. This isn't something the merge
introduced — it was already broken over there. This baseline fixes it.)
