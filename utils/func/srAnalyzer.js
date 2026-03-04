// srAnalyzer.js
// Detects Support, Resistance, Accumulation, and Distribution zones
// from 15-min candle data. Plug into existing fyers getHistory calls.

const moment = require("moment");

class SRAnalyzer {
  constructor(options = {}) {
    // How many candles each side a pivot must be highest/lowest to qualify
    this.pivotStrength = options.pivotStrength || 3;

    // Two S/R levels are merged if they are within this % of each other
    this.clusterThresholdPct = options.clusterThresholdPct || 0.3;

    // A consolidation zone needs at least this many consecutive candles
    this.minZoneCandles = options.minZoneCandles || 6;

    // Range of a consolidation zone must be ≤ this % of the zone midpoint
    this.maxZoneRangePct = options.maxZoneRangePct || 1.5;

    // How many top S/R levels to return
    this.maxLevels = options.maxLevels || 4;
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────

  /**
   * Main entry point.
   * @param {Array} candles  - raw fyers candle arrays [ts, open, high, low, close, vol]
   * @param {number} currentPrice
   * @returns {Object} { support, resistance, accumulation, distribution, summary }
   */
  analyze(candles, currentPrice) {
    if (!candles || candles.length < 20) {
      return { error: "Not enough candles for SR analysis" };
    }

    const parsed = candles.map((c) => ({
      ts: c[0],
      time: moment.unix(c[0]).format("YYYY-MM-DD HH:mm"),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      vol: parseFloat(c[5]),
      range: parseFloat(c[2]) - parseFloat(c[3]),
    }));

    const pivots = this._findPivots(parsed);
    const { supports, resistances } = this._clusterAndRank(
      pivots,
      currentPrice
    );
    const zones = this._findConsolidationZones(parsed);
    const { accumulation, distribution } = this._classifyZones(
      zones,
      currentPrice
    );

    const nearestSupport = supports[0] || null;
    const nearestResistance = resistances[0] || null;

    return {
      support: supports,
      resistance: resistances,
      accumulation,
      distribution,
      currentPrice,
      summary: this._buildSummary(
        nearestSupport,
        nearestResistance,
        accumulation,
        distribution,
        currentPrice
      ),
    };
  }

  // ─────────────────────────────────────────────────────────
  // STEP 1 – Pivot highs / lows
  // ─────────────────────────────────────────────────────────

  _findPivots(candles) {
    const n = candles.length;
    const s = this.pivotStrength;
    const pivots = [];

    for (let i = s; i < n - s; i++) {
      const slice = candles.slice(i - s, i + s + 1);

      // Pivot HIGH
      const isHigh = slice.every((c, idx) =>
        idx === s ? true : c.high <= candles[i].high
      );
      if (isHigh) {
        pivots.push({
          type: "high",
          price: candles[i].high,
          time: candles[i].time,
          ts: candles[i].ts,
          touches: 1,
        });
      }

      // Pivot LOW
      const isLow = slice.every((c, idx) =>
        idx === s ? true : c.low >= candles[i].low
      );
      if (isLow) {
        pivots.push({
          type: "low",
          price: candles[i].low,
          time: candles[i].time,
          ts: candles[i].ts,
          touches: 1,
        });
      }
    }

    return pivots;
  }

  // ─────────────────────────────────────────────────────────
  // STEP 2 – Cluster nearby pivots → ranked S/R levels
  // ─────────────────────────────────────────────────────────

  _clusterAndRank(pivots, currentPrice) {
    const highs = pivots.filter((p) => p.type === "high");
    const lows = pivots.filter((p) => p.type === "low");

    const clusterLevels = (points) => {
      const sorted = [...points].sort((a, b) => a.price - b.price);
      const clusters = [];

      for (const pt of sorted) {
        const existing = clusters.find(
          (cl) =>
            Math.abs(cl.price - pt.price) / cl.price <=
            this.clusterThresholdPct / 100
        );
        if (existing) {
          // Merge: keep weighted average price, accumulate touches
          existing.price =
            (existing.price * existing.touches + pt.price) /
            (existing.touches + 1);
          existing.touches += 1;
          // Keep the most recent time
          if (pt.ts > existing.ts) {
            existing.time = pt.time;
            existing.ts = pt.ts;
          }
        } else {
          clusters.push({ ...pt });
        }
      }

      // Rank by touches (strength), then recency as tiebreak
      return clusters.sort(
        (a, b) => b.touches - a.touches || b.ts - a.ts
      );
    };

    const allHighClusters = clusterLevels(highs);
    const allLowClusters = clusterLevels(lows);

    // Resistances = high clusters ABOVE current price (nearest first)
    const resistances = allHighClusters
      .filter((c) => c.price > currentPrice)
      .sort((a, b) => a.price - b.price) // nearest on top
      .slice(0, this.maxLevels)
      .map((c) => ({
        price: +c.price.toFixed(2),
        touches: c.touches,
        time: c.time,
        distancePct: +(((c.price - currentPrice) / currentPrice) * 100).toFixed(
          2
        ),
        strength: c.touches >= 3 ? "STRONG" : c.touches === 2 ? "MODERATE" : "WEAK",
      }));

    // Supports = low clusters BELOW current price (nearest first)
    const supports = allLowClusters
      .filter((c) => c.price < currentPrice)
      .sort((a, b) => b.price - a.price) // nearest on top
      .slice(0, this.maxLevels)
      .map((c) => ({
        price: +c.price.toFixed(2),
        touches: c.touches,
        time: c.time,
        distancePct: +(((currentPrice - c.price) / currentPrice) * 100).toFixed(
          2
        ),
        strength: c.touches >= 3 ? "STRONG" : c.touches === 2 ? "MODERATE" : "WEAK",
      }));

    return { supports, resistances };
  }

  // ─────────────────────────────────────────────────────────
  // STEP 3 – Find consolidation zones (tight range periods)
  // ─────────────────────────────────────────────────────────

  _findConsolidationZones(candles) {
    const zones = [];
    const n = candles.length;
    let i = 0;

    while (i < n) {
      let j = i + 1;

      // Grow the window while candles stay in a tight range
      let zoneHigh = candles[i].high;
      let zoneLow = candles[i].low;

      while (j < n) {
        const testHigh = Math.max(zoneHigh, candles[j].high);
        const testLow = Math.min(zoneLow, candles[j].low);
        const midpoint = (testHigh + testLow) / 2;
        const rangePct = ((testHigh - testLow) / midpoint) * 100;

        if (rangePct <= this.maxZoneRangePct) {
          zoneHigh = testHigh;
          zoneLow = testLow;
          j++;
        } else {
          break;
        }
      }

      const length = j - i;
      if (length >= this.minZoneCandles) {
        const midpoint = (zoneHigh + zoneLow) / 2;
        const totalVol = candles
          .slice(i, j)
          .reduce((s, c) => s + c.vol, 0);

        zones.push({
          startTime: candles[i].time,
          endTime: candles[j - 1].time,
          startTs: candles[i].ts,
          endTs: candles[j - 1].ts,
          high: +zoneHigh.toFixed(2),
          low: +zoneLow.toFixed(2),
          midpoint: +midpoint.toFixed(2),
          rangePct: +(((zoneHigh - zoneLow) / midpoint) * 100).toFixed(2),
          candleCount: length,
          totalVolume: totalVol,
          avgVolume: +(totalVol / length).toFixed(0),
        });
        i = j; // skip past this zone
      } else {
        i++;
      }
    }

    return zones;
  }

  // ─────────────────────────────────────────────────────────
  // STEP 4 – Classify zones as Accumulation or Distribution
  //
  // Logic:
  //   • Look at 10 candles BEFORE the zone starts
  //   • If price was trending DOWN into the zone → Accumulation (smart money buying)
  //   • If price was trending UP   into the zone → Distribution (smart money selling)
  // ─────────────────────────────────────────────────────────

  _classifyZones(zones, currentPrice) {
    const accumulation = [];
    const distribution = [];

    for (const zone of zones) {
      // We classify based on what happened AFTER the zone ended
      // (breakout direction is the strongest signal)
      // Since we don't always have post-zone candles, we use midpoint vs currentPrice
      // as a proxy: if zone is well below current price it was accumulation, etc.

      const aboveCurrentPct =
        ((currentPrice - zone.midpoint) / currentPrice) * 100;

      // Also check if the zone is near a key price (just use midpoint label)
      const zoneLabel = `~${zone.low}–${zone.high}`;

      const entry = {
        zone: zoneLabel,
        low: zone.low,
        high: zone.high,
        midpoint: zone.midpoint,
        candleCount: zone.candleCount,
        startTime: zone.startTime,
        endTime: zone.endTime,
        totalVolume: zone.totalVolume,
        avgVolume: zone.avgVolume,
        rangePct: zone.rangePct,
        distanceFromCurrentPct: +aboveCurrentPct.toFixed(2),
      };

      if (aboveCurrentPct > 0.5) {
        // Zone is below current price → Accumulation (price broke upward after)
        accumulation.push(entry);
      } else if (aboveCurrentPct < -0.5) {
        // Zone is above current price → Distribution (price broke downward after)
        distribution.push(entry);
      }
      // Zones within 0.5% of current price are ambiguous — skip
    }

    // Sort: accumulation nearest below, distribution nearest above
    accumulation.sort((a, b) => b.midpoint - a.midpoint);
    distribution.sort((a, b) => a.midpoint - b.midpoint);

    return {
      accumulation: accumulation.slice(0, 2),
      distribution: distribution.slice(0, 2),
    };
  }

  // ─────────────────────────────────────────────────────────
  // STEP 5 – Human-readable summary
  // ─────────────────────────────────────────────────────────

  _buildSummary(nearestSupport, nearestResistance, accumulation, distribution, currentPrice) {
    const lines = [];

    if (nearestSupport) {
      lines.push(
        `🟢 Support  : ₹${nearestSupport.price} (${nearestSupport.distancePct}% below) [${nearestSupport.strength}]`
      );
    }
    if (nearestResistance) {
      lines.push(
        `🔴 Resistance: ₹${nearestResistance.price} (${nearestResistance.distancePct}% above) [${nearestResistance.strength}]`
      );
    }
    if (accumulation.length) {
      const a = accumulation[0];
      lines.push(`📦 Accum Zone: ₹${a.low}–₹${a.high} (${a.candleCount} candles)`);
    }
    if (distribution.length) {
      const d = distribution[0];
      lines.push(`📤 Dist Zone : ₹${d.low}–₹${d.high} (${d.candleCount} candles)`);
    }

    return lines.join("\n");
  }
}

module.exports = SRAnalyzer;