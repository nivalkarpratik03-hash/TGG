/**
 * backend/src/services/instrumentTypeResolver.js
 * ─────────────────────────────────────────────────────────────────
 * Resolves a (assetClass, instrumentType) pair from the Scanner UI's new
 * Instrument Type dropdown into a concrete, deduplicated list of Fyers
 * symbol strings to scan — always live, no DB dependency, consistent
 * across Equity/Index/Commodity, per the agreed design.
 *
 *   assetClass:     "equity" | "index" | "commodity" | "all"
 *   instrumentType: "spot"   | "fut"   | "opt"        | "all"
 *
 * REUSES existing, already-tested logic rather than duplicating it:
 *   - symbolsRouter.js's getSymbols()/buildFutures() output for Spot and
 *     for Commodity Fut (which buildFutures() already tags type
 *     "commodity" specifically so it works as "current fut" — see that
 *     file's own comment).
 *   - derivativesGapFill.js's resolveFuturesSymbols() for Index Fut (all 5
 *     curated indices, not just symbolsRouter.js's INDEX_FUT_ROOTS
 *     NIFTY/BANKNIFTY subset) — including the 2026-08-03 BSE/SENSEX
 *     expiry-day fix.
 *   - derivativesGapFill.js's resolveChainLookupSymbol() + the generic
 *     fetchOptionChain() for Opt discovery (index/commodity).
 *   - curatedUnderlyingsLoader.js's loadCuratedUnderlyings()/
 *     loadEquityUnderlyings() for the underlying lists to drive Opt/Fut
 *     discovery from, instead of hand-assembling them here.
 *
 * COST NOTE (flagged, not a bug): Opt discovery for Equity or "All" means
 * up to ~202 live Fyers option-chain calls just to find symbols, before
 * any candle fetching even starts — meaningfully slower than a spot-only
 * scan. Expect broker rate-limit warnings in logs for edge cases (e.g.
 * SILVERMIC/GOLDPETAL correctly return empty — no listed options; FINNIFTY
 * is a known, separate, unresolved broker-side issue — see
 * symbols/index.json's own _readme and this module's resolveIndexOpt()
 * comment below).
 *
 * NOT DONE HERE (flagged, not silently skipped): an earlier plan for this
 * feature also proposed swapping FINNIFTY's option-chain lookup symbol
 * from "NSE:CNXFINANCE-INDEX" to "NSE:FINNIFTY-INDEX" to work around the
 * "Please provide a valid symbol" broker error. That swap is NOT applied
 * here — nothing in this codebase (server.js's INDEX_ROOT_TO_SYMBOL,
 * symbols/index.json, curatedUnderlyings.json, or any prior session's
 * saved output) confirms "NSE:FINNIFTY-INDEX" is a real, valid Fyers
 * symbol; every reference in this repo uses NSE:CNXFINANCE-INDEX
 * consistently. Applying an unverified symbol swap risks silently
 * breaking a currently-correct spot/candle symbol for a "fix" that has no
 * evidence behind it in this codebase. FINNIFTY Opt discovery will
 * continue to come back empty until this is independently confirmed live
 * against the Fyers API (or Fyers support) — flagged, not guessed around.
 * ─────────────────────────────────────────────────────────────────
 */

"use strict";

const symbolsRouter = require("../routes/symbolsRouter");
const { loadCuratedUnderlyings, loadEquityUnderlyings } = require("../derivatives/curatedUnderlyingsLoader");
const { resolveFuturesSymbols, resolveChainLookupSymbol } = require("../derivatives/derivativesGapFill");
const { fetchOptionChain } = require("../fyers/client");

const ASSET_CLASSES = ["equity", "index", "commodity", "all"];
const INSTRUMENT_TYPES = ["spot", "fut", "opt", "all"];

// Which instrumentType values are valid for a given assetClass — mirrors
// the frontend's ASSET_TO_INSTRUMENT_TYPES gating map exactly (Commodity
// has no Spot — no fixed spot symbol exists for an MCX root, see
// derivativesGapFill.js's resolveChainLookupSymbol() comment).
const VALID_INSTRUMENT_TYPES_FOR_ASSET_CLASS = {
  equity: ["spot", "fut", "opt", "all"],
  index: ["spot", "fut", "opt", "all"],
  commodity: ["fut", "opt", "all"],
  all: ["spot", "fut", "opt", "all"],
};

const OPT_STRIKE_COUNT = 20; // strikes each side of ATM — matches derivativesGapFill.js's default band usage elsewhere

function dedupe(symbols) {
  return [...new Set(symbols.filter(Boolean))];
}

// Bases that show up tagged type:"future" in symbolsRouter.getSymbols()
// but are actually the 2 index futures buildFutures() also generates
// there (NIFTY, BANKNIFTY — via its INDEX_FUT_ROOTS), not equity futures.
// Needed to cleanly split that merged bucket back into "just the equities"
// when isolating the near-month-only contract for Equity Fut.
const INDEX_FUT_BASES_IN_FUTURE_TYPE = new Set(["NIFTY", "BANKNIFTY"]);

function nearMonthCode() {
  const codes = symbolsRouter.monthCodesFromOffset(1, symbolsRouter.nseNearMonthOffset());
  return codes[0];
}

// ── Spot ─────────────────────────────────────────────────────────────────────
// Unchanged existing behavior: today's symbolsRouter.getSymbols().filter(type===X).
function resolveEquitySpot() {
  return symbolsRouter.getSymbols().filter((s) => s.type === "equity").map((s) => s.symbol);
}
function resolveIndexSpot() {
  return symbolsRouter.getSymbols().filter((s) => s.type === "index").map((s) => s.symbol);
}
// No resolveCommoditySpot() — no fixed spot symbol exists for an MCX root
// (see derivativesGapFill.js's resolveChainLookupSymbol comment). Callers
// must reject Commodity+Spot before reaching this module (scannerRouter.js
// does, and the frontend dropdown never offers the combo either).

// ── Fut ──────────────────────────────────────────────────────────────────────
/**
 * Equity Fut — near-month contract only, per symbol.
 * symbolsRouter.js's buildFutures() generates FUT_MONTHS_AHEAD (3) months
 * for every F&O-eligible equity, all tagged the same type:"future" — there
 * is no built-in way to ask for "just the near month". This filters the
 * already-generated (and already exclusion-filtered) "future" bucket down
 * to just the near-month code, rather than reimplementing the F&O
 * eligibility/exclusion logic a second time here.
 */
function resolveEquityFut() {
  const code = nearMonthCode();
  const suffix = `${code}FUT`;
  return symbolsRouter.getSymbols()
    .filter((s) => s.type === "future" && s.symbol.startsWith("NSE:") && s.symbol.endsWith(suffix))
    .filter((s) => {
      const ticker = s.symbol.split(":")[1];
      const base = ticker.slice(0, ticker.length - suffix.length);
      return !INDEX_FUT_BASES_IN_FUTURE_TYPE.has(base);
    })
    .map((s) => s.symbol);
}

/**
 * Index Fut — near-month contract only, for all 5 curated indices (not
 * just symbolsRouter.js's INDEX_FUT_ROOTS NIFTY/BANKNIFTY subset).
 * Reuses derivativesGapFill.js's resolveFuturesSymbols(entry), which
 * returns [nearMonth, nextMonth] — takes just the first.
 */
function resolveIndexFut() {
  const { indices } = loadCuratedUnderlyings();
  return indices
    .filter((entry) => entry.hasFutures !== false)
    .map((entry) => resolveFuturesSymbols(entry)[0])
    .filter(Boolean);
}

/**
 * Commodity Fut — needs no new logic. symbolsRouter.js's buildFutures()
 * already tags each commodity root's near-month contract as
 * type:"commodity" specifically so it works as "current fut" (see that
 * function's own comment). This is today's existing type=commodity filter,
 * unchanged.
 */
function resolveCommodityFut() {
  return symbolsRouter.getSymbols().filter((s) => s.type === "commodity").map((s) => s.symbol);
}

// ── Opt (live) ───────────────────────────────────────────────────────────────
/**
 * Discovers real strike symbols for one curated (index/commodity) entry via
 * a live fetchOptionChain call. hasOptions:false entries (SILVERMIC,
 * GOLDPETAL — no listed options) correctly resolve to an empty array
 * without a broker call.
 */
async function discoverOptSymbolsForEntry(entry, log) {
  if (entry.hasOptions === false) return [];
  const lookupSymbol = resolveChainLookupSymbol(entry);
  const { strikes } = await fetchOptionChain(lookupSymbol, { strikeCount: OPT_STRIKE_COUNT });
  if (log) log(`[InstrumentTypeResolver] Opt ${entry.underlying} (${lookupSymbol}): ${strikes.length} real strike symbol(s)`);
  return strikes.map((s) => s.symbol);
}

async function resolveIndexOpt(log) {
  const { indices } = loadCuratedUnderlyings();
  const out = [];
  for (const entry of indices) {
    out.push(...(await discoverOptSymbolsForEntry(entry, log)));
  }
  return out;
}

async function resolveCommodityOpt(log) {
  const { commodities } = loadCuratedUnderlyings();
  const out = [];
  for (const entry of commodities) {
    out.push(...(await discoverOptSymbolsForEntry(entry, log)));
  }
  return out;
}

/**
 * Equity Opt — up to ~202 live fetchOptionChain calls, one per equity
 * underlying, using symbols/equity.json's spot symbol directly
 * ("NSE:{TICKER}-EQ"). fetchOptionChain is confirmed fully generic (any
 * symbol string, no hardcoding — see its own docstring in
 * backend/src/fyers/client.js), so this works the same way the
 * index/commodity paths already do; it is a NEW live-call site though —
 * this codebase's existing GapFill checkpoint deliberately never calls it
 * for equities (see derivativesGapFill.js's file-header note on why), so
 * this is genuinely unverified against a live broker token in this
 * session. Deliberately bypasses each entry's hasOptions flag from
 * curatedUnderlyingsLoader.js — that flag is hardcoded false for every
 * equity uniformly (GapFill's scope decision, not a real "no options"
 * fact) and would otherwise skip every single equity here.
 */
async function resolveEquityOpt(log) {
  const equities = loadEquityUnderlyings();
  const out = [];
  for (const entry of equities) {
    const { strikes } = await fetchOptionChain(entry.spotSymbol, { strikeCount: OPT_STRIKE_COUNT });
    if (log && strikes.length > 0) log(`[InstrumentTypeResolver] Opt ${entry.underlying} (${entry.spotSymbol}): ${strikes.length} real strike symbol(s)`);
    out.push(...strikes.map((s) => s.symbol));
  }
  return out;
}

// ── Per-assetClass dispatch ───────────────────────────────────────────────────
async function resolveEquity(instrumentType, log) {
  if (instrumentType === "spot") return resolveEquitySpot();
  if (instrumentType === "fut") return resolveEquityFut();
  if (instrumentType === "opt") return dedupe(await resolveEquityOpt(log));
  // "all" — union of Spot + Fut + Opt
  const opt = await resolveEquityOpt(log);
  return dedupe([...resolveEquitySpot(), ...resolveEquityFut(), ...opt]);
}

async function resolveIndex(instrumentType, log) {
  if (instrumentType === "spot") return resolveIndexSpot();
  if (instrumentType === "fut") return resolveIndexFut();
  if (instrumentType === "opt") return dedupe(await resolveIndexOpt(log));
  const opt = await resolveIndexOpt(log);
  return dedupe([...resolveIndexSpot(), ...resolveIndexFut(), ...opt]);
}

async function resolveCommodity(instrumentType, log) {
  // instrumentType === "spot" is rejected by resolveInstrumentSymbols()
  // before this is ever reached.
  if (instrumentType === "fut") return resolveCommodityFut();
  if (instrumentType === "opt") return dedupe(await resolveCommodityOpt(log));
  const opt = await resolveCommodityOpt(log);
  return dedupe([...resolveCommodityFut(), ...opt]);
}

/**
 * Resolves a (assetClass, instrumentType) combo into a deduplicated symbol
 * list. assetClass="all" unions Equity+Index+Commodity for the given
 * instrumentType (Commodity naturally contributes nothing for "spot" — no
 * fixed spot symbol exists — rather than being an error in the "all"
 * context, unlike an explicit Commodity+Spot request).
 * @returns {Promise<string[]>}
 * @throws {Error} on unknown assetClass/instrumentType or an explicit
 *   Commodity+Spot request — callers (scannerRouter.js) should catch and
 *   map to a 400.
 */
async function resolveInstrumentSymbols(assetClass, instrumentType, deps = {}) {
  const log = deps.log || ((msg) => console.log(msg));

  if (!ASSET_CLASSES.includes(assetClass)) {
    throw new Error(`Unknown assetClass "${assetClass}" — expected one of: ${ASSET_CLASSES.join(", ")}`);
  }
  if (!INSTRUMENT_TYPES.includes(instrumentType)) {
    throw new Error(`Unknown instrumentType "${instrumentType}" — expected one of: ${INSTRUMENT_TYPES.join(", ")}`);
  }
  if (assetClass === "commodity" && instrumentType === "spot") {
    throw new Error(`Invalid combination: Commodity + Spot — no fixed spot symbol exists for an MCX root`);
  }

  if (assetClass === "equity") return resolveEquity(instrumentType, log);
  if (assetClass === "index") return resolveIndex(instrumentType, log);
  if (assetClass === "commodity") return resolveCommodity(instrumentType, log);

  // assetClass === "all" — union across Equity + Index + Commodity.
  // Commodity is skipped for instrumentType==="spot" (contributes nothing,
  // not an error — the "all" context isn't an explicit Commodity+Spot ask).
  const parts = [
    resolveEquity(instrumentType, log),
    resolveIndex(instrumentType, log),
    instrumentType === "spot" ? Promise.resolve([]) : resolveCommodity(instrumentType, log),
  ];
  const results = await Promise.all(parts);
  return dedupe(results.flat());
}

module.exports = {
  resolveInstrumentSymbols,
  ASSET_CLASSES,
  INSTRUMENT_TYPES,
  VALID_INSTRUMENT_TYPES_FOR_ASSET_CLASS,
};
