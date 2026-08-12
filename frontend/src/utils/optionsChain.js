// utils/optionsChain.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for the options-chain modal, Ctrl+Q's ATM Workspace, and
// Auto-ATM strike switching.
//
// ROOT-CAUSE NOTE (2026-08-11): this file used to also contain
// buildStrikeLadder()/optionSymbol()/nextMonthlyExpiries() (+ their private
// date-math helpers and the MCX_EXPIRY_DAY/RESTRICTED_MONTH_CYCLE/
// EXPIRY_GRACE_DAYS/INDEX_WEEKLY_EXPIRY_DAY/FYERS_WEEKLY_MONTH_CHAR/
// MONTH_CODES constants) — a fully offline strike-ladder + Fyers-expiry-
// format guesser that OptionsChainModal.js used to build strike/expiry
// symbols locally. That guessed encoding is frequently rejected by Fyers as
// "Invalid symbol provided" (confirmed live). OptionsChainModal.js now
// fetches the real chain from GET /api/options/chain instead — the same
// endpoint Ctrl+Q's AtmWorkspace.js and Auto-ATM below already used, and
// the reason neither of those two ever had this bug. All of the above was
// deleted here since OptionsChainModal.js was its only caller; everything
// remaining in this file is still actively used by Ctrl+Q / Auto-ATM /
// OptionsChainModal's cosmetic labels.
// Supports: NSE equities, NSE/BSE indices, MCX commodities.
// ─────────────────────────────────────────────────────────────────────────────

// ── MCX commodity config ──────────────────────────────────────────────────────
// strikeStep  — interval between strikes (in ₹ per unit)
// decimals    — decimal places in strike price
// unit        — traded unit label shown in the options chain header
export const MCX_COMMODITIES = {
  GOLD: { name: "Gold", strikeStep: 100, decimals: 0, unit: "10g", exchange: "MCX" },
  GOLDM: { name: "Gold Mini", strikeStep: 100, decimals: 0, unit: "100g", exchange: "MCX" },
  GOLDPETAL: { name: "Gold Petal", strikeStep: 50, decimals: 0, unit: "1g", exchange: "MCX" },
  SILVER: { name: "Silver", strikeStep: 500, decimals: 0, unit: "1kg", exchange: "MCX" },
  SILVERM: { name: "Silver Mini", strikeStep: 500, decimals: 0, unit: "100g", exchange: "MCX" },
  SILVERMIC: { name: "Silver Micro", strikeStep: 100, decimals: 0, unit: "1kg", exchange: "MCX" },
  CRUDEOIL: { name: "Crude Oil", strikeStep: 50, decimals: 0, unit: "bbl", exchange: "MCX" },
  CRUDEOILM: { name: "Crude Oil Mini", strikeStep: 50, decimals: 0, unit: "bbl", exchange: "MCX" },
  NATURALGAS: { name: "Natural Gas", strikeStep: 5, decimals: 1, unit: "mmBtu", exchange: "MCX" },
  NATGASMINI: { name: "Natural Gas Mini", strikeStep: 5, decimals: 1, unit: "mmBtu", exchange: "MCX" },
  COPPER: { name: "Copper", strikeStep: 5, decimals: 1, unit: "1kg", exchange: "MCX" },
  ZINC: { name: "Zinc", strikeStep: 1, decimals: 1, unit: "1kg", exchange: "MCX" },
  ZINCMINI: { name: "Zinc Mini", strikeStep: 1, decimals: 1, unit: "1kg", exchange: "MCX" },
  LEAD: { name: "Lead", strikeStep: 1, decimals: 1, unit: "1kg", exchange: "MCX" },
  LEADMINI: { name: "Lead Mini", strikeStep: 1, decimals: 1, unit: "1kg", exchange: "MCX" },
  NICKEL: { name: "Nickel", strikeStep: 10, decimals: 0, unit: "1kg", exchange: "MCX" },
  ALUMINIUM: { name: "Aluminium", strikeStep: 1, decimals: 1, unit: "1kg", exchange: "MCX" },
  MENTHAOIL: { name: "Mentha Oil", strikeStep: 1, decimals: 1, unit: "kg", exchange: "MCX" },
  COTTON: { name: "Cotton", strikeStep: 100, decimals: 0, unit: "bale", exchange: "MCX" },
  CASTORSEED: { name: "Castor Seed", strikeStep: 50, decimals: 0, unit: "100kg", exchange: "MCX" },
};

// Commodities that trade WEEKLY options (every Friday expiry on MCX) — used
// only as a cosmetic "WEEKLY" badge in OptionsChainModal.js now; the real
// expiry list/dates come from Fyers, not from this set.
export const WEEKLY_EXPIRY_COMMODITIES = new Set(["SILVERMIC"]);

// ── NSE/BSE index option roots ─────────────────────────────────────────────────
// Frontend code can't read symbols/index.json off disk (no filesystem access
// in the browser — would need /api/symbols to go fully dynamic), so this
// stays a small hand-maintained map, verified against the real index.json.
//
// IMPORTANT — this must stay a FULL map of all 6 curated indices, not just
// the 2 that getOptionRoot()'s forward "-INDEX"-strip fallback can't handle
// on its own. NSE_INDEX_TICKERS below is the REVERSE of this map (root name
// → full ticker), and ChartsPage.js uses that reverse map in 3 places to
// rebuild a full underlying symbol from just a parsed option's root — with
// a fallback that assumes `${root}-EQ` (equity) for anything not found here.
// An earlier pass trimmed this to just NIFTY/BANKNIFTY on the theory that
// the forward fallback alone was enough — that was correct for
// getOptionRoot() but silently broke ChartsPage.js's Auto-ATM lookups for
// FINNIFTY/MIDCPNIFTY/SENSEX/BANKEX (each would have resolved to a bogus
// "...-EQ" equity symbol instead of "...-INDEX"). Caught and fixed by
// actually testing that consumer, not just getOptionRoot() in isolation.
//
// Previously this also carried a stale "CNXFINANCE-INDEX": "FINNIFTY" entry
// (FINNIFTY's spot symbol changed to NSE:FINNIFTY-INDEX on 2026-08-06 — see
// symbols/index.json's own _readme — CNXFINANCE-INDEX is no longer a real
// symbol anywhere in this codebase) and a "CNXIT-INDEX": "NIFTYIT" orphan
// (NIFTYIT was never one of the 6 curated indices). Both dropped.
const NSE_INDEX_ROOTS = {
  "NIFTY50-INDEX": "NIFTY",
  "NIFTYBANK-INDEX": "BANKNIFTY",
  "FINNIFTY-INDEX": "FINNIFTY",
  "MIDCPNIFTY-INDEX": "MIDCPNIFTY",
  "SENSEX-INDEX": "SENSEX",   // BSE
  "BANKEX-INDEX": "BANKEX",   // BSE
};

// Inverse of NSE_INDEX_ROOTS (option root → index ticker), derived once so the
// two stay in sync automatically. Used to rebuild a full underlying symbol
// ("SENSEX" → "SENSEX-INDEX") from a parsed option's root.
export const NSE_INDEX_TICKERS = Object.fromEntries(
  Object.entries(NSE_INDEX_ROOTS).map(([ticker, root]) => [root, ticker])
);

// ── Parse an underlying symbol → { exch, root, isIndex, isCommodity, strikeStep, decimals } ──
export function getOptionRoot(symbolStr) {
  if (!symbolStr) return { exch: "NSE", root: "", isIndex: false, isCommodity: false, strikeStep: 50, decimals: 0 };

  const colonIdx = symbolStr.indexOf(":");
  const exch = colonIdx >= 0 ? symbolStr.slice(0, colonIdx) : "NSE";
  const ticker = colonIdx >= 0 ? symbolStr.slice(colonIdx + 1) : symbolStr;

  // MCX commodity — ticker may be:
  //   "CRUDEOIL-I"        (old -I style, should not reach here anymore)
  //   "CRUDEOIL26JULFUT"  (dated future from /api/symbols, type=commodity)
  //   "NATGASMINI26JUNFUT"
  if (exch === "MCX") {
    let base = ticker.replace(/-.*$/, "");  // strip -I or any suffix after dash
    base = base.replace(/\d{2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)FUT$/i, ""); // strip dated FUT
    base = base.toUpperCase();
    const cfg = MCX_COMMODITIES[base] || { strikeStep: 50, decimals: 0 };
    return {
      exch: "MCX",
      root: base,
      isIndex: false,
      isCommodity: true,
      strikeStep: cfg.strikeStep,
      decimals: cfg.decimals,
      commodityName: cfg.name || base,
    };
  }

  // NSE/BSE index
  if (ticker.endsWith("-INDEX") || NSE_INDEX_ROOTS[ticker]) {
    const root = NSE_INDEX_ROOTS[ticker] || ticker.replace(/-INDEX$/, "");
    return { exch, root, isIndex: true, isCommodity: false, strikeStep: 50, decimals: 0 };
  }

  // NSE equity (e.g. RELIANCE-EQ → root = RELIANCE)
  const root = ticker.replace(/-(EQ|BE|SM|PP|N1|N2|T0)$/i, "");
  return { exch, root, isIndex: false, isCommodity: false, strikeStep: 50, decimals: 0 };
}

// ── Resolve the correct strike step for a root, regardless of underlying type ─
// getOptionRoot() above always reports strikeStep:50 for indices (the real
// per-index step is applied below via INDEX_STRIKE_STEPS) — kept as-is
// there to avoid changing existing callers. Auto-ATM needs the REAL step to
// decide how far a hysteresis breach must move before suggesting a switch:
// commodity override → index table → guessed step. The actual strike/symbol
// itself always comes from the live /api/options/chain-fetched map, never
// from this step value directly (see ChartsPage.js's autoAtmStrikeMap).
export function getStrikeStep(spot, parsed) {
  if (!parsed) return guessStep(spot);
  if (parsed.isCommodity) return parsed.strikeStep;
  if (parsed.isIndex) return INDEX_STRIKE_STEPS[parsed.root] || guessStep(spot);
  return guessStep(spot);
}

// One entry per curated index (all 6). NIFTYIT's old entry was dropped:
// it's not one of the 6 curated indices, and with the CNXIT-INDEX orphan
// removed from NSE_INDEX_ROOTS above, no code path can ever produce
// root:"NIFTYIT" here any more anyway — it was already dead.
//
// BANKEX: live-confirmed 100, via a real BSE Option Chain screenshot
// (27 Aug 26 expiry) showing 12 consecutive sorted strikes from 64,900
// to 66,000, every adjacent pair exactly 100 apart. This replaces the
// earlier guessStep(spot) fallback, which had been outputting 500 for
// BANKEX's ~64,000–65,000 range — that was never a confirmed real strike
// gap, just what the generic price-bucket heuristic happened to produce.
const INDEX_STRIKE_STEPS = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  MIDCPNIFTY: 25,
  SENSEX: 100,
  BANKEX: 100,
};

function guessStep(price) {
  if (price >= 50000) return 500;
  if (price >= 10000) return 200;
  if (price >= 5000) return 100;
  if (price >= 2000) return 50;
  if (price >= 1000) return 20;
  if (price >= 500) return 10;
  if (price >= 200) return 5;
  if (price >= 100) return 2;
  if (price >= 50) return 1;
  if (price >= 10) return 0.5;
  return 0.1;
}

// ── Recognize + parse an option contract symbol ───────────────────────────────
// Parses a REAL Fyers-issued option symbol string (never constructs one —
// see the file header note on why symbol construction was removed):
//   EXCH:ROOT + YYMON + STRIKE + (CE|PE)
// e.g. "BSE:SENSEX25JUL77000CE" → { exch:"BSE", root:"SENSEX", expiryCode:"25JUL", strike:77000, kind:"CE" }
// Matches BOTH Fyers expiry encodings:
//   Monthly: YY + 3-letter month            e.g. "26JUL" → BANKNIFTY26JUL50000CE
//   Weekly:  YY + 1-char month (1-9/O/N/D) + DD   e.g. "26702" → SENSEX2670277000CE (02 Jul 2026)
// Both are exactly 5 characters, so a single alternation handles both without
// ambiguity (the 3-letter month only matches A-Z letters, so "702" can never
// be misread as a month code).
//
// IMPORTANT — P3 #13: the canonical version of this parsing logic now lives
// in database/src/symbolParser.js (parseDerivativeSymbol()), and
// backend/src/server.js delegates to it. This frontend copy stays separate
// on purpose — browser code can't require() that Node module — but if the
// symbol format ever changes, update both. Same pattern as
// holidays.js/holidayCalendar.js and tickStream.js/useSocket.js.
const OPTION_SYMBOL_RE = /^([A-Z]+):(.*?)(\d{2}(?:[A-Z]{3}|[1-9OND]\d{2}))(\d+(?:\.\d+)?)(CE|PE)$/;

export function isOptionSymbol(symbolStr) {
  if (!symbolStr) return false;
  return OPTION_SYMBOL_RE.test(symbolStr);
}

export function parseOptionSymbol(symbolStr) {
  if (!symbolStr) return null;
  const m = OPTION_SYMBOL_RE.exec(symbolStr);
  if (!m) return null;
  const [, exch, root, expiryCode, strikeStr, kind] = m;
  return { exch, root, expiryCode, strike: Number(strikeStr), kind };
}

// ── Auto-ATM strike switching with hysteresis ─────────────────────────────────
// Decides whether the chart should switch to a different strike as spot moves,
// WITHOUT flip-flopping every time price oscillates near a strike boundary.
//
// Plain "nearest strike" rounding is symmetric around the midpoint between two
// strikes — e.g. step=100, strikes 77000/77100: the boundary sits at 77050, so
// price bouncing 77049 ⇄ 77051 would flip the result every tick. That's the
// exact problem described: real markets chop back and forth across boundaries
// constantly.
//
// Fix: a dead zone (hysteresis buffer) straddles each boundary. Once on a given
// strike, price must move PAST the boundary by `buffer` extra points before a
// switch is suggested — not just past the raw midpoint. Until that happens this
// returns the SAME strike the caller already has, so chop near a boundary never
// triggers a result change.
//
// `bufferRatio` is the extra cushion as a fraction of one strike step (e.g. 0.2
// = 20% of step on each side of the boundary, so for SENSEX step=100 a switch
// only fires once spot is >60 points from the current strike's center).
export function nearestStrikeWithHysteresis(spot, currentStrike, step, bufferRatio = 0.2) {
  if (!spot || spot <= 0 || !step || step <= 0) return currentStrike;
  if (currentStrike == null) return Math.round(spot / step) * step;

  const buffer = step * Math.min(Math.max(bufferRatio, 0), 0.49); // clamp — can't exceed half a step
  const distance = spot - currentStrike;

  // Still within the dead zone around the current strike — no switch.
  if (Math.abs(distance) <= step / 2 + buffer) return currentStrike;

  // Breached the dead zone — move exactly one step in that direction.
  // (Large jumps, e.g. after a long disconnect, fall through to plain rounding.)
  if (Math.abs(distance) <= step * 1.5 + buffer) {
    return distance > 0 ? currentStrike + step : currentStrike - step;
  }
  return Math.round(spot / step) * step;
}