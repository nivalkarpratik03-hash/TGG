/**
 * backend/src/parrva/tickStore.js  (NEW 2026-11-05)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1-second price bars per option symbol, built from the recorder's raw tick files
 * (recordings/<date>/symbols/<SYMBOL>/quotes.jsonl; older layout: recordings/<date>/quotes.jsonl). The status engine uses these to judge entry / target / SL to the
 * tick, the same way the Telegram bot does. Minute candles are only the fallback.
 *
 * The tick files are read incrementally (only the new bytes, at most CHUNK per read), so a long file never
 * blocks the backend. Progress is saved to secbars/<date>.json (bars + file offsets) every few minutes, so a
 * restart picks up where it left off instead of re-reading the whole day.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const U = require("./util");

const CHUNK = 16 * 1024 * 1024;          // bytes per read
const isOption = (sym) => /(CE|PE)$/.test(String(sym || ""));

class TickStore {
  constructor(day) {
    this.day = day;
    this.dir = path.join(U.dataRoot(), "recordings", day);
    this.saveFile = path.join(U.dataRoot(), "secbars", `${day}.json`);
    this.bars = new Map();               // symbol -> [{t, o, h, l, c, d: 1}] sorted by t
    this.offsets = {};                   // tick file (relative to the day folder) -> bytes read
    this.lastRead = 0;
    this.dirty = false;
    this.load();
  }

  load() {
    const data = U.readJson(this.saveFile, null);
    if (!data || !data.bars) return;
    this.offsets = data.offsets && typeof data.offsets === "object" ? data.offsets : {};
    for (const [sym, list] of Object.entries(data.bars)) {
      this.bars.set(sym, (list || []).map((a) => ({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], d: 1 })));
    }
  }

  save() {
    if (!this.dirty) return;
    const bars = {};
    for (const [sym, list] of this.bars) bars[sym] = list.map((b) => [b.t, b.o, b.h, b.l, b.c]);
    U.writeJson(this.saveFile, { day: this.day, offsets: this.offsets, savedAt: new Date().toISOString(), bars });
    this.dirty = false;
  }

  add(sym, sec, px) {
    let list = this.bars.get(sym);
    if (!list) { list = []; this.bars.set(sym, list); }
    const last = list[list.length - 1];
    if (!last || sec > last.t) { list.push({ t: sec, o: px, h: px, l: px, c: px, d: 1 }); return; }
    // Same second (or a tick that arrived slightly out of order): update that bar if it is recent.
    for (let i = list.length - 1; i >= 0 && i >= list.length - 5; i--) {
      const b = list[i];
      if (b.t === sec) { b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); if (i === list.length - 1) b.c = px; return; }
      if (b.t < sec) { list.splice(i + 1, 0, { t: sec, o: px, h: px, l: px, c: px, d: 1 }); return; }
    }
  }

  /** Option tick files of the day (only options are needed for the trade status). */
  files() {
    const out = [];
    const symDir = path.join(this.dir, "symbols");
    let names = [];
    try { names = fs.readdirSync(symDir); } catch { /* not recording yet */ }
    for (const d of names) if (/(CE|PE)$/.test(d)) out.push(path.join("symbols", d, "quotes.jsonl"));
    if (fs.existsSync(path.join(this.dir, "quotes.jsonl"))) out.push("quotes.jsonl");    // older layout (one file)
    return out;
  }

  /** Read new ticks. Throttled to once per `minGapMs`. `all` = keep reading until the end of every file. */
  refresh({ minGapMs = 2000, all = false } = {}) {
    if (Date.now() - this.lastRead < minGapMs) return;
    this.lastRead = Date.now();
    let budget = CHUNK;
    for (const rel of this.files()) {
      if (!all && budget <= 0) break;
      budget -= this.readFile(rel, all ? Infinity : budget);
    }
  }

  readFile(rel, maxBytes) {
    let fd, used = 0;
    try { fd = fs.openSync(path.join(this.dir, rel), "r"); } catch { return 0; }
    try {
      const size = fs.fstatSync(fd).size;
      let off = this.offsets[rel] || 0;
      if (size < off) off = 0;                                              // file was replaced
      while (used < maxBytes) {
        const len = Math.min(CHUNK, size - off, maxBytes - used);
        if (len <= 0) break;
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, off);
        const end = buf.lastIndexOf(10, got - 1);                            // last complete line
        if (end < 0) break;
        const text = buf.toString("utf8", 0, end);
        off += end + 1; used += end + 1;
        for (const line of text.split("\n")) {
          if (!line || line.indexOf('"ltp"') < 0) continue;
          let r; try { r = JSON.parse(line); } catch { continue; }
          const px = Number(r.ltp), ms = Number(r.recv_ms);
          if (!isOption(r.symbol) || !(px > 0) || !Number.isFinite(ms)) continue;
          this.add(r.symbol, Math.floor(ms / 1000), px);
        }
        this.dirty = true;
      }
      this.offsets[rel] = off;
    } catch (e) {
      console.warn(`[PaRRVA] tick file ${this.day}/${rel}: ${e.message}`);
    } finally {
      fs.closeSync(fd);
    }
    return used;
  }

  barsOf(sym) { return (sym && this.bars.get(sym)) || null; }
  has(sym) { const b = this.barsOf(sym); return !!(b && b.length); }
}

/** Store for an earlier day, fully read, small cache (results files normally make this unnecessary). */
const pastCache = new Map();
function pastStore(day) {
  const hit = pastCache.get(day);
  if (hit) return hit;
  const st = new TickStore(day);
  st.refresh({ minGapMs: 0, all: true });
  st.save();
  pastCache.set(day, st);
  if (pastCache.size > 2) pastCache.delete(pastCache.keys().next().value);
  return st;
}

module.exports = { TickStore, pastStore };
