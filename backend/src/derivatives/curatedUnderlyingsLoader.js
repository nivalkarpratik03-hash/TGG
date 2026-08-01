/**
 * backend/src/derivatives/curatedUnderlyingsLoader.js
 *
 * REPOINTED 2026-07-31 — reads the root-level `symbols/` master (sibling to
 * backend/, frontend/, database/) instead of the temporary
 * backend/src/derivatives/symbols/ folder:
 *   symbols/index.json              — 5 index underlyings, plain shape
 *                                      (name/symbol/exchange/type)
 *   symbols/commodity.json          — 6 MCX commodities (GapFill-curated
 *                                      list, NOT frontend/src/mcx.json's 18),
 *                                      plain shape
 *   symbols/equity.json             — ~202 NSE equities, plain shape
 *   symbols/derivatives-config.json — F&O-only overlay (expiryTypes,
 *                                      expiryDayRule, hasOptions/hasFutures,
 *                                      mcxAtmReference, strikeGap,
 *                                      atmBandWidth, openItems), keyed by
 *                                      `name` for indices/commodities, plus
 *                                      one uniform equities block
 *
 * This is the second repoint of this file. The 2026-07-30 rewrite (see git
 * history) moved it off noExpirySymbols.json/curatedUnderlyings.json onto
 * backend/src/derivatives/symbols/ — that folder was always meant to be
 * temporary, absorbed into this root master once it existed. Nothing about
 * the OUTPUT SHAPE below changed in this repoint: derivativesGapFill.js
 * (loadCuratedUnderlyings → { all, atmBandWidth }, filtering on
 * entry.assetClass / entry.underlying) and server.js
 * (loadIndexSpotSymbols / loadStockSpotSymbols → [{name, symbol}]) both
 * keep working unmodified — only where the data comes from changed.
 *
 * The root master keeps the plain files (index/commodity/equity) free of
 * F&O-specific fields, per the design locked in earlier this session — this
 * loader is the join point that merges each plain entry with its
 * derivatives-config.json overlay by `name` to reconstruct the same
 * F&O-shaped entry the rest of the derivatives pipeline already expects.
 *
 * EQUITIES ARE SPOT-ONLY (confirmed 2026-07-30, not a guess): no stock
 * futures, no stock options, ever, in the GapFill checkpoint.
 * derivatives-config.json's single `equities` block (not one entry per
 * symbol — the rule is uniform) carries hasOptions:false, hasFutures:false
 * explicitly, so this is a stated decision baked into the data, not an
 * omission every consumer has to re-derive. derivativesGapFill.js's scoped
 * filter also excludes assetClass==="EQUITY" outright rather than relying
 * on these flags alone.
 */

const fs = require("fs");
const path = require("path");

// backend/src/derivatives -> backend/src -> backend -> repo root -> symbols
const SYMBOLS_DIR = path.resolve(__dirname, "../../../symbols");
const INDEX_PATH = path.join(SYMBOLS_DIR, "index.json");
const COMMODITY_PATH = path.join(SYMBOLS_DIR, "commodity.json");
const EQUITY_PATH = path.join(SYMBOLS_DIR, "equity.json");
const CONFIG_PATH = path.join(SYMBOLS_DIR, "derivatives-config.json");

/**
 * Recovery+Staleness sweep in server.js's runCuratedSymbolCatchUp() only
 * ever tracked spot data for these 3 indices (NIFTY, BANKNIFTY, SENSEX) —
 * NOT FINNIFTY/MIDCPNIFTY, which the F&O side tracks but this particular
 * spot sweep never did. This is the same 3-entry subset that used to live
 * verbatim in the temporary symbols/settings.json's `indexSpotSymbols`
 * array; carried forward as-is here rather than guessed at or silently
 * expanded to all 5. Display names ("NIFTY 50" / "NIFTY BANK") also match
 * that original list verbatim — they differ from index.json's `name` field
 * ("NIFTY" / "BANKNIFTY") on purpose, symbols are looked up (not retyped)
 * so they can never drift from the master.
 */
const INDEX_SPOT_SUBSET = [
  { underlying: "NIFTY", displayName: "NIFTY 50" },
  { underlying: "BANKNIFTY", displayName: "NIFTY BANK" },
  { underlying: "SENSEX", displayName: "SENSEX" },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Joins the plain root-master entries (index.json / commodity.json) with
 * their F&O overlay in derivatives-config.json, by `name`, producing the
 * same flat F&O-shaped entry shape this loader has always returned.
 */
function mergeWithConfig(plainEntries, configBlock, assetClass) {
  return plainEntries.map((entry) => {
    const cfg = configBlock[entry.name];
    if (!cfg) {
      throw new Error(
        `[curatedUnderlyingsLoader] No derivatives-config.json overlay found for "${entry.name}" (${assetClass}) — symbols/index.json, commodity.json, and derivatives-config.json have drifted out of sync.`
      );
    }
    return {
      underlying: entry.name,
      assetClass,
      exchange: entry.exchange,
      spotSymbol: entry.symbol,
      hasOptions: cfg.hasOptions,
      hasFutures: cfg.hasFutures,
      expiryTypes: cfg.expiryTypes,
      expiryDayRule: cfg.expiryDayRule,
      mcxAtmReference: cfg.mcxAtmReference,
      strikeGap: cfg.strikeGap,
      notes: cfg.notes,
    };
  });
}

/**
 * Builds the normalized equity entries atmMergeService.js (and
 * derivativesGapFill.js) iterate over, from symbols/equity.json's flat
 * name/symbol pairs plus derivatives-config.json's single uniform equities
 * block (same hasOptions:false/hasFutures:false rule for every one of the
 * ~202 equities — no per-symbol config entries needed since it never
 * varies).
 */
function loadEquityUnderlyings() {
  const { equities } = readJson(EQUITY_PATH);
  const { equities: equityCfg } = readJson(CONFIG_PATH);
  return equities.map((entry) => {
    // "NSE:RELIANCE-EQ" -> underlying "RELIANCE"
    const withoutExchange = entry.symbol.split(":")[1] || entry.symbol;
    const underlying = withoutExchange.replace(/-EQ$/, "");
    return {
      underlying,
      assetClass: "EQUITY",
      exchange: entry.exchange,
      spotSymbol: entry.symbol,
      hasOptions: equityCfg.hasOptions,
      hasFutures: equityCfg.hasFutures,
      expiryTypes: [],
      expiryDayRule: { exchange: "NSE", monthly: "last Tuesday" },
      mcxAtmReference: null,
      strikeGap: null,
      notes: `${equityCfg.notes} (source: symbols/equity.json "${entry.name}")`,
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
 *   alone.
 */
function loadCuratedUnderlyings() {
  const { indices: indexMaster } = readJson(INDEX_PATH);
  const { commodities: commodityMaster } = readJson(COMMODITY_PATH);
  const config = readJson(CONFIG_PATH);

  const indices = mergeWithConfig(indexMaster, config.indices, "INDEX");
  const commodities = mergeWithConfig(commodityMaster, config.commodities, "COMMODITY");
  const equities = loadEquityUnderlyings();
  const all = [...indices, ...commodities, ...equities];

  return {
    indices,
    commodities,
    equities,
    all,
    atmBandWidth: config.atmBandWidth,
    openItems: config.openItems,
  };
}

/**
 * The 3 index spot symbols (NIFTY 50, NIFTY BANK, SENSEX) — flat
 * name/symbol pairs, same shape as loadStockSpotSymbols() below. Used by
 * server.js's runCuratedSymbolCatchUp() to build its full curated-spot
 * symbol list (3 indices + ~202 equities) without reading equity.json's
 * F&O-irrelevant fields directly.
 * @returns {Array<{name: string, symbol: string}>}
 */
function loadIndexSpotSymbols() {
  const { indices } = readJson(INDEX_PATH);
  const byUnderlying = new Map(indices.map((e) => [e.name, e]));
  return INDEX_SPOT_SUBSET.map(({ underlying, displayName }) => {
    const master = byUnderlying.get(underlying);
    if (!master) {
      throw new Error(
        `[curatedUnderlyingsLoader] loadIndexSpotSymbols: "${underlying}" not found in symbols/index.json — expected subset and master have drifted out of sync.`
      );
    }
    return { name: displayName, symbol: master.symbol };
  });
}

/**
 * The ~202 equity spot symbols — flat name/symbol pairs, verbatim from
 * symbols/equity.json. Used by server.js's runCuratedSymbolCatchUp() the
 * same way it used to read the temporary symbols/stocks.json.
 * @returns {Array<{name: string, symbol: string}>}
 */
function loadStockSpotSymbols() {
  const { equities } = readJson(EQUITY_PATH);
  return equities.map((e) => ({ name: e.name, symbol: e.symbol }));
}

module.exports = {
  loadCuratedUnderlyings,
  loadEquityUnderlyings,
  loadIndexSpotSymbols,
  loadStockSpotSymbols,
};