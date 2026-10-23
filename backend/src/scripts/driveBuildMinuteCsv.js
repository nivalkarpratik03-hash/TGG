/**
 * backend/src/scripts/driveBuildMinuteCsv.js
 * AFTER-CLOSE step of the daily options -> Parquet -> Drive test.   NIFTY only for now.
 * Builds the 1-minute CSV that sir will review. Writes NOTHING to the database.
 *
 * REUSES the existing "Dynamic ATM" export (services/bulkOptionFetch.js) - the same
 * code the Data Export page uses - so ATM +-N following spot, OI and IV are not
 * re-implemented here. For each cycle (weekly, monthly) it asks for the day's
 * 1-minute rows with OI and IV, then adds:
 *   - cycle                 weekly / monthly
 *   - symbol                real Fyers symbol (from the option chain)
 *   - quote_changes_in_minute, last_bid, last_ask, last_quote_time
 *                           from quote_changes.csv written by driveLiveCapture.js
 *                           (the LAST bid/ask change at or before the end of that minute,
 *                           matched on EXCHANGE time, whole seconds; last_quote_time is exchange time)
 *
 * RUN (after the close, inside backend/, valid Fyers token):
 *   cd backend
 *   node src/scripts/driveBuildMinuteCsv.js
 *   node src/scripts/driveBuildMinuteCsv.js --date 2026-10-05 --out drive_test_2026-10-05
 *
 *   --date YYYY-MM-DD  trading day (default today IST). Contracts must still be live.
 *   --root NIFTY       default: first root in symbols/drive-export-roots.json
 *   --width 2          strikes each side of ATM (default: the root's atmWidth)
 *   --out <folder>     default backend/drive_test_<date> (same folder as the live capture)
 *   --quotes <file>    quote_changes.csv to join (default: <out>/quote_changes.csv)
 *   --cycles weekly,monthly   build only these cycles (default: all of the root's cycles)
 *
 * EXPIRY GUARD: the cycle's expiry is taken from the capture's own quote_changes.csv. If Fyers now lists a different
 * expiry as the nearest weekly/monthly (e.g. the weekly you captured has expired), that cycle is SKIPPED with a message
 * instead of being filled with another expiry's data. Run this script right after 15:41 on an expiry day.
 *
 * Output: <out>/minute_candles_<date>.csv  + a printed check list.
 */
"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const { validateToken, fetchOptionChain } = require("../fyers/client");
const { findCuratedEntry } = require("../derivatives/curatedUnderlyingsLoader");
const { runBulkOptionFetch } = require("../services/bulkOptionFetch");
const S = require("../driveExport/driveShared");

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };

const COLS = ["minute_time", "underlying", "cycle", "expiry_date", "strike", "option_type", "atm_offset", "symbol",
  "open", "high", "low", "close", "volume", "oi", "iv", "underlying_price",
  "quote_changes_in_minute", "last_bid", "last_ask", "last_quote_time"];

(async () => {
  const roots = S.loadDriveRoots();
  const root = roots.find((r) => r.name === String(opt("root", roots[0].name)).toUpperCase());
  if (!root) throw new Error(`Root not in symbols/drive-export-roots.json. Available: ${roots.map((r) => r.name).join(", ")}`);
  const width = Number(opt("width", root.atmWidth));
  const date = opt("date", S.istDate(Date.now()));
  const outDir = path.resolve(opt("out", path.resolve(__dirname, `../../drive_test_${date}`)));

  if (!(await validateToken())) { console.error("Fyers token missing or invalid. Connect via /admin, then run again."); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });   // only after the token check, so a failed start leaves no empty folder
  const entry = findCuratedEntry(root.name, root.exchange);
  if (!entry || !entry.spotSymbol) throw new Error(`No spot symbol for ${root.name} in the curated list.`);

  // quote changes from the live capture (optional)
  const quotesFile = path.resolve(opt("quotes", path.join(outDir, "quote_changes.csv")));
  const quotesByKey = new Map(), capExpiry = {};   // capExpiry[cycle] -> Map(expiry_date -> rows)
  if (fs.existsSync(quotesFile)) {
    for (const q of S.readCsv(quotesFile)) {
      const em = (capExpiry[q.cycle] = capExpiry[q.cycle] || new Map()); em.set(q.expiry_date, (em.get(q.expiry_date) || 0) + 1);
      const key = `${q.expiry_date}|${Number(q.strike)}|${q.option_type}`;
      if (!quotesByKey.has(key)) quotesByKey.set(key, []);
      // Join on the EXCHANGE time (exch_feed_time, whole seconds), not our PC clock: a PC clock that is
      // a few seconds off would otherwise push quotes into the wrong minute. Falls back to recv_ms if absent.
      const exch = Number(q.exch_feed_time);
      quotesByKey.get(key).push({ ms: Number.isFinite(exch) && exch > 0 ? exch * 1000 : Number(q.recv_ms), bid: q.bid, ask: q.ask });
    }
    for (const l of quotesByKey.values()) l.sort((a, b) => a.ms - b.ms);   // stable: same-second rows keep file (arrival) order
    console.log(`Joined quote changes from ${quotesFile} (${quotesByKey.size} contracts).`);
  } else {
    console.log(`No quote_changes.csv at ${quotesFile} - bid/ask columns will be empty.`);
  }

  console.log(`\nBuilding minute data for ${date}${date === S.istDate(Date.now()) ? "  (today: a partial day if the market is still open)" : ""}`);
  console.log(`Resolving expiries for ${root.name} ...`);
  const found = await S.resolveCycles(fetchOptionChain, entry.spotSymbol);
  console.table(found.table);

  const out = [];
  const report = [];
  for (const cycleName of root.cycles) {
    if (opt("cycles", null) && !String(opt("cycles")).split(",").includes(cycleName)) continue;
    const c = found[cycleName];
    if (!c) { report.push(`${cycleName}: NO live expiry found - skipped`); continue; }
    const ce = capExpiry[cycleName];
    if (ce && ce.size) {
      const expected = [...ce.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (expected !== c.dateIso) {
        const msg = `${cycleName}: SKIPPED - the capture followed expiry ${expected}, but Fyers now lists ${c.dateIso} as the nearest ${cycleName}. Building it would label another expiry's data as this one. (An expired contract is no longer listed; run this script right after 15:41 on expiry day.)`;
        console.log(`\n${msg}`); report.push(msg); continue;
      }
    }
    console.log(`\n=== ${cycleName}  expiry ${c.date} ===`);
    // symbol lookup for this expiry
    const chain = await fetchOptionChain(entry.spotSymbol, { strikeCount: 30, timestamp: c.expiry });
    const symOf = new Map(chain.strikes.map((s) => [`${s.strike_price}|${s.option_type}`, s.symbol]));
    const res = await runBulkOptionFetch({
      underlying: root.name, exchange: root.exchange, mode: "dynamic", atmWidth: width,
      expiryDate: c.date, from: date, to: date, timeframe: "1min", includeOI: true, includeIV: true,
      onProgress: ({ done, total, symbol }) => process.stdout.write(`\r  fetching ${done}/${total} ${symbol}        `),
    });
    console.log(`\n  ${res.rows.length} rows, ${res.fetched.length} contracts, ${res.skipped.length} skipped`);
    for (const s of res.skipped) console.log(`  skipped ${s.symbol || s.strike}: ${s.reason}`);
    let withQuote = 0, nullIv = 0, nullOi = 0;
    const perMinute = new Map();
    for (const r of res.rows) {
      const ms = Date.parse(`${r.Date}T${r.Time}+05:30`);
      const key = `${c.dateIso}|${r.Strike}|${r.Type}`;
      const qm = S.quotesForMinute(quotesByKey.get(key), ms);
      if (qm.count) withQuote++;
      if (r.IV === undefined || r.IV === null || r.IV === "") nullIv++;
      if (r.OI === undefined || r.OI === null || r.OI === "") nullOi++;
      perMinute.set(ms, (perMinute.get(ms) || 0) + 1);
      out.push({
        minute_time: `${r.Date} ${r.Time}`, underlying: r.Underlying, cycle: cycleName, expiry_date: c.dateIso, strike: r.Strike,
        option_type: r.Type, atm_offset: r["Steps from ATM"], symbol: symOf.get(`${r.Strike}|${r.Type}`) || "",
        open: r.Open, high: r.High, low: r.Low, close: r.Close, volume: r.Volume, oi: r.OI, iv: r.IV, underlying_price: r.Spot,
        quote_changes_in_minute: qm.count, last_bid: qm.last ? qm.last.bid : "", last_ask: qm.last ? qm.last.ask : "",
        last_quote_time: qm.last ? S.istStamp(qm.last.ms, true) : "",
      });
    }
    const counts = [...perMinute.values()];
    report.push(
      `${cycleName} (${c.date}): rows ${res.rows.length}, minutes ${perMinute.size}, contracts/minute min ${Math.min(...counts)} max ${Math.max(...counts)} (expected ${(2 * (2 * width + 1))}), ` +
      `empty IV ${nullIv}, empty OI ${nullOi}, rows with a bid/ask change in the minute ${withQuote} (${((withQuote / res.rows.length) * 100).toFixed(1)}%)`
    );
  }
  if (!out.length) { console.log("\nCHECK LIST"); report.forEach((l) => console.log("  " + l)); throw new Error("No rows produced (every cycle was skipped)."); }

  out.sort((a, b) => a.cycle.localeCompare(b.cycle) || a.minute_time.localeCompare(b.minute_time) || a.strike - b.strike || a.option_type.localeCompare(b.option_type));
  const file = path.join(outDir, `minute_candles_${date}.csv`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const w = S.makeCsvWriter(file, COLS);
  for (const r of out) w.row(r);
  await w.close();

  console.log("\nCHECK LIST");
  report.forEach((l) => console.log("  " + l));
  console.log(`\nWritten: ${file}  (${out.length} rows)`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });