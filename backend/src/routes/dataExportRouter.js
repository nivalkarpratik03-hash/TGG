/**
 * dataExportRouter.js
 * ─────────────────────────────────────────────────────────────────
 * REST API backing the homepage's "Data Export" page — lets any user
 * search any live NSE/BSE/MCX symbol (spot, future, or option) and
 * download its candle history as an .xlsx, straight from the browser.
 * Previously this only existed as a terminal-only script
 * (scripts/fetchSpotCandles.js, spot-only, no UI, no futures/options).
 *
 * Reuses, rather than re-implements:
 *   - fyers/client.js's loadToken/validateToken       (same token check
 *     scripts/fetchSpotCandles.js and every other script use)
 *   - services/candleExport.js's fetchCandleRows/rowsToXlsxBuffer  (the
 *     exact row-building + xlsx logic fetchSpotCandles.js uses, now
 *     shared — see that file's header comment)
 *   - routes/symbolsRouter.js's getSymbols()          (the existing
 *     curated index/equity/commodity/future list — still used for MCX
 *     and as part of spot/future results, see "SCOPE NOTE" in
 *     fyersSymbolMaster.js for why MCX isn't in the universal source)
 *   - services/fyersSymbolMaster.js's searchUniversalSymbols()  (the new
 *     NSE/BSE "every live symbol" source that adds anything outside the
 *     curated ~200, e.g. BEML)
 *   - the exact same xlsx-attachment header pattern already used by
 *     routes/analyticsRouter.js's GET /export — same Content-Type,
 *     same Content-Disposition convention, nothing reinvented.
 *
 * Mounted at: /api/data-export
 *
 * GET /api/data-export/symbols?q=&segment=spot|future|option[&exchange=NSE|BSE|MCX]
 *   Returns up to 50 matches: [{ symbol, name, exchange, type,
 *   underlying, expiryDate, strike, optionType }, ...]
 *
 * GET /api/data-export/download?symbol=&from=&timeframe=[&to=]
 *   Streams an .xlsx attachment. `to` is accepted for forward-compat with
 *   the UI's date pickers but candles are always fetched through today —
 *   same "from a date through today" behavior fetchSpotCandles.js always
 *   had; rows after `to` (if given) are trimmed out before export so an
 *   earlier `to` date still does something useful rather than being
 *   silently ignored.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");
const router = express.Router();

const { loadToken, validateToken } = require("../fyers/client");
const { fetchCandleRows, rowsToXlsxBuffer, safeFilenamePart } = require("../services/candleExport");
const { getSymbols } = require("./symbolsRouter");
const { searchUniversalSymbols } = require("../services/fyersSymbolMaster");

// ── Curated → universal-shaped adapter ──────────────────────────────────
// symbolsRouter's getSymbols() entries look like { symbol, name, type }
// with type one of "index"|"equity"|"commodity"|"future". Mapped here to
// the same { symbol, name, exchange, type, underlying, expiryDate, strike,
// optionType } shape fyersSymbolMaster's entries already use, so the two
// sources can be merged into one result list without the frontend needing
// to know there even are two sources.
function exchangeOfSymbol(symbol) {
  const idx = symbol.indexOf(":");
  return idx >= 0 ? symbol.slice(0, idx).toUpperCase() : "NSE";
}

function toUniversalShape(curatedEntry) {
  const segment = curatedEntry.type === "index" || curatedEntry.type === "equity" ? "spot" : "future";
  return {
    symbol: curatedEntry.symbol,
    name: curatedEntry.name,
    exchange: exchangeOfSymbol(curatedEntry.symbol),
    type: segment,
    underlying: curatedEntry.symbol.split(":").pop(),
    expiryDate: null,
    strike: null,
    optionType: null,
  };
}

function searchCurated(query, segment, exchange) {
  const q = query.toLowerCase();
  const wantedTypes = segment === "option"
    ? [] // curated list carries no options at all
    : segment === "future"
      ? ["future", "commodity"]
      : ["index", "equity"]; // "spot"
  if (wantedTypes.length === 0) return [];

  let symbols = getSymbols().filter((s) => wantedTypes.includes(s.type));
  if (exchange) symbols = symbols.filter((s) => exchangeOfSymbol(s.symbol) === exchange.toUpperCase());

  return symbols
    .filter((s) => {
      const ticker = s.symbol.split(":").pop().toLowerCase();
      return s.name.toLowerCase().startsWith(q) || ticker.startsWith(q) || ticker.includes(q);
    })
    .map(toUniversalShape);
}

/** GET /api/data-export/symbols?q=&segment=spot|future|option[&exchange=] */
router.get("/symbols", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const segment = (req.query.segment || "spot").toLowerCase();
    const exchange = (req.query.exchange || "").toUpperCase() || undefined;

    if (!["spot", "future", "option"].includes(segment)) {
      return res.status(400).json({ error: "invalid_segment", message: "segment must be spot, future, or option" });
    }
    if (!q) return res.json([]);

    // MCX commodities only exist in the curated list (see
    // fyersSymbolMaster.js's "SCOPE NOTE") — so for MCX specifically,
    // only the curated source is queried, never the universal one.
    const wantsMcxOnly = exchange === "MCX";

    const [universal, curated] = await Promise.all([
      wantsMcxOnly ? Promise.resolve([]) : searchUniversalSymbols(q, { type: segment, exchange, limit: 50 }),
      searchCurated(q, segment, exchange),
    ]);

    // Universal (Fyers-direct, always current) results first, then any
    // curated entries not already present — dedup by symbol so the same
    // ticker never shows twice just because it exists in both sources.
    const seen = new Set();
    const merged = [];
    for (const entry of [...universal, ...curated]) {
      if (seen.has(entry.symbol)) continue;
      seen.add(entry.symbol);
      merged.push(entry);
    }

    res.json(merged.slice(0, 50));
  } catch (err) {
    res.status(500).json({ error: "symbol_search_failed", message: err.message });
  }
});

/** GET /api/data-export/download?symbol=&from=&timeframe=[&to=] */
router.get("/download", async (req, res) => {
  try {
    const { symbol, from, to, timeframe } = req.query;
    if (!symbol || !from) {
      return res.status(400).json({ error: "missing_params", message: "symbol and from are required" });
    }

    // Same token check every script in scripts/ already does before
    // touching Fyers — surfaced here as a clean 401 instead of a crash,
    // since this is now reachable from a browser, not just a terminal.
    const token = loadToken();
    if (!token) {
      return res.status(401).json({
        error: "no_token",
        message: "No Fyers access token found. Please first generate a valid token from Admin.",
      });
    }
    const valid = await validateToken();
    if (!valid) {
      return res.status(401).json({
        error: "invalid_token",
        message: "Fyers token is invalid or expired. Please first generate a valid token from Admin.",
      });
    }

    const timeframeLabel = timeframe || "1day";
    const { rows: allRows } = await fetchCandleRows(symbol, from, timeframeLabel);

    // `to` narrows the already-fetched range (fetchCandleRows always goes
    // through today) — trimmed here rather than passed down, so
    // candleExport.js's one fetch function stays the same for the CLI
    // script (which has no --to) and this endpoint.
    const rows = to
      ? allRows.filter((r) => r.Date <= to)
      : allRows;

    if (rows.length === 0) {
      return res.status(404).json({
        error: "no_data",
        message: `No candles found for ${symbol} in the given date range.`,
      });
    }

    const buffer = rowsToXlsxBuffer(rows);
    const filename = `${safeFilenamePart(symbol)}_${safeFilenamePart(timeframeLabel)}_${from}_to_${to || "today"}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "download_failed", message: err.message });
  }
});

module.exports = router;
