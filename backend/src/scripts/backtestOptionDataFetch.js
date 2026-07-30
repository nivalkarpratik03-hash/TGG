/**
 * backend/src/scripts/backtestOptionDataFetch.js
 * ─────────────────────────────────────────────────────────────────────────
 * Builds the raw data set for NIFTY monthly-option backtesting, in 1-min
 * candles (any higher timeframe — 5m/15m/1h/D — can be derived from this
 * later, same as candleBuilder.deriveTimeframe does elsewhere in this repo).
 *
 * PIPELINE
 *   Step 1 — fetch NIFTY50-INDEX 1-min spot candles for the requested
 *            window, compute the nearest-50 ATM strike for every candle,
 *            and collect the SET of unique strikes that were ATM at any
 *            point in that window.
 *   Step 2 — call Fyers getOptionChain (via fetchOptionChain) for the
 *            CURRENT live expiry to get the real, exchange-confirmed CE
 *            and PE symbol string for each of those strikes.
 *   Step 3 — for every resolved CE/PE symbol, fetch its FULL 1-min
 *            candle history over the same window (the whole life of
 *            that strike in range, not just from the moment it became
 *            ATM), same as any other symbol via fetchCandles.
 *   Step 4 — attach derived columns (distance from ATM, steps from ATM,
 *            is_atm flag, days to expiry), SORT into a single
 *            chronological timeline (date, time, strike, option_type)
 *            instead of leaving rows grouped block-by-symbol, and write
 *            three sheets: option_candles, spot_reference,
 *            atm_transitions.
 *
 * USAGE
 *   node src/scripts/backtestOptionDataFetch.js \
 *     --from 2026-07-01 --to 2026-07-23 \
 *     --expiry 2026-07-28 --expiryCode 26JUL \
 *     [--out backtest_nifty_jul2026.xlsx]
 *
 * NOTES
 *   - --expiry / --expiryCode must match the CURRENTLY LIVE monthly
 *     contract's real expiry date + Fyers code (e.g. NIFTY26JUL...).
 *   - Requires a valid Fyers access token already generated via
 *     generate.js, exactly like every other script in backend/src.
 *   - Only ever targets the CURRENT, not-yet-expired contract.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const path = require("path");
const XLSX = require("xlsx");
const { fetchCandles, fetchOptionChain } = require("../fyers/client");

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

const NIFTY_SPOT_SYMBOL = "NSE:NIFTY50-INDEX";
const NIFTY_STRIKE_STEP = 50;
const RESOLUTION = "1"; // 1-min candles — every other timeframe is derived from this later
const CHAIN_POLITE_DELAY_MS = 300; // small gap between per-symbol calls, same spirit as backtestRunner.js BATCH_DELAY_MS

// Proxy volume source for VWAP (NSE:NIFTY50-INDEX itself always returns volume = 0 from
// Fyers -- confirmed against a real Fyers history response for this exact symbol). NIFTY
// futures are a genuinely traded instrument, so their volume is real. Symbol format follows
// the same "NIFTY{expiryCode}FUT" convention already used for options in this file -- reused,
// not independently guessed -- but still UNVERIFIED against Fyers' live symbol master. Confirm
// this actually resolves before trusting any VWAP output.
function buildFuturesSymbol(expiryCode) {
  return `NSE:NIFTY${expiryCode}FUT`;
}

async function fetchFuturesVolumeSeries(fromDate, toDate, expiryCode) {
  const fromMs = toEpochSeconds(fromDate) * 1000;
  const toMs = toEpochSeconds(toDate, true) * 1000;
  const lookbackDays = Math.ceil((toMs - fromMs) / 86400000) + 1;
  const futSymbol = buildFuturesSymbol(expiryCode);

  console.log(`[Step 1b] Fetching futures volume proxy: ${futSymbol} ...`);
  let candles;
  try {
    candles = await fetchCandles(futSymbol, RESOLUTION, 200000, lookbackDays);
  } catch (err) {
    throw new Error(
      `[Step 1b] FAILED fetching ${futSymbol}: ${err.message}. Check this symbol actually ` +
      `exists in Fyers' symbol master for this expiry -- the format is a carried-over ` +
      `convention, not independently confirmed for futures.`
    );
  }

  const volumeByKey = new Map();
  for (const c of candles) {
    if (c.time < fromMs || c.time > toMs) continue;
    const { date, time } = toISTDateTime(c.time);
    volumeByKey.set(`${date} ${time}`, c.volume);
  }
  console.log(`[Step 1b] ${volumeByKey.size} futures volume minutes collected for ${futSymbol}.`);
  return { futSymbol, volumeByKey };
}

function attachFuturesVolume(spotReference, volumeByKey) {
  let matched = 0;
  for (const s of spotReference) {
    const v = volumeByKey.get(`${s.date} ${s.time}`);
    s.futures_volume = v === undefined ? 0 : v;
    if (v !== undefined) matched += 1;
  }
  const missing = spotReference.length - matched;
  if (missing > 0) {
    console.warn(`[Step 1b] WARNING -- ${missing}/${spotReference.length} spot minutes had no matching futures candle (set to 0).`);
  }
}

// ── CLI args ────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = (args[i] || "").replace(/^--/, "");
    out[key] = args[i + 1];
  }
  return out;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTDateTime(epochMs) {
  const dt = new Date(epochMs + IST_OFFSET_MS);
  return {
    date: dt.toISOString().slice(0, 10),
    time: dt.toISOString().slice(11, 19),
  };
}

function toEpochSeconds(dateStr, endOfDay = false) {
  const iso = `${dateStr}T${endOfDay ? "23:59:59" : "00:00:00"}+05:30`;
  return Math.floor(new Date(iso).getTime() / 1000);
}

function nearestStrike(spot, step = NIFTY_STRIKE_STEP) {
  return Math.round(spot / step) * step;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Step 1: spot candles → ATM per candle → unique strike set ──────────────
async function buildSpotReferenceAndStrikes(fromDate, toDate) {
  const fromMs = toEpochSeconds(fromDate) * 1000;
  const toMs = toEpochSeconds(toDate, true) * 1000;
  const lookbackDays = Math.ceil((toMs - fromMs) / 86400000) + 1;

  console.log(`[Step 1] Fetching NIFTY spot 1-min candles, ${lookbackDays}d lookback...`);
  const spotCandles = await fetchCandles(NIFTY_SPOT_SYMBOL, RESOLUTION, 200000, lookbackDays);

  const spotReference = [];
  const strikeSet = new Set();

  for (const c of spotCandles) {
    if (c.time < fromMs || c.time > toMs) continue;
    const atm = nearestStrike(c.close);
    strikeSet.add(atm);
    const { date, time } = toISTDateTime(c.time);
    spotReference.push({
      date,
      time,
      spot_open: c.open,
      spot_high: c.high,
      spot_low: c.low,
      spot_close: c.close,
      atm_strike: atm,
      futures_volume: null,
    });
  }

  // spot candles come back time-ascending already, but sort explicitly in
  // case of any chunk-boundary overlap — everything downstream depends on
  // this being in true chronological order.
  spotReference.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const strikes = [...strikeSet].sort((a, b) => a - b);
  console.log(`[Step 1] ${spotReference.length} spot candles in range. ${strikes.length} unique ATM strikes touched: ${strikes.join(", ")}`);
  return { spotReference, strikes };
}

// ── Step 2: resolve real CE/PE symbols for those strikes via live chain ────
async function resolveSymbolsForStrikes(strikes) {
  if (!strikes.length) return [];

  const minStrike = strikes[0];
  const maxStrike = strikes[strikes.length - 1];
  const strikesEachSide = Math.ceil((maxStrike - minStrike) / (2 * NIFTY_STRIKE_STEP)) + 10;

  console.log(`[Step 2] Requesting option chain, strikecount=${strikesEachSide} each side...`);
  const { strikes: chainStrikes, expiries } = await fetchOptionChain(NIFTY_SPOT_SYMBOL, {
    strikeCount: strikesEachSide,
  });

  if (expiries.length) {
    console.log(`[Step 2] Chain nearest expiries reported by Fyers: ${expiries.map((e) => e.date).join(", ")}`);
  }

  const wanted = new Set(strikes);
  const resolved = chainStrikes.filter((s) => wanted.has(s.strike_price));

  const foundStrikes = new Set(resolved.map((r) => r.strike_price));
  const missing = strikes.filter((st) => !foundStrikes.has(st));
  if (missing.length) {
    console.warn(`[Step 2] WARNING — strikes not returned by chain (outside strikecount, or not listed): ${missing.join(", ")}`);
  }

  console.log(`[Step 2] Resolved ${resolved.length} real CE/PE symbols (${resolved.length / 2} strikes × CE+PE, assuming both sides present).`);
  return resolved; // [{ symbol, strike_price, option_type, ltp, oi }, ...]
}

// ── Step 3: full 1-min history for every resolved CE/PE symbol ─────────────
async function fetchAllOptionCandles(resolvedStrikes, fromDate, toDate, expiryDate, expiryCode) {
  const fromMs = toEpochSeconds(fromDate) * 1000;
  const toMs = toEpochSeconds(toDate, true) * 1000;
  const lookbackDays = Math.ceil((toMs - fromMs) / 86400000) + 1;

  const rows = [];

  for (let i = 0; i < resolvedStrikes.length; i++) {
    const { symbol, strike_price, option_type, oi } = resolvedStrikes[i];
    console.log(`[Step 3] (${i + 1}/${resolvedStrikes.length}) ${symbol}`);

    let candles;
    try {
      candles = await fetchCandles(symbol, RESOLUTION, 200000, lookbackDays);
    } catch (err) {
      console.warn(`[Step 3] SKIPPED ${symbol}: ${err.message}`);
      continue;
    }

    for (const c of candles) {
      if (c.time < fromMs || c.time > toMs) continue;
      const { date, time } = toISTDateTime(c.time);
      rows.push({
        date,
        time,
        underlying: "NIFTY",
        expiry_date: expiryDate,
        expiry_code: expiryCode,
        symbol,
        strike: strike_price,
        option_type,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        oi: oi ?? "",
      });
    }

    if (i < resolvedStrikes.length - 1) await delay(CHAIN_POLITE_DELAY_MS);
  }

  console.log(`[Step 3] ${rows.length} total option candle rows collected (still symbol-blocked at this point).`);
  return rows;
}

// ── Step 4a: derived columns ────────────────────────────────────────────────
function addDerivedColumns(optionRows, spotReference, expiryDate) {
  const atmByTimestamp = new Map();
  const atmByDate = new Map(); // last value written per date = end-of-day ATM, used as fallback only
  for (const s of spotReference) {
    atmByTimestamp.set(`${s.date} ${s.time}`, s.atm_strike);
    atmByDate.set(s.date, s.atm_strike);
  }

  for (const row of optionRows) {
    const exactKey = `${row.date} ${row.time}`;
    const atm = atmByTimestamp.has(exactKey) ? atmByTimestamp.get(exactKey) : atmByDate.get(row.date);

    row.distance_from_atm = atm != null ? row.strike - atm : "";
    row.strike_steps_from_atm = atm != null ? (row.strike - atm) / NIFTY_STRIKE_STEP : "";
    row.is_atm = atm != null ? row.strike === atm : "";
    row.days_to_expiry = Math.round((new Date(expiryDate) - new Date(row.date)) / 86400000);
  }
}

// ── Step 4b: re-sort into ONE chronological timeline ────────────────────────
// Instead of "all of strike A's dates, then all of strike B's dates, ...",
// this produces "everything at 09:15, then everything at 09:16, ..." so
// scrolling down the sheet shows every strike side-by-side minute by minute,
// and which one has is_atm = TRUE at that instant — no jumping between
// symbol blocks to see what ATM was doing on a given day.
function sortChronologically(optionRows) {
  optionRows.sort((a, b) => {
    const tsA = `${a.date} ${a.time}`;
    const tsB = `${b.date} ${b.time}`;
    if (tsA !== tsB) return tsA.localeCompare(tsB);
    if (a.strike !== b.strike) return a.strike - b.strike;
    return a.option_type.localeCompare(b.option_type); // CE before PE at same strike/time
  });
}

// ── Step 4c: ATM-transition summary — "how many times did it change today" ──
// One row per moment the ATM strike actually changed (not one row per
// candle). Also carries a running per-day change count so "how many times
// did ATM change on X date" is a number you can read directly, not count by
// eye.
function buildAtmTransitions(spotReference) {
  const transitions = [];
  let lastAtm = null;
  let lastDate = null;
  let changeCountToday = 0;

  for (const s of spotReference) {
    if (s.date !== lastDate) {
      lastDate = s.date;
      changeCountToday = 0; // reset the counter for each new trading day
      lastAtm = null; // force the first candle of each day to log as a transition
    }
    if (s.atm_strike !== lastAtm) {
      changeCountToday += 1;
      transitions.push({
        date: s.date,
        time: s.time,
        atm_strike: s.atm_strike,
        change_number_today: changeCountToday,
        spot_close: s.spot_close,
      });
      lastAtm = s.atm_strike;
    }
  }

  return transitions;
}

// ── Write workbook ───────────────────────────────────────────────────────
function writeWorkbook(optionRows, spotReference, atmTransitions, outPath) {
  const wb = XLSX.utils.book_new();

  const optionSheet = XLSX.utils.json_to_sheet(optionRows, {
    header: [
      "date", "time", "underlying", "expiry_date", "expiry_code", "symbol",
      "strike", "option_type", "open", "high", "low", "close", "volume", "oi",
      "distance_from_atm", "strike_steps_from_atm", "is_atm", "days_to_expiry",
    ],
  });
  XLSX.utils.book_append_sheet(wb, optionSheet, "option_candles");

  const spotSheet = XLSX.utils.json_to_sheet(spotReference, {
    header: ["date", "time", "spot_open", "spot_high", "spot_low", "spot_close", "atm_strike", "futures_volume"],
  });
  XLSX.utils.book_append_sheet(wb, spotSheet, "spot_reference");

  const atmSheet = XLSX.utils.json_to_sheet(atmTransitions, {
    header: ["date", "time", "atm_strike", "change_number_today", "spot_close"],
  });
  XLSX.utils.book_append_sheet(wb, atmSheet, "atm_transitions");

  XLSX.writeFile(wb, outPath);
  console.log(
    `[Step 4] Wrote ${optionRows.length} option rows (chronological), ` +
    `${spotReference.length} spot rows, ${atmTransitions.length} ATM-transition rows -> ${outPath}`
  );
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const { from, to, expiry, expiryCode, out } = parseArgs();

  if (!from || !to || !expiry || !expiryCode) {
    console.error(
      "Usage: node backtestOptionDataFetch.js --from 2026-07-01 --to 2026-07-23 " +
      "--expiry 2026-07-28 --expiryCode 26JUL [--out backtest.xlsx]"
    );
    process.exit(1);
  }

  const outPath = out || path.join(__dirname, "..", "..", "backtest_output.xlsx");

  const { spotReference, strikes } = await buildSpotReferenceAndStrikes(from, to);
  const { volumeByKey } = await fetchFuturesVolumeSeries(from, to, expiryCode);
  attachFuturesVolume(spotReference, volumeByKey);
  const resolvedStrikes = await resolveSymbolsForStrikes(strikes);
  const optionRows = await fetchAllOptionCandles(resolvedStrikes, from, to, expiry, expiryCode);

  addDerivedColumns(optionRows, spotReference, expiry);
  sortChronologically(optionRows);
  const atmTransitions = buildAtmTransitions(spotReference);

  writeWorkbook(optionRows, spotReference, atmTransitions, outPath);
}

main().catch((err) => {
  console.error("[backtestOptionDataFetch] FATAL:", err);
  process.exit(1);
});