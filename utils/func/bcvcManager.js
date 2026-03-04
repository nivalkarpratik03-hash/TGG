const moment = require('moment');
const fyers  = require('./fyersapi')
const bot = require('./telegram')
const telegramchat ="8559767849"

class BCVCManager {
    constructor() {
        this.fyers = fyers;
        
        this.config = {
            volumePeriod: 20,
            volumeProportion: 1.25,
            bigCandleLookbackPeriod: 7,
            bigCandleProportion: 1.3,
            includeRed: false
        };

        this.bcvcCache = new Map();

        this.timeframes = {
            '1': { resolution: '1', duration: 1, unit: 'minutes', rollingDays: 30 },
            '5': { resolution: '5', duration: 5, unit: 'minutes', rollingDays: 30 },
            '15': { resolution: '15', duration: 15, unit: 'minutes', rollingDays: 60 },
            '60': { resolution: '60', duration: 60, unit: 'minutes', rollingDays: 100 },
            'D': { resolution: 'D', duration: 1, unit: 'days', rollingDays: 100 }
        };
    }

    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        console.log('✅ BCVC configuration updated:', this.config);
        this.clearAllCache();
    }

    getCacheKey(symbol, resolution) {
        return `${symbol}-${resolution}`;
    }

    isFormingCandle(candleTimestamp, resolution) {
        const tfConfig = this.timeframes[resolution];
        const candleTime = moment.unix(candleTimestamp);
        const closeTime = moment(candleTime).add(tfConfig.duration, tfConfig.unit);
        const now = moment();
        const isForming = now.isBefore(closeTime);
        if (isForming) {
            console.log(`🕐 Candle at ${candleTime.format('YYYY-MM-DD HH:mm')} is still forming (closes at ${closeTime.format('HH:mm:ss')})`);
        }
        return isForming;
    }

    calculateEMA(values, period) {
        if (values.length === 0) return null;
        const multiplier = 2 / (period + 1);
        let ema = values[0];
        for (let i = 1; i < values.length; i++) {
            ema = (values[i] * multiplier) + (ema * (1 - multiplier));
        }
        return ema;
    }

    calculateAverageVolume(candles, period = this.config.volumePeriod) {
        if (candles.length < period) return null;
        const volumes = candles.map(candle => parseFloat(candle[5]));
        return this.calculateEMA(volumes, period);
    }

    calculateAverageRange(candles, lookbackPeriod = this.config.bigCandleLookbackPeriod) {
        if (candles.length < lookbackPeriod) return null;
        const ranges = candles.map(candle => {
            const high = parseFloat(candle[2]);
            const low = parseFloat(candle[3]);
            return high - low;
        });
        return this.calculateEMA(ranges, lookbackPeriod);
    }

    analyzeBCVC(candles) {
        const minRequiredCandles = Math.max(
            this.config.volumePeriod,
            this.config.bigCandleLookbackPeriod
        ) + 1;

        if (candles.length < minRequiredCandles) {
            console.log(`Not enough data. Need at least ${minRequiredCandles} candles, have ${candles.length}`);
            return null;
        }

        const lastCandle = candles[candles.length - 1];
        const timestamp = lastCandle[0];
        const open = parseFloat(lastCandle[1]);
        const high = parseFloat(lastCandle[2]);
        const low = parseFloat(lastCandle[3]);
        const close = parseFloat(lastCandle[4]);
        const volume = parseFloat(lastCandle[5]);

        const candleRange = high - low;
        const candleBody = Math.abs(close - open);
        const isUpBar = close > open;
        const isDownBar = open > close;

        const avgVolume = this.calculateAverageVolume(candles, this.config.volumePeriod);
        const avgRange = this.calculateAverageRange(candles, this.config.bigCandleLookbackPeriod);

        if (!avgVolume || !avgRange) return null;

        const volumeThreshold = avgVolume * this.config.volumeProportion;
        const rangeThreshold = avgRange * this.config.bigCandleProportion;

        const isHighVolume = volume > volumeThreshold;
        const isBigCandle = candleRange > rangeThreshold;

        let isBCVC = false;
        let candleColor = 'none';
        let isBullish = false;
        let isBearish = false;
        let bcvcType = null;

        if (isUpBar && isHighVolume && isBigCandle) {
            // WHITE: high volume, big range, up bar
            isBCVC = true;
            candleColor = 'white';
            isBullish = true;
            bcvcType = '🚀 BULLISH BCVC (WHITE)';
        }
        else if (isDownBar && isHighVolume && isBigCandle) {
            // ORANGE: high volume, big range, down bar
            isBCVC = true;
            candleColor = 'orange';
            isBearish = true;
            bcvcType = '🔴 BEARISH BCVC (ORANGE)';
        }
        else if (isDownBar && isHighVolume && !isBigCandle) {
            // MAROON: high volume, small range, down bar (early warning)
            isBCVC = true;
            candleColor = 'maroon';
            isBearish = true;
            bcvcType = '🟤 BEARISH BCVC (MAROON - High Vol, Small Range)';
        }
        else if (this.config.includeRed && isDownBar) {
            // RED: any down bar (only when flag enabled, e.g. bearish crossover scan)
            isBCVC = true;
            candleColor = 'red';
            isBearish = true;
            bcvcType = '🔻 BEARISH BCVC (RED - Any Down Candle)';
        }

        const volumeRatio = avgVolume > 0 ? volume / avgVolume : 0;
        const rangeRatio = avgRange > 0 ? candleRange / avgRange : 0;

        return {
            timestamp: moment.unix(timestamp).format('YYYY-MM-DD HH:mm'),
            timestampUnix: timestamp,
            open, high, low, close, volume,
            candleRange, candleBody,
            isUpBar, isDownBar, isBullish, isBearish,
            candleColor,
            direction: isBullish ? 'BULLISH' : isBearish ? 'BEARISH' : 'NEUTRAL',
            avgVolume, volumeThreshold,
            volumeRatio: volumeRatio.toFixed(2),
            isHighVolume,
            volumeQualified: isHighVolume ? '✅' : '❌',
            avgRange, rangeThreshold,
            rangeRatio: rangeRatio.toFixed(2),
            isBigCandle,
            rangeQualified: isBigCandle ? '✅' : '❌',
            isBCVC,
            bcvcStatus: isBCVC ? '🔥 BCVC CONFIRMED' : 'Not BCVC',
            bcvcType
        };
    }

    async getBCVC(symbol, resolution = '60', maxRetries = 10, retryDelay = 2000) {
        const cacheKey = this.getCacheKey(symbol, resolution);
        const cache = this.bcvcCache.get(cacheKey);
        const tfConfig = this.timeframes[resolution];

        if (!tfConfig) {
            console.error(`❌ Invalid resolution: ${resolution}. Available: ${Object.keys(this.timeframes).join(', ')}`);
            return null;
        }

        const needsInit = !cache ||
            cache.symbol !== symbol ||
            cache.resolution !== resolution ||
            (Date.now() - cache.lastUpdate > 24 * 60 * 60 * 1000);

        if (needsInit) {
            console.log(`🔧 Initializing BCVC for ${symbol} [${resolution}]...`);
            let retryCount = 0;
            while (retryCount < maxRetries) {
                try {
                    const validTo = moment();
                    const validFrom = moment().subtract(tfConfig.rollingDays, 'days');
                    const response = await this.fyers.getHistory({
                        symbol, resolution: tfConfig.resolution,
                        date_format: "1",
                        range_from: validFrom.format("YYYY-MM-DD"),
                        range_to: validTo.format("YYYY-MM-DD"),
                        cont_flag: "1"
                    });

                    if (!response || !response.candles || response.candles.length === 0) {
                        console.log(`No data for ${symbol} [${resolution}], retry ${retryCount + 1}/${maxRetries}`);
                        retryCount++;
                        if (retryCount < maxRetries) {
                            await this.sleep(Math.max(retryDelay * retryCount, 2000));
                            continue;
                        }
                        console.error(`❌ Failed to get candle data after ${maxRetries} retries`);
                        return null;
                    }

                    let candles = response.candles;
                    const lastCandle = candles[candles.length - 1];
                    if (this.isFormingCandle(lastCandle[0], resolution)) {
                        console.log(`🔧 Removing forming candle for initialization`);
                        candles = candles.slice(0, -1);
                    }

                    const bcvcResult = this.analyzeBCVC(candles);
                    if (bcvcResult) {
                        this.bcvcCache.set(cacheKey, {
                            symbol, resolution,
                            lastUpdate: Date.now(),
                            lastCandleTimestamp: bcvcResult.timestampUnix,
                            lastAnalysis: bcvcResult,
                            candleCount: candles.length
                        });
                        console.log(`✅ BCVC initialized for ${symbol} [${resolution}]:`);
                        console.log(`   Status: ${bcvcResult.bcvcStatus}`);
                        console.log(`   Volume: ${bcvcResult.volume.toFixed(0)} (${bcvcResult.volumeRatio}x avg) ${bcvcResult.volumeQualified}`);
                        console.log(`   Range: ${bcvcResult.candleRange.toFixed(2)} (${bcvcResult.rangeRatio}x avg) ${bcvcResult.rangeQualified}`);
                        if (bcvcResult.isBCVC) console.log(`   Type: ${bcvcResult.bcvcType}`);
                        return { symbol, resolution, ...bcvcResult, candleCount: candles.length };
                    } else {
                        console.log(`❌ BCVC analysis failed for ${symbol} [${resolution}], retry ${retryCount + 1}/${maxRetries}`);
                    }

                    retryCount++;
                    if (retryCount < maxRetries) await this.sleep(retryDelay * retryCount);
                } catch (error) {
                    console.error(`Error initializing BCVC for ${symbol} [${resolution}] (${retryCount + 1}/${maxRetries}):`, error.message);
                    retryCount++;
                    if (retryCount < maxRetries) await this.sleep(retryDelay * retryCount);
                }
            }
            console.error(`❌ Failed to initialize BCVC for ${symbol} [${resolution}] after ${maxRetries} attempts`);
            return null;
        }

        let retryCount = 0;
        while (retryCount < maxRetries) {
            try {
                const validTo = moment();
                const candlesToFetch = resolution === 'D' ? 10 : resolution === '60' ? 5 : 10;
                let validFrom;
                if (resolution === 'D') {
                    validFrom = moment().subtract(candlesToFetch, 'days');
                } else {
                    validFrom = moment().subtract(tfConfig.duration * candlesToFetch, 'minutes');
                }

                const response = await this.fyers.getHistory({
                    symbol, resolution: tfConfig.resolution,
                    date_format: "1",
                    range_from: validFrom.format("YYYY-MM-DD"),
                    range_to: validTo.format("YYYY-MM-DD"),
                    cont_flag: "1"
                });

                if (!response || !response.candles || response.candles.length === 0) {
                    console.log(`No candle data for ${symbol} [${resolution}], retry ${retryCount + 1}/${maxRetries}`);
                    retryCount++;
                    if (retryCount < maxRetries) { await this.sleep(retryDelay * retryCount); continue; }
                    if (cache && cache.lastAnalysis) {
                        console.log(`⚠️ Returning cached BCVC values for ${symbol} [${resolution}]`);
                        return { symbol, resolution, ...cache.lastAnalysis, cached: true };
                    }
                    return null;
                }

                let completedCandles = response.candles.filter(candle => !this.isFormingCandle(candle[0], resolution));
                if (completedCandles.length === 0) {
                    console.log(`⚠️ No completed candles available yet for ${symbol} [${resolution}]`);
                    retryCount++;
                    if (retryCount < maxRetries) { await this.sleep(retryDelay * retryCount); continue; }
                    if (cache && cache.lastAnalysis) {
                        console.log(`⚠️ Returning cached BCVC values for ${symbol} [${resolution}]`);
                        return { symbol, resolution, ...cache.lastAnalysis, cached: true };
                    }
                    return null;
                }

                const fullValidFrom = moment().subtract(tfConfig.rollingDays, 'days');
                const fullResponse = await this.fyers.getHistory({
                    symbol, resolution: tfConfig.resolution,
                    date_format: "1",
                    range_from: fullValidFrom.format("YYYY-MM-DD"),
                    range_to: validTo.format("YYYY-MM-DD"),
                    cont_flag: "1"
                });

                if (fullResponse && fullResponse.candles && fullResponse.candles.length > 0) {
                    let fullCandles = fullResponse.candles.filter(candle => !this.isFormingCandle(candle[0], resolution));
                    const lastCompletedCandle = fullCandles[fullCandles.length - 1];
                    const candleTimestamp = lastCompletedCandle[0];

                    if (cache.lastCandleTimestamp === candleTimestamp) {
                        console.log(`⚠ Skipping update for ${symbol} [${resolution}] - same candle already processed`);
                        return { symbol, resolution, ...cache.lastAnalysis, cached: true };
                    }

                    const bcvcResult = this.analyzeBCVC(fullCandles);
                    if (bcvcResult) {
                        this.bcvcCache.set(cacheKey, {
                            symbol, resolution,
                            lastUpdate: Date.now(),
                            lastCandleTimestamp: bcvcResult.timestampUnix,
                            lastAnalysis: bcvcResult,
                            candleCount: fullCandles.length
                        });
                        console.log(`✅ BCVC updated for ${symbol} [${resolution}]:`);
                        console.log(`   Status: ${bcvcResult.bcvcStatus}`);
                        console.log(`   Volume: ${bcvcResult.volume.toFixed(0)} (${bcvcResult.volumeRatio}x avg) ${bcvcResult.volumeQualified}`);
                        console.log(`   Range: ${bcvcResult.candleRange.toFixed(2)} (${bcvcResult.rangeRatio}x avg) ${bcvcResult.rangeQualified}`);
                        if (bcvcResult.isBCVC) console.log(`   Type: ${bcvcResult.bcvcType}`);
                        return { symbol, resolution, ...bcvcResult, candleCount: fullCandles.length };
                    }
                }

                console.log(`🔄 Reinitializing BCVC for ${symbol} [${resolution}]...`);
                this.bcvcCache.delete(cacheKey);
                await this.sleep(2000);
                return await this.getBCVC(symbol, resolution, 8, retryDelay);

            } catch (error) {
                console.error(`Error updating BCVC for ${symbol} [${resolution}] (${retryCount + 1}/${maxRetries}):`, error.message);
                retryCount++;
                if (retryCount < maxRetries) await this.sleep(retryDelay * retryCount);
            }
        }

        if (cache && cache.lastAnalysis) {
            console.log(`⚠️ All retries failed, returning cached BCVC values for ${symbol} [${resolution}]`);
            return { symbol, resolution, ...cache.lastAnalysis, cached: true };
        }
        console.error(`❌ Failed to get BCVC for ${symbol} [${resolution}] after ${maxRetries} attempts`);
        return null;
    }

    async getMultipleBCVC(symbols, resolution = '60', maxRetries = 10, retryDelay = 2000) {
        const results = {};
        for (const symbol of symbols) {
            results[symbol] = await this.getBCVC(symbol, resolution, maxRetries, retryDelay);
        }
        return results;
    }

    async getMultiTimeframeBCVC(symbol, resolutions = ['5', '15', '60'], maxRetries = 10, retryDelay = 2000) {
        const results = {};
        for (const resolution of resolutions) {
            results[resolution] = await this.getBCVC(symbol, resolution, maxRetries, retryDelay);
        }
        return results;
    }

    async scanBCVC(symbols, resolution = '60', maxRetries = 10, retryDelay = 2000) {
        console.log(`\n🔍 Scanning ${symbols.length} symbols for BCVC signals [${resolution}]...\n`);
        const bcvcSignals = { bullish: [], bearish: [], neutral: [] };
        for (const symbol of symbols) {
            const bcvc = await this.getBCVC(symbol, resolution, maxRetries, retryDelay);
            if (bcvc && bcvc.isBCVC) {
                const signal = {
                    symbol: bcvc.symbol, type: bcvc.bcvcType,
                    direction: bcvc.direction, volumeRatio: bcvc.volumeRatio,
                    rangeRatio: bcvc.rangeRatio, timestamp: bcvc.timestamp
                };
                if (bcvc.isBullish) bcvcSignals.bullish.push(signal);
                else if (bcvc.isBearish) bcvcSignals.bearish.push(signal);
                else bcvcSignals.neutral.push(signal);
            }
        }
        console.log(`\n📊 BCVC Scan Results:`);
        console.log(`   🚀 Bullish: ${bcvcSignals.bullish.length}`);
        console.log(`   🔴 Bearish: ${bcvcSignals.bearish.length}`);
        console.log(`   ⚪ Neutral: ${bcvcSignals.neutral.length}`);
        return bcvcSignals;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    clearSymbolData(symbol, resolution = null) {
        if (resolution) {
            const cacheKey = this.getCacheKey(symbol, resolution);
            if (this.bcvcCache.has(cacheKey)) {
                this.bcvcCache.delete(cacheKey);
                console.log(`✓ Cleared BCVC data for ${symbol} [${resolution}]`);
            }
        } else {
            let cleared = 0;
            for (const res of Object.keys(this.timeframes)) {
                const cacheKey = this.getCacheKey(symbol, res);
                if (this.bcvcCache.has(cacheKey)) {
                    this.bcvcCache.delete(cacheKey);
                    cleared++;
                }
            }
            if (cleared > 0) console.log(`✓ Cleared BCVC data for ${symbol} (${cleared} timeframes)`);
        }
    }

    clearAllCache() {
        this.bcvcCache.clear();
        console.log("✓ BCVC cache cleared completely");
    }

    getCacheStatus() {
        return Array.from(this.bcvcCache.entries()).map(([key, value]) => ({
            key,
            symbol: value.symbol,
            resolution: value.resolution,
            lastUpdate: new Date(value.lastUpdate).toLocaleString(),
            lastCandle: moment.unix(value.lastCandleTimestamp).format('YYYY-MM-DD HH:mm'),
            isBCVC: value.lastAnalysis?.isBCVC,
            bcvcType: value.lastAnalysis?.bcvcType,
            candleCount: value.candleCount
        }));
    }

    getDebugInfo(symbol, resolution = '60') {
        const cacheKey = this.getCacheKey(symbol, resolution);
        const cache = this.bcvcCache.get(cacheKey);
        if (!cache) return { error: 'Symbol-resolution not found in cache' };
        return {
            symbol: cache.symbol, resolution: cache.resolution,
            lastUpdate: new Date(cache.lastUpdate).toLocaleString(),
            lastCandle: moment.unix(cache.lastCandleTimestamp).format('YYYY-MM-DD HH:mm'),
            analysis: cache.lastAnalysis, candleCount: cache.candleCount
        };
    }

    async getHistoricalBCVC(symbol, resolution = '60', days = 20, includeRed = null, maxRetries = 10, retryDelay = 2000) {
        const shouldIncludeRed = includeRed === "red";
        const originalIncludeRed = this.config.includeRed;

        if (shouldIncludeRed) this.config.includeRed = true;

        const tfConfig = this.timeframes[resolution];
        if (!tfConfig) {
            console.error(`❌ Invalid resolution: ${resolution}. Available: ${Object.keys(this.timeframes).join(', ')}`);
            return null;
        }

        console.log(`🔍 Fetching ${days} days of BCVC history for ${symbol} [${resolution}]...`);

        let retryCount = 0;
        while (retryCount < maxRetries) {
            try {
                const validTo = moment();
                const validFrom = moment().subtract(days, 'days');

                const response = await this.fyers.getHistory({
                    symbol, resolution: tfConfig.resolution,
                    date_format: "1",
                    range_from: validFrom.format("YYYY-MM-DD"),
                    range_to: validTo.format("YYYY-MM-DD"),
                    cont_flag: "1"
                });

                if (!response || !response.candles || response.candles.length === 0) {
                    console.log(`No data for ${symbol} [${resolution}], retry ${retryCount + 1}/${maxRetries}`);
                    retryCount++;
                    if (retryCount < maxRetries) {
                        await this.sleep(Math.max(retryDelay * retryCount, 2000));
                        continue;
                    }
                    console.error(`❌ Failed to get candle data after ${maxRetries} retries`);
                    this.config.includeRed = originalIncludeRed;
                    return null;
                }

                let candles = response.candles;
                const lastCandle = candles[candles.length - 1];
                if (this.isFormingCandle(lastCandle[0], resolution)) {
                    console.log(`🔧 Removing forming candle for historical analysis`);
                    candles = candles.slice(0, -1);
                }

                const bcvcFormations = [];
                const minRequiredCandles = Math.max(
                    this.config.volumePeriod,
                    this.config.bigCandleLookbackPeriod
                ) + 1;

                for (let i = minRequiredCandles - 1; i < candles.length; i++) {
                    const candlesUpToIndex = candles.slice(0, i + 1);
                    const analysis = this.analyzeBCVC(candlesUpToIndex);
                    if (analysis && analysis.isBCVC) {
                        bcvcFormations.push({
                            symbol,
                            timestamp: analysis.timestamp,
                            timestampUnix: analysis.timestampUnix,
                            type: analysis.bcvcType,
                            direction: analysis.direction,
                            candleColor: analysis.candleColor,
                            isBullish: analysis.isBullish,
                            isBearish: analysis.isBearish,
                            open: analysis.open,
                            high: analysis.high,
                            low: analysis.low,
                            close: analysis.close,
                            volume: analysis.volume,
                            candleRange: analysis.candleRange,
                            volumeRatio: parseFloat(analysis.volumeRatio),
                            rangeRatio: parseFloat(analysis.rangeRatio),
                            avgVolume: analysis.avgVolume,
                            avgRange: analysis.avgRange
                        });
                    }
                }

                const bullishCount = bcvcFormations.filter(f => f.isBullish).length;
                const bearishCount = bcvcFormations.filter(f => f.isBearish).length;
                const redCount = bcvcFormations.filter(f => f.candleColor === 'red').length;
                const orangeCount = bcvcFormations.filter(f => f.candleColor === 'orange').length;
                const maroonCount = bcvcFormations.filter(f => f.candleColor === 'maroon').length;
                const whiteCount = bcvcFormations.filter(f => f.candleColor === 'white').length;
                const totalCount = bcvcFormations.length;

                const avgVolumeRatio = totalCount > 0
                    ? bcvcFormations.reduce((sum, f) => sum + f.volumeRatio, 0) / totalCount : 0;
                const avgRangeRatio = totalCount > 0
                    ? bcvcFormations.reduce((sum, f) => sum + f.rangeRatio, 0) / totalCount : 0;

                const result = {
                    symbol, resolution,
                    period: `${days} days`,
                    periodStart: validFrom.format('YYYY-MM-DD'),
                    periodEnd: validTo.format('YYYY-MM-DD'),
                    totalCandles: candles.length,
                    bcvcCount: totalCount,
                    bullishCount, bearishCount, whiteCount, orangeCount, maroonCount, redCount,
                    bcvcPercentage: ((totalCount / candles.length) * 100).toFixed(2),
                    avgVolumeRatio: avgVolumeRatio.toFixed(2),
                    avgRangeRatio: avgRangeRatio.toFixed(2),
                    formations: bcvcFormations,
                    mostRecent: bcvcFormations.length > 0 ? bcvcFormations[bcvcFormations.length - 1] : null
                };

                this.config.includeRed = originalIncludeRed;
                return result;

            } catch (error) {
                console.error(`Error fetching historical BCVC for ${symbol} [${resolution}] (${retryCount + 1}/${maxRetries}):`, error.message);
                retryCount++;
                if (retryCount < maxRetries) await this.sleep(retryDelay * retryCount);
            }
        }

        this.config.includeRed = originalIncludeRed;
        console.error(`❌ Failed to get historical BCVC for ${symbol} [${resolution}] after ${maxRetries} attempts`);
        return null;
    }

    async getMultipleHistoricalBCVC(symbols, resolution = '60', days = 20, includeRed = null, maxRetries = 10, retryDelay = 2000) {
        console.log(`\n🔍 Analyzing ${symbols.length} symbols for BCVC formations over ${days} days...\n`);
        const results = {};
        const summary = {
            totalSymbols: symbols.length,
            symbolsWithBCVC: 0,
            totalBullish: 0, totalBearish: 0,
            totalWhite: 0, totalOrange: 0, totalMaroon: 0, totalRed: 0,
            totalFormations: 0, mostRecent: []
        };

        for (const symbol of symbols) {
            const historical = await this.getHistoricalBCVC(symbol, resolution, days, includeRed, maxRetries, retryDelay);
            if (historical) {
                results[symbol] = historical;
                if (historical.bcvcCount > 0) {
                    summary.symbolsWithBCVC++;
                    summary.totalBullish += historical.bullishCount;
                    summary.totalBearish += historical.bearishCount;
                    summary.totalWhite += historical.whiteCount;
                    summary.totalOrange += historical.orangeCount;
                    summary.totalMaroon += historical.maroonCount;
                    summary.totalRed += historical.redCount;
                    summary.totalFormations += historical.bcvcCount;
                    if (historical.mostRecent) {
                        summary.mostRecent.push({ symbol, ...historical.mostRecent });
                    }
                }
            }
        }

        summary.mostRecent.sort((a, b) => b.timestampUnix - a.timestampUnix);
        console.log(`\n📊 Multi-Symbol BCVC Summary (${days} days):`);
        console.log(`   Symbols Analyzed: ${summary.totalSymbols}`);
        console.log(`   Symbols with BCVC: ${summary.symbolsWithBCVC}`);
        console.log(`   Total Formations: ${summary.totalFormations}`);
        console.log(`   🚀 Total Bullish: ${summary.totalBullish} (White: ${summary.totalWhite})`);
        console.log(`   🔴 Total Bearish: ${summary.totalBearish} (Orange: ${summary.totalOrange}, Maroon: ${summary.totalMaroon}, Red: ${summary.totalRed})`);
        return { results, summary };
    }

    async generateBCVCReport(symbol, resolution = '60', days = 20) {
        const historical = await this.getHistoricalBCVC(symbol, resolution, days);
        if (!historical) return null;

        const report = {
            header: {
                symbol: historical.symbol, resolution: historical.resolution,
                period: historical.period,
                dateRange: `${historical.periodStart} to ${historical.periodEnd}`,
                generatedAt: moment().format('YYYY-MM-DD HH:mm:ss')
            },
            summary: {
                totalCandles: historical.totalCandles,
                bcvcFormations: historical.bcvcCount,
                bcvcPercentage: historical.bcvcPercentage,
                bullishFormations: historical.bullishCount,
                bearishFormations: historical.bearishCount,
                whiteFormations: historical.whiteCount,
                orangeFormations: historical.orangeCount,
                maroonFormations: historical.maroonCount,
                redFormations: historical.redCount,
                bullishPercentage: historical.bcvcCount > 0
                    ? ((historical.bullishCount / historical.bcvcCount) * 100).toFixed(2) : '0.00',
                bearishPercentage: historical.bcvcCount > 0
                    ? ((historical.bearishCount / historical.bcvcCount) * 100).toFixed(2) : '0.00'
            },
            characteristics: {
                averageVolumeRatio: historical.avgVolumeRatio,
                averageRangeRatio: historical.avgRangeRatio,
                configuration: {
                    volumePeriod: this.config.volumePeriod,
                    volumeProportion: this.config.volumeProportion,
                    bigCandleLookbackPeriod: this.config.bigCandleLookbackPeriod,
                    bigCandleProportion: this.config.bigCandleProportion,
                    includeRed: this.config.includeRed
                }
            },
            recentActivity: {
                mostRecent: historical.mostRecent,
                last5Formations: historical.formations.slice(-5).reverse()
            },
            allFormations: historical.formations
        };

        console.log(`\n${'='.repeat(80)}`);
        console.log(`BCVC ANALYSIS REPORT`);
        console.log(`${'='.repeat(80)}`);
        console.log(`\nSymbol: ${report.header.symbol} | Timeframe: ${report.header.resolution} | Period: ${report.header.period}`);
        console.log(`Date Range: ${report.header.dateRange}`);
        console.log(`Generated: ${report.header.generatedAt}`);
        console.log(`\n${'-'.repeat(80)}`);
        console.log(`SUMMARY`);
        console.log(`${'-'.repeat(80)}`);
        console.log(`Total Candles Analyzed: ${report.summary.totalCandles}`);
        console.log(`BCVC Formations: ${report.summary.bcvcFormations} (${report.summary.bcvcPercentage}% of candles)`);
        console.log(`  🚀 Bullish: ${report.summary.bullishFormations} (${report.summary.bullishPercentage}%) - White: ${report.summary.whiteFormations}`);
        console.log(`  🔴 Bearish: ${report.summary.bearishFormations} (${report.summary.bearishPercentage}%) - Orange: ${report.summary.orangeFormations}, Maroon: ${report.summary.maroonFormations}, Red: ${report.summary.redFormations}`);
        console.log(`\n${'-'.repeat(80)}`);
        console.log(`CHARACTERISTICS`);
        console.log(`${'-'.repeat(80)}`);
        console.log(`Average Volume Ratio: ${report.characteristics.averageVolumeRatio}x`);
        console.log(`Average Range Ratio: ${report.characteristics.averageRangeRatio}x`);
        console.log(`\nConfiguration:`);
        console.log(`  Volume Period: ${report.characteristics.configuration.volumePeriod}`);
        console.log(`  Volume Threshold: ${report.characteristics.configuration.volumeProportion}x`);
        console.log(`  Range Lookback: ${report.characteristics.configuration.bigCandleLookbackPeriod}`);
        console.log(`  Range Threshold: ${report.characteristics.configuration.bigCandleProportion}x`);
        console.log(`  Include Red Candles: ${report.characteristics.configuration.includeRed}`);
        if (report.recentActivity.last5Formations.length > 0) {
            console.log(`\n${'-'.repeat(80)}`);
            console.log(`RECENT FORMATIONS (Last 5)`);
            console.log(`${'-'.repeat(80)}`);
            report.recentActivity.last5Formations.forEach((sig, idx) => {
                console.log(`${idx + 1}. ${sig.timestamp} | ${sig.type} | Vol: ${sig.volumeRatio.toFixed(2)}x | Range: ${sig.rangeRatio.toFixed(2)}x`);
            });
        }
        console.log(`\n${'='.repeat(80)}\n`);
        return report;
    }
    static buildSRTelegramBlock(srAnalysis, direction = "BULLISH") {
  if (!srAnalysis || srAnalysis.error) return "";

  const lines = ["", "📐 <b>S/R Levels (at signal):</b>"];

  if (direction === "BULLISH") {
    // Show nearest support (defense) and nearest resistance (target)
    if (srAnalysis.support && srAnalysis.support.length > 0) {
      const s = srAnalysis.support[0];
      lines.push(`🟢 Support  : ₹${s.price} (${s.distancePct}% below) [${s.strength}]`);
    }
    if (srAnalysis.resistance && srAnalysis.resistance.length > 0) {
      const r = srAnalysis.resistance[0];
      lines.push(`🔴 Resist   : ₹${r.price} (${r.distancePct}% above) [${r.strength}]`);
    }
    if (srAnalysis.accumulation && srAnalysis.accumulation.length > 0) {
      const a = srAnalysis.accumulation[0];
      lines.push(`📦 Accum    : ₹${a.low}–₹${a.high} (${a.candleCount} candles)`);
    }
  } else {
    // BEARISH — show nearest resistance (defense) and nearest support (target)
    if (srAnalysis.resistance && srAnalysis.resistance.length > 0) {
      const r = srAnalysis.resistance[0];
      lines.push(`🔴 Resist   : ₹${r.price} (${r.distancePct}% above) [${r.strength}]`);
    }
    if (srAnalysis.support && srAnalysis.support.length > 0) {
      const s = srAnalysis.support[0];
      lines.push(`🟢 Support  : ₹${s.price} (${s.distancePct}% below) [${s.strength}]`);
    }
    if (srAnalysis.distribution && srAnalysis.distribution.length > 0) {
      const d = srAnalysis.distribution[0];
      lines.push(`📤 Dist     : ₹${d.low}–₹${d.high} (${d.candleCount} candles)`);
    }
  }

  return lines.join("\n");
}
}

module.exports = BCVCManager;