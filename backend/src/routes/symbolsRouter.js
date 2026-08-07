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
 * convention to preserve for those two. BANKEX (added 2026-08-06) is the
 * same situation as FINNIFTY/MIDCPNIFTY — no legacy display text ever
 * existed for it, so it's deliberately NOT in the overrides map below and
 * falls through to index.json's own `name` field ("BANKEX") via the
 * `INDEX_DISPLAY_NAME_OVERRIDES[s.name] || s.name` fallback in
 * loadIndices() — confirmed correct output, not an oversight.
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
const { loadIndexSpotSymbols } = require("../derivatives/curatedUnderlyingsLoader");

const router = express.Router();

// backend/src/routes -> backend/src -> backend -> repo root -> symbols
const SYMBOLS_DIR = path.resolve(__dirname, "../../../symbols");
const INDEX_JSON = path.join(SYMBOLS_DIR, "index.json");
const EQUITY_JSON = path.join(SYMBOLS_DIR, "equity.json");
const COMMODITY_JSON = path.join(SYMBOLS_DIR, "commodity.json");
const EQUITY_FO_EXCLUSIONS_JSON = path.join(SYMBOLS_DIR, "equity-fo-exclusions.json");

/**
 * equity.json is the general NSE board list, NOT the (smaller) NSE
 * F&O-eligible list -- most equities in it have no listed derivatives at
 * all. Loads the live-verified exclusion set (see
 * symbols/equity-fo-exclusions.json's own _readme/coverage block for
 * exactly what's been checked and what hasn't -- only 9 of 202 as of
 * 2026-08-01, NOT a complete eligibility table). Returns a Set of
 * excluded underlyings, or an empty Set if the file is missing/unreadable
 * (fails open to current behavior rather than silently blocking futures
 * generation for everything).
 */
function loadEquityFoExclusions() {
  try {
    const { excluded } = JSON.parse(fs.readFileSync(EQUITY_FO_EXCLUSIONS_JSON, "utf8"));
    return new Set((excluded || []).map((e) => e.underlying));
  } catch (err) {
    console.warn(`[Symbols] Could not read equity-fo-exclusions.json: ${err.message} — proceeding with zero exclusions`);
    return new Set();
  }
}

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

// The futures-ticker root sometimes differs from the index's spot ticker
// (e.g. spot ticker "NIFTY50-INDEX" but the futures contract root is
// "NIFTY"). Built dynamically from symbols/index.json — the same root
// master curatedUnderlyingsLoader.js reads — instead of a hand-maintained
// table. This works uniformly for all 6 curated indices because each
// index's futures root IS simply its `name` field in index.json
// (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX all match their
// own name exactly) — confirmed by inspecting every entry, not assumed.
// No per-index override table needed, and this can't go stale again if a
// 7th index is ever curated.
const INDEX_FUT_ROOTS = Object.fromEntries(
  loadIndexSpotSymbols().map((e) => [e.symbol.split(":")[1], e.name])
);

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

// ── BSE F&O expiry rollover ──────────────────────────────────────────────────
// NEW 2026-08-03 — BSE (SENSEX/BANKEX) monthly F&O contracts expire on the
// LAST THURSDAY of the month, NOT NSE's last-Tuesday rule — this mirrors
// exactly the same last-Thursday convention already relied on elsewhere in
// this codebase (database/src/symbolParser.js's lastThursdayOfMonth(), used
// by derivativesGapFill.js's classifyMonthlyExpiry() with
// `exchange === "BSE" ? lastThursdayOfMonth : lastTuesdayOfMonth`). Added
// because derivativesGapFill.js's resolveFuturesSymbols() previously called
// nseNearMonthOffset() unconditionally for every non-MCX exchange, including
// BSE — silently assuming SENSEX rolls on NSE's Tuesday schedule. Follows
// the identical structure to nseNearMonthOffset() below, including the same
// holiday-adjustment step, just with Thursday as the target weekday.
const BSE_EXPIRY_DOW = 4; // Thursday
function bseNearMonthOffset(from = new Date()) {
  let lastThu = new Date(from.getFullYear(), from.getMonth() + 1, 0); // last calendar day of month
  while (lastThu.getDay() !== BSE_EXPIRY_DOW) lastThu.setDate(lastThu.getDate() - 1);
  lastThu = previousTradingDay(lastThu, "BSE");
  const expiryClose = new Date(lastThu);
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
 *   - NSE equities
 *   - All 6 curated index futures (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY —
 *     NSE; SENSEX, BANKEX — BSE), each on its own exchange's real expiry
 *     calendar
 *   - MCX commodities (roots taken from symbols/commodity.json)
 *
 * ROOT-CAUSE FIX (2026-08-01): equity.json is the general NSE board list,
 * not the F&O-eligible subset — most equities in it have no listed
 * derivatives at all. This used to generate a futures contract for every
 * single one, producing confirmed-invalid symbols for stocks with no real
 * F&O (EXIDEIND, HUDCO, PPLPHARMA, SAMMAANCAP, SYNGENE, TATATECH,
 * TORNTPOWER, NUVAMA — each individually live-verified in the Fyers app,
 * see symbols/equity-fo-exclusions.json). Those 8 are now skipped.
 * IMPORTANT: only 9 of 202 equities have been checked this way — this is
 * a partial, honestly-scoped exclusion list, not a complete eligibility
 * table. See that file's own coverage/warning block before assuming any
 * other equity is confirmed either way.
 *
 * ROOT-CAUSE FIX (this session): this function used to hard-skip every
 * symbol whose exchange wasn't NSE (`if (exch !== "NSE") continue`), so
 * SENSEX and BANKEX (both BSE) never generated futures no matter what
 * INDEX_FUT_ROOTS contained — and it also called nseNearMonthOffset()
 * unconditionally, which is the wrong (Tuesday) expiry rule for BSE
 * (Thursday — see bseNearMonthOffset() above, already used correctly
 * elsewhere in this codebase, just never wired in here). Now equities stay
 * NSE-only (real constraint — equity F&O only exists on NSE), while index
 * futures are generated per the index's own real exchange, each using that
 * exchange's own expiry calendar.
 *
 * The nearest commodity month is tagged type "commodity" so it keeps
 * appearing (and working) under the existing Commodity tab using a real,
 * currently-tradable symbol. Every month (including that nearest one) is
 * also tagged "future" so it shows under the new Futures tab.
 */
function buildFutures(equityAndIndexSymbols, commodityRoots) {
  const nseMonthCodes = monthCodesFromOffset(FUT_MONTHS_AHEAD, nseNearMonthOffset());
  const bseMonthCodes = monthCodesFromOffset(FUT_MONTHS_AHEAD, bseNearMonthOffset());
  const foExclusions = loadEquityFoExclusions();
  const out = [];

  for (const s of equityAndIndexSymbols) {
    const [exch, rawTicker] = s.symbol.split(":");

    let base = null;
    let monthCodes = null;
    if (s.type === "equity") {
      if (exch !== "NSE") continue; // equity F&O is an NSE-only segment
      base = rawTicker.replace(/-EQ$/i, "");
      monthCodes = nseMonthCodes;
    } else if (s.type === "index" && INDEX_FUT_ROOTS[rawTicker]) {
      base = INDEX_FUT_ROOTS[rawTicker];
      monthCodes = exch === "BSE" ? bseMonthCodes : nseMonthCodes;
    }
    if (!base) continue;
    if (s.type === "equity" && foExclusions.has(base)) continue; // live-verified: no real F&O for this one

    for (const mc of monthCodes) {
      out.push({ symbol: `${exch}:${base}${mc}FUT`, name: `${s.name} FUT (${mc})`, type: "future" });
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

/** GET /api/symbols[?exchange=NSE|MCX|BSE][&type=index|equity|commodity|future] */
router.get("/", (req, res) => {
  try {
    let symbols = getSymbols();
    const exch = (req.query.exchange || "").toUpperCase();
    if (exch) symbols = symbols.filter(s => exchangeOf(s) === exch);
    // NEW 2026-08-02 — category filter for the Scanner UI's symbol/category
    // dropdown (All/Index/Commodity/Equity). "commodity" here means the
    // near-month tradable contract buildFutures() already tags type
    // "commodity" (not "future") specifically so this filter works without
    // any extra logic — see buildFutures()'s own comment on why.
    const type = (req.query.type || "").toLowerCase();
    if (type) symbols = symbols.filter(s => s.type === type);
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
// NEW 2026-08-03 — see the function's own comment above for the bug this
// fixes (derivativesGapFill.js's resolveFuturesSymbols() defaulting every
// non-MCX exchange, including BSE, to NSE's Tuesday rule).
module.exports.bseNearMonthOffset = bseNearMonthOffset;
module.exports.mcxNearMonthOffset = mcxNearMonthOffset;
module.exports.nextMonthCodes = nextMonthCodes;
module.exports.monthCodesFromOffset = monthCodesFromOffset;
// NEW 2026-08-01 — exported so derivativesGapFill.js's resolveFuturesSymbols()
// can respect RESTRICTED_MONTH_CYCLE (SILVERM/SILVERMIC only list Feb/Apr/
// Jun/Aug/Nov/Dec) instead of generating calendar-sequential months that
// were never listed. Previously this function existed but was never
// exported, so GapFill had no way to reach it and used the unrestricted
// monthCodesFromOffset() for every MCX root — root cause of the confirmed
// "MCX:SILVERM26SEPFUT ... Invalid symbol provided" failure.
module.exports.nextValidMonthCodes = nextValidMonthCodes;
// NEW 2026-07-31 — exposed so server.js's Scanner+Backtest symbol loading
// (previously its own duplicate loadScanSymbols(), now deleted, see
// server.js) can reuse this exact parser instead of re-reading the same
// files with a second, simpler implementation. Returns the same cached/
// refreshed list getSymbols() above uses — one parser, one cache, no drift.
module.exports.getSymbols = getSymbols;
// NEW (this session) — exported so instrumentTypeResolver.js's
// INDEX_FUT_BASES_IN_FUTURE_TYPE can derive itself from this exact map
// instead of keeping its own separate hardcoded copy of "which bases get
// type:'future' index entries here." One source of truth for that fact.
module.exports.INDEX_FUT_ROOTS = INDEX_FUT_ROOTS;