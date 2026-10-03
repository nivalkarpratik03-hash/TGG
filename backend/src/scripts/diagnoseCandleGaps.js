/**
 * scripts/diagnoseCandleGaps.js
 * ─────────────────────────────────────────────────────────────────
 * READ-ONLY. Answers "why is this day still missing candles?" for ONE
 * symbol + ONE IST trading day by checking every stage of the pipeline:
 *
 *   1. DB      – which 1m candles exist, which expected minutes are missing.
 *   2. Validator – does validateCandleArray() flag it, and as which GAP?
 *   3. Broker  – is the token valid, and does Fyers actually HAVE those missing minutes?
 *                (if not, NO recovery can ever fill them from Fyers)
 *   4. repair_log – was this day already "repaired", i.e. would the scheduled
 *                validator skip it as a known-short day?
 *
 * Nothing is written to the DB.
 *
 * USAGE (from backend/):
 *   node src/scripts/diagnoseCandleGaps.js BSE:SENSEX-INDEX 2026-09-24
 * ─────────────────────────────────────────────────────────────────
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const symbol = process.argv[2];
const day = process.argv[3]; // IST date, YYYY-MM-DD
if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(day || "")) {
  console.error("Usage: node src/scripts/diagnoseCandleGaps.js SYMBOL YYYY-MM-DD");
  process.exit(1);
}

const IST = 5.5 * 3600e3, MIN = 60e3, DAY = 86400e3;
const hm = (ms) => new Date(ms + IST).toISOString().slice(11, 16);

async function main() {
  const db = require("../../../database/src/index");
  const { fetchCandles, validateToken } = require("../fyers/client");
  const { isTradingHoliday } = require("../data/holidays");
  db.setHolidayChecker((k) => { const [y, m, d] = k.split("-").map(Number); return y !== 2026 ? null : isTradingHoliday(new Date(y, m - 1, d, 12), "NSE"); });

  const dayStart = Date.parse(`${day}T00:00:00+05:30`);
  const sessionStart = dayStart + (9 * 60 + 15) * MIN;
  const sessionEnd = dayStart + (15 * 60 + 30) * MIN;
  console.log(`\n=== ${symbol} on ${day} (IST) ===\n`);

  // 1. DB
  const dbCandles = await db.loadCandles(symbol, 1, { from: new Date(dayStart), to: new Date(dayStart + DAY - 1), limit: 5000 });
  const have = new Set(dbCandles.map((c) => c.time));
  const expected = []; for (let t = sessionStart; t < sessionEnd; t += MIN) expected.push(t);
  const missing = expected.filter((t) => !have.has(t));
  console.log(`1. DB: ${dbCandles.length} candle(s) stored, ${missing.length} of ${expected.length} session minutes missing`);
  if (missing.length) {
    const runs = []; let s = missing[0], p = missing[0];
    for (const t of missing.slice(1)) { if (t - p > MIN) { runs.push([s, p]); s = t; } p = t; }
    runs.push([s, p]);
    console.log("   missing ranges (IST): " + runs.map(([a, b]) => (a === b ? hm(a) : `${hm(a)}–${hm(b)}`)).join(", "));
  }

  // 2. Validator
  const wide = await db.loadCandles(symbol, 1, { from: new Date(dayStart - 3 * DAY), to: new Date(dayStart + 4 * DAY), limit: 20000 });
  const { issues } = db.validateCandleArray(wide, 1);
  // whole-day check needs the full stored history, not just the 7-day window
  const all = await db.loadCandles(symbol, 1, { from: new Date(Date.now() - 90 * DAY), limit: 100000 });
  const covered = new Set(issues.filter((i) => i.type === "GAP").flatMap((i) => i.days || []));
  for (const m of db.findMissingTradingDays(symbol, all)) if (!covered.has(m.day)) issues.push(m);
  const forDay = db.summarizeGaps(issues).find((g) => g.day === day);
  console.log(`2. Validator: ${forDay ? `flags ${forDay.missingMinutes} missing minute(s) on this day` : "does NOT flag this day"}`);
  if (missing.length && !forDay) {
    console.log("   → missing minutes exist but the validator ignores them. Usual reasons: they sit within 10 min of the");
    console.log("     09:15 open / 15:30 close (BOUNDARY_TOLERANCE_MIN), or the calendar lists this day as an exchange holiday.");
  }

  // 3. Broker
  let tokenOk = false;
  try { tokenOk = await validateToken(); } catch (_) { }
  console.log(`3a. Fyers token valid: ${tokenOk}${tokenOk ? "" : "   ← scheduled Staleness/GapFill/Validator chain SKIPS everything while this is false"}`);
  if (tokenOk && missing.length) {
    const lookback = Math.ceil((Date.now() - dayStart) / DAY) + 2;
    const broker = await fetchCandles(symbol, 1, undefined, lookback);
    const onDay = broker.filter((c) => c.time >= dayStart && c.time < dayStart + DAY);
    const brokerHas = new Set(onDay.map((c) => c.time));
    const fillable = missing.filter((t) => brokerHas.has(t));
    console.log(`3b. Broker: Fyers returned ${onDay.length} candle(s) for the day; it HAS ${fillable.length} of the ${missing.length} minutes the DB lacks`);
    if (fillable.length === 0) console.log("   → Fyers itself has no data for those minutes. Recovery cannot fill them from Fyers.");
    else console.log("   → these are recoverable. Click Refresh (new build) or run the validator.");
  } else if (missing.length) {
    console.log("3b. Broker: skipped (no valid token)");
  }

  // 4. repair_log
  const hist = (await db.getRepairHistory(symbol, 200)).filter((r) => r.trading_day && new Date(r.trading_day).toISOString().slice(0, 10) === day);
  console.log(`4. repair_log: ${hist.length} entr${hist.length === 1 ? "y" : "ies"} for this day`);
  for (const r of hist.slice(0, 8)) console.log(`   ${new Date(r.started_at).toISOString()}  trigger=${r.trigger}  status=${r.status}  +${r.candles_inserted}/-${r.candles_deleted}  ${r.detail || ""}`);
  const known = await db.wasDayAlreadyRepaired(symbol, new Date(`${day}T12:00:00+05:30`), 3);
  console.log(`   scheduled validator would skip this day as 'known short': ${known}`);
  console.log("");
  process.exit(0);
}

main().catch((e) => { console.error("diagnose failed:", e); process.exit(1); });