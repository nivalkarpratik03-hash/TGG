/**
 * backend/src/driveExport/liveCapture.js
 * Core of the LIVE bid/ask capture test. All outside-world pieces (Fyers REST,
 * websocket subscribe, clock) are INJECTED, so the logic can be tested with
 * simulated messages. The runnable wiring is scripts/driveLiveCapture.js.
 *
 * What it records (files in outDir):
 *   quote_changes.csv     one row each time a contract's bid/ask/size CHANGES (sir's choice)
 *   raw_messages.jsonl    every raw websocket message, exactly as received
 *   rest_snapshots.csv    once a minute (at :55) the REST option-chain bid/ask next to
 *                         what the websocket last said, to check the websocket is right
 *   window_events.csv     every time the ATM window moved with spot
 *   connection_events.csv connects, closes, errors, silent gaps
 *   summary.txt           what the test found (written by finish())
 */
"use strict";

const fs = require("fs");
const path = require("path");
const S = require("./driveShared");

const QUOTE_COLS = ["recv_time_ist", "recv_ms", "symbol", "cycle", "expiry_date", "strike", "option_type", "atm_offset", "in_window",
  "bid", "ask", "bid_size", "ask_size", "ltp", "exch_feed_time", "last_traded_time", "tt",
  "vol_traded_today", "last_traded_qty", "avg_trade_price", "tot_buy_qty", "tot_sell_qty", "day_open", "day_high", "day_low", "prev_close"];
const REST_COLS = ["snapshot_time_ist", "snapshot_ms", "symbol", "cycle", "strike", "option_type", "bid", "ask", "ltp", "oi", "volume",
  "ws_bid", "ws_ask", "bid_match", "ask_match", "iv", "delta", "gamma", "theta", "vega"];
const WINDOW_COLS = ["time_ist", "cycle", "spot", "atm_strike", "window_strikes", "newly_subscribed"];
const CONN_COLS = ["time_ist", "event", "detail"];

function createCapture(cfg) {
  const {
    lookup, cycles: wantedCycles, width, outDir, chainBand = 15, rawLimit = 300000, restEnabled = true, rowsOnTrade = false,
    fetchOptionChain, restOptionChain, restSpot, subscribe, now = () => Date.now(), log = console.log,
  } = cfg;

  fs.mkdirSync(outDir, { recursive: true });
  const quoteW = S.makeCsvWriter(path.join(outDir, "quote_changes.csv"), QUOTE_COLS);
  const restW = S.makeCsvWriter(path.join(outDir, "rest_snapshots.csv"), REST_COLS);
  const winW = S.makeCsvWriter(path.join(outDir, "window_events.csv"), WINDOW_COLS);
  const connW = S.makeCsvWriter(path.join(outDir, "connection_events.csv"), CONN_COLS);
  const rawStream = fs.createWriteStream(path.join(outDir, "raw_messages.jsonl"), { flags: "a", encoding: "utf8" });

  const cycles = {};            // name -> {name,date,dateIso,expiry,strikes[],sym:Map,atmIdx}
  const meta = new Map();       // symbol -> {cycle, strike, type, expiryIso}
  const wanted = new Set();
  const tracker = S.makeQuoteTracker();
  const lastTrade = new Map();   // only used when rowsOnTrade is on
  const st = { spot: null, spotMs: 0, connected: false, lastMsgMs: 0, inGap: false, refreshing: false, lastRefreshMs: 0, lastRestMinute: -1, restBusy: false };
  const stats = {
    msgs: 0, optMsgs: 0, spotMsgs: 0, otherSymbolMsgs: 0, noSymbolMsgs: 0, msgsWithBidAsk: 0, changes: 0, windowChanges: 0,
    rawLogged: 0, gaps: 0, connects: 0, closes: 0, errors: 0, restRows: 0, restBidMatch: 0, restAskMatch: 0, restBidCmp: 0, restAskCmp: 0,
    keys: new Set(), perSymbolMsgs: new Map(), perSymbolChanges: new Map(), perMinute: new Map(), startedMs: now(),
    exchTimeKeysSeen: new Set(),
  };
  const conn = (event, detail = "") => { connW.row({ time_ist: S.istStamp(now(), true), event, detail }); log(`[${S.istTime(now())}] ${event} ${detail}`); };

  async function loadChain(c) {
    const ch = await fetchOptionChain(lookup, { strikeCount: chainBand, timestamp: c.expiry });
    if (!ch.strikes.length) throw new Error(`No strikes returned for ${c.name} expiry ${c.date}`);
    const sym = new Map();
    for (const s of ch.strikes) {
      sym.set(`${s.strike_price}|${s.option_type}`, s.symbol);
      meta.set(s.symbol, { cycle: c.name, strike: s.strike_price, type: s.option_type, expiryIso: c.dateIso });
    }
    cycles[c.name] = { ...c, strikes: S.uniqueSortedStrikes(ch.strikes), sym, atmIdx: null };
  }

  function windowSymbols(c) {
    const out = [];
    for (const k of S.windowStrikes(c.strikes, c.atmIdx, width)) for (const t of ["CE", "PE"]) { const s = c.sym.get(`${k}|${t}`); if (s) out.push(s); }
    return out;
  }

  let needRefresh = false;
  function applySpot(price, ms) {
    if (!Number.isFinite(price)) return;
    st.spot = price; st.spotMs = ms;
    for (const c of Object.values(cycles)) {
      const idx = S.nearestStrikeIndex(c.strikes, price);
      if (idx === c.atmIdx) continue;
      c.atmIdx = idx;
      const syms = windowSymbols(c);
      const fresh = syms.filter((s) => !wanted.has(s));
      fresh.forEach((s) => wanted.add(s));
      if (fresh.length && st.connected) subscribe(fresh);
      stats.windowChanges++;
      winW.row({ time_ist: S.istStamp(ms, true), cycle: c.name, spot: price, atm_strike: c.strikes[idx],
        window_strikes: S.windowStrikes(c.strikes, idx, width).join(" "), newly_subscribed: fresh.length });
      if (idx < 2 || idx > c.strikes.length - 3) needRefresh = true;
    }
  }

  async function init() {
    for (const c of wantedCycles) await loadChain(c);
    try { const p = await restSpot(); if (Number.isFinite(p)) applySpot(p, now()); } catch (e) { conn("spot_seed_failed", e.message); }
    return { spot: lookup, symbols: [...wanted] };
  }
  function symbolsToSubscribe() { return [lookup, ...wanted]; }

  function onConnect() { st.connected = true; stats.connects++; conn("connect", `subscribing ${wanted.size + 1} symbols`); subscribe(symbolsToSubscribe()); }
  function onClose() { st.connected = false; stats.closes++; conn("close"); }
  function onError(e) { stats.errors++; conn("error", (e && e.message) || String(e)); }

  function onMessage(msg) {
    const recv = now();
    st.lastMsgMs = recv;
    if (st.inGap) { st.inGap = false; conn("gap_end"); }
    const ticks = Array.isArray(msg) ? msg : [msg];
    for (const t of ticks) {
      if (!t || typeof t !== "object") continue;
      stats.msgs++;
      for (const k of Object.keys(t)) if (stats.keys.size < 120) stats.keys.add(k);
      if (stats.rawLogged < rawLimit) { rawStream.write(JSON.stringify({ recv_ms: recv, recv_ist: S.istStamp(recv, true), msg: t }) + "\n"); stats.rawLogged++; }
      const symbol = t.symbol;
      if (!symbol) { stats.noSymbolMsgs++; continue; }
      if (symbol === lookup) { stats.spotMsgs++; if (t.ltp !== undefined) applySpot(Number(t.ltp), recv); continue; }
      const m = meta.get(symbol);
      if (!m) { stats.otherSymbolMsgs++; continue; }
      stats.optMsgs++;
      stats.perSymbolMsgs.set(symbol, (stats.perSymbolMsgs.get(symbol) || 0) + 1);
      const minute = Math.floor(recv / 60000);
      stats.perMinute.set(minute, (stats.perMinute.get(minute) || 0) + 1);
      for (const k of ["exch_feed_time", "last_traded_time", "tt", "timestamp"]) if (t[k] !== undefined) stats.exchTimeKeysSeen.add(k);

      const q = S.extractQuote(t);
      if (q.bid !== undefined || q.ask !== undefined) stats.msgsWithBidAsk++;
      const r = tracker.update(symbol, q);
      // Default (unchanged): a row only when bid/ask/size changes. With rowsOnTrade, a change in last price or
      // cumulative volume (a trade with the same bid/ask) also writes a row.
      let tradeChanged = false;
      if (rowsOnTrade) {
        const prev = lastTrade.get(symbol) || {}, vol = Number(t.vol_traded_today), px = Number(t.ltp);
        if ((Number.isFinite(vol) && vol !== prev.vol) || (Number.isFinite(px) && px !== prev.px)) tradeChanged = true;
        lastTrade.set(symbol, { vol: Number.isFinite(vol) ? vol : prev.vol, px: Number.isFinite(px) ? px : prev.px });
      }
      if (!r.changed && !tradeChanged) continue;
      stats.changes++;
      stats.perSymbolChanges.set(symbol, (stats.perSymbolChanges.get(symbol) || 0) + 1);
      const c = cycles[m.cycle];
      const off = c && c.atmIdx !== null ? c.strikes.indexOf(m.strike) - c.atmIdx : "";
      quoteW.row({
        recv_time_ist: S.istStamp(recv, true), recv_ms: recv, symbol, cycle: m.cycle, expiry_date: m.expiryIso, strike: m.strike,
        option_type: m.type, atm_offset: off, in_window: off === "" ? "" : Math.abs(off) <= width,
        bid: r.state.bid, ask: r.state.ask, bid_size: r.state.bidSize, ask_size: r.state.askSize, ltp: t.ltp,
        exch_feed_time: t.exch_feed_time, last_traded_time: t.last_traded_time, tt: t.tt,
        vol_traded_today: t.vol_traded_today, last_traded_qty: t.last_traded_qty, avg_trade_price: t.avg_trade_price,
        tot_buy_qty: t.tot_buy_qty, tot_sell_qty: t.tot_sell_qty, day_open: t.open_price, day_high: t.high_price,
        day_low: t.low_price, prev_close: t.prev_close_price,
      });
    }
  }

  async function restSnapshot() {
    const ms = now();
    for (const c of Object.values(cycles)) {
      if (c.atmIdx === null) continue;
      let res;
      try { res = await restOptionChain(c); } catch (e) { conn("rest_error", e.message); continue; }
      const list = (res && res.data && res.data.optionsChain) || [];
      const win = new Set(windowSymbols(c));
      for (const e of list) {
        if (!win.has(e.symbol)) continue;
        const ws = tracker.state(e.symbol) || {};
        const bm = ws.bid === undefined ? "" : Number(e.bid) === ws.bid;
        const am = ws.ask === undefined ? "" : Number(e.ask) === ws.ask;
        if (bm !== "") { stats.restBidCmp++; if (bm) stats.restBidMatch++; }
        if (am !== "") { stats.restAskCmp++; if (am) stats.restAskMatch++; }
        stats.restRows++;
        const m = meta.get(e.symbol) || {}, g = e.greeks || {};   // greeks come from Fyers (iv in percent); empty if not returned
        restW.row({ snapshot_time_ist: S.istStamp(ms, true), snapshot_ms: ms, symbol: e.symbol, cycle: c.name, strike: e.strike_price,
          option_type: e.option_type, bid: e.bid, ask: e.ask, ltp: e.ltp, oi: e.oi, volume: e.volume,
          ws_bid: ws.bid, ws_ask: ws.ask, bid_match: bm, ask_match: am, iv: g.iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega });
      }
    }
  }

  /** Call once per second. */
  async function tick1s() {
    const ms = now();
    if (st.connected && st.lastMsgMs && !st.inGap && ms - st.lastMsgMs > 10000) { st.inGap = true; stats.gaps++; conn("gap_start", `no websocket message for ${Math.round((ms - st.lastMsgMs) / 1000)}s`); }
    if (needRefresh && !st.refreshing && ms - st.lastRefreshMs > 300000) {
      st.refreshing = true; needRefresh = false; st.lastRefreshMs = ms;
      try {
        for (const c of wantedCycles) await loadChain(c);
        for (const c of Object.values(cycles)) c.atmIdx = null;
        applySpot(st.spot, ms);
        conn("chain_refreshed", "spot neared the edge of the loaded strikes");
      } catch (e) { conn("chain_refresh_failed", e.message); }
      st.refreshing = false;
    }
    const sec = Math.floor(ms / 1000) % 60, minute = Math.floor(ms / 60000);
    if (restEnabled && sec >= 55 && st.lastRestMinute !== minute && !st.restBusy) {   // >= so a skipped timer second cannot lose the snapshot
      st.lastRestMinute = minute; st.restBusy = true;
      try { await restSnapshot(); } finally { st.restBusy = false; }
    }
  }

  function summaryText() {
    const pm = [...stats.perMinute.values()];
    const avg = pm.length ? pm.reduce((a, b) => a + b, 0) / pm.length : 0;
    const sorted = [...pm].sort((a, b) => a - b);
    const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";
    const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}% (${a}/${b})` : "n/a (nothing compared)");
    const mins = ((now() - stats.startedMs) / 60000).toFixed(1);
    return [
      `LIVE CAPTURE SUMMARY  (${S.istStamp(stats.startedMs)} -> ${S.istStamp(now())}, ${mins} min)`,
      `Underlying lookup: ${lookup}   ATM window: +-${width} strikes   cycles: ${Object.keys(cycles).join(", ")}`,
      "",
      "1) Does the websocket carry bid/ask for options?",
      `   option messages: ${stats.optMsgs}   carrying a bid or ask key: ${pct(stats.msgsWithBidAsk, stats.optMsgs)}`,
      "2) Is every change delivered, or batched?",
      rowsOnTrade ? `   rows written: ${stats.changes}  (bid/ask changes plus trade-only changes)` : `   bid/ask change rows written: ${stats.changes}`,
      `   option messages per minute: min ${sorted[0] || 0}, avg ${avg.toFixed(1)}, max ${sorted[sorted.length - 1] || 0}  (over ${pm.length} minutes)`,
      "3) Is there a timestamp on each update?",
      `   time keys seen on option messages: ${[...stats.exchTimeKeysSeen].join(", ") || "NONE (rows use our PC clock: recv_time_ist)"}`,
      "4) Websocket vs REST option chain (taken at :55 each minute):",
      `   bid agrees: ${pct(stats.restBidMatch, stats.restBidCmp)}   ask agrees: ${pct(stats.restAskMatch, stats.restAskCmp)}`,
      "   (small mismatches are normal: the two are read a moment apart)",
      "",
      `Other: spot messages ${stats.spotMsgs}, other-symbol messages ${stats.otherSymbolMsgs}, messages without symbol ${stats.noSymbolMsgs}`,
      `ATM window moves: ${stats.windowChanges}   contracts subscribed: ${wanted.size}`,
      `Connection: connects ${stats.connects}, closes ${stats.closes}, errors ${stats.errors}, silent gaps >10s ${stats.gaps}`,
      `All message key names seen: ${[...stats.keys].join(", ") || "(none)"}`,
      "",
      "Most active contracts (messages):", top(stats.perSymbolMsgs),
      "Most bid/ask changes:", top(stats.perSymbolChanges),
    ].join("\n");
  }

  async function finish() {
    const text = summaryText();
    fs.writeFileSync(path.join(outDir, "summary.txt"), text + "\n", "utf8");
    await Promise.all([quoteW.close(), restW.close(), winW.close(), connW.close(), new Promise((r) => rawStream.end(r))]);
    return text;
  }

  return { init, onConnect, onClose, onError, onMessage, tick1s, finish, symbolsToSubscribe, _internals: { stats, cycles, wanted, st, applySpot } };
}

module.exports = { createCapture, QUOTE_COLS };