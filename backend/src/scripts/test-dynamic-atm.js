/**
 * backend/src/scripts/test-dynamic-atm.js
 * ─────────────────────────────────────────────────────────────────────────
 * ONE-OFF DIAGNOSTIC — read-only. Does NOT boot the server, does NOT touch
 * the DB, does NOT modify any existing file. Same style as test-oi-flag.js.
 *
 * Answers, on THIS account with LIVE data, the three questions that decide
 * whether "Dynamic ATM" (rotating ATM strike per candle) + IV can be built:
 *
 *   TEST 1 — FAR STRIKES: does the live chain for the target expiry list
 *            EVERY strike between the month's spot low and high (CE and PE),
 *            and does Fyers return 1-min history for the far ones going back
 *            to the start of the month?
 *   TEST 2 — GAPS: for 3 strikes (far / middle / near-ATM, CE+PE each), how
 *            many 1-min candles are missing versus Nifty spot's own 1-min
 *            candles on the same days? (Explains why CE rows < PE rows in
 *            your earlier exports.)
 *   TEST 3 — ALIGNMENT: do option candle timestamps match spot candle
 *            timestamps minute-for-minute? (Dynamic ATM and IV both join
 *            option rows to spot rows on this.)
 *
 * API CALLS: 1 spot history + 2 option-chain + 6 option history = 9 calls,
 * paced 700ms apart. No rate-limit risk.
 *
 * HOW TO RUN (inside backend/, valid Fyers token already saved via /admin):
 *   cd backend
 *   node src/scripts/test-dynamic-atm.js
 *   node src/scripts/test-dynamic-atm.js --from 2026-08-28 --expiry 29-09-2026
 *
 *   --from    YYYY-MM-DD   start of the window        (default 2026-08-28)
 *   --expiry  DD-MM-YYYY   or YYYY-MM-DD expiry to test (default 29-09-2026)
 *
 * Delete after use — it's a one-off check, not part of the app.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

require("dotenv").config();

const { validateToken, fetchCandles, fetchOptionChain } = require("../fyers/client");

const SPOT_SYMBOL = "NSE:NIFTY50-INDEX"; // symbols/index.json → NIFTY
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const CALL_DELAY_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── helpers ────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = (args[i] || "").replace(/^--/, "");
    out[key] = args[i + 1];
  }
  return out;
}

/** Accepts "YYYY-MM-DD" or "DD-MM-YYYY", returns "YYYY-MM-DD" (or null). */
function normDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function istDate(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function uniqueSortedStrikes(strikes) {
  return [...new Set(strikes.map((s) => s.strike_price))].sort((a, b) => a - b);
}

function deriveGap(sortedUnique) {
  let min = Infinity;
  for (let i = 1; i < sortedUnique.length; i++) {
    const g = sortedUnique[i] - sortedUnique[i - 1];
    if (g > 0 && g < min) min = g;
  }
  return Number.isFinite(min) ? min : null;
}

function nearestStrike(sortedUnique, target) {
  let best = null;
  for (const s of sortedUnique) {
    if (best === null || Math.abs(s - target) < Math.abs(best - target)) best = s;
  }
  return best;
}

function pct(a, b) {
  return b > 0 ? ((a / b) * 100).toFixed(2) + "%" : "n/a";
}

// ── per-contract analysis ─────────────────────────────────────────────────
/**
 * @param {string} label
 * @param {object[]} candles  fetchCandles() output, already >= fromMs
 * @param {Map<number, object>} spotByTime
 * @param {Map<string, number[]>} spotTimesByDate  date → spot candle times
 */
function analyseContract(label, candles, spotByTime, spotTimesByDate) {
  const optTimes = new Set(candles.map((c) => c.time));
  const dates = [...new Set(candles.map((c) => istDate(c.time)))].sort();
  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];

  // Spot minutes that SHOULD have an option candle: every spot candle from
  // the option's first candle date onward.
  let spotMinutesInSpan = 0;
  let matched = 0;
  const perDay = []; // {date, spot, opt}
  for (const [date, times] of spotTimesByDate) {
    if (date < firstDate) continue;
    let optCount = 0;
    for (const t of times) if (optTimes.has(t)) optCount++;
    spotMinutesInSpan += times.length;
    matched += optCount;
    perDay.push({ date, spot: times.length, opt: optCount });
  }
  const missing = spotMinutesInSpan - matched;

  // Option candles with NO spot candle at the same timestamp.
  let orphan = 0;
  for (const c of candles) if (!spotByTime.has(c.time)) orphan++;

  const zeroDays = perDay.filter((d) => d.opt === 0).length;
  const worst = perDay
    .filter((d) => d.opt < d.spot)
    .sort((a, b) => (b.spot - b.opt) - (a.spot - a.opt))
    .slice(0, 3);

  const oiNonZero = candles.filter((c) => Number.isFinite(c.oi) && c.oi !== 0).length;
  const oiMissing = candles.filter((c) => c.oi === undefined || c.oi === null).length;

  console.log(`  ${label}`);
  console.log(`    candles: ${candles.length} | first: ${firstDate} | last: ${lastDate} | days with data: ${dates.length}`);
  console.log(`    coverage vs spot minutes (from first day): ${matched}/${spotMinutesInSpan} = ${pct(matched, spotMinutesInSpan)} | missing minutes: ${missing} | days with ZERO candles: ${zeroDays}`);
  if (worst.length) {
    console.log(`    worst days: ${worst.map((d) => `${d.date} (${d.opt}/${d.spot})`).join(", ")}`);
  }
  console.log(`    timestamps with no matching spot candle: ${orphan}`);
  console.log(`    OI: non-zero ${oiNonZero} | missing field ${oiMissing} | of ${candles.length}`);

  return {
    label, n: candles.length, firstDate, coveragePct: spotMinutesInSpan ? (matched / spotMinutesInSpan) * 100 : 0,
    missing, orphan, zeroDays,
  };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  const FROM = normDate(args.from || "2026-08-28");
  const EXPIRY = normDate(args.expiry || "29-09-2026");
  if (!FROM) { console.error(`Bad --from "${args.from}" — use YYYY-MM-DD.`); process.exit(1); }
  if (!EXPIRY) { console.error(`Bad --expiry "${args.expiry}" — use DD-MM-YYYY or YYYY-MM-DD.`); process.exit(1); }

  const fromMs = new Date(`${FROM}T00:00:00+05:30`).getTime();
  if (Number.isNaN(fromMs)) { console.error(`Could not parse --from "${FROM}".`); process.exit(1); }
  const lookbackDays = Math.max(1, Math.ceil((Date.now() - fromMs) / 86400000));

  console.log(`\n=== Dynamic ATM / IV pre-build diagnostic ===`);
  console.log(`Spot: ${SPOT_SYMBOL} | window: ${FROM} → today | expiry under test: ${EXPIRY}\n`);

  if (!(await validateToken())) {
    console.error("Fyers token missing/invalid/expired. Regenerate it from the app's /admin page, then re-run.");
    process.exit(1);
  }
  console.log("Token OK.\n");

  const results = { far: null, gaps: [], orphanTotal: 0 };

  // ── Step 1: spot 1-min candles for the window ───────────────────────────
  console.log("── Step 1: Nifty spot 1-min candles ──");
  let spotAll;
  try {
    spotAll = await fetchCandles(SPOT_SYMBOL, 1, 999999, lookbackDays, false);
  } catch (err) {
    console.error(`Spot fetch failed: ${err.message}`);
    process.exit(1);
  }
  const spot = spotAll.filter((c) => c.time >= fromMs);
  if (spot.length === 0) { console.error("No spot candles in the window — cannot continue."); process.exit(1); }

  const spotByTime = new Map();
  const spotTimesByDate = new Map();
  for (const c of spot) {
    spotByTime.set(c.time, c);
    const d = istDate(c.time);
    if (!spotTimesByDate.has(d)) spotTimesByDate.set(d, []);
    spotTimesByDate.get(d).push(c.time);
  }
  const monthHigh = Math.max(...spot.map((c) => c.high));
  const monthLow = Math.min(...spot.map((c) => c.low));
  const lastClose = spot[spot.length - 1].close;
  const firstOpen = spot[0].open;
  const notMinuteAligned = spot.filter((c) => c.time % 60000 !== 0).length;
  console.log(`  ${spot.length} candles over ${spotTimesByDate.size} trading days`);
  console.log(`  first open ${firstOpen} | last close ${lastClose} | month high ${monthHigh} | month low ${monthLow}`);
  console.log(`  spot timestamps not on an exact minute boundary: ${notMinuteAligned}\n`);
  await sleep(CALL_DELAY_MS);

  // ── Step 2: live chain — probe, then wide band for the target expiry ────
  console.log("── Step 2: live option chain ──");
  const probe = await fetchOptionChain(SPOT_SYMBOL, { strikeCount: 2 });
  if (!probe.expiries.length || !probe.strikes.length) {
    console.error("Option chain returned nothing (token invalid, or no live chain right now).");
    process.exit(1);
  }
  console.log(`  live expiries: ${probe.expiries.map((e) => e.date).join(", ")}`);
  const target = probe.expiries.find((e) => normDate(e.date) === EXPIRY);
  if (!target) {
    console.error(`  Expiry ${EXPIRY} is not among the live expiries above. Re-run with --expiry set to one of them.`);
    process.exit(1);
  }
  const probeGap = deriveGap(uniqueSortedStrikes(probe.strikes));
  if (!probeGap) { console.error("Could not derive strike gap from the probe chain."); process.exit(1); }
  const atmNow = Math.round(lastClose / probeGap) * probeGap;

  const needEachSide = Math.max(
    Math.ceil((monthHigh - atmNow) / probeGap),
    Math.ceil((atmNow - monthLow) / probeGap),
    1
  ) + 2;
  await sleep(CALL_DELAY_MS);
  const chain = await fetchOptionChain(SPOT_SYMBOL, { strikeCount: needEachSide, timestamp: target.expiry });
  if (!chain.strikes.length) { console.error("Wide chain call returned no strikes."); process.exit(1); }

  const listedStrikes = uniqueSortedStrikes(chain.strikes);
  const gap = deriveGap(listedStrikes) || probeGap;
  const listedKeys = new Set(chain.strikes.map((s) => `${s.strike_price}|${s.option_type}`));
  const symbolByKey = new Map(chain.strikes.map((s) => [`${s.strike_price}|${s.option_type}`, s.symbol]));

  console.log(`  strike gap: ${gap} | ATM now: ${atmNow} | asked ±${needEachSide} strikes each side`);
  console.log(`  chain returned ${chain.strikes.length} contracts, strikes ${listedStrikes[0]} … ${listedStrikes[listedStrikes.length - 1]} (${listedStrikes.length} unique)`);

  // TEST 1a — is every strike in [monthLow, monthHigh] listed, CE and PE?
  const reqStart = Math.floor(monthLow / gap) * gap;
  const reqEnd = Math.ceil(monthHigh / gap) * gap;
  const missingListed = [];
  for (let k = reqStart; k <= reqEnd; k += gap) {
    for (const t of ["CE", "PE"]) if (!listedKeys.has(`${k}|${t}`)) missingListed.push(`${k}${t}`);
  }
  const requiredCount = ((reqEnd - reqStart) / gap + 1) * 2;
  console.log(`  TEST 1a: required strikes ${reqStart}…${reqEnd} (${requiredCount} contracts) → not listed: ${missingListed.length}`);
  if (missingListed.length) console.log(`           missing: ${missingListed.slice(0, 20).join(", ")}${missingListed.length > 20 ? " …" : ""}`);
  console.log("");

  // ── Step 3: 3 strikes × CE/PE — history, gaps, alignment ────────────────
  console.log("── Step 3: option 1-min history (OI on) for far / middle / near strikes ──");
  const farStrike = nearestStrike(listedStrikes, monthHigh);
  const midStrike = nearestStrike(listedStrikes, (monthHigh + atmNow) / 2);
  const nearStrike = nearestStrike(listedStrikes, atmNow);
  const picks = [
    { name: "FAR (near month high)", strike: farStrike },
    { name: "MIDDLE", strike: midStrike },
    { name: "NEAR (current ATM)", strike: nearStrike },
  ];

  let historyFailures = 0;
  let farHistoryOk = null;
  for (const p of picks) {
    for (const type of ["CE", "PE"]) {
      const symbol = symbolByKey.get(`${p.strike}|${type}`);
      if (!symbol) {
        console.log(`  ${p.name} ${p.strike}${type}: not in the chain — skipped`);
        historyFailures++;
        continue;
      }
      await sleep(CALL_DELAY_MS);
      let candles;
      try {
        const raw = await fetchCandles(symbol, 1, 999999, lookbackDays, true);
        candles = raw.filter((c) => c.time >= fromMs);
      } catch (err) {
        console.log(`  ${p.name} ${symbol}: FETCH FAILED — ${err.message}`);
        historyFailures++;
        if (p.name.startsWith("FAR")) farHistoryOk = false;
        continue;
      }
      if (candles.length === 0) {
        console.log(`  ${p.name} ${symbol}: 0 candles in window`);
        historyFailures++;
        if (p.name.startsWith("FAR")) farHistoryOk = false;
        continue;
      }
      const r = analyseContract(`${p.name} — ${symbol}`, candles, spotByTime, spotTimesByDate);
      results.gaps.push(r);
      results.orphanTotal += r.orphan;
      if (p.name.startsWith("FAR") && farHistoryOk !== false) {
        const firstSpotDate = [...spotTimesByDate.keys()].sort()[0];
        farHistoryOk = r.firstDate <= firstSpotDate;
      }
      console.log("");
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("=== RESULT ===");
  const t1 = missingListed.length === 0 && farHistoryOk === true;
  console.log(`TEST 1 FAR STRIKES : ${t1 ? "PASS" : "FAIL"} — ` +
    `${missingListed.length} required contracts not listed; far-strike history ${farHistoryOk === true ? "reaches back to the start of the window" : farHistoryOk === false ? "does NOT reach the start / failed" : "unknown"}.`);

  const worstCov = results.gaps.length ? Math.min(...results.gaps.map((g) => g.coveragePct)) : 0;
  const t2 = results.gaps.length > 0 && historyFailures === 0 && worstCov >= 99;
  console.log(`TEST 2 GAPS        : ${t2 ? "PASS" : "GAPS PRESENT"} — ` +
    `worst-contract coverage vs spot minutes: ${results.gaps.length ? worstCov.toFixed(2) + "%" : "n/a"}; ${historyFailures} contract fetch(es) failed/skipped. ` +
    `(Coverage < 99% means Fyers omits minutes with no trades — the export must then forward-fill or leave blanks; decide before building.)`);

  const t3 = results.gaps.length > 0 && results.orphanTotal === 0 && notMinuteAligned === 0;
  console.log(`TEST 3 ALIGNMENT   : ${t3 ? "PASS" : "FAIL"} — ` +
    `${results.orphanTotal} option candles with no same-timestamp spot candle; ${notMinuteAligned} spot candles off the minute boundary.`);

  console.log(`\nPaste this whole output back and we decide the build from it.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
