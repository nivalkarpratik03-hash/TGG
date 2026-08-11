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
 * EQUITIES — REVERSED 2026-08-11 (explicit user go-ahead, see
 * derivatives-config.json's equities block for the full history): equities
 * are no longer spot-only. The originally spot-only decision (confirmed
 * 2026-07-30) is superseded, not deleted. derivatives-config.json's single
 * `equities` block (not one entry per symbol — the rule is uniform) now
 * carries hasOptions:true, hasFutures:true, so this is a stated decision
 * baked into the data, not an omission every consumer has to re-derive.
 * derivativesGapFill.js's scoped filter now includes assetClass==="EQUITY"
 * under startup/nse_bse_close (excluded only from mcx_close, same as
 * indices), rather than excluding it outright.
 */

const fs = require("fs");
const path = require("path");

// backend/src/derivatives -> backend/src -> backend -> repo root -> symbols
const SYMBOLS_DIR = path.resolve(__dirname, "../../../symbols");
const INDEX_PATH = path.join(SYMBOLS_DIR, "index.json");
const COMMODITY_PATH = path.join(SYMBOLS_DIR, "commodity.json");
const EQUITY_PATH = path.join(SYMBOLS_DIR, "equity.json");
const CONFIG_PATH = path.join(SYMBOLS_DIR, "derivatives-config.json");

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
 * block (same hasOptions/hasFutures rule for every one of the ~202
 * equities — no per-symbol config entries needed since the flags don't
 * vary; strikeGap isn't needed here either — discoverStrikesSinceCheckpoint
 * derives it live from the real chain response per underlying, same as
 * every index).
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
      // BUG FIX (2026-08-11): this was hardcoded to [] regardless of
      // equityCfg.hasOptions — harmless while hasOptions was always false
      // (nothing downstream ever read it), but would have silently broken
      // option-chain discovery the moment equities were enabled (dual-cycle
      // check in discoverStrikes/discoverStrikesSinceCheckpoint reads
      // expiryTypes.length, and every equity would have failed that check
      // with an empty array). Individual stocks only ever get monthly
      // options in India — SEBI's Oct-2024 circular limits weekly expiry
      // to one benchmark index per exchange (NIFTY on NSE, SENSEX on BSE),
      // confirmed already in this same config for NIFTY's own entry — so
      // "monthly" is the correct, not-guessed value here, not a default.
      expiryTypes: equityCfg.hasOptions ? ["monthly"] : [],
      // NSE equity derivatives' monthly expiry day: confirmed via live web
      // search 2026-08-11 (Groww, Dhan, Nubra, ICICIDirect, all citing the
      // real NSE circular) — the Sept-2025 "last Tuesday" change explicitly
      // covers BOTH index AND single-stock derivatives, not index-only.
      // This was already the value here before equities were enabled; now
      // independently confirmed correct rather than inherited unverified.
      expiryDayRule: { exchange: "NSE", monthly: "last Tuesday" },
      mcxAtmReference: null,
      // No static strikeGap needed — discoverStrikesSinceCheckpoint derives
      // the real gap live from each equity's own chain response, same as
      // every index (all of which also have strikeGap:null in config).
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
 *   Equity entries are hasOptions:true AND hasFutures:true as of 2026-08-11
 *   (previously spot-only, confirmed 2026-07-30, since superseded — see
 *   module header above) — derivativesGapFill.js's scoped filter now
 *   includes assetClass==="EQUITY" under startup/nse_bse_close, excluded
 *   only from mcx_close, same as indices.
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
 * The 6 index spot symbols (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX,
 * BANKEX) — flat name/symbol pairs, read directly from symbols/index.json,
 * same pattern as loadStockSpotSymbols() below (no intermediate hardcoded
 * subset). Used by server.js's runCuratedSymbolCatchUp() to build its full
 * curated-spot symbol list (6 indices + ~202 equities) without reading
 * equity.json's F&O-irrelevant fields directly.
 *
 * REPOINTED 2026-08-07: previously filtered through a hardcoded
 * INDEX_SPOT_SUBSET array carrying only 3 of the (then 5, now 6) indices,
 * left over from the old temporary symbols/settings.json's
 * `indexSpotSymbols` list. The array's `displayName` field was confirmed
 * unused — catchUp.js's only call site reads `.symbol` alone (`.map((s) =>
 * s.symbol)`) — so there was nothing behavior-relevant left to preserve by
 * keeping a separate label per index; `index.json`'s own `name` field is
 * used as-is, same as the equity loader already does.
 * @returns {Array<{name: string, symbol: string}>}
 */
function loadIndexSpotSymbols() {
  const { indices } = readJson(INDEX_PATH);
  return indices.map((e) => ({ name: e.name, symbol: e.symbol }));
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