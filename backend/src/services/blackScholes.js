/**
 * backend/src/services/blackScholes.js
 *
 * Computes implied volatility (IV) from an option's actual traded price,
 * by inverting the Black-Scholes formula. This is the ONLY way IV is ever
 * produced anywhere — Fyers does not transmit IV directly (confirmed, see
 * oi-iv-data-export-handoff.md), and no exchange or broker does either.
 * Every "IV" figure shown on any terminal, including brokers' own
 * official displays, is derived exactly this way. A correctly-computed
 * IV using the LTP from the same candle it's attached to is not an
 * approximation or a "lesser" number than any other IV you'd see
 * elsewhere — there is no more-official alternate source to compare
 * against.
 *
 * METHOD: Newton-Raphson (fast, used first), falling back to bisection
 * (slower but always converges if a solution exists in range) when
 * Newton fails to converge — standard, robust combination for this kind
 * of root-finding problem.
 *
 * RISK-FREE RATE: no single "correct" number exists for this — it's a
 * modeling assumption, not a fetched fact. Defaulted here to 7% (0.07),
 * a reasonable approximation of India's short-term risk-free rate
 * (roughly tracks the RBI repo rate / short-term T-bill yield as of
 * 2026). This is a documented assumption, not a guess dressed up as a
 * fact — callers can override it via the riskFreeRate parameter if a
 * different convention is ever wanted.
 */

"use strict";

const RISK_FREE_RATE_DEFAULT = 0.07;

/** Standard normal cumulative distribution function, via the Abramowitz
 * & Stegun approximation (max error ~7.5e-8) — no external stats library
 * needed for this, and this project doesn't have one. */
function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

/** Standard normal probability density function. */
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes theoretical price for a European call or put.
 * @param {number} spot              underlying price
 * @param {number} strike            strike price
 * @param {number} timeToExpiryYears time to expiry, in years (e.g. 7/365 for a week)
 * @param {number} riskFreeRate      annualized, as a decimal (0.07 = 7%)
 * @param {number} volatility        annualized, as a decimal (0.20 = 20%)
 * @param {"CE"|"PE"} optionType
 * @returns {number} theoretical option price
 */
function blackScholesPrice(spot, strike, timeToExpiryYears, riskFreeRate, volatility, optionType) {
  if (timeToExpiryYears <= 0 || volatility <= 0) return Math.max(0, optionType === "CE" ? spot - strike : strike - spot);
  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiryYears) / (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  if (optionType === "CE") {
    return spot * normCdf(d1) - strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normCdf(d2);
  }
  return strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normCdf(-d2) - spot * normCdf(-d1);
}

/** Vega (dPrice/dVolatility) — the derivative Newton-Raphson needs. */
function blackScholesVega(spot, strike, timeToExpiryYears, riskFreeRate, volatility) {
  if (timeToExpiryYears <= 0 || volatility <= 0) return 0;
  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiryYears) / (volatility * sqrtT);
  return spot * normPdf(d1) * sqrtT;
}

/**
 * Solves for implied volatility given an observed option price.
 *
 * Returns null (never NaN, never a misleading 0) when no solution exists
 * — e.g. the quoted price is outside the option's no-arbitrage bounds
 * (impossible price for any volatility), or timeToExpiryYears <= 0 (the
 * contract has already expired as of this candle's timestamp).
 *
 * @param {number} optionPrice        the option's actual traded price (e.g. Close)
 * @param {number} spot               underlying price at the same moment
 * @param {number} strike
 * @param {number} timeToExpiryYears
 * @param {"CE"|"PE"} optionType
 * @param {number} [riskFreeRate=RISK_FREE_RATE_DEFAULT]
 * @returns {number|null} IV as a decimal (0.18 = 18%), or null
 */
function impliedVolatility(optionPrice, spot, strike, timeToExpiryYears, optionType, riskFreeRate = RISK_FREE_RATE_DEFAULT) {
  if (!(optionPrice > 0) || !(spot > 0) || !(strike > 0) || !(timeToExpiryYears > 0)) return null;
  if (optionType !== "CE" && optionType !== "PE") return null;

  // No-arbitrage sanity bounds, correctly accounting for the discount
  // factor (a call's true floor is spot - strike*e^(-rT), not the
  // simpler undiscounted spot-strike — using the undiscounted version
  // would let some genuinely-impossible prices slip past this check and
  // rely on the bisection bracket-check below to catch them instead,
  // which still works but is a slower path to the same correct answer).
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeToExpiryYears);
  const intrinsic = Math.max(0, optionType === "CE" ? spot - discountedStrike : discountedStrike - spot);
  const upperBound = optionType === "CE" ? spot : strike;
  if (optionPrice < intrinsic - 1e-6 || optionPrice > upperBound + 1e-6) return null;

  // ── Newton-Raphson first — fast, usually converges in <10 iterations ──
  let vol = 0.3; // reasonable starting guess (30%) for Indian index/equity options
  for (let i = 0; i < 50; i++) {
    const price = blackScholesPrice(spot, strike, timeToExpiryYears, riskFreeRate, vol, optionType);
    const vega = blackScholesVega(spot, strike, timeToExpiryYears, riskFreeRate, vol);
    const diff = price - optionPrice;
    if (Math.abs(diff) < 1e-4) return Math.round(vol * 10000) / 10000;
    if (vega < 1e-8) break; // vega too flat, Newton would diverge — fall through to bisection
    vol = vol - diff / vega;
    if (vol <= 0 || vol > 5) break; // wandered out of any sane range — fall through to bisection
  }

  // ── Bisection fallback — always converges if a root exists in [1e-4, 5] ──
  let lo = 1e-4, hi = 5;
  const priceAtLo = blackScholesPrice(spot, strike, timeToExpiryYears, riskFreeRate, lo, optionType) - optionPrice;
  const priceAtHi = blackScholesPrice(spot, strike, timeToExpiryYears, riskFreeRate, hi, optionType) - optionPrice;
  if (priceAtLo * priceAtHi > 0) return null; // no sign change — no root in range, genuinely unsolvable here

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const priceAtMid = blackScholesPrice(spot, strike, timeToExpiryYears, riskFreeRate, mid, optionType) - optionPrice;
    if (Math.abs(priceAtMid) < 1e-4) return Math.round(mid * 10000) / 10000;
    if ((priceAtLo < 0) === (priceAtMid < 0)) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10000) / 10000;
}

module.exports = { impliedVolatility, blackScholesPrice, RISK_FREE_RATE_DEFAULT };
