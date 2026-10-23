/**
 * backend/src/driveExport/depthCapture.js
 * Core of the CONTINUOUS 50-LEVEL DEPTH capture (Fyers tick-by-tick feed). Everything outside (Fyers REST, the
 * socket, the clock) is INJECTED so the logic is testable. Runnable wiring: scripts/driveDepthCapture.js.
 *
 * What it stores: one Parquet row per depth frame, FULL 50 positions per list (zeros kept) so that the level is
 * the list position and nothing is trimmed. Files are written in parts (default every 10 minutes) so a crash
 * loses at most the part being written; each closed part is a valid, complete Parquet file:
 *   <staging>/TGG_Dataset/<asset>/<root>/options/<cycle>/depth50/<date>_depth50_<HHMMSS>.parquet
 * Columns: recv_time_ist, recv_ms, feed_ts (seconds), feed_ts_raw, symbol, cycle, expiry_date, strike, option_type,
 *   snapshot, tbq, tsq, n_bid, n_ask, seq_no, bid_price[50], bid_qty[50], bid_orders[50], ask_price[50], ask_qty[50], ask_orders[50]
 *
 * It also counts, separately, the three ways a book can look "wrong" (gap inside the book, prices not monotonic,
 * best bid >= best ask) so the data-quality question can be answered from the numbers.
 * The ATM window follows spot (polled over REST); new contracts are subscribed on NEW channels of up to 5 symbols
 * (limit taken from third-party code, not confirmed by Fyers), and none are dropped during the day.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const parquet = require("parquetjs-lite");
const S = require("./driveShared");

const C = (t) => ({ type: t, compression: "GZIP" });
const R = (t) => ({ type: t, repeated: true, compression: "GZIP" });
const DEPTH_SCHEMA = new parquet.ParquetSchema({
  recv_time_ist: C("UTF8"), recv_ms: C("INT64"), feed_ts: C("INT64"), feed_ts_raw: C("UTF8"), symbol: C("UTF8"), cycle: C("UTF8"),
  expiry_date: C("UTF8"), strike: C("DOUBLE"), option_type: C("UTF8"), snapshot: C("BOOLEAN"), tbq: C("INT64"), tsq: C("INT64"),
  n_bid: C("INT64"), n_ask: C("INT64"), seq_no: C("INT64"),
  bid_price: R("DOUBLE"), bid_qty: R("INT64"), bid_orders: R("INT64"), ask_price: R("DOUBLE"), ask_qty: R("INT64"), ask_orders: R("INT64"),
});
const LEVELS = 50;
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const fix = (arr, f) => Array.from({ length: LEVELS }, (_, i) => f(arr[i]));
const strictly = (a, dir) => a.every((x, i) => i === 0 || (dir === "desc" ? x < a[i - 1] : x > a[i - 1]));

/** Position (0-based) of the first filled level that breaks the price order, or -1. */
function firstBad(p, q, dir) {
  let prev = null;
  for (let i = 0; i < LEVELS; i++) {
    if (!(p[i] > 0 && q[i] > 0)) continue;
    if (prev !== null && (dir === "desc" ? p[i] >= prev : p[i] <= prev)) return i;
    prev = p[i];
  }
  return -1;
}

/** Pure: one SDK depth object -> {row fields, quality flags}. Returns null if the frame is malformed. */
function frameToRow(d) {
  if (!d || !["bidprice", "askprice", "bidqty", "askqty", "bidordn", "askordn"].every((k) => Array.isArray(d[k]))) return null;
  const bp = fix(d.bidprice, num), bq = fix(d.bidqty, (x) => Math.round(num(x))), bo = fix(d.bidordn, (x) => Math.round(num(x)));
  const ap = fix(d.askprice, num), aq = fix(d.askqty, (x) => Math.round(num(x))), ao = fix(d.askordn, (x) => Math.round(num(x)));
  const live = (p, q, i) => p[i] > 0 && q[i] > 0;
  let nBid = 0, lastBid = 0, nAsk = 0, lastAsk = 0;
  for (let i = 0; i < LEVELS; i++) { if (live(bp, bq, i)) { nBid++; lastBid = i + 1; } if (live(ap, aq, i)) { nAsk++; lastAsk = i + 1; } }
  const bids = bp.filter((_, i) => live(bp, bq, i)), asks = ap.filter((_, i) => live(ap, aq, i));
  const fbBid = firstBad(bp, bq, "desc"), fbAsk = firstBad(ap, aq, "asc"), fb = [fbBid, fbAsk].filter((x) => x >= 0);
  const raw = num(d.timestamp), feedTs = Math.floor(raw > 1e17 ? raw / 1e9 : raw > 1e14 ? raw / 1e6 : raw > 1e11 ? raw / 1e3 : raw);
  return {
    fields: { feed_ts: feedTs, feed_ts_raw: String(d.timestamp), snapshot: !!d.snapshot, tbq: Math.round(num(d.tbq)), tsq: Math.round(num(d.tsq)), n_bid: nBid, n_ask: nAsk, seq_no: Math.round(num(d.seqNo)),
      bid_price: bp, bid_qty: bq, bid_orders: bo, ask_price: ap, ask_qty: aq, ask_orders: ao },
    quality: {
      gapInside: lastBid > nBid || lastAsk > nAsk,                                   // an empty position before the last filled one
      notMonotonic: !(strictly(bids, "desc") && strictly(asks, "asc")),              // among filled levels only
      crossed: bids.length > 0 && asks.length > 0 && bids[0] >= asks[0],
      empty: nBid === 0 && nAsk === 0,
      firstBad: fb.length ? Math.min(...fb) : -1,
    },
  };
}

function createDepthCapture(cfg) {
  const { lookup, cycles: wantedCycles, width, stagingRoot, assetClass, root, date, outDir, partMinutes = 10, spotPollMs = 3000, chainBand = 15, gapSeconds = 15,
    fetchOptionChain, restSpot, subscribeChannel, now = () => Date.now(), log = console.log } = cfg;
  fs.mkdirSync(outDir, { recursive: true });
  const evW = S.makeCsvWriter(path.join(outDir, "depth_events.csv"), ["time_ist", "event", "detail"]);
  const ev = (event, detail = "") => { evW.row({ time_ist: S.istStamp(now(), true), event, detail }); log(`[${S.istTime(now())}] ${event} ${detail}`); };

  const cycles = {}, meta = new Map(), wanted = [], channels = [];   // channels: [{no, symbols}]
  let connected = false, opens = 0, spot = null, lastFrameMs = 0, inGap = false, polling = false, curKey = null, lastSpotPoll = 0;
  const st = { frames: 0, snapshots: 0, malformed: 0, unknown: 0, gapInside: 0, notMonotonic: 0, crossed: 0, empty: 0, maxBid: 0, maxAsk: 0, perSym: new Map(), perMin: new Map(),
    windowMoves: 0, gaps: 0, writeErrors: 0, lastWriteError: "", bytes: 0, partsClosed: 0, partRows: 0, started: now(), parts: [], spotErrors: 0,
    badPos: { top10: 0, p10_19: 0, p20_34: 0, p35_49: 0 }, seq: { ok: 0, repeat: 0, jump: 0, missing: 0, backward: 0 } };
  const lastSeq = new Map();
  const cur = new Map(), closing = [];

  async function loadChain(c) {
    const ch = await fetchOptionChain(lookup, { strikeCount: chainBand, timestamp: c.expiry });
    if (!ch.strikes.length) throw new Error(`No strikes returned for ${c.name} expiry ${c.date}`);
    const sym = new Map();
    for (const s of ch.strikes) { sym.set(`${s.strike_price}|${s.option_type}`, s.symbol); meta.set(s.symbol, { cycle: c.name, strike: s.strike_price, type: s.option_type, expiryIso: c.dateIso }); }
    cycles[c.name] = { ...c, strikes: S.uniqueSortedStrikes(ch.strikes), sym, atmIdx: null };
  }
  function windowSymbols(c) {
    const out = [];
    for (const k of S.windowStrikes(c.strikes, c.atmIdx, width)) for (const t of ["CE", "PE"]) { const s = c.sym.get(`${k}|${t}`); if (s) out.push(s); }
    return out;
  }
  function addChannels(symbols) {   // new symbols always go on NEW channels of <= 5
    for (let i = 0; i < symbols.length; i += 5) {
      if (channels.length >= 50) { ev("channel_limit", "50 channels used; new contracts not subscribed"); return; }
      const ch = { no: channels.length + 1, symbols: symbols.slice(i, i + 5) }; channels.push(ch);
      if (connected) subscribeChannel(ch.symbols, String(ch.no));
    }
  }
  function applySpot(price) {
    if (!Number.isFinite(price) || price <= 0) return;
    spot = price;
    for (const c of Object.values(cycles)) {
      const idx = S.nearestStrikeIndex(c.strikes, price);
      if (idx === c.atmIdx) continue;
      c.atmIdx = idx; st.windowMoves++;
      const fresh = windowSymbols(c).filter((s) => !wanted.includes(s));
      fresh.forEach((s) => wanted.push(s));
      if (fresh.length) addChannels(fresh);
      ev("window", `${c.name} spot ${price} atm ${c.strikes[idx]} new ${fresh.length}`);
    }
  }
  async function init() {
    for (const c of wantedCycles) await loadChain(c);
    applySpot(await restSpot());
    return { symbols: [...wanted], channels: channels.length };
  }
  function onOpen() {
    opens++; connected = true;
    ev("open", `${opens === 1 ? "first connect" : "RECONNECT"}; subscribing ${channels.length} channel(s), ${wanted.length} symbols`);
    for (const ch of channels) subscribeChannel(ch.symbols, String(ch.no));
  }
  function onClose() { connected = false; ev("close"); }
  function onError(e) { ev("error", (e && e.message) || String(e)); }
  function onServerError(m) { ev("server_error", typeof m === "string" ? m : JSON.stringify(m)); }

  function partFor(cycle, ms) {
    let p = cur.get(cycle);
    if (!p) {
      const dir = path.join(stagingRoot, "TGG_Dataset", assetClass, root, "options", cycle, "depth50"); fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, `${date}_depth50_${S.istTime(ms).replace(/:/g, "")}.parquet`);
      if (fs.existsSync(file)) file = file.replace(/\.parquet$/, `_${ms % 100000}.parquet`);
      p = { file, rows: 0, wp: parquet.ParquetWriter.openFile(DEPTH_SCHEMA, file), q: Promise.resolve() }; p.wp.catch(() => {}); cur.set(cycle, p);
    }
    return p;
  }
  function write(p, row) {
    p.rows++;
    p.q = p.q.then(() => p.wp).then((w) => w.appendRow(row)).catch((e) => { st.writeErrors++; st.lastWriteError = e.message; });
  }
  async function closePart(p) {
    try { await p.q; const w = await p.wp; await w.close(); const size = fs.statSync(p.file).size; st.bytes += size; st.partsClosed++; st.partRows += p.rows; st.parts.push({ file: p.file, rows: p.rows, size }); }
    catch (e) { st.writeErrors++; st.lastWriteError = e.message; ev("part_close_failed", `${p.file}: ${e.message}`); }
  }

  function onDepth(symbol, d) {
    const recv = now(); lastFrameMs = recv;
    if (inGap) { inGap = false; ev("gap_end"); }
    const f = frameToRow(d);
    if (!f) { st.malformed++; return; }
    const m = meta.get(symbol);
    if (!m) { st.unknown++; return; }
    st.frames++; if (f.fields.snapshot) st.snapshots++;
    st.perSym.set(symbol, (st.perSym.get(symbol) || 0) + 1);
    const mk = Math.floor(recv / 60000); st.perMin.set(mk, (st.perMin.get(mk) || 0) + 1);
    st.maxBid = Math.max(st.maxBid, f.fields.n_bid); st.maxAsk = Math.max(st.maxAsk, f.fields.n_ask);
    for (const k of ["gapInside", "notMonotonic", "crossed", "empty"]) if (f.quality[k]) st[k]++;
    const fb = f.quality.firstBad; if (fb >= 0) st.badPos[fb < 10 ? "top10" : fb < 20 ? "p10_19" : fb < 35 ? "p20_34" : "p35_49"]++;
    const sq = f.fields.seq_no;   // the feed's own sequence number: is it consecutive per contract?
    if (sq > 0) { const prev = lastSeq.get(symbol); if (prev !== undefined) { const dl = sq - prev; if (dl === 1) st.seq.ok++; else if (dl === 0) st.seq.repeat++; else if (dl < 0) st.seq.backward++; else { st.seq.jump++; st.seq.missing += dl - 1; } } lastSeq.set(symbol, sq); }
    write(partFor(m.cycle, recv), { recv_time_ist: S.istStamp(recv, true), recv_ms: recv, symbol, cycle: m.cycle, expiry_date: m.expiryIso, strike: Number(m.strike), option_type: m.type, ...f.fields });
  }

  /** Call about once a second. */
  async function tick() {
    const ms = now(), key = Math.floor(ms / (partMinutes * 60000));
    if (curKey !== null && key !== curKey) { const old = [...cur.values()]; cur.clear(); old.forEach((p) => closing.push(closePart(p))); }
    curKey = key;
    if (connected && lastFrameMs && !inGap && ms - lastFrameMs > gapSeconds * 1000) { inGap = true; st.gaps++; ev("gap_start", `no depth frame for ${Math.round((ms - lastFrameMs) / 1000)}s`); }
    if (!polling && ms - lastSpotPoll >= spotPollMs) {
      polling = true; lastSpotPoll = ms;
      try { applySpot(await restSpot()); } catch (e) { st.spotErrors++; if (st.spotErrors <= 3) ev("spot_poll_failed", e.message); } finally { polling = false; }
    }
  }

  function summaryText() {
    const pm = [...st.perMin.values()], mins = Math.max(1, (now() - st.started) / 60000);
    const pct = (a) => (st.frames ? `${a} (${((a / st.frames) * 100).toFixed(1)}%)` : "0");
    const top = [...st.perSym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)";
    const mb = st.bytes / 1048576, bpf = st.partRows ? st.bytes / st.partRows : 0;
    return [
      `DEPTH50 CAPTURE SUMMARY  (${S.istStamp(st.started)} -> ${S.istStamp(now())}, ${mins.toFixed(1)} min)`,
      `Root ${root}  ATM window +-${width}  cycles: ${Object.keys(cycles).join(", ")}  contracts subscribed: ${wanted.length} on ${channels.length} channel(s)`,
      "",
      `Frames stored: ${st.frames} (${st.snapshots} snapshots)   rate: avg ${(st.frames / mins).toFixed(0)}/min, max ${Math.max(0, ...pm)}/min   malformed skipped: ${st.malformed}   unknown symbol: ${st.unknown}`,
      `Levels: up to ${st.maxBid} bid and ${st.maxAsk} ask (target 50)`,
      "DATA QUALITY (a frame can fall in more than one group):",
      `  gap inside the book (an empty position before a filled one): ${pct(st.gapInside)}`,
      `  prices not strictly falling (bids) / rising (asks) among filled levels: ${pct(st.notMonotonic)}`,
      `  crossed (best bid >= best ask): ${pct(st.crossed)}`,
      `  completely empty: ${pct(st.empty)}`,
      `  where the first out-of-order level sits (0 = best price): top 10 levels ${st.badPos.top10}, levels 10-19 ${st.badPos.p10_19}, levels 20-34 ${st.badPos.p20_34}, levels 35-49 ${st.badPos.p35_49}`,
      `SEQUENCE NUMBERS per contract: consecutive ${st.seq.ok}, repeated ${st.seq.repeat}, jumps ${st.seq.jump} (about ${st.seq.missing} updates missing), backward ${st.seq.backward}   (if the numbers are shared across contracts, jumps are expected)`,
      "FILES:",
      `  parts closed: ${st.partsClosed}   rows in them: ${st.partRows}   size: ${mb.toFixed(1)} MB   ${bpf.toFixed(0)} bytes/frame   ~${(mb / mins * 60).toFixed(0)} MB/hour (GZIP compression)`,
      `  write errors: ${st.writeErrors}${st.lastWriteError ? "  last: " + st.lastWriteError : ""}`,
      `CONNECTION: opens ${opens}, silent gaps >${gapSeconds}s: ${st.gaps}, ATM window moves: ${st.windowMoves}, spot poll failures: ${st.spotErrors}`,
      "Most active contracts (frames):", top,
    ].join("\n");
  }
  async function finish() {
    const old = [...cur.values()]; cur.clear(); old.forEach((p) => closing.push(closePart(p)));
    await Promise.all(closing);
    const text = summaryText(); fs.writeFileSync(path.join(outDir, "depth_summary.txt"), text + "\n", "utf8");
    await evW.close(); return text;
  }
  return { init, onOpen, onClose, onError, onServerError, onDepth, tick, finish, _x: { st, cycles, wanted, channels, cur } };
}

module.exports = { createDepthCapture, frameToRow, DEPTH_SCHEMA, LEVELS };