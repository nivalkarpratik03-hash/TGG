/**
 * Dow Theory Analysis Utility
 * Analyzes rawCandles to determine trend structure, phase, and signal alignment.
 * Candle format: [timestamp, open, high, low, close, volume]
 */

const SWING_LOOKBACK = 5; // candles on each side to identify a swing point

/**
 * Identify swing highs and swing lows from candle data.
 * A swing high is a candle whose high is the highest among SWING_LOOKBACK candles on each side.
 * A swing low  is a candle whose low  is the lowest  among SWING_LOOKBACK candles on each side.
 */
function findSwingPoints(candles) {
  const swingHighs = [];
  const swingLows  = [];

  for (let i = SWING_LOOKBACK; i < candles.length - SWING_LOOKBACK; i++) {
    const high = candles[i][2];
    const low  = candles[i][3];

    let isSwingHigh = true;
    let isSwingLow  = true;

    for (let j = i - SWING_LOOKBACK; j <= i + SWING_LOOKBACK; j++) {
      if (j === i) continue;
      if (candles[j][2] > high) isSwingHigh = false;
      if (candles[j][3] < low)  isSwingLow  = false;
    }

    if (isSwingHigh) swingHighs.push({ index: i, price: high, timestamp: candles[i][0] });
    if (isSwingLow)  swingLows.push({ index: i, price: low,  timestamp: candles[i][0] });
  }

  return { swingHighs, swingLows };
}

/**
 * Determine trend direction from the last few swing highs and lows.
 * Returns: "UPTREND" | "DOWNTREND" | "SIDEWAYS"
 * Also returns the structure description (e.g. "HH + HL").
 */
function determineTrendDirection(swingHighs, swingLows) {
  const recentHighs = swingHighs.slice(-3);
  const recentLows  = swingLows.slice(-3);

  if (recentHighs.length < 2 || recentLows.length < 2) {
    return { direction: "SIDEWAYS", structure: "Insufficient data" };
  }

  const hhCount = recentHighs.filter((h, i) => i > 0 && h.price > recentHighs[i - 1].price).length;
  const lhCount = recentHighs.filter((h, i) => i > 0 && h.price < recentHighs[i - 1].price).length;
  const hlCount = recentLows.filter((l, i) => i > 0 && l.price > recentLows[i - 1].price).length;
  const llCount = recentLows.filter((l, i) => i > 0 && l.price < recentLows[i - 1].price).length;

  const isUptrend   = hhCount > 0 && hlCount > 0 && hhCount >= lhCount && hlCount >= llCount;
  const isDowntrend = lhCount > 0 && llCount > 0 && lhCount >= hhCount && llCount >= hlCount;

  if (isUptrend && !isDowntrend) {
    return { direction: "UPTREND",   structure: "HH + HL" };
  } else if (isDowntrend && !isUptrend) {
    return { direction: "DOWNTREND", structure: "LH + LL" };
  } else {
    return { direction: "SIDEWAYS",  structure: "Mixed" };
  }
}

/**
 * Determine Dow Theory phase based on price position and volatility.
 * Phases: ACCUMULATION | MARKUP | DISTRIBUTION | MARKDOWN | SIDEWAYS
 */
function determineTrendPhase(candles, trendDirection) {
  if (candles.length < 20) return "UNKNOWN";

  const recent  = candles.slice(-20);
  const longer  = candles.length >= 60 ? candles.slice(-60) : candles.slice(0, -20);

  const recentHigh = Math.max(...recent.map(c => c[2]));
  const recentLow  = Math.min(...recent.map(c => c[3]));
  const longerHigh = Math.max(...longer.map(c => c[2]));
  const longerLow  = Math.min(...longer.map(c => c[3]));

  // Volatility: average candle range over recent vs longer period
  const avgRecentRange = recent.reduce((s, c) => s + (c[2] - c[3]), 0) / recent.length;
  const avgLongerRange = longer.reduce((s, c) => s + (c[2] - c[3]), 0) / longer.length;
  const isContracted   = avgRecentRange < avgLongerRange * 0.85;
  const isExpanded     = avgRecentRange > avgLongerRange * 1.15;

  const nearHigh = recentHigh >= longerHigh * 0.97;
  const nearLow  = recentLow  <= longerLow  * 1.03;

  if (isContracted && nearLow)  return "ACCUMULATION";
  if (isExpanded   && trendDirection === "UPTREND")   return "MARKUP";
  if (isContracted && nearHigh) return "DISTRIBUTION";
  if (isExpanded   && trendDirection === "DOWNTREND") return "MARKDOWN";
  return "TRANSITION";
}

/**
 * Analyze candles using Dow Theory principles.
 * @param {Array} rawCandles - Array of [timestamp, open, high, low, close, volume]
 * @param {string} signalDirection - "BULLISH" | "BEARISH"
 * @returns {Object} Dow Theory analysis result
 */
function analyzeDowTheory(rawCandles, signalDirection) {
  if (!rawCandles || rawCandles.length < SWING_LOOKBACK * 2 + 1) {
    return { error: "Insufficient candle data for Dow Theory analysis" };
  }

  const { swingHighs, swingLows } = findSwingPoints(rawCandles);

  const { direction, structure } = determineTrendDirection(swingHighs, swingLows);
  const phase = determineTrendPhase(rawCandles, direction);

  const lastSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : null;
  const lastSwingLow  = swingLows.length  > 0 ? swingLows[swingLows.length  - 1].price : null;

  const aligned =
    (signalDirection === "BULLISH" && direction === "UPTREND")   ||
    (signalDirection === "BEARISH" && direction === "DOWNTREND");

  return {
    direction,
    structure,
    phase,
    lastSwingHigh,
    lastSwingLow,
    aligned,
    signalDirection,
  };
}

/**
 * Build an HTML-formatted Telegram block for the Dow Theory analysis.
 * @param {Object} dowAnalysis - Result from analyzeDowTheory()
 * @returns {string} HTML-formatted string for Telegram
 */
function buildDowTheoryTelegramBlock(dowAnalysis) {
  if (!dowAnalysis || dowAnalysis.error) return "";

  const PHASE_LABELS = {
    ACCUMULATION: "Accumulation",
    MARKUP:       "Markup",
    DISTRIBUTION: "Distribution",
    MARKDOWN:     "Markdown",
    TRANSITION:   "Transition",
    UNKNOWN:      "Unknown",
  };
  const DIRECTION_LABELS = {
    UPTREND:   "Uptrend",
    DOWNTREND: "Downtrend",
    SIDEWAYS:  "Sideways",
  };

  const trendIcon =
    dowAnalysis.direction === "UPTREND"   ? "📈" :
    dowAnalysis.direction === "DOWNTREND" ? "📉" : "↔️";

  const phaseIcon =
    dowAnalysis.phase === "ACCUMULATION"  ? "🔄" :
    dowAnalysis.phase === "MARKUP"        ? "🚀" :
    dowAnalysis.phase === "DISTRIBUTION"  ? "🔄" :
    dowAnalysis.phase === "MARKDOWN"      ? "🔻" : "🔄";

  const alignmentLine = dowAnalysis.aligned
    ? "✅ Alignment: Signal ALIGNED with trend"
    : "⚠️ Alignment: COUNTER-TREND signal — use caution";

  const highLine = dowAnalysis.lastSwingHigh !== null
    ? `🔝 Last Swing High: ₹${(+dowAnalysis.lastSwingHigh).toFixed(2)}`
    : "";
  const lowLine = dowAnalysis.lastSwingLow !== null
    ? `🔻 Last Swing Low: ₹${(+dowAnalysis.lastSwingLow).toFixed(2)}`
    : "";

  const lines = [
    "",
    "📊 <b>Dow Theory:</b>",
    `${trendIcon} Trend: ${DIRECTION_LABELS[dowAnalysis.direction] || dowAnalysis.direction} (${dowAnalysis.structure})`,
    `${phaseIcon} Phase: ${PHASE_LABELS[dowAnalysis.phase] || dowAnalysis.phase}`,
    alignmentLine,
  ];

  if (highLine) lines.push(highLine);
  if (lowLine)  lines.push(lowLine);

  return lines.join("\n");
}

module.exports = { analyzeDowTheory, buildDowTheoryTelegramBlock };
