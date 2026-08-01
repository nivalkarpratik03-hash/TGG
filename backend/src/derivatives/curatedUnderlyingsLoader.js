/**
 * backend/src/derivatives/curatedUnderlyingsLoader.js
 *
 * REWRITTEN 2026-07-30 — reads 3 flat, hand-editable files under
 * backend/src/derivatives/symbols/ instead of parsing
 * noExpirySymbols.json by "-EQ" suffix and merging with
 * curatedUnderlyings.json:
 *   symbols/index.json      — the 5 index underlyings (F&O-shaped, verbatim
 *                              from the old curatedUnderlyings.json "indices")
 *   symbols/commodity.json  — the 6 MCX commodities (verbatim from the old
 *                              curatedUnderlyings.json "commodities")
 *   symbols/stocks.json     — the ~202 NSE equities (verbatim name/symbol
 *                              pairs, previously mixed into noExpirySymbols.json
 *                              alongside the 3 index spot entries)
 *   symbols/settings.json   — atmBandWidth, openItems, and the 3 index spot
 *                              entries server.js's runCuratedSymbolCatchUp()
 *                              needs directly (cross-cutting, not specific
 *                              to one asset class)
 *
 * This removes the old suffix-filtering guesswork (previously had to infer
 * "is this an equity or an index?" from whether the symbol ended in "-EQ"
 * vs "-INDEX") — each file now only ever contains one asset class, so
 * nothing needs to be inferred.
 *
 * EQUITIES ARE SPOT-ONLY (confirmed 2026-07-30, not a guess): no stock
 * futures, no stock options, ever, in the GapFill checkpoint. Every equity
 * entry below is explicit hasOptions:false, hasFutures:false so this is a
 * stated decision baked into the data, not an omission that has to be
 * re-derived by every consumer. curatedSymbolCatchUp's Recovery+Staleness
 * sweep (in server.js) is the only thing that ever touches equity data —
 * it now reads symbols/stocks.json directly instead of noExpirySymbols.json.
 */

const fs = require("fs");
const path = require("path");

const SYMBOLS_DIR = path.join(__dirname, "symbols");
const INDEX_PATH = path.join(SYMBOLS_DIR, "index.json");
const COMMODITY_PATH = path.join(SYMBOLS_DIR, "commodity.json");
const STOCKS_PATH = path.join(SYMBOLS_DIR, "stocks.json");
const SETTINGS_PATH = path.join(SYMBOLS_DIR, "settings.json");

/**
 * Builds the normalized equity entries atmMergeService.js (and
 * derivativesGapFill.js) iterate over, from symbols/stocks.json's flat
 * name/symbol pairs.
 */
function loadEquityUnderlyings() {
  const { equities } = JSON.parse(fs.readFileSync(STOCKS_PATH, "utf8"));
  return equities.map((entry) => {
    // "NSE:RELIANCE-EQ" -> underlying "RELIANCE"
    const withoutExchange = entry.symbol.split(":")[1] || entry.symbol;
    const underlying = withoutExchange.replace(/-EQ$/, "");
    return {
      underlying,
      assetClass: "EQUITY",
      exchange: "NSE",
      spotSymbol: entry.symbol,
      // CONFIRMED 2026-07-30: equities are spot-only in this app, no F&O
      // tracking of any kind. Explicit false here — not left undefined —
      // so no eligibility check anywhere has to guess. (This was the
      // original root cause of the "freeze": these two flags used to be
      // entirely absent, and derivativesGapFill.js's old eligibility
      // checks only ever excluded an entry when the flag was STRICTLY
      // `=== false`/`!== false`. undefined never matched that, so every
      // one of these ~202 equities was silently treated as futures- AND
      // options-eligible on every checkpoint run.)
      hasOptions: false,
      hasFutures: false,
      expiryTypes: [],
      expiryDayRule: { exchange: "NSE", monthly: "last Tuesday" },
      mcxAtmReference: null,
      strikeGap: null,
      notes: `Derived from symbols/stocks.json ("${entry.name}") — spot-only, confirmed 2026-07-30, never part of the derivatives GapFill checkpoint.`,
    };
  });
}

/**
 * @returns {{ indices: object[], commodities: object[], equities: object[], all: object[], atmBandWidth: number, openItems: string[] }}
 *   `all` is every trackable underlying flattened into one array, in the
 *   normalized shape every entry above already uses — this is what
 *   atmMergeService.js iterates over. Commodity entries with
 *   hasOptions:false (SILVERMIC, GOLDPETAL) ARE included in `all` (they
 *   still need futures rolling) but atmMergeService.js's ATM merge-check
 *   specifically must skip them — see hasOptions on each entry.
 *   Equity entries are hasOptions:false AND hasFutures:false (spot-only,
 *   confirmed 2026-07-30) — derivativesGapFill.js's scoped filter excludes
 *   assetClass==="EQUITY" outright rather than relying on these flags
 *   alone, so equities never enter the F&O checkpoint at all.
 */
function loadCuratedUnderlyings() {
  const { indices } = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const { commodities } = JSON.parse(fs.readFileSync(COMMODITY_PATH, "utf8"));
  const { atmBandWidth, openItems } = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  const equities = loadEquityUnderlyings();
  const all = [...indices, ...commodities, ...equities];
  return {
    indices,
    commodities,
    equities,
    all,
    atmBandWidth,
    openItems,
  };
}

/**
 * The 3 index spot symbols (NIFTY 50, NIFTY BANK, SENSEX) — flat
 * name/symbol pairs, same shape as loadStockSpotSymbols() below. Used by
 * server.js's runCuratedSymbolCatchUp() to build its full curated-spot
 * symbol list (3 indices + ~202 equities) without reading
 * noExpirySymbols.json directly.
 * @returns {Array<{name: string, symbol: string}>}
 */
function loadIndexSpotSymbols() {
  const { indexSpotSymbols } = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  return indexSpotSymbols;
}

/**
 * The ~202 equity spot symbols — flat name/symbol pairs, verbatim from
 * symbols/stocks.json. Used by server.js's runCuratedSymbolCatchUp() the
 * same way it used to read noExpirySymbols.json's "-EQ" entries directly.
 * @returns {Array<{name: string, symbol: string}>}
 */
function loadStockSpotSymbols() {
  const { equities } = JSON.parse(fs.readFileSync(STOCKS_PATH, "utf8"));
  return equities;
}

module.exports = {
  loadCuratedUnderlyings,
  loadEquityUnderlyings,
  loadIndexSpotSymbols,
  loadStockSpotSymbols,
};