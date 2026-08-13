// frontend/src/utils/symbolMeta.js
//
// SINGLE SOURCE OF TRUTH for splitting an "EXCHANGE:TICKER" string, previously
// copy-pasted independently across 4 files.
//
// Two shapes existed before this consolidation — kept as two shapes here too,
// NOT collapsed into one, because they genuinely take different inputs and
// have different fallback defaults (verified, not guessed):
//
//   tickerOf(sym) / exchangeOf(sym)
//     — take a plain STRING like "NSE:RELIANCE".
//     — exchangeOf() with no colon found returns "" (empty string).
//     — previously duplicated identically in pages/BacktestPage.js (tickerOf
//       only), pages/ScannerPage.js, pages/StrategiesPage.js.
//
//   getTicker(symObj) / getExchange(symObj)
//     — take a symbol OBJECT ({ symbol: "NSE:RELIANCE", ... }) as used by the
//       /api/symbols list.
//     — getExchange() with no colon found returns "NSE" (not ""), since
//       components/SymbolSearch.js's original getExchange() defaulted to NSE.
//     — previously only in components/SymbolSearch.js; kept as thin wrappers
//       around tickerOf/exchangeOf here so the underlying colon-split logic
//       still has exactly one implementation, while preserving the NSE
//       default and object-vs-string input shape unchanged for that caller.

export function tickerOf(sym) {
  const idx = (sym || "").indexOf(":");
  return idx >= 0 ? sym.slice(idx + 1) : sym;
}

export function exchangeOf(sym) {
  const idx = (sym || "").indexOf(":");
  return idx >= 0 ? sym.slice(0, idx) : "";
}

export function getTicker(symObj) {
  return tickerOf(symObj.symbol);
}

export function getExchange(symObj) {
  return exchangeOf(symObj.symbol) || "NSE";
}
