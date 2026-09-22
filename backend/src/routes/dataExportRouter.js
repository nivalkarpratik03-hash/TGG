/**
 * dataExportRouter.js
 * ─────────────────────────────────────────────────────────────────
 * REST API backing the homepage's "Data Export" page — lets any user
 * search any live NSE/BSE/MCX symbol (spot, future, or option) and
 * download its candle history as an .xlsx, straight from the browser.
 * Previously this only existed as a terminal-only script
 * (scripts/fetchSpotCandles.js, spot-only, no UI, no futures/options).
 *
 * Exported as a factory — `createDataExportRouter({ io })` — the same
 * shape routes/chartRouter.js already uses, because the new bulk-options
 * endpoint below needs `io` to push live progress/summary events over the
 * SAME Socket.io connection every other real-time feature in this app
 * already shares (see frontend/src/utils/backendSocket.js) — not a new,
 * second socket connection.
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
 *   - services/bulkOptionFetch.js's runBulkOptionFetch() — ATM±N /
 *     strike-list resolution + fetch, itself built on the SAME
 *     fetchOptionChain / curatedUnderlyingsLoader / derivativesGapFill
 *     helpers the live gap-fill pipeline already uses (see that file's
 *     header for the full list) — no second, dashboard-only copy of any
 *     of that logic.
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
 *   Streams an .xlsx attachment for ONE exact contract. `to` is accepted
 *   for forward-compat with the UI's date pickers but candles are always
 *   fetched through today — same "from a date through today" behavior
 *   fetchSpotCandles.js always had; rows after `to` (if given) are trimmed
 *   out before export so an earlier `to` date still does something useful
 *   rather than being silently ignored.
 *
 * GET /api/data-export/curated-underlyings
 *   Returns [{underlying, exchange, assetClass}], plus the app-wide
 *   atmBandWidth default — for populating the Bulk-mode underlying picker.
 *
 * GET /api/data-export/expiries?underlying=[&exchange=]
 *   Returns the currently-live expiry dates for that underlying — for the
 *   Bulk-mode expiry dropdown (leave blank in bulk-options to auto-pick
 *   the nearest one instead).
 *
 * GET /api/data-export/bulk-options?underlying=&mode=atm|strikes[&exchange=]
 *     [&atmWidth=][&strikes=23100,23150][&optionTypes=CE,PE][&expiryDate=]
 *     &from=&timeframe=[&to=][&socketId=]
 *   Streams ONE .xlsx attachment covering every matched strike/expiry
 *   combination, one flat sheet (see services/bulkOptionFetch.js's header
 *   for the exact row shape). If `socketId` is given and that socket is
 *   currently connected, "bulk_options_progress" ({done,total,symbol})
 *   fires after each contract, and "bulk_options_summary"
 *   ({fetched,skipped,clipped,clipMessage,expiryUsed}) fires once, right
 *   before the file is sent.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");

const { loadToken, validateToken, fetchOptionChain } = require("../fyers/client");
const { fetchCandleRows, rowsToXlsxBuffer, safeFilenamePart } = require("../services/candleExport");
const { getSymbols } = require("./symbolsRouter");
const { searchUniversalSymbols } = require("../services/fyersSymbolMaster");
const { loadCuratedUnderlyings } = require("../derivatives/curatedUnderlyingsLoader");
const { resolveChainLookupSymbol } = require("../derivatives/derivativesGapFill");
const { runBulkOptionFetch } = require("../services/bulkOptionFetch");

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

/** Same 401-on-bad-token guard used by /download and now /bulk-options — one place, not two. */
async function requireValidToken(res) {
  const token = loadToken();
  if (!token) {
    res.status(401).json({
      error: "no_token",
      message: "No Fyers access token found. Please first generate a valid token from Admin.",
    });
    return false;
  }
  const valid = await validateToken();
  if (!valid) {
    res.status(401).json({
      error: "invalid_token",
      message: "Fyers token is invalid or expired. Please first generate a valid token from Admin.",
    });
    return false;
  }
  return true;
}

/**
 * @param {object} deps
 * @param {import("socket.io").Server} [deps.io]
 */
module.exports = function createDataExportRouter({ io } = {}) {
  const router = express.Router();

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

      // Sort nearest-strike-first for options — previously random file
      // order, which is why far-away strikes (e.g. 18950 next to a
      // current price near 25000) showed up mixed in with near-ATM ones.
      // "Nearest" has no live ATM reference at plain-search time, so this
      // sorts by strike value itself (ascending) — grouping same-strike
      // CE/PE together — which is what actually fixed the visible
      // out-of-order symptom; true ATM-centering only applies to Bulk
      // mode below, which has a real ATM reference from fetchOptionChain.
      if (segment === "option") {
        merged.sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0) || (a.expiryDate || "").localeCompare(b.expiryDate || ""));
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
      if (!(await requireValidToken(res))) return;

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

  /** GET /api/data-export/curated-underlyings — for the Bulk-mode underlying picker. */
  router.get("/curated-underlyings", (req, res) => {
    try {
      const { all, atmBandWidth } = loadCuratedUnderlyings();
      const underlyings = all
        .filter((e) => e.assetClass !== "EQUITY") // bulk mode targets indices/commodities; the ~200 equities are still reachable via single-contract search
        .map((e) => ({ underlying: e.underlying, exchange: e.exchange, assetClass: e.assetClass, expiryTypes: e.expiryTypes || [] }));
      res.json({ underlyings, atmBandWidth: atmBandWidth || 4 });
    } catch (err) {
      res.status(500).json({ error: "curated_underlyings_failed", message: err.message });
    }
  });

  /**
   * GET /api/data-export/expiries?underlying=[&exchange=]
   *   Live expiries only — the same probe call runBulkOptionFetch() itself
   *   makes first (fetchOptionChain, no timestamp), exposed on its own so
   *   the Bulk-mode expiry dropdown can show real options instead of the
   *   user typing a date blind. Not used by single-contract search (that
   *   already derives its expiry list client-side from the already-fetched
   *   universal search results — a different, already-cached source, see
   *   fyersSymbolMaster.js — so this isn't a second copy of that).
   */
  router.get("/expiries", async (req, res) => {
    try {
      const { underlying, exchange } = req.query;
      if (!underlying) return res.status(400).json({ error: "missing_params", message: "underlying is required" });

      if (!(await requireValidToken(res))) return;

      const { all } = loadCuratedUnderlyings();
      const entry = all.find((e) => e.underlying.toUpperCase() === underlying.toUpperCase() && (!exchange || e.exchange === exchange.toUpperCase()));
      if (!entry) {
        return res.status(400).json({
          error: "unknown_underlying",
          message: `"${underlying}" isn't in this app's curated options list.`,
        });
      }

      const lookupSymbol = resolveChainLookupSymbol(entry);
      const probe = await fetchOptionChain(lookupSymbol, { strikeCount: 1 });
      res.json({ expiries: probe.expiries.map((e) => e.date) });
    } catch (err) {
      res.status(500).json({ error: "expiries_failed", message: err.message });
    }
  });

  /**
   * GET /api/data-export/bulk-options
   *   ?underlying=&mode=atm|strikes[&exchange=][&atmWidth=][&strikes=23100,23150]
   *   [&optionTypes=CE,PE][&expiryDate=]&from=&timeframe=[&to=][&socketId=]
   */
  router.get("/bulk-options", async (req, res) => {
    try {
      const {
        underlying, exchange, mode, atmWidth, strikes, optionTypes,
        expiryDate, from, to, timeframe, socketId,
      } = req.query;

      if (!underlying || !mode || !from) {
        return res.status(400).json({ error: "missing_params", message: "underlying, mode, and from are required" });
      }
      if (mode !== "atm" && mode !== "strikes") {
        return res.status(400).json({ error: "invalid_mode", message: 'mode must be "atm" or "strikes"' });
      }
      if (mode === "strikes" && !strikes) {
        return res.status(400).json({ error: "missing_strikes", message: "strikes is required when mode=strikes (comma-separated numbers)" });
      }

      if (!(await requireValidToken(res))) return;

      const parsedStrikes = mode === "strikes"
        ? strikes.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
        : undefined;
      const parsedOptionTypes = optionTypes
        ? optionTypes.split(",").map((t) => t.trim().toUpperCase()).filter((t) => t === "CE" || t === "PE")
        : ["CE", "PE"];

      const targetSocket = socketId && io ? io.sockets.sockets.get(socketId) : null;

      const result = await runBulkOptionFetch({
        underlying, exchange, mode,
        atmWidth: atmWidth ? Number(atmWidth) : undefined,
        strikes: parsedStrikes,
        optionTypes: parsedOptionTypes,
        expiryDate: expiryDate || undefined,
        from, to: to || undefined,
        timeframe: timeframe || "1day",
        onProgress: targetSocket
          ? (p) => targetSocket.emit("bulk_options_progress", p)
          : undefined,
      });

      if (targetSocket) {
        targetSocket.emit("bulk_options_summary", {
          fetched: result.fetched,
          skipped: result.skipped,
          clipped: result.clipped,
          clipMessage: result.clipMessage,
          expiryUsed: result.expiryUsed,
          atmStrike: result.atmStrike,
        });
      }

      const buffer = rowsToXlsxBuffer(result.rows, "Options");
      const filename = `${safeFilenamePart(underlying)}_${safeFilenamePart(result.expiryUsed)}_${safeFilenamePart(timeframe || "1day")}_${result.actualFrom}_to_${result.actualTo}.xlsx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      res.status(400).json({ error: "bulk_options_failed", message: err.message });
    }
  });

  return router;
};