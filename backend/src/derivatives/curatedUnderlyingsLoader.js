/**
 * backend/src/derivatives/curatedUnderlyingsLoader.js
 *
 * Merges curatedUnderlyings.json (indices + commodities, hand-maintained)
 * with the equity list DERIVED from backend/src/data/noExpirySymbols.json
 * (never hand-copied — see curatedUnderlyings.json's _readme for why) into
 * one normalized array atmMergeService.js can iterate over without caring
 * where each entry originally came from.
 *
 * Equity derivation rule: every entry in noExpirySymbols.json whose symbol
 * ends in "-EQ" (i.e. everything except the 3 indices mixed into that same
 * file — NIFTY 50, NIFTY BANK, SENSEX, identified by "-INDEX" instead).
 * Every equity gets the identical, uniform rule confirmed for NSE stocks:
 * single monthly cycle, NSE, last Tuesday, no options-tracking substitution
 * needed (unlike the MCX micro/petal cases).
 */

const fs = require("fs");
const path = require("path");

const CURATED_PATH = path.join(__dirname, "curatedUnderlyings.json");
const NO_EXPIRY_PATH = path.join(__dirname, "..", "data", "noExpirySymbols.json");

function loadEquityUnderlyings() {
  const noExpiry = JSON.parse(fs.readFileSync(NO_EXPIRY_PATH, "utf8"));
  return noExpiry
    .filter((entry) => typeof entry.symbol === "string" && entry.symbol.endsWith("-EQ"))
    .map((entry) => {
      // "NSE:RELIANCE-EQ" -> underlying "RELIANCE"
      const withoutExchange = entry.symbol.split(":")[1] || entry.symbol;
      const underlying = withoutExchange.replace(/-EQ$/, "");
      return {
        underlying,
        assetClass: "EQUITY",
        exchange: "NSE",
        spotSymbol: entry.symbol,
        expiryTypes: ["monthly"],
        expiryDayRule: { exchange: "NSE", monthly: "last Tuesday" },
        mcxAtmReference: null,
        strikeGap: null,
        notes: `Derived from noExpirySymbols.json ("${entry.name}") — not hand-maintained here.`,
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
 */
function loadCuratedUnderlyings() {
  const curated = JSON.parse(fs.readFileSync(CURATED_PATH, "utf8"));
  const equities = loadEquityUnderlyings();
  const all = [...curated.indices, ...curated.commodities, ...equities];
  return {
    indices: curated.indices,
    commodities: curated.commodities,
    equities,
    all,
    atmBandWidth: curated.atmBandWidth,
    openItems: curated.openItems,
  };
}

module.exports = { loadCuratedUnderlyings, loadEquityUnderlyings };
