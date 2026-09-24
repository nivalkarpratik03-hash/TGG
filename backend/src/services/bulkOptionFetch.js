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
 * ATM VALUE: fetchOptionChain(underlying, {strikeCount: N}) returns a
 * symmetric band of 2N+1 strikes centered on Fyers' own live ATM — so the
 * middle element of the sorted, de-duplicated strike list IS the real ATM
 * Fyers used, derived from what was actually returned rather than
 * recomputed/guessed from a spot price separately.
 * ─────────────────────────────────────────────────────────────────────────
 */

"use strict";

const { fetchOptionChain } = require("../fyers/client");
const { loadCuratedUnderlyings } = require("../derivatives/curatedUnderlyingsLoader");
const { resolveChainLookupSymbol, deriveStrikeGap, INTER_STRIKE_DELAY_MS } = require("../derivatives/derivativesGapFill");
const { fetchCandleRows } = require("./candleExport");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Finds the curated entry for `underlying` (optionally scoped to `exchange`). */
function findCuratedEntry(underlying, exchange) {
  const { all } = loadCuratedUnderlyings();
  const wanted = (underlying || "").toUpperCase();
  const wantedExchange = exchange ? exchange.toUpperCase() : null;
  return all.find(
    (e) => e.underlying.toUpperCase() === wanted && (!wantedExchange || e.exchange === wantedExchange)
  );
}

/** Sorted, de-duplicated strike prices from a fetchOptionChain strikes[] array. */
function uniqueSortedStrikes(strikes) {
  return [...new Set(strikes.map((s) => s.strike_price))].sort((a, b) => a - b);
}

/**
 * @param {object} params
 * @param {string} params.underlying    e.g. "NIFTY"
 * @param {string} [params.exchange]    "NSE" | "BSE" — disambiguates when needed
 * @param {"atm"|"strikes"} params.mode
 * @param {number} [params.atmWidth]    used when mode==="atm"; defaults to this
 *                                      app's own curatedUnderlyings.json atmBandWidth
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
    onProgress,
  } = params;

  if (!underlying) throw new Error("underlying is required");
  if (!from) throw new Error("from is required");
  if (mode !== "atm" && mode !== "strikes") throw new Error('mode must be "atm" or "strikes"');
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

  for (let i = 0; i < contracts.length; i++) {
    const c = contracts[i];
    try {
      const { rows: candleRows } = await fetchCandleRows(c.symbol, from, timeframe, includeOI);
      const trimmed = to ? candleRows.filter((r) => r.Date <= to) : candleRows;

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

module.exports = { runBulkOptionFetch };