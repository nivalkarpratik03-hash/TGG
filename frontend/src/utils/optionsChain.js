// utils/optionsChain.js
// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for OptionsChainModal.
// Supports: NSE equities, NSE/BSE indices, MCX commodities.
// ─────────────────────────────────────────────────────────────────────────────

import { previousTradingDay } from "./holidayCalendar";

// ── Month codes ───────────────────────────────────────────────────────────────
const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

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

// ── MCX expiry-day approximations ─────────────────────────────────────────────
// Used to decide which contract month to start from — MUST stay in sync with
// symbolsRouter.js MCX_EXPIRY_DAY so commodity, futures, and options chain
// always show the same contract month.
// Rule: only roll forward to next month once today is PAST (expiryDay + grace)
// — never roll early. See symbolsRouter.js for the full rationale.
const MCX_EXPIRY_DAY = {
  CRUDEOIL: 19, CRUDEOILM: 19,
  NATURALGAS: 23, NATGASMINI: 23,
  COPPER: 22, ZINC: 22, ZINCMINI: 22,
  ALUMINIUM: 22, LEAD: 22, LEADMINI: 22, NICKEL: 22,
  GOLD: 5, GOLDM: 29, GOLDPETAL: 29,
  SILVER: 27, SILVERM: 27, SILVERMIC: 27,
  MENTHAOIL: 29, COTTON: 29, CASTORSEED: 29,
};
const EXPIRY_GRACE_DAYS = 1; // roll this many days AFTER the approx expiry (never before)

// Commodities that trade WEEKLY options (every Friday expiry on MCX)
export const WEEKLY_EXPIRY_COMMODITIES = new Set(["SILVERMIC"]);

// ── Restricted contract-month cycles ─────────────────────────────────────
// MUST stay in sync with symbolsRouter.js RESTRICTED_MONTH_CYCLE. Unlike
// CRUDEOIL/NATURALGAS/COPPER etc (which list a new contract every single
// calendar month), MCX's silver family does NOT trade every month — it only
// lists contracts in a fixed cycle. Building an options-chain tab for a
// month outside this cycle produces a symbol that was never listed, which
// Fyers correctly rejects with "Invalid symbol provided" for every strike
// in that tab. Confirmed via MCX expiry circulars: Feb, Apr, Jun, Aug, Nov, Dec.
// (SILVERMIC is unaffected — it's routed through WEEKLY_EXPIRY_COMMODITIES
// above and never reaches this monthly branch.)
const RESTRICTED_MONTH_CYCLE = {
  SILVER: [1, 3, 5, 7, 10, 11],   // 0-based: Feb, Apr, Jun, Aug, Nov, Dec
  SILVERM: [1, 3, 5, 7, 10, 11],
};

// ── Index weekly expiry weekday ───────────────────────────────────────────────
// SEBI's Oct-2024 circular limited weekly index options to ONE benchmark per
// exchange: NSE kept NIFTY, BSE kept SENSEX. Every other index (BANKNIFTY,
// FINNIFTY, MIDCPNIFTY, NIFTYIT) now trades MONTHLY ONLY — not listed here.
// Weekday: 0=Sun..6=Sat (JS Date.getDay()).
//   NIFTY:  Tuesday (2) — moved from Thursday, effective 1 Sep 2025.
//   SENSEX: Thursday (4) — BSE's weekly day, unchanged through the same
//           Aug/Sep 2025 restructuring (BSE's monthly expiry also moved to
//           the last Thursday of the month at the same time).
// If either exchange changes this again, update here only — both the expiry
// list (nextMonthlyExpiries) and the symbol builder (optionSymbol) read it.
const INDEX_WEEKLY_EXPIRY_DAY = {
  NIFTY: 2,
  SENSEX: 4,
};
export { INDEX_WEEKLY_EXPIRY_DAY };

// ── NSE index option roots ────────────────────────────────────────────────────
const NSE_INDEX_ROOTS = {
  "NIFTY50-INDEX": "NIFTY",
  "NIFTYBANK-INDEX": "BANKNIFTY",
  "CNXFINANCE-INDEX": "FINNIFTY",
  "CNXIT-INDEX": "NIFTYIT",
  "MIDCPNIFTY-INDEX": "MIDCPNIFTY",
  "SENSEX-INDEX": "SENSEX",   // BSE
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

// ── Unified expiry roll logic ─────────────────────────────────────────────────
// Returns the month offset (0 = this month, 1 = next, ...) for the NEAR
// contract of a given MCX root — IDENTICAL to symbolsRouter.js mcxNearMonthOffset
// so the commodity tab, futures tab, and options chain all show the same month.
function mcxNearMonthOffset(root, now = new Date()) {
  const expiryDay = MCX_EXPIRY_DAY[root];
  if (!expiryDay) return 0;
  return now.getDate() > (expiryDay + EXPIRY_GRACE_DAYS) ? 1 : 0;
}

// ── Build expiry list ─────────────────────────────────────────────────────────
// Returns `count` upcoming expiry objects { label, code, date, approx, weekly }
//
// KEY DESIGN: For MCX commodities, the starting month is determined by
// mcxNearMonthOffset() — the SAME roll logic as symbolsRouter.js — so
// the first expiry shown here always matches the contract month shown
// in the Commodity tab and Futures tab of the search bar.
//
// NSE equities/indices (monthly-only underlyings — BANKNIFTY, FINNIFTY,
// MIDCPNIFTY, NIFTYIT, and all single-stock F&O): last TUESDAY of the month,
// holiday-adjusted. NSE moved its monthly/quarterly/half-yearly expiry from
// the last Thursday to the last Tuesday of the month effective contracts
// expiring on/after 1 Sep 2025 (NSE circular Ref. 111/2025). If that
// computed last-Tuesday falls on an exchange holiday, actual expiry shifts
// to the previous trading day — see holidayCalendar.js.
// EXCEPT NIFTY/SENSEX, which also trade WEEKLY (see INDEX_WEEKLY_EXPIRY_DAY)
// and so must list every week's expiry, not just the monthly one. Before this
// fix, nextMonthlyExpiries always jumped straight to lastThursdayOfMonth(),
// which used the WRONG weekday (Thursday, pre-Sep-2025 rule) AND skipped
// every weekly expiry before the month-end one — e.g. on 26 Jun 2026 it
// returned "30 JUL" as the nearest SENSEX expiry, when the true nearest
// expiry is the next Thursday, "02 JUL".
// MCX commodities: approximate expiry day per commodity (MCX publishes exact
// date via monthly circular; `approx: true` flags this in the UI). Holiday
// adjustment is applied here too (MCX's own 4 full-closure holidays only),
// which only ever refines the approximation — never makes it less accurate.
export function nextMonthlyExpiries(count = 3, commodityRoot = null, indexRoot = null) {
  // Silver Micro uses WEEKLY expiries (every Friday), not monthly
  if (commodityRoot && WEEKLY_EXPIRY_COMMODITIES.has(commodityRoot)) {
    return nextWeeklyExpiries(count, 5, { fyersWeeklyCode: false });
  }
  // NIFTY/SENSEX trade weekly — every Tuesday/Thursday is a real, separately
  // tradeable expiry, including the one that happens to also be month-end.
  if (indexRoot && INDEX_WEEKLY_EXPIRY_DAY[indexRoot] != null) {
    return nextWeeklyExpiries(count, INDEX_WEEKLY_EXPIRY_DAY[indexRoot], { fyersWeeklyCode: true });
  }

  const now = new Date();
  const results = [];

  const approxDay = commodityRoot ? MCX_EXPIRY_DAY[commodityRoot] : null;
  const cycle = commodityRoot ? RESTRICTED_MONTH_CYCLE[commodityRoot] : null;

  // For unrestricted MCX roots (every calendar month lists a contract): start
  // from the near-month offset so we match symbolsRouter.
  // For restricted-cycle roots (SILVER/SILVERM): don't pre-jump via
  // mcxNearMonthOffset — that offset only knows about day-of-month, not which
  // months are even valid. Instead walk forward from the current month and
  // let the `cycle` check below skip non-listed months, and the cutoff check
  // skip cycle months whose expiry has already passed this year.
  // For NSE: start offset = 0 (current month), let the cutoff skip if passed.
  let year = now.getFullYear();
  let month = now.getMonth();
  if (commodityRoot && !cycle) {
    month += mcxNearMonthOffset(commodityRoot, now);
    year += Math.floor(month / 12);
    month = month % 12;
  }

  let guard = 0;
  for (let i = 0; results.length < count && guard < 60; i++, guard++) {
    let m = month + i;
    let y = year + Math.floor(m / 12);
    m = m % 12;

    // Restricted-cycle commodities only list contracts in specific months —
    // skip any month that was never a real listed contract.
    if (cycle && !cycle.includes(m)) continue;

    let expDate = approxDay
      ? clampToLastDayOfMonth(y, m, approxDay)
      : lastWeekdayOfMonth(y, m, 2); // 2 = Tuesday (NSE rule since 1 Sep 2025)

    // Holiday-adjust: if the computed date lands on an exchange holiday,
    // the exchange itself shifts expiry to the previous trading day.
    expDate = previousTradingDay(expDate, approxDay ? "MCX" : "NSE");

    // Skip months whose expiry (+ grace period for MCX) has already passed.
    // For unrestricted MCX roots this never actually triggers (offset above
    // already starts on a fresh month), but for restricted-cycle roots this
    // is essential — e.g. if today is just past Aug's expiry, Aug must be
    // skipped in favour of Nov, not re-shown.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (approxDay ? (1 + EXPIRY_GRACE_DAYS) : 1));
    if (expDate < cutoff) continue;

    const dd = String(expDate.getDate()).padStart(2, "0");
    const mon = MONTH_CODES[m];
    const yy = String(y).slice(-2);

    results.push({
      label: `${approxDay ? "~" : ""}${dd} ${mon}`,
      code: `${yy}${mon}`,  // e.g. "26JUL" — used in Fyers option symbol
      date: expDate,
      approx: !!approxDay,
      weekly: false,
    });
  }
  return results;
}

// ── Fyers weekly-contract month character ─────────────────────────────────────
// Confirmed against real Fyers symbols: months 1-9 are the bare digit, and
// Oct/Nov/Dec are single letters O/N/D (e.g. "NIFTY24D2622700CE" = 26 Dec 2024).
// This is ONLY used for the weekly date-coded format — monthly contracts keep
// the existing 3-letter MONTH_CODES (e.g. "26JAN") untouched.
const FYERS_WEEKLY_MONTH_CHAR = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "O", "N", "D"];

// Returns upcoming expiry dates for a given weekday (0=Sun..6=Sat).
// Used for: MCX weekly commodities (Friday, fyersWeeklyCode:false — keeps the
// existing YYMON-style code since that path was already working and hasn't
// been verified against a real MCX weekly symbol) and NSE/BSE weekly index
// options (Tuesday/Thursday, fyersWeeklyCode:true — uses Fyers' actual
// {YY}{monthChar}{DD} weekly symbol format, confirmed against real examples).
function nextWeeklyExpiries(count, weekday, { fyersWeeklyCode }) {
  // Holiday adjustment: index weekly (fyersWeeklyCode:true) is exact
  // per-exchange — Tuesday belongs to NSE, Thursday to BSE. MCX weekly
  // (Friday, SILVERMIC) uses MCX's own 4-holiday calendar. If neither
  // applies (shouldn't happen given current callers) skip adjustment.
  const exchange = fyersWeeklyCode
    ? (weekday === 4 ? "BSE" : "NSE")
    : "MCX";
  const seenKeys = new Set();

  const results = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1); // start from tomorrow
  while (results.length < count) {
    if (d.getDay() === weekday) {
      const adjusted = previousTradingDay(d, exchange);
      const key = adjusted.toISOString().slice(0, 10);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        const dd = String(adjusted.getDate()).padStart(2, "0");
        const mon = MONTH_CODES[adjusted.getMonth()];
        const yy = String(adjusted.getFullYear()).slice(-2);
        results.push({
          label: `${dd} ${mon}`,
          code: fyersWeeklyCode ? `${yy}${FYERS_WEEKLY_MONTH_CHAR[adjusted.getMonth()]}${dd}` : `${yy}${mon}`,
          date: adjusted,
          approx: !fyersWeeklyCode, // MCX weekly stays "approx" as before; index weekly is exact (exchange-published rule)
          weekly: true,
        });
      }
    }
    d.setDate(d.getDate() + 1);
  }
  return results;
}

function clampToLastDayOfMonth(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

// Generic "last <weekday> of month" finder — weekday: 0=Sun..6=Sat.
// Replaces the old hardcoded lastThursdayOfMonth() now that the NSE monthly
// rule is Tuesday (2), not Thursday (4). BSE monthly (Thursday) is handled
// via the weekly-expiry branch for SENSEX (INDEX_WEEKLY_EXPIRY_DAY), since
// SENSEX is the only BSE underlying with options in this codebase.
function lastWeekdayOfMonth(year, month, weekday) {
  const d = new Date(year, month + 1, 0); // last day of month
  while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
  return new Date(d);
}

// ── Resolve the correct strike step for a root, regardless of underlying type ─
// getOptionRoot() above always reports strikeStep:50 for indices (the real
// per-index step is applied later inside buildStrikeLadder via
// INDEX_STRIKE_STEPS) — kept as-is there to avoid changing existing callers.
// Auto-ATM needs the REAL step up front, so resolve it the same way
// buildStrikeLadder does: commodity override → index table → guessed step.
export function getStrikeStep(spot, parsed) {
  if (!parsed) return guessStep(spot);
  if (parsed.isCommodity) return parsed.strikeStep;
  if (parsed.isIndex) return INDEX_STRIKE_STEPS[parsed.root] || guessStep(spot);
  return guessStep(spot);
}

// ── Build strike ladder centred on spot ───────────────────────────────────────
export function buildStrikeLadder(spot, indexRoot, stepsEachSide = 14, overrideStep = null) {
  if (!spot || spot <= 0) return { strikes: [], atm: null };

  let step = overrideStep;
  if (!step) {
    step = indexRoot
      ? (INDEX_STRIKE_STEPS[indexRoot] || guessStep(spot))
      : guessStep(spot);
  }

  const atm = Math.round(spot / step) * step;
  const strikes = [];
  for (let i = -stepsEachSide; i <= stepsEachSide; i++) {
    const s = atm + i * step;
    if (s > 0) strikes.push(Math.round(s * 100) / 100);
  }
  return { strikes, atm };
}

const INDEX_STRIKE_STEPS = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  MIDCPNIFTY: 25,
  NIFTYIT: 50,
  SENSEX: 100,
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

// ── Build Fyers option symbol string ─────────────────────────────────────────
// NSE equity:    NSE:RELIANCE26JUL3200CE
// NSE index:     NSE:NIFTY26JUL24000CE
// MCX commodity: MCX:CRUDEOIL26JUL5000CE
//                MCX:NATGASMINI26JUN310CE
export function optionSymbol(exch, root, expiryCode, strike, kind) {
  const strikeStr = Number.isInteger(strike) ? String(strike) : strike.toFixed(1);
  return `${exch}:${root}${expiryCode}${strikeStr}${kind}`;
}

// ── Recognize + parse an option contract symbol ───────────────────────────────
// Matches the shape produced by optionSymbol() above:
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