/**
 * backend/src/services/bulkOptionFetch.js
 * ─────────────────────────────────────────────────────────────────────────
 * Powers the Data Export page's bulk option download: "give me ATM ± N
 * strikes" or "give me this explicit strike list", for a date range, in
 * ONE file — instead of the one-contract-at-a-time flow that made the
 * client run 8 separate downloads for 8 NIFTY strikes.
 *
 * REUSES, never re-implements:
 *   - fyers/client.js's fetchOptionChain()  — the SAME function
 *     derivativesGapFill.js's discoverStrikes() already uses to turn
 *     "underlying + band width" into real, broker-confirmed CE/PE symbols.
 *     Never hand-builds a symbol string.
 *   - derivatives/curatedUnderlyingsLoader.js's loadCuratedUnderlyings() —
 *     the SAME underlying → spot/futures-symbol + exchange + expiryTypes
 *     config every other derivatives feature in this app already reads.
 *     No second "NIFTY is special-cased" list (that was the exact
 *     complaint about the old backtestOptionDataFetch.js script).
 *   - derivativesGapFill.js's resolveChainLookupSymbol() and
 *     deriveStrikeGap() — same spot/futures resolution and same
 *     never-hardcode-the-strike-gap rule already established there.
 *   - derivativesGapFill.js's INTER_STRIKE_DELAY_MS — the SAME 600ms
 *     between-strike pacing already used for exactly this kind of
 *     sequential multi-strike Fyers call, not a re-guessed number.
 *   - services/candleExport.js's fetchCandleRows() — the SAME candle-row
 *     logic the single-symbol download and the CLI script already share.
 *
 * DYNAMIC ATM MODE (mode === "dynamic", added 2026-09-28): the ATM strike
 * is NOT frozen at today's live ATM — it FOLLOWS SPOT candle by candle. For
 * every option candle, the underlying's spot close at that same timestamp
 * (or, for post-close candles 15:30-15:39 where the spot index has no
 * candle, the LAST spot close of that same trading day) picks the nearest
 * listed strike; only that strike's candles (±atmWidth strikes, where
 * atmWidth 0 = ATM only) are kept. Every strike spot ever sat at during
 * the range is fetched (month low to month high of spot), then filtered
 * per candle. Verified live before building (see test-dynamic-atm.js run):
 * far strikes are listed + have full-month 1-min history, option and spot
 * timestamps align, and the 15:30-15:39 option-only candles are the only
 * misalignment. Output adds a "Spot" column (the spot close used to pick
 * ATM for that row) and "Steps from ATM" is relative to THAT candle's ATM.
 *
 * ATM VALUE: fetchOptionChain(underlying, {strikeCount: N}) returns a
 * symmetric band of 2N+1 strikes centered on Fyers' own live ATM — so the
 * middle element of the sorted, de-duplicated strike list IS the real ATM
 * Fyers used, derived from what was actually returned rather than
 * recomputed/guessed from a spot price separately.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { fetchOptionChain } = require("../fyers/client");
const { loadCuratedUnderlyings, findCuratedEntry } = require("../derivatives/curatedUnderlyingsLoader");
const { resolveChainLookupSymbol, deriveStrikeGap, INTER_STRIKE_DELAY_MS } = require("../derivatives/derivativesGapFill");
const { fetchCandleRows } = require("./candleExport");
const { fetchUnderlyingSpotMap, attachIV } = require("./ivEnrichment");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDateOf(epochMs) {
  return new Date(epochMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Greatest index i with sortedArr[i] <= x, or -1 if none. */
function lastIndexAtOrBefore(sortedArr, x) {
  let lo = 0, hi = sortedArr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedArr[mid] <= x) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/** Index in sortedStrikes of the strike nearest `price` (an exact tie goes to the lower strike). */
function nearestStrikeIndex(sortedStrikes, price) {
  const i = lastIndexAtOrBefore(sortedStrikes, price);
  if (i < 0) return 0;
  if (i === sortedStrikes.length - 1) return i;
  return (price - sortedStrikes[i]) <= (sortedStrikes[i + 1] - price) ? i : i + 1;
}

// findCuratedEntry() moved to derivatives/curatedUnderlyingsLoader.js
// (2026-09-24, IV feature) — imported above, single shared copy.

/** Sorted, de-duplicated strike prices from a fetchOptionChain strikes[] array. */
function uniqueSortedStrikes(strikes) {
  return [...new Set(strikes.map((s) => s.strike_price))].sort((a, b) => a - b);
}

/**
 * @param {object} params
 * @param {string} params.underlying    e.g. "NIFTY"
 * @param {string} [params.exchange]    "NSE" | "BSE" — disambiguates when needed
 * @param {"atm"|"strikes"|"dynamic"} params.mode
 * @param {number} [params.atmWidth]    used when mode==="atm"; defaults to this
 *                                      app's own curatedUnderlyings.json atmBandWidth.
 *                                      In mode==="dynamic" it is the strikes-each-side
 *                                      count around the rotating ATM; 0 = ATM only.
 * @param {number[]} [params.strikes]   used when mode==="strikes"
 * @param {string[]} [params.optionTypes=["CE","PE"]]
 * @param {string} [params.expiryDate]  "YYYY-MM-DD" — omit for the nearest live expiry
 * @param {string} params.from          "YYYY-MM-DD"
 * @param {string} [params.to]          "YYYY-MM-DD"
 * @param {string} [params.timeframe="1day"]
 * @param {Function} [params.onProgress]  ({done, total, symbol}) => void
 * @returns {Promise<{rows: object[], fetched: string[], skipped: {symbol?:string, strike?:number, reason:string}[],
 *   clipped: boolean, clipMessage: string|null, expiryUsed: string, atmStrike: number|null, strikeGap: number|null}>}
 */
async function runBulkOptionFetch(params) {
  const {
    underlying, exchange, mode, atmWidth, strikes: requestedStrikes,
    optionTypes = ["CE", "PE"], expiryDate, from, to, timeframe = "1day",
    includeOI = false,
    includeIV = false,
    onProgress,
  } = params;

  if (!underlying) throw new Error("underlying is required");
  if (!from) throw new Error("from is required");
  if (mode !== "atm" && mode !== "strikes" && mode !== "dynamic") throw new Error('mode must be "atm", "strikes" or "dynamic"');
  if (mode === "strikes" && (!requestedStrikes || requestedStrikes.length === 0)) {
    throw new Error("strikes list is required when mode is \"strikes\"");
  }

  const entry = findCuratedEntry(underlying, exchange);
  if (!entry) {
    throw new Error(
      `"${underlying}" isn't in this app's curated options list (NIFTY, BANKNIFTY, FINNIFTY, SENSEX, BANKEX, and the tracked equities). ` +
      `Bulk ATM/strike-list download only covers those. For any other option, use a single-contract download from the Symbol search instead.`
    );
  }

  const lookupSymbol = resolveChainLookupSymbol(entry);
  const defaultAtmWidth = loadCuratedUnderlyings().atmBandWidth || 4;
  const effectiveAtmWidth = mode === "atm" ? (atmWidth || defaultAtmWidth) : defaultAtmWidth;

  // ── Step 1: probe call — real live expiries + a reference band, no
  // timestamp (Fyers' own "nearest live expiry" pick — this is what
  // satisfies "auto-pick live expiry"). ────────────────────────────────
  const probe = await fetchOptionChain(lookupSymbol, { strikeCount: Math.max(effectiveAtmWidth, 2) });
  if (!probe.strikes.length || !probe.expiries.length) {
    throw new Error(
      `Fyers returned no live option chain for ${underlying}. Either the Fyers token is invalid, or this underlying has no live option contracts right now.`
    );
  }

  let targetExpiry = probe.expiries[0]; // default: nearest live
  if (expiryDate) {
    const match = probe.expiries.find((e) => e.date === expiryDate);
    if (!match) {
      throw new Error(
        `"${expiryDate}" isn't a currently live expiry for ${underlying}. Live expiries right now: ${probe.expiries.map((e) => e.date).join(", ")}.`
      );
    }
    targetExpiry = match;
  }

  // ── DYNAMIC ATM: self-contained path (spot-following ATM). ──────────
  if (mode === "dynamic") {
    const parsedWidth = Number(atmWidth);
    const dynWidth = Number.isFinite(parsedWidth) && parsedWidth >= 0 ? Math.min(Math.floor(parsedWidth), 50) : 0;
    return runDynamicAtmFetch({
      entry, underlying, lookupSymbol, probe, targetExpiry, width: dynWidth,
      optionTypes, from, to, timeframe, includeOI, includeIV, onProgress,
    });
  }

  // ── Step 2: the real chain call for the target expiry. In "strikes"
  // mode, size the band wide enough to cover every requested strike
  // (derived from the probe's own strike gap — never a guessed number),
  // so one call resolves the whole list at once. ──────────────────────
  const probeGap = deriveStrikeGap(probe.strikes) || 1;
  let strikeCountForChain = effectiveAtmWidth;
  if (mode === "strikes") {
    const probeAtm = uniqueSortedStrikes(probe.strikes)[Math.floor(uniqueSortedStrikes(probe.strikes).length / 2)];
    const maxDistanceSteps = Math.max(
      ...requestedStrikes.map((s) => Math.ceil(Math.abs(s - probeAtm) / probeGap))
    );
    strikeCountForChain = Math.max(maxDistanceSteps + 1, 2);
  }

  const isSameExpiryAsProbe = targetExpiry.date === probe.expiries[0].date;
  const chain = isSameExpiryAsProbe && strikeCountForChain <= Math.max(effectiveAtmWidth, 2)
    ? probe
    : await fetchOptionChain(lookupSymbol, { strikeCount: strikeCountForChain, timestamp: targetExpiry.expiry });

  if (!chain.strikes.length) {
    throw new Error(`Fyers returned no strikes for ${underlying} at expiry ${targetExpiry.date}.`);
  }

  const sortedStrikePrices = uniqueSortedStrikes(chain.strikes);
  const atmStrike = sortedStrikePrices[Math.floor(sortedStrikePrices.length / 2)];
  const strikeGap = deriveStrikeGap(chain.strikes) || probeGap;

  // ── Step 3: pick the exact contracts to fetch ────────────────────────
  const skipped = [];
  let wantedStrikePrices;
  if (mode === "atm") {
    wantedStrikePrices = sortedStrikePrices;
  } else {
    wantedStrikePrices = requestedStrikes.filter((s) => sortedStrikePrices.includes(s));
    for (const s of requestedStrikes) {
      if (!sortedStrikePrices.includes(s)) {
        skipped.push({ strike: s, reason: `not a real live strike for ${underlying} at expiry ${targetExpiry.date}` });
      }
    }
  }

  const contracts = chain.strikes
    .filter((s) => wantedStrikePrices.includes(s.strike_price) && optionTypes.includes(s.option_type))
    .sort((a, b) => a.strike_price - b.strike_price || a.option_type.localeCompare(b.option_type));

  if (contracts.length === 0) {
    throw new Error("No contracts matched after filtering by strike/option type — nothing to fetch.");
  }

  // ── Step 4: sequential candle fetch — same delay/skip-on-failure
  // pattern as derivativesGapFill.js's backfillStrikesForEntry(). ──────
  const rows = [];
  const fetched = [];
  let minActualDate = null;
  let maxActualDate = null;

  // IV needs the underlying's own spot price series — fetched ONCE here
  // (not once per contract below) since every strike/expiry in this
  // request shares the same underlying. lookupSymbol is the same symbol
  // already used for the option-chain lookup above (indices/equities:
  // real spot; commodities: near-month future, the standard reference
  // price used for commodity option IV — see ivEnrichment.js's header).
  const spotMap = includeIV ? await fetchUnderlyingSpotMap(lookupSymbol, from, timeframe) : null;
  const expiryEpochSeconds = Number(targetExpiry.expiry) || undefined;

  for (let i = 0; i < contracts.length; i++) {
    const c = contracts[i];
    try {
      const { rows: candleRows } = await fetchCandleRows(c.symbol, from, timeframe, includeOI);
      let trimmed = to ? candleRows.filter((r) => r.Date <= to) : candleRows;
      if (includeIV && spotMap) {
        trimmed = attachIV(trimmed, spotMap, {
          strike: c.strike_price, optionType: c.option_type, expiryEpochSeconds,
        });
      }

      if (trimmed.length === 0) {
        skipped.push({ symbol: c.symbol, strike: c.strike_price, reason: "no candles in the requested date range" });
      } else {
        for (const r of trimmed) {
          rows.push({
            Underlying: entry.underlying,
            Strike: c.strike_price,
            Expiry: targetExpiry.date,
            Type: c.option_type,
            Date: r.Date,
            Time: r.Time,
            Open: r.Open,
            High: r.High,
            Low: r.Low,
            Close: r.Close,
            Volume: r.Volume,
            ...(includeOI ? { OI: r.OI } : {}),
            ...(includeIV ? { IV: r.IV } : {}),
            "Steps from ATM": strikeGap ? Math.round((c.strike_price - atmStrike) / strikeGap) : "",
          });
        }
        fetched.push(c.symbol);
        const first = trimmed[0].Date;
        const last = trimmed[trimmed.length - 1].Date;
        if (!minActualDate || first < minActualDate) minActualDate = first;
        if (!maxActualDate || last > maxActualDate) maxActualDate = last;
      }
    } catch (err) {
      skipped.push({ symbol: c.symbol, strike: c.strike_price, reason: err.message });
    }

    if (onProgress) onProgress({ done: i + 1, total: contracts.length, symbol: c.symbol });
    if (i < contracts.length - 1) await sleep(INTER_STRIKE_DELAY_MS);
  }

  if (rows.length === 0) {
    throw new Error("No candles could be fetched for any requested strike — every contract was skipped. See the skipped list for why.");
  }

  // Merge order: chronological first (Date, Time), strike/type second —
  // matches the locked output format (read top-to-bottom = read the ATM
  // band move through the session, one strike/expiry/type set of columns
  // per row so Excel can still filter/pivot down to one strike).
  rows.sort((a, b) =>
    (a.Date + a.Time).localeCompare(b.Date + b.Time) ||
    a.Strike - b.Strike ||
    a.Type.localeCompare(b.Type)
  );

  const clipped = !!(minActualDate && minActualDate > from);
  const clipMessage = clipped
    ? `You asked for ${from} to ${to || "today"}, but this contract's data is only available from ${minActualDate} onward (Fyers restriction — no history before a contract went live). Downloaded ${minActualDate} to ${maxActualDate} only.`
    : null;

  return {
    rows, fetched, skipped, clipped, clipMessage,
    expiryUsed: targetExpiry.date,
    atmStrike, strikeGap,
    requestedFrom: from, requestedTo: to || null,
    actualFrom: minActualDate, actualTo: maxActualDate,
  };
}

/**
 * Dynamic ATM: see this file's header ("DYNAMIC ATM MODE"). Called only from
 * runBulkOptionFetch() once the entry, probe and target expiry are resolved.
 */
async function runDynamicAtmFetch(ctx) {
  const {
    entry, underlying, lookupSymbol, probe, targetExpiry, width,
    optionTypes, from, to, timeframe, includeOI, includeIV, onProgress,
  } = ctx;

  // ── Spot series for the range — fetched ONCE; this same map also feeds
  // attachIV() below, so ATM selection and IV use the identical spot. ────
  const spotMap = await fetchUnderlyingSpotMap(lookupSymbol, from, timeframe);
  const spotEntries = [...spotMap.entries()]
    .map(([t, close]) => ({ t, close, date: istDateOf(t) }))
    .filter((e) => !to || e.date <= to)
    .sort((a, b) => a.t - b.t);
  if (spotEntries.length === 0) {
    throw new Error(`No ${underlying} spot candles found for ${from} to ${to || "today"} — Dynamic ATM needs the spot series to pick each candle's ATM.`);
  }
  const spotTimes = spotEntries.map((e) => e.t);
  let rangeLow = Infinity, rangeHigh = -Infinity;
  for (const e of spotEntries) {
    if (e.close < rangeLow) rangeLow = e.close;
    if (e.close > rangeHigh) rangeHigh = e.close;
  }

  // ── One wide chain call sized to cover the whole spot range. ─────────
  const probeStrikes = uniqueSortedStrikes(probe.strikes);
  const probeGap = deriveStrikeGap(probe.strikes) || 1;
  const probeAtm = probeStrikes[Math.floor(probeStrikes.length / 2)];
  const stepsUp = Math.ceil(Math.max(0, rangeHigh - probeAtm) / probeGap);
  const stepsDown = Math.ceil(Math.max(0, probeAtm - rangeLow) / probeGap);
  const strikeCountForChain = Math.max(stepsUp, stepsDown, 2) + width + 2;

  const chain = await fetchOptionChain(lookupSymbol, { strikeCount: strikeCountForChain, timestamp: targetExpiry.expiry });
  if (!chain.strikes.length) {
    throw new Error(`Fyers returned no strikes for ${underlying} at expiry ${targetExpiry.date} (asked for ±${strikeCountForChain} strikes).`);
  }

  const sortedStrikes = uniqueSortedStrikes(chain.strikes);
  const strikeGap = deriveStrikeGap(chain.strikes) || probeGap;
  const strikeIdxByPrice = new Map(sortedStrikes.map((k, i) => [k, i]));

  // Refuse to silently mislabel: if the chain does not reach the full spot
  // range (plus the requested ± width), the "nearest listed strike" at the
  // edge would NOT really be the ATM. Fail loudly instead.
  const half = strikeGap / 2;
  const listedMin = sortedStrikes[0];
  const listedMax = sortedStrikes[sortedStrikes.length - 1];
  if (listedMin > rangeLow - half - width * strikeGap || listedMax < rangeHigh + half + width * strikeGap) {
    throw new Error(
      `Fyers only returned strikes ${listedMin}–${listedMax} for ${underlying} ${targetExpiry.date}, but ${underlying} spot traded ${Math.floor(rangeLow)}–${Math.ceil(rangeHigh)} ` +
      `in ${from} to ${to || "today"}${width ? ` (plus ±${width} strikes)` : ""}. Use a shorter date range, or try again.`
    );
  }

  // ── Every strike that is ATM (±width) at ANY spot candle in the range. ──
  const wantedIdx = new Set();
  let minAtmIdx = Infinity, maxAtmIdx = -Infinity;
  for (const e of spotEntries) {
    const a = nearestStrikeIndex(sortedStrikes, e.close);
    if (a < minAtmIdx) minAtmIdx = a;
    if (a > maxAtmIdx) maxAtmIdx = a;
    for (let k = -width; k <= width; k++) {
      const j = a + k;
      if (j >= 0 && j < sortedStrikes.length) wantedIdx.add(j);
    }
  }
  const wantedStrikePrices = new Set([...wantedIdx].map((j) => sortedStrikes[j]));
  const atmRange = `${sortedStrikes[minAtmIdx]}–${sortedStrikes[maxAtmIdx]}`;

  const contracts = chain.strikes
    .filter((s) => wantedStrikePrices.has(s.strike_price) && optionTypes.includes(s.option_type))
    .sort((a, b) => a.strike_price - b.strike_price || a.option_type.localeCompare(b.option_type));
  if (contracts.length === 0) {
    throw new Error("No contracts matched after filtering by strike/option type — nothing to fetch.");
  }

  /** ATM index + spot for one option row: spot at the row's own timestamp, or the last spot of the SAME trading day (post-close 15:30-15:39 rows). */
  function atmRefForRow(r) {
    const t = Date.parse(`${r.Date}T${r.Time}+05:30`);
    if (Number.isNaN(t)) return null;
    const i = lastIndexAtOrBefore(spotTimes, t);
    if (i < 0 || spotEntries[i].date !== r.Date) return null;
    return { atmIdx: nearestStrikeIndex(sortedStrikes, spotEntries[i].close), spot: spotEntries[i].close };
  }

  const expiryEpochSeconds = Number(targetExpiry.expiry) || undefined;
  const rows = [];
  const fetched = [];
  const skipped = [];
  let minActualDate = null;
  let maxActualDate = null;

  for (let i = 0; i < contracts.length; i++) {
    const c = contracts[i];
    try {
      const strikeIdx = strikeIdxByPrice.get(c.strike_price);
      const { rows: candleRows } = await fetchCandleRows(c.symbol, from, timeframe, includeOI);
      const inRange = to ? candleRows.filter((r) => r.Date <= to) : candleRows;

      // Keep ONLY the candles where this strike is within ±width of that candle's ATM.
      const kept = [];
      for (const r of inRange) {
        const ref = atmRefForRow(r);
        if (!ref) continue;
        const steps = strikeIdx - ref.atmIdx;
        if (Math.abs(steps) <= width) kept.push({ row: r, spot: ref.spot, steps });
      }

      if (kept.length === 0) {
        skipped.push({ symbol: c.symbol, strike: c.strike_price, reason: "no candles where this strike was ATM in the requested range" });
      } else {
        let keptRows = kept.map((k) => k.row);
        if (includeIV) {
          keptRows = attachIV(keptRows, spotMap, { strike: c.strike_price, optionType: c.option_type, expiryEpochSeconds });
        }
        for (let n = 0; n < keptRows.length; n++) {
          const r = keptRows[n];
          rows.push({
            Underlying: entry.underlying,
            Strike: c.strike_price,
            Expiry: targetExpiry.date,
            Type: c.option_type,
            Date: r.Date,
            Time: r.Time,
            Open: r.Open,
            High: r.High,
            Low: r.Low,
            Close: r.Close,
            Volume: r.Volume,
            ...(includeOI ? { OI: r.OI } : {}),
            ...(includeIV ? { IV: r.IV } : {}),
            Spot: kept[n].spot,
            "Steps from ATM": kept[n].steps,
          });
        }
        fetched.push(c.symbol);
        const first = keptRows[0].Date;
        const last = keptRows[keptRows.length - 1].Date;
        if (!minActualDate || first < minActualDate) minActualDate = first;
        if (!maxActualDate || last > maxActualDate) maxActualDate = last;
      }
    } catch (err) {
      skipped.push({ symbol: c.symbol, strike: c.strike_price, reason: err.message });
    }

    if (onProgress) onProgress({ done: i + 1, total: contracts.length, symbol: c.symbol });
    if (i < contracts.length - 1) await sleep(INTER_STRIKE_DELAY_MS);
  }

  if (rows.length === 0) {
    throw new Error("No candles could be fetched for any ATM strike — every contract was skipped. See the skipped list for why.");
  }

  rows.sort((a, b) =>
    (a.Date + a.Time).localeCompare(b.Date + b.Time) ||
    a.Strike - b.Strike ||
    a.Type.localeCompare(b.Type)
  );

  const clipped = !!(minActualDate && minActualDate > from);
  const clipMessage = clipped
    ? `You asked for ${from} to ${to || "today"}, but ATM data is only available from ${minActualDate} onward (Fyers restriction — no history before a contract went live). Downloaded ${minActualDate} to ${maxActualDate} only.`
    : null;

  return {
    rows, fetched, skipped, clipped, clipMessage,
    expiryUsed: targetExpiry.date,
    atmStrike: null, atmRange, strikeGap,
    requestedFrom: from, requestedTo: to || null,
    actualFrom: minActualDate, actualTo: maxActualDate,
  };
}

module.exports = { runBulkOptionFetch };