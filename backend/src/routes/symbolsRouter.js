/**
 * symbolsRouter.js
 * ─────────────────────────────────────────────────────────────────
 * REPOINTED 2026-07-31 — provides REST endpoints that merge symbols from
 * the root `symbols/` master (sibling to backend/, frontend/, database/)
 * instead of reaching into frontend/src/:
 *   1. symbols/index.json      — 5 curated indices (plain: name/symbol/exchange/type)
 *   2. symbols/equity.json     — ~202 NSE equities (plain: name/symbol/exchange/type/displayName)
 *   3. symbols/commodity.json  — 6 curated MCX commodity ROOTS (GapFill-curated
 *                                list, NOT frontend/src/mcx.json's broader 18 —
 *                                names only, the actual tradable symbols are
 *                                generated, see "Futures generation")
 *
 * This replaces the previous 4-source read (frontend/src/symbols.json,
 * stocks.xlsx, NIFTY.xlsx, mcx.json) — this is the fix for the confirmed
 * backend→frontend coupling flagged earlier this session. frontend/src/
 * symbols.json was confirmed byte-identical to noExpirySymbols.json (which
 * equity.json is itself sourced from) plus 5 stale hardcoded dated MCX
 * futures contracts, and stocks.xlsx/NIFTY.xlsx together produced the same
 * ~202/205-equity set now already carried verbatim in equity.json — so no
 * xlsx parsing is needed here any more either.
 *
 * DISPLAY-NAME NOTE (flagged, not silently patched): the old mcx.json had
 * human-readable names for 5 of the 6 curated commodities (e.g. "Gold Mini
 * (MCX)") but had NO entry at all for NATGASMINI (it only listed the
 * non-mini "NATURALGAS-I"). Rather than invent prose for the one gap while
 * keeping hand-written names for the other 5, symbol search below uses
 * commodity.json's own `name` field (the bare ticker root, e.g.
 * "CRUDEOILM") uniformly for all 6. This is a cosmetic display-text change
 * from before — if a prettier label is wanted, add a `displayName` field to
 * symbols/commodity.json (same pattern equity.json already uses) rather
 * than reintroducing a second source of truth here.
 *
 * INDEX DISPLAY-NAME NOTE (also flagged): symbols.json used to show "NIFTY
 * 50" / "NIFTY BANK" / "SENSEX" for the 3 indices it carried. index.json's
 * own `name` field is the shorter "NIFTY" / "BANKNIFTY" / "SENSEX". To
 * avoid silently changing established search-result text, the 3 legacy
 * names are preserved via INDEX_DISPLAY_NAME_OVERRIDES below; FINNIFTY and
 * MIDCPNIFTY are new to symbol search (symbols.json never carried them) so
 * they use index.json's own `name` field as-is — there's no prior
 * convention to preserve for those two.
 *
 * PLUS dynamically generated, always-current-month contracts:
 *   - NSE equity futures      e.g. NSE:RELIANCE26JUNFUT
 *   - NIFTY / BANKNIFTY futures
 *   - MCX commodity futures   e.g. MCX:CRUDEOIL26JULFUT
 * These are computed fresh from today's date on every cache rebuild
 * (see CACHE_TTL_MS below) so they never go stale. UNCHANGED from before.
 *
 * Every returned entry includes a `type` field:
 *   "index" | "equity" | "commodity" | "future" | "option" | "etf"
 *
 * GET /api/symbols
 *   ?exchange=NSE|BSE|MCX   (optional filter)
 *   Returns: [{ symbol, name, type }, ...]
 *   Indices first, then sorted alphabetically.
 *   No param → returns everything (backward compatible).
 *
 * GET /api/symbols/search?q=GOLD[&exchange=MCX]
 *   Returns up to 20 filtered results.
 *
 * POST /api/symbols/refresh
 *   Force reload from disk.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const { previousTradingDay } = require("../data/holidays");

const router = express.Router();

// backend/src/routes -> backend/src -> backend -> repo root -> symbols
const SYMBOLS_DIR = path.resolve(__dirname, "../../../symbols");
const INDEX_JSON = path.join(SYMBOLS_DIR, "index.json");
const EQUITY_JSON = path.join(SYMBOLS_DIR, "equity.json");
const COMMODITY_JSON = path.join(SYMBOLS_DIR, "commodity.json");

// See "INDEX DISPLAY-NAME NOTE" above.
const INDEX_DISPLAY_NAME_OVERRIDES = {
  NIFTY: "NIFTY 50",
  BANKNIFTY: "NIFTY BANK",
  SENSEX: "SENSEX",
};

let _cachedSymbols = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Futures generation ───────────────────────────────────────────────────────
// Fyers symbols for futures are DATED contracts, e.g. "NSE:RELIANCE26JUNFUT"
// or "MCX:CRUDEOIL26JULFUT" — there is no "-I" continuous-contract ticker in
// Fyers' symbol master (that convention belongs to other data vendors). We
// compute the live contract months from today's date so these never go
// stale and never need manual monthly edits. UNCHANGED from before.
const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const FUT_MONTHS_AHEAD = 3; // near / next / far contract months shown in search

// ── MCX expiry-day approximations (per commodity, day-of-month) ─────────────
// MCX expiry dates are NOT calendar-fixed — the exchange shifts them a few
// days around holidays and publishes the exact date in a monthly circular.
// These are close approximations only, used to decide whether THIS month's
// contract has likely already expired so we roll to next month's contract
// instead of pointing at a dead symbol.
//
// IMPORTANT: we roll over the day AFTER the approximate expiry day has
// passed — never before. Rolling early (e.g. subtracting a multi-day
// "safety buffer") was the cause of months like June disappearing from the
// list days before they actually expired, even while still actively
// trading. A small +1 day grace period is added instead, so a contract
// that expires on (say) the 22nd still shows up through the 23rd, in case
// MCX's actual circular date lands a day later than our approximation.
// Source: MCX settlement/expiry circulars (rules vary by commodity).
// UNCHANGED from before.
const MCX_EXPIRY_DAY = {
  CRUDEOIL: 19, CRUDEOILM: 19,                 // ~19th–20th
  NATURALGAS: 23, NATGASMINI: 23,                  // ~23rd (NATGASMINI is Fyers root for Nat Gas Mini)
  COPPER: 22, ZINC: 22, ZINCMINI: 22,
  ALUMINIUM: 22, LEAD: 22, LEADMINI: 22, NICKEL: 22,
  GOLD: 5, GOLDM: 29, GOLDPETAL: 29,       // bullion: early/late month, varies
  SILVER: 27, SILVERM: 27, SILVERMIC: 27,
  MENTHAOIL: 29,
  COTTON: 29, CASTORSEED: 29,                  // agri: near month-end
};
const EXPIRY_GRACE_DAYS = 1; // roll over this many days AFTER the approx expiry (never before)

// ── Restricted contract-month cycles ─────────────────────────────────────────
// Unlike CRUDEOIL/NATURALGAS/COPPER etc (which list a new contract every
// single calendar month), MCX's silver family does NOT trade every month —
// it only lists contracts in a fixed cycle. Building "...26JULFUT" for these
// roots produces a symbol that was never listed, which Fyers correctly
// rejects with "Invalid symbol provided" — confirmed via MCX expiry
// circulars: Feb, Apr, Jun, Aug, Nov, Dec. UNCHANGED from before.
const RESTRICTED_MONTH_CYCLE = {
  SILVER: [1, 3, 5, 7, 10, 11],     // 0-based: Feb, Apr, Jun, Aug, Nov, Dec
  SILVERM: [1, 3, 5, 7, 10, 11],
  SILVERMIC: [1, 3, 5, 7, 10, 11],
};

// Like nextMonthCodes, but only emits months that are valid contract months
// for `root` (per RESTRICTED_MONTH_CYCLE). Unrestricted roots behave exactly
// like nextMonthCodes. Walks forward month-by-month so it always lands on
// real, listed contracts.
function nextValidMonthCodes(root, n, from = new Date()) {
  const cycle = RESTRICTED_MONTH_CYCLE[root];
  if (!cycle) return nextMonthCodes(n, from);

  const codes = [];
  let y = from.getFullYear();
  let m = from.getMonth();
  let guard = 0;
  while (codes.length < n && guard < 60) {
    if (cycle.includes(m)) {
      codes.push(`${String(y % 100).padStart(2, "0")}${MONTH_CODES[m]}`);
    }
    m++;
    if (m > 11) { m = 0; y++; }
    guard++;
  }
  return codes;
}

/**
 * Returns the month-offset (0 = this month, 1 = next month, ...) to use as
 * the "near month" contract for a given MCX root, based on today's date.
 * Only rolls to next month once today is PAST (approxExpiryDay + grace) —
 * i.e. the current month's contract keeps showing all the way through its
 * expiry day, and a day or two beyond, before we switch.
 */
function mcxNearMonthOffset(root, from = new Date()) {
  const expiryDay = MCX_EXPIRY_DAY[root];
  if (!expiryDay) return 0; // unknown root — fall back to current month
  const today = from.getDate();
  return today > (expiryDay + EXPIRY_GRACE_DAYS) ? 1 : 0;
}

function nextMonthCodes(n, from = new Date()) {
  const codes = [];
  let y = from.getFullYear();
  let m = from.getMonth(); // 0-based
  for (let i = 0; i < n; i++) {
    codes.push(`${String(y % 100).padStart(2, "0")}${MONTH_CODES[m]}`);
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return codes;
}

// Like nextMonthCodes, but starting from an arbitrary month offset (used to
// roll MCX roots past an already-expired near-month contract).
function monthCodesFromOffset(n, offset, from = new Date()) {
  let y = from.getFullYear();
  let m = from.getMonth() + offset;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return nextMonthCodes(n, new Date(y, m, 1));
}

// The futures-ticker root sometimes differs from the index's spot ticker.
const INDEX_FUT_ROOTS = {
  "NIFTY50-INDEX": "NIFTY",
  "NIFTYBANK-INDEX": "BANKNIFTY",
};

// ── NSE F&O expiry rollover ──────────────────────────────────────────────────
// NSE monthly F&O contracts expire on the LAST TUESDAY of the month (NSE
// circular 111/2025, effective for contracts expiring on/after Sept 1,
// 2025 — moved from the old last-Thursday rule). buildFutures() previously
// just listed "today's month + next 2 months" with no awareness of expiry
// at all, so for every day between the real Tuesday expiry and the
// calendar flipping to the next month, it kept generating a symbol for an
// already-dead contract (e.g. still offering "...26JUNFUT" days after it
// expired) — Fyers rejects those as invalid, and that's what was showing
// up as a broken/invalid result in the search box. This mirrors the same
// offset pattern already used for MCX commodities below. UNCHANGED from before.
const NSE_EXPIRY_DOW = 2; // Tuesday
function nseNearMonthOffset(from = new Date()) {
  // Last Tuesday of the current month, at midnight.
  let lastTue = new Date(from.getFullYear(), from.getMonth() + 1, 0); // last calendar day of month
  while (lastTue.getDay() !== NSE_EXPIRY_DOW) lastTue.setDate(lastTue.getDate() - 1);
  // Holiday adjustment: if that Tuesday is an exchange holiday, real expiry
  // shifted to the previous trading day — without this, the roll decision
  // could stay "current month" for an extra day or two after the contract
  // actually expired (matching the same fix applied in optionsChain.js).
  lastTue = previousTradingDay(lastTue, "NSE");
  const expiryClose = new Date(lastTue);
  expiryClose.setHours(15, 30, 0, 0);
  return from.getTime() > expiryClose.getTime() ? 1 : 0;
}

/**
 * symbols/commodity.json already gives bare exchange:root strings (e.g.
 * "MCX:CRUDEOILM", no "-I" suffix) — unlike the old mcx.json, which used
 * "-I" continuous-contract tickers that aren't real Fyers symbols. The
 * "-I" strip below is kept as a no-op safety net only, in case that file
 * is ever hand-edited back to the old convention; it does nothing to the
 * current data.
 */
function loadCommodityRoots(filePath) {
  try {
    const { commodities } = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return commodities
      .filter((s) => s.symbol && s.name)
      .map((s) => {
        const ticker = String(s.symbol).trim();
        const root = ticker.split(":").pop().replace(/-I+$/i, "");
        return { root, name: String(s.name).trim() };
      });
  } catch (err) {
    console.warn(`[Symbols] Could not read ${path.basename(filePath)}: ${err.message}`);
    return [];
  }
}

/**
 * Builds live FUT contracts for:
 *   - NSE equities + the two liquid index futures (NIFTY, BANKNIFTY)
 *   - MCX commodities (roots taken from symbols/commodity.json)
 *
 * The nearest commodity month is tagged type "commodity" so it keeps
 * appearing (and working) under the existing Commodity tab using a real,
 * currently-tradable symbol. Every month (including that nearest one) is
 * also tagged "future" so it shows under the new Futures tab.
 * UNCHANGED from before.
 */
function buildFutures(equityAndIndexSymbols, commodityRoots) {
  const nseOffset = nseNearMonthOffset();
  const monthCodes = monthCodesFromOffset(FUT_MONTHS_AHEAD, nseOffset);
  const out = [];

  for (const s of equityAndIndexSymbols) {
    const [exch, rawTicker] = s.symbol.split(":");
    if (exch !== "NSE") continue; // F&O is an NSE-only segment

    let base = null;
    if (s.type === "equity") base = rawTicker.replace(/-EQ$/i, "");
    else if (s.type === "index" && INDEX_FUT_ROOTS[rawTicker]) base = INDEX_FUT_ROOTS[rawTicker];
    if (!base) continue;

    for (const mc of monthCodes) {
      out.push({ symbol: `NSE:${base}${mc}FUT`, name: `${s.name} FUT (${mc})`, type: "future" });
    }
  }

  for (const c of commodityRoots) {
    // Roll past this month's contract if it's likely already expired/illiquid
    // for THIS specific commodity (different commodities expire on different
    // days — see MCX_EXPIRY_DAY above).
    const offset = mcxNearMonthOffset(c.root);
    const fromMonth = new Date();
    fromMonth.setMonth(fromMonth.getMonth() + offset);
    const commodityMonthCodes = nextValidMonthCodes(c.root, FUT_MONTHS_AHEAD, fromMonth);
    commodityMonthCodes.forEach((mc, i) => {
      const symbol = `MCX:${c.root}${mc}FUT`;
      if (i === 0) {
        out.push({ symbol, name: c.name, type: "commodity" });
      } else {
        out.push({ symbol, name: `${c.name} FUT (${mc})`, type: "future" });
      }
    });
  }

  return out;
}

// ── Loaders ─────────────────────────────────────────────────────────────────

/** symbols/index.json's 5 curated indices → flat {symbol, name, type}. */
function loadIndices(filePath) {
  try {
    const { indices } = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return indices
      .filter((s) => s.symbol && s.name)
      .map((s) => ({
        symbol: String(s.symbol).trim(),
        name: INDEX_DISPLAY_NAME_OVERRIDES[s.name] || String(s.name).trim(),
        type: "index",
      }));
  } catch (err) {
    console.warn(`[Symbols] Could not read ${path.basename(filePath)}: ${err.message}`);
    return [];
  }
}

/**
 * symbols/equity.json's ~202 curated equities → flat {symbol, name, type}.
 * Uses `displayName` (the full company name, e.g. "360 ONE WAM LIMITED"),
 * confirmed byte-identical to what frontend/src/symbols.json's `name` field
 * used to carry for these same symbols — not `name` (equity.json's short
 * ticker-style field, e.g. "360ONE").
 */
function loadEquities(filePath) {
  try {
    const { equities } = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return equities
      .filter((s) => s.symbol && (s.displayName || s.name))
      .map((s) => ({
        symbol: String(s.symbol).trim(),
        name: String(s.displayName || s.name).trim(),
        type: "equity",
      }));
  } catch (err) {
    console.warn(`[Symbols] Could not read ${path.basename(filePath)}: ${err.message}`);
    return [];
  }
}

// ── Build merged list ────────────────────────────────────────────────────────
function buildSymbolList() {
  const seen = new Map(); // symbol → entry

  const sources = [
    ...loadIndices(INDEX_JSON),
    ...loadEquities(EQUITY_JSON),
  ];

  for (const s of sources) {
    if (!seen.has(s.symbol)) seen.set(s.symbol, s);
  }

  // Generate live Futures (equities, NIFTY/BANKNIFTY, MCX commodities).
  // The nearest-month commodity contracts also become the "commodity" type
  // entries — replacing the old static (and not Fyers-valid) "-I" symbols.
  const equityAndIndex = Array.from(seen.values()).filter(
    (s) => s.type === "equity" || s.type === "index"
  );
  const commodityRoots = loadCommodityRoots(COMMODITY_JSON);
  const generated = buildFutures(equityAndIndex, commodityRoots);

  for (const g of generated) {
    if (!seen.has(g.symbol)) seen.set(g.symbol, g);
  }

  const all = Array.from(seen.values());

  // Indices first, then alphabetically by name
  const indices = all.filter(s => s.type === "index")
    .sort((a, b) => a.name.localeCompare(b.name));
  const rest = all.filter(s => s.type !== "index")
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...indices, ...rest];
}

function getSymbols(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedSymbols && now - _cacheTime < CACHE_TTL_MS) {
    return _cachedSymbols;
  }
  _cachedSymbols = buildSymbolList();
  _cacheTime = now;
  console.log(`[Symbols] Loaded ${_cachedSymbols.length} symbols`);
  return _cachedSymbols;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function exchangeOf(sym) {
  const idx = sym.symbol.indexOf(":");
  return idx >= 0 ? sym.symbol.slice(0, idx).toUpperCase() : "NSE";
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/symbols[?exchange=NSE|MCX|BSE] */
router.get("/", (req, res) => {
  try {
    let symbols = getSymbols();
    const exch = (req.query.exchange || "").toUpperCase();
    if (exch) symbols = symbols.filter(s => exchangeOf(s) === exch);
    res.json(symbols);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/symbols/search?q=GOLD[&exchange=MCX] */
router.get("/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  const exch = (req.query.exchange || "").toUpperCase();
  if (!q) return res.json([]);
  try {
    let symbols = getSymbols();
    if (exch) symbols = symbols.filter(s => exchangeOf(s) === exch);
    const results = symbols
      .filter((s) => {
        const colonIdx = s.symbol.indexOf(":");
        const ticker = (colonIdx >= 0 ? s.symbol.slice(colonIdx + 1) : s.symbol).toLowerCase();
        return s.name.toLowerCase().startsWith(q) || ticker.startsWith(q) || ticker.includes(q);
      })
      .slice(0, 20);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/symbols/refresh */
router.post("/refresh", (req, res) => {
  try {
    const symbols = getSymbols(true);
    res.json({ count: symbols.length, message: "Symbol list refreshed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eager load at startup
getSymbols();

module.exports = router;
// Additive only — router is a function, and Express supports attaching
// extra properties to it without changing its behavior as middleware at
// all (app.use(symbolsRouter) still works identically). Exposed so
// backend/src/derivatives/* can reuse this exact, already-tested
// near-month resolution logic instead of re-implementing the same NSE
// Tuesday / MCX per-root expiry-day rules a second time in a different
// file, which is exactly the kind of silent-drift risk flagged
// repeatedly during this project's design phase.
module.exports.nseNearMonthOffset = nseNearMonthOffset;
module.exports.mcxNearMonthOffset = mcxNearMonthOffset;
module.exports.nextMonthCodes = nextMonthCodes;
module.exports.monthCodesFromOffset = monthCodesFromOffset;
// NEW 2026-07-31 — exposed so server.js's Scanner+Backtest symbol loading
// (previously its own duplicate loadScanSymbols(), now deleted, see
// server.js) can reuse this exact parser instead of re-reading the same
// files with a second, simpler implementation. Returns the same cached/
// refreshed list getSymbols() above uses — one parser, one cache, no drift.
module.exports.getSymbols = getSymbols;