/**
 * backend/src/scripts/candleLagTest.js
 * ─────────────────────────────────────────────────────────────────────────
 * ONE symbol (default NSE:NIFTY50-INDEX), ONE timeframe (1 minute).
 *
 * This runs the REST-candle path sir proposed and times every step:
 *
 *   bar closes ──► REST returns the bar ──► values stop changing ──► row is
 *   committed in Postgres (candles table)
 *
 * For every 1-minute bar that closes in market hours it polls Fyers REST at
 * +2, +5, +10, +20, +40 s after the close, then upserts the final REST bar
 * into the candles table and records, per bar:
 *
 *   first_seen_s    seconds after close until REST returned the bar at all
 *   stable_s        seconds after close until the REST values stopped changing
 *   committed_lag_s seconds after close until the row was COMMITTED in Postgres
 *   db_write_ms     how long the Postgres upsert itself took
 *   tick_*          what the candles table held for that minute BEFORE the REST
 *                   write (the tick-built bar), incl. tick_inserted_at
 *
 * Everything goes to its own table, candle_lag_log (never overwritten).
 * This script is separate from migration 007 / engine_state.
 *
 * USAGE (from the backend folder, token valid via /admin, backend running):
 *   node src/scripts/candleLagTest.js               live run, 09:15-15:29 IST
 *   node src/scripts/candleLagTest.js --no-write    measure REST only, do not write candles
 *   node src/scripts/candleLagTest.js --report      report for today, no polling
 *   node src/scripts/candleLagTest.js --report 2026-10-01
 *   node src/scripts/candleLagTest.js --symbol NSE:NIFTY50-INDEX
 *
 * Keep the PC clock synced (Windows: Settings > Time > Sync now); every lag
 * is measured against this machine's clock.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { fetchCandles, validateToken } = require("../fyers/client");
const { pool } = require("../../../database/src/pool");
const { upsertCandles } = require("../../../database/src/store/candleStore");

const OFFSETS_S = [2, 5, 10, 20, 40]; // seconds after bar close
const MARKET_OPEN_MIN = 9 * 60 + 15;  // 09:15 IST as minutes since midnight
const LAST_BAR_MIN = 15 * 60 + 29;    // the 15:29 bar is the last bar of the day
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

// ── args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};
const SYMBOL = argVal("--symbol") || "NSE:NIFTY50-INDEX";
const WRITE_CANDLES = !args.includes("--no-write");
const REPORT_ONLY = args.includes("--report");
const REPORT_DATE = argVal("--report");

// ── helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const sleepUntil = (tsMs) => sleep(tsMs - Date.now());
const istMinuteOfDay = (tsMs) => Math.floor(((tsMs + IST_OFFSET_MS) % 86400000) / 60000);
const istDate = (tsMs) => new Date(tsMs + IST_OFFSET_MS).toISOString().slice(0, 10);
const istWeekday = (tsMs) => new Date(tsMs + IST_OFFSET_MS).getUTCDay(); // 0 Sun .. 6 Sat
const hhmm = (tsMs) => new Date(tsMs + IST_OFFSET_MS).toISOString().slice(11, 19);
const sameValues = (a, b) =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candle_lag_log (
      symbol           TEXT        NOT NULL,
      bar_time         TIMESTAMPTZ NOT NULL,
      close_time       TIMESTAMPTZ NOT NULL,
      first_seen_s     NUMERIC,
      stable_s         NUMERIC,
      stable_confirmed BOOLEAN,
      open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION,
      close DOUBLE PRECISION, volume BIGINT,
      polls            JSONB       NOT NULL,
      logged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (symbol, bar_time)
    )`);
  for (const col of [
    "committed_at TIMESTAMPTZ", "committed_lag_s NUMERIC", "db_write_ms INTEGER", "db_written BOOLEAN",
    "tick_open DOUBLE PRECISION", "tick_high DOUBLE PRECISION", "tick_low DOUBLE PRECISION",
    "tick_close DOUBLE PRECISION", "tick_volume BIGINT", "tick_inserted_at TIMESTAMPTZ",
  ]) {
    await pool.query(`ALTER TABLE candle_lag_log ADD COLUMN IF NOT EXISTS ${col}`);
  }
}

/** Poll Fyers REST for one bar at each offset after its close. */
async function measureBar(barStartMs) {
  const closeMs = barStartMs + 60000;
  const polls = []; // { at_s, at_iso, found, open.. }

  for (const off of OFFSETS_S) {
    await sleepUntil(closeMs + off * 1000);
    let found = null;
    let err = null;
    try {
      const candles = await fetchCandles(SYMBOL, 1, 10000, 1);
      found = candles.find((c) => c.time === barStartMs) || null;
    } catch (e) {
      err = e.message;
    }
    const nowMs = Date.now(); // moment the answer arrived
    polls.push({
      at_s: +((nowMs - closeMs) / 1000).toFixed(2),
      at_iso: new Date(nowMs).toISOString(),
      found: !!found,
      ...(found ? { open: found.open, high: found.high, low: found.low, close: found.close, volume: found.volume } : {}),
      ...(err ? { error: err } : {}),
    });

    // stop early once the bar has been returned twice with identical values
    const seen = polls.filter((p) => p.found);
    if (seen.length >= 2 && sameValues(seen[seen.length - 1], seen[seen.length - 2])) break;
  }

  const seen = polls.filter((p) => p.found);
  if (seen.length === 0) {
    return { barStartMs, closeMs, polls, first_seen_s: null, stable_s: null, confirmed: false, final: null };
  }
  const last = seen[seen.length - 1];
  let idx = seen.length - 1; // earliest poll in the trailing run of identical values
  while (idx > 0 && sameValues(seen[idx - 1], last)) idx--;
  return {
    barStartMs, closeMs, polls,
    first_seen_s: seen[0].at_s,
    stable_s: seen[idx].at_s,
    confirmed: seen.length - idx >= 2,
    final: last,
  };
}

/** Read the bar the candles table holds BEFORE we write the REST one (tick-built). */
async function readExistingBar(barStartMs) {
  const { rows } = await pool.query(
    `SELECT open, high, low, close, volume, inserted_at
       FROM candles WHERE symbol = $1 AND resolution = 1 AND time = to_timestamp($2/1000.0)`,
    [SYMBOL, barStartMs]);
  return rows[0] || null;
}

async function saveResult(r) {
  const f = r.final || {};
  const tick = await readExistingBar(r.barStartMs);

  // ── the REST-candle write: this timestamp is "landed in Postgres" ──
  let committedAt = null, dbWriteMs = null, dbWritten = null;
  if (WRITE_CANDLES && r.final) {
    const t0 = Date.now();
    let n = 0;
    try {
      n = await upsertCandles(SYMBOL, 1, [{
        time: r.barStartMs, open: f.open, high: f.high, low: f.low, close: f.close, volume: f.volume,
      }]);
    } catch (e) {
      console.error("[LagTest] upsert failed:", e.message);
    }
    committedAt = Date.now();
    dbWriteMs = committedAt - t0;
    dbWritten = n > 0; // false if STORE_SPOT=false or the candle failed validation
  }

  await pool.query(
    `INSERT INTO candle_lag_log
       (symbol, bar_time, close_time, first_seen_s, stable_s, stable_confirmed,
        open, high, low, close, volume, polls,
        committed_at, committed_lag_s, db_write_ms, db_written,
        tick_open, tick_high, tick_low, tick_close, tick_volume, tick_inserted_at)
     VALUES ($1, to_timestamp($2/1000.0), to_timestamp($3/1000.0), $4,$5,$6,$7,$8,$9,$10,$11,$12,
             CASE WHEN $13::bigint IS NULL THEN NULL ELSE to_timestamp($13/1000.0) END,
             $14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (symbol, bar_time) DO NOTHING`,
    [SYMBOL, r.barStartMs, r.closeMs, r.first_seen_s, r.stable_s, r.confirmed,
     f.open ?? null, f.high ?? null, f.low ?? null, f.close ?? null, f.volume ?? null,
     JSON.stringify(r.polls),
     committedAt, committedAt ? +((committedAt - r.closeMs) / 1000).toFixed(2) : null, dbWriteMs, dbWritten,
     tick?.open ?? null, tick?.high ?? null, tick?.low ?? null, tick?.close ?? null, tick?.volume ?? null,
     tick?.inserted_at ?? null]
  );
  return { committedAt, dbWriteMs, dbWritten };
}

async function report(dateStr) {
  const day = dateStr || istDate(Date.now());
  const where = `symbol = $1 AND (bar_time AT TIME ZONE 'Asia/Kolkata')::date = $2::date`;
  const pct = (col, p) => `round(percentile_cont(${p}) WITHIN GROUP (ORDER BY ${col})::numeric, 2)`;

  const { rows: [s] } = await pool.query(
    `SELECT count(*)::int AS bars,
            count(first_seen_s)::int AS bars_seen,
            count(*) FILTER (WHERE first_seen_s IS NULL)::int AS never_seen,
            count(*) FILTER (WHERE stable_confirmed = false AND first_seen_s IS NOT NULL)::int AS unconfirmed,
            ${pct("first_seen_s", 0.5)} AS fs_med, ${pct("first_seen_s", 0.95)} AS fs_p95, round(max(first_seen_s),2) AS fs_max,
            ${pct("stable_s", 0.5)} AS st_med, ${pct("stable_s", 0.95)} AS st_p95, round(max(stable_s),2) AS st_max,
            ${pct("committed_lag_s", 0.5)} AS cm_med, ${pct("committed_lag_s", 0.95)} AS cm_p95, round(max(committed_lag_s),2) AS cm_max,
            count(committed_at)::int AS committed, count(*) FILTER (WHERE db_written = false)::int AS not_written,
            round(avg(db_write_ms)::numeric,1) AS db_avg_ms, max(db_write_ms) AS db_max_ms,
            ${pct("EXTRACT(EPOCH FROM (tick_inserted_at - close_time))", 0.5)} AS tk_med,
            ${pct("EXTRACT(EPOCH FROM (tick_inserted_at - close_time))", 0.95)} AS tk_p95,
            round(max(EXTRACT(EPOCH FROM (tick_inserted_at - close_time)))::numeric,2) AS tk_max,
            count(tick_inserted_at)::int AS tick_rows,
            count(*) FILTER (WHERE tick_open IS NULL)::int AS tick_missing,
            count(*) FILTER (WHERE tick_open IS NOT NULL AND (abs(tick_high-high) > 0.005 OR abs(tick_low-low) > 0.005))::int AS hl_differ,
            count(*) FILTER (WHERE tick_open IS NOT NULL AND (abs(tick_open-open) > 0.005 OR abs(tick_close-close) > 0.005))::int AS oc_differ,
            round(max(greatest(abs(tick_high-high), abs(tick_low-low)))::numeric,2) AS worst_hl
       FROM candle_lag_log WHERE ${where}`, [SYMBOL, day]);

  const { rows: last } = await pool.query(
    `SELECT first_seen_s, stable_s, committed_lag_s FROM candle_lag_log
      WHERE ${where} AND (bar_time AT TIME ZONE 'Asia/Kolkata')::time = '15:29'`, [SYMBOL, day]);
  const { rows: [tbl] } = await pool.query(
    `SELECT count(*)::int AS n FROM candles
      WHERE symbol=$1 AND resolution=1 AND (time AT TIME ZONE 'Asia/Kolkata')::date = $2::date`, [SYMBOL, day]);

  console.log(`\n===== Candle lag report | ${SYMBOL} | ${day} =====`);
  console.log(`bars logged: ${s.bars} (full day = 375) | seen on REST: ${s.bars_seen} | never seen: ${s.never_seen}`);
  console.log(`\nSeconds after the bar CLOSED until:`);
  console.log(`  REST returned the bar        median ${s.fs_med}  p95 ${s.fs_p95}  max ${s.fs_max}`);
  console.log(`  REST values stopped changing median ${s.st_med}  p95 ${s.st_p95}  max ${s.st_max}   (not confirmed in window: ${s.unconfirmed})`);
  console.log(`  row COMMITTED in Postgres    median ${s.cm_med}  p95 ${s.cm_p95}  max ${s.cm_max}   (${s.committed} written, ${s.not_written} not written)`);
  console.log(`  Postgres upsert itself took  avg ${s.db_avg_ms} ms, max ${s.db_max_ms} ms`);
  console.log(`\nCurrent tick path (what candles held before the REST write):`);
  console.log(`  landed in Postgres after close: median ${s.tk_med}  p95 ${s.tk_p95}  max ${s.tk_max}  (${s.tick_rows} bars; ${s.tick_missing} had no row yet)`);
  console.log(`  caveat: tick_inserted_at is only the first-write time if nothing rewrote that row before the test read it`);
  console.log(`\nTick-built vs REST, same minute: high/low differ ${s.hl_differ}, open/close differ ${s.oc_differ}, worst high/low gap ${s.worst_hl} points`);
  console.log(last.length
    ? `\n15:29 bar: logged | first_seen ${last[0].first_seen_s}s | stable ${last[0].stable_s}s | committed ${last[0].committed_lag_s}s after close`
    : `\n15:29 bar: NOT in the log`);
  console.log(`rows in candles table for this day: ${tbl.n}\n`);
}

async function main() {
  await ensureTable();

  if (REPORT_ONLY) {
    await report(REPORT_DATE);
    return;
  }

  const wd = istWeekday(Date.now());
  if (wd === 0 || wd === 6) {
    console.error("Today is a weekend in IST - the market is closed. Nothing to measure.");
    return;
  }
  if (!(await validateToken())) {
    console.error("Fyers token is not valid. Connect via /admin first.");
    process.exit(1);
  }
  console.log(`[LagTest] ${SYMBOL} 1m | polls at +${OFFSETS_S.join(", +")}s | write-candles=${WRITE_CANDLES}`);
  console.log(`[LagTest] If today is an exchange holiday, bars will show NEVER - ignore that day's results.`);

  for (;;) {
    const barStart = Math.floor(Date.now() / 60000) * 60000; // the bar forming right now
    const m = istMinuteOfDay(barStart);

    if (m > LAST_BAR_MIN) break;
    if (m < MARKET_OPEN_MIN) {
      await sleepUntil(barStart + 60000);
      continue;
    }

    const r = await measureBar(barStart);
    const w = await saveResult(r);
    console.log(
      `[LagTest] ${hhmm(barStart)} bar | seen ${r.first_seen_s ?? "NEVER"}s | stable ${r.stable_s ?? "-"}s` +
      `${r.confirmed ? "" : " (unconfirmed)"} | committed ${w.committedAt ? ((w.committedAt - r.closeMs) / 1000).toFixed(2) + "s" : "-"}` +
      `${w.dbWriteMs != null ? ` (db ${w.dbWriteMs}ms)` : ""}${w.dbWritten === false ? " NOT WRITTEN" : ""}`
    );
  }

  console.log("[LagTest] 15:29 bar done.");
  await report();
}

main()
  .catch((e) => { console.error("[LagTest] fatal:", e); process.exitCode = 1; })
  .finally(() => pool.end());
