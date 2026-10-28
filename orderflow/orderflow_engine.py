"""
PINAKA · ORDER FLOW ENGINE  v2  (Python twin of Spec OF-1, draft 2, Sun 04-Oct-2026)

What changed from v1, in one line each (full list in Spec §18):
  - A quote callback is no longer treated as a trade. Executions are inferred from the cumulative
    volume field (vol_traded_today); every candle carries a QUALITY flag saying how much of its
    volume was VERIFIED (one execution = one LTQ) vs PROXY (an interval of volume whose composition
    is unknown) vs UNKNOWN.
  - The aggressor is judged against the last valid quote seen BEFORE the trade, with an age limit;
    inside-the-spread trades use the tick test (previous different price); otherwise UNKNOWN.
  - One ordered event reducer. A candle is FINALIZED exactly once, at the first event past its end
    (or at end of file), and every feature of that candle is computed from history ending there and
    stored. Appending later events never changes a stored candle.
  - The book is keyed by exact price with a coverage window; replenishment and withdrawal are
    counted per episode on covered prices only, after the trade interval has been applied.
  - Every detector takes a DIRECTION (ceiling test or floor test) and the tested LEVEL.
  - The study harness writes one row per finalized candle with a quality status.

Blocks:  0 CONFIG · 1 LOGGER · 2 TRADE IDENTITY · 3 AGGRESSOR · 4 CANDLES · 5 BOOK · 6 DETECTORS
         7 BREAK EPISODES · 8 CLOCK · 9 WITNESS · 10 ENGINE (reducer) · 11 CHART · 12 CLI / STUDY
"""
from __future__ import annotations
import json, math, csv, datetime as dt, statistics
from collections import deque, defaultdict
from dataclasses import dataclass, field

# =====================================================================================
# 0. CONFIGURATION  — every number in Spec §13, with its owner
# =====================================================================================
CONFIG = {
    # feeds / instruments
    "DEPTH_LEVELS_LOG":    50,     # Tushar : 50 = TBT feed, 5 = normal feed
    "DEPTH_LEVELS_HEAT":   10,     # Claude : rows drawn each side in the heat view
    "PRICE_TICK":          0.10,   # NSE    : index futures tick in the 15 000–30 000 slab (FAOP 67135); options differ
    # candles / rows
    "CANDLE_SEC":          60,     # Tushar
    "ROW_SIZE":            5.0,    # Claude : one price row = 5 points
    "CONTACT_ROWS":        2,      # Claude : a candle is "at the level" if its range comes within 2 rows of it
    # quotes / aggressor
    "QUOTE_MAX_AGE_SEC":   2.0,    # Claude : a pre-trade quote older than this → UNKNOWN
    "LATE_EVENT_SEC":      1.0,    # Claude : an event older than the last processed by more than this is DROPPED (flagged)
    # references / readiness
    "AVG_DELTA_WINDOW":    20,     # Claude : candles in avg |Delta|
    "DOT_REF_WINDOW":      20,     # Claude : candles in the dot reference
    "MIN_HISTORY":         5,      # Claude : every feature reports INSUFFICIENT_HISTORY below this many finalized candles
    "MIN_VERIFIED_FRAC":   0.6,    # Claude : a candle with less verified volume than this is flagged LOW_QUALITY (features still computed)
    # dots
    "DOT_FLOOR": 0.3, "DOT_MED": 1.0, "DOT_LARGE": 2.0,   # Claude
    # signatures
    "ABS_DELTA_X": 1.5, "ABS_PROGRESS_ROWS": 1,           # Claude : signed Delta toward the level ≥ 1.5×ref, progress ≤ 1 row, in contact
    "EXH_CANDLES": 2, "EXH_SHRINK": 0.5,                  # Claude : each smaller than the one before, last ≤ 50 % of first, same price, in contact
    "IMP_DELTA_X": 3.0, "IMP_PROGRESS_ROWS": 2,           # Claude : signed Delta ≥ 3×ref AND signed progress ≥ 2 rows (same direction)
    "STK_RATIO": 3.0, "STK_ROWS": 3, "STK_MIN_VOL": 1,    # Claude : adjacent rows (exactly ROW_SIZE apart), one side ≥ 3× other, row volume ≥ min
    "DIV_LOOKBACK": 5,                                    # Claude
    "SPEED_X": 2.0,                                       # Claude : verified executions/sec ≥ 2× its 10-candle reference; UNKNOWN if tape not verified
    # book
    "BOOK_WINDOW_SEC":     600,    # Claude : 10-minute baseline, 1 Hz fixed-cadence samples, current sample excluded
    "BOOK_MIN_COVERAGE":   0.5,    # Claude : baseline needs ≥ 50 % of its samples present
    "NEAR_LEVEL_ROWS":     4,      # Claude : pulling/stacking are measured on the covered prices within 4 rows of the tested level
    "PULL_DROP": 0.5, "STACK_RISE": 1.5,                  # Claude
    "WALL_X": 3.0, "WALL_PERSIST_SEC": 20, "WALL_MAX_ROWS": 3,   # Claude : ≥ 3× side median, seen ≥ 20 s, within 3 rows of the level
    "REPLENISH_RATIO": 0.8, "REPLENISH_COUNT": 5,         # Claude : REPLENISHMENT EVIDENCE (was "ICE"): eaten ≥ 80 % then back ≥ 80 %, 5 episodes
    "WITHDRAW_TRADED_MAX": 0.2, "WITHDRAW_COUNT": 3,      # Claude : WITHDRAWAL (was "HOLLOW"): big covered level gone with < 20 % traded, 3 episodes
    "BIG_LEVEL_X":         2.0,    # Claude : a level is "big" if ≥ 2× its side median
    # clock
    "ABS_CLOCK_GREEN_MIN": 3, "ABS_CLOCK_RED_MIN": 12,    # OPEN   : set from the validation
    "CLOCK_MAX_IDLE_MIN":  5,      # Claude : clock invalidates after 5 min out of contact with the level
    # breaks
    "BREAK_NEEDS_BODY_CLOSE": True,                       # Tushar
    # witness
    "WITNESS_MAX_AGE_SEC": 90,     # Claude : a CE/PE verdict older than this is STALE
}

# =====================================================================================
# 1. LOGGER — records RAW callbacks with their type. Computes nothing.
# =====================================================================================
class TickLogger:
    """One JSON line per callback. 'Q' = quote/symbol update (whatever fields the SDK gave),
       'D' = depth update. The schema version is written on the first line of every file."""
    SCHEMA = 2
    def __init__(self, folder: str):
        self.folder, self.files = folder, {}
    def _file(self, symbol):
        day = dt.date.today().strftime("%Y-%m-%d"); key = f"{symbol}_{day}"
        if key not in self.files:
            f = open(f"{self.folder}/{symbol.replace(':','_')}_{day}.jsonl", "a")
            f.write(json.dumps({"t": "H", "schema": self.SCHEMA, "symbol": symbol, "depth_levels": CONFIG["DEPTH_LEVELS_LOG"]}) + "\n")
            self.files[key] = f
        return self.files[key]
    def on_quote(self, symbol, ts, ltp, ltq, vol_cum, bid, ask, raw=None):
        # vol_cum = vol_traded_today from the SDK. It is what tells an execution from a quote refresh.
        self._file(symbol).write(json.dumps({"t": "Q", "ts": ts, "p": ltp, "q": ltq, "v": vol_cum, "b": bid, "a": ask}) + "\n")
    def on_depth(self, symbol, ts, bids, asks, snapshot=False):
        self._file(symbol).write(json.dumps({"t": "D", "ts": ts, "bids": bids, "asks": asks, "snap": snapshot}) + "\n")
    def flush(self):
        for f in self.files.values(): f.flush()
# Wiring (Spec §3.2–3.3):  SymbolUpdate → on_quote(sym, ts, ltp, last_traded_qty, vol_traded_today, bid_price, ask_price)
#                          DepthUpdate / TBT depth → on_depth(sym, ts, [[p,q],...], [[p,q],...], snapshot)

# =====================================================================================
# 2. TRADE IDENTITY — which quote callbacks carry an execution?
# =====================================================================================
class TradeIdentity:
    """Rule: an execution interval exists only when cumulative volume increased.
       dv == ltq  → one VERIFIED execution of ltq at ltp.
       dv  > 0 and dv != ltq → a PROXY interval: dv volume traded, composition unknown, booked at ltp.
       dv == 0   → quote-only refresh, no trade.
       dv  < 0 or first message → RESET/START: no trade, quality event logged."""
    def __init__(self): self.last_v = None
    def classify(self, ltq, vol_cum):
        if self.last_v is None or vol_cum is None:
            self.last_v = vol_cum; return "START", 0
        dv = vol_cum - self.last_v; self.last_v = vol_cum
        if dv < 0: return "RESET", 0
        if dv == 0: return "QUOTE_ONLY", 0
        if ltq and dv == ltq: return "VERIFIED", dv
        return "PROXY", dv

# =====================================================================================
# 3. AGGRESSOR — judged on the last valid quote seen BEFORE the trade
# =====================================================================================
class Aggressor:
    """Returns +1 (buyer aggressive), -1 (seller aggressive) or 0 (UNKNOWN).
       Name of the method, exactly: 'pre-trade quote comparison with tick-test fallback'."""
    def __init__(self):
        self.q_bid = self.q_ask = None; self.q_ts = None; self.last_px = None; self.last_diff_side = 0
    def quote(self, ts, bid, ask):
        if bid and ask and ask > bid:            # reject zero, locked or crossed quotes
            self.q_bid, self.q_ask, self.q_ts = bid, ask, ts
    def side(self, ts, price):
        side = 0
        if self.q_ts is not None and ts - self.q_ts <= CONFIG["QUOTE_MAX_AGE_SEC"]:
            if price >= self.q_ask: side = +1
            elif price <= self.q_bid: side = -1
        if side == 0 and self.last_px is not None:          # tick test: compare with the previous DIFFERENT price
            if price > self.last_px: side = +1
            elif price < self.last_px: side = -1
            else: side = self.last_diff_side                 # same price → same side as the last price change; 0 if none
        if self.last_px is None or price != self.last_px:
            if self.last_px is not None: self.last_diff_side = +1 if price > self.last_px else -1
            self.last_px = price
        return side

# =====================================================================================
# 4. CANDLES — built from identified executions, finalized exactly once
# =====================================================================================
def row_of(p): s = CONFIG["ROW_SIZE"]; return math.floor(p / s + 1e-9) * s

@dataclass
class Candle:
    start: int; open: float; high: float; low: float; close: float
    buy: int = 0; sell: int = 0; unknown: int = 0
    verified_vol: int = 0; proxy_vol: int = 0; executions: int = 0
    row_buy: dict = field(default_factory=lambda: defaultdict(int))
    row_sell: dict = field(default_factory=lambda: defaultdict(int))
    row_unknown: dict = field(default_factory=lambda: defaultdict(int))
    quality_events: list = field(default_factory=list)      # RESET / START / DROPPED / GAP notes
    final: dict | None = None                                # frozen features once finalized
    @property
    def delta(self): return self.buy - self.sell
    @property
    def volume(self): return self.buy + self.sell + self.unknown
    @property
    def verified_frac(self): v = self.volume; return (self.verified_vol / v) if v else 0.0
    def rows(self): return sorted(set(self.row_buy) | set(self.row_sell) | set(self.row_unknown))
    def row_net(self): return {r: self.row_buy[r] - self.row_sell[r] for r in self.rows()}

# =====================================================================================
# 5. BOOK — price-keyed, coverage-aware, time-windowed baseline, per-episode counts
# =====================================================================================
class Book:
    """State per side: {price: qty} from the latest depth, plus the covered price range of that
       depth (min, max price shown). A price inside the range with no entry is a COVERED ZERO; a
       price outside it is UNOBSERVED. Baseline samples are taken at 1 Hz (fixed cadence); the
       current second is excluded from the baseline."""
    def __init__(self):
        self.ts = None; self.bid = {}; self.ask = {}; self.cov = {"bid": (None, None), "ask": (None, None)}
        self.samples = deque()                 # (sec, near_bid_qty, near_ask_qty) — filled by sample()
        self.first_seen = {}                   # (side, price) → ts the current wall-candidate first appeared
        self.ep = {}                           # (side, price) → episode dict for replenish / withdraw
        self.replenish = defaultdict(int); self.withdraw = defaultdict(int)
        self.gap = False
    # --- helpers ---
    def side_dict(self, side): return self.bid if side == "bid" else self.ask
    def median(self, side):
        q = sorted(self.side_dict(side).values()); return q[len(q)//2] if q else 0
    def covered(self, side, price):
        lo, hi = self.cov[side]; return lo is not None and lo <= price <= hi
    def qty(self, side, price): return self.side_dict(side).get(price, 0)
    def wall_candidate(self, side, level):
        """The largest level within the near-level zone if ≥ WALL_X × side median — no persistence test.
           Excluded from near_qty in BOTH the current value and every baseline sample (one definition)."""
        if level is None: return None
        R = CONFIG["ROW_SIZE"] * CONFIG["NEAR_LEVEL_ROWS"]
        zone = [(p, q) for p, q in self.side_dict(side).items() if abs(p - level) <= R]
        if not zone: return None
        p, q = max(zone, key=lambda x: x[1]); med = self.median(side) or 1
        return p if q >= CONFIG["WALL_X"] * med else None
    def near_qty(self, side, level, exclude_wall=True):
        """Sum of qty on covered prices within NEAR_LEVEL_ROWS of the level.
           exclude_wall=True (PULLING: the levels around the wall) / False (STACKING: everything, a growing wall counts).
           Returns None when the zone is outside the covered price range (unobserved)."""
        if level is None: return None
        R = CONFIG["ROW_SIZE"] * CONFIG["NEAR_LEVEL_ROWS"]
        lo, hi = self.cov[side]
        if lo is None or hi < level - R or lo > level + R: return None
        wc = self.wall_candidate(side, level) if exclude_wall else None
        return sum(q for p, q in self.side_dict(side).items() if abs(p - level) <= R and p != wc)
    def wall(self, side, level):
        """Largest level on the side if ≥ WALL_X × side median, seen ≥ WALL_PERSIST_SEC, within WALL_MAX_ROWS of the level."""
        d = self.side_dict(side)
        if len(d) < 3 or level is None: return None
        p, q = max(d.items(), key=lambda x: x[1]); med = self.median(side) or 1
        ok = q >= CONFIG["WALL_X"] * med and abs(p - level) <= CONFIG["WALL_MAX_ROWS"] * CONFIG["ROW_SIZE"]
        seen = self.first_seen.get((side, p)); persisted = seen is not None and self.ts is not None and self.ts - seen >= CONFIG["WALL_PERSIST_SEC"]
        return (p, q) if ok and persisted else None
    # --- update ---
    def update(self, ts, bids, asks, traded, snapshot=False):
        """traded = {price: qty executed since the previous depth update} — applied BEFORE reconciling."""
        if self.ts is not None and ts - self.ts > 5: self.gap = True
        new = {"bid": {p: q for p, q in bids if q > 0}, "ask": {p: q for p, q in asks if q > 0}}
        cov = {s: ((min(d), max(d)) if d else (None, None)) for s, d in new.items()}
        for side in ("bid", "ask"):
            old = self.side_dict(side); med_new = statistics.median(new[side].values()) if new[side] else 0
            # wall persistence bookkeeping
            for p in new[side]:
                self.first_seen.setdefault((side, p), ts)
            for key in [k for k in self.first_seen if k[0] == side and k[1] not in new[side]]:
                del self.first_seen[key]
            # episodes on big levels, covered prices only
            for p, q in old.items():
                k = (side, p); e = self.ep.get(k)
                if e is None: continue
                e["traded"] += traded.get(p, 0)
                now_q = new[side].get(p, 0); was_covered = self.covered(side, p); now_covered = (cov[side][0] is not None and cov[side][0] <= p <= cov[side][1])
                if not (was_covered and now_covered) or self.gap:
                    e["state"] = "UNOBSERVED"; continue             # cannot attribute → episode ends unknown
                if e["state"] == "BIG" and now_q <= (1 - CONFIG["REPLENISH_RATIO"]) * e["size"]:
                    if e["traded"] >= CONFIG["REPLENISH_RATIO"] * e["size"]: e["state"] = "DEPLETED"
                    elif e["traded"] <= CONFIG["WITHDRAW_TRADED_MAX"] * e["size"]:
                        e["state"] = "WITHDRAWN"; self.withdraw[k] += 1
                    else: e["state"] = "MIXED"
                elif e["state"] == "DEPLETED" and now_q >= CONFIG["REPLENISH_RATIO"] * e["size"]:
                    self.replenish[k] += 1; e.update(state="BIG", traded=0, size=now_q)   # new episode at the same price
            for p, q in new[side].items():
                k = (side, p)
                if k not in self.ep or self.ep[k]["state"] in ("UNOBSERVED", "WITHDRAWN", "MIXED"):
                    if med_new and q >= CONFIG["BIG_LEVEL_X"] * med_new:
                        self.ep[k] = {"state": "BIG", "size": q, "traded": 0}
                    elif k in self.ep: del self.ep[k]
            for k in [k for k in self.ep if k[0] == side and k[1] not in new[side] and self.ep[k]["state"] in ("DEPLETED", "BIG")]:
                e = self.ep[k]
                if self.covered(side, k[1]) and e["state"] == "BIG" and e["traded"] <= CONFIG["WITHDRAW_TRADED_MAX"] * e["size"]:
                    self.withdraw[k] += 1
                del self.ep[k]
        self.bid, self.ask, self.cov, self.ts, self.gap = new["bid"], new["ask"], cov, ts, False
    def sample(self, sec, level):
        """Fixed-cadence 1 Hz sample of the near-level quantities. Called by the engine once per second."""
        self.samples.append((sec, {"bid": (self.near_qty("bid", level, True), self.near_qty("bid", level, False)),
                                   "ask": (self.near_qty("ask", level, True), self.near_qty("ask", level, False))}))
        while self.samples and sec - self.samples[0][0] > CONFIG["BOOK_WINDOW_SEC"]: self.samples.popleft()
    def baseline(self, side, sec, exclude_wall=True):
        """Mean of the samples older than the current second over the window; None if coverage is short.
           The same exclude_wall choice is applied to the baseline as to the current value."""
        i = 0 if exclude_wall else 1
        xs = [d[side][i] for (s, d) in self.samples if s < sec and d[side][i] is not None]
        need = CONFIG["BOOK_MIN_COVERAGE"] * CONFIG["BOOK_WINDOW_SEC"]
        return (sum(xs) / len(xs)) if len(xs) >= need else None
    def pulling(self, direction, level, sec):
        """Ceiling test: asks near the level thin. Floor test: bids near the level thin. Returns True/False/None(no baseline)."""
        side = "ask" if direction == "ceiling" else "bid"; base = self.baseline(side, sec, exclude_wall=True)
        if base is None: return None
        cur = self.near_qty(side, level, exclude_wall=True)
        if cur is None: return None
        return cur <= CONFIG["PULL_DROP"] * base
    def stacking(self, direction, level, sec):
        """Ceiling test: bids under price build. Floor test: asks over price build."""
        side = "bid" if direction == "ceiling" else "ask"; base = self.baseline(side, sec, exclude_wall=False)
        cur = self.near_qty(side, level, exclude_wall=False)
        if base is None or cur is None: return None
        return cur >= CONFIG["STACK_RISE"] * base
    def replenishment_rows(self): return [k for k, n in self.replenish.items() if n >= CONFIG["REPLENISH_COUNT"]]
    def withdrawal_rows(self):   return [k for k, n in self.withdraw.items() if n >= CONFIG["WITHDRAW_COUNT"]]

# =====================================================================================
# 6. DETECTORS — every one takes the finalized history, the DIRECTION and the LEVEL
#    direction = "ceiling" (buyers attacking a ceiling) or "floor" (sellers attacking a floor)
#    sgn = +1 for ceiling, −1 for floor; "toward the level" means sgn × Delta > 0
# =====================================================================================
INSUFFICIENT = "INSUFFICIENT_HISTORY"
def sgn_of(direction): return +1 if direction == "ceiling" else -1
def rows_signed(c, direction): return sgn_of(direction) * (c.close - c.open) / CONFIG["ROW_SIZE"]
def in_contact(c, level):
    if level is None: return False
    band = CONFIG["CONTACT_ROWS"] * CONFIG["ROW_SIZE"]
    return (c.low - band) <= level <= (c.high + band)
def ref_delta(hist):
    xs = [abs(c.delta) for c in hist[-CONFIG["AVG_DELTA_WINDOW"]-1:-1]]
    return max(sum(xs) / len(xs), 1) if xs else None
def ready(hist, n=None): return len(hist) >= (n or CONFIG["MIN_HISTORY"])

def det_ABS(hist, direction, level):
    if not ready(hist) or level is None: return INSUFFICIENT, 0
    c = hist[-1]; ref = ref_delta(hist); s = sgn_of(direction)
    toward = s * c.delta
    fired = in_contact(c, level) and toward >= CONFIG["ABS_DELTA_X"] * ref and abs(rows_signed(c, direction)) <= CONFIG["ABS_PROGRESS_ROWS"]
    return fired, toward / ref

def det_EXH(hist, direction, level):
    n = CONFIG["EXH_CANDLES"] + 1
    if not ready(hist, max(n, CONFIG["MIN_HISTORY"])) or level is None: return INSUFFICIENT, 0
    cs = hist[-n:]; s = sgn_of(direction)
    same_price = all(abs(x.close - cs[0].close) <= CONFIG["ROW_SIZE"] for x in cs)
    toward = [s * x.delta for x in cs]
    fired = same_price and all(t > 0 for t in toward) and all(toward[i] < toward[i-1] for i in range(1, n)) \
            and toward[-1] <= CONFIG["EXH_SHRINK"] * toward[0] and in_contact(cs[-1], level)
    return fired, toward[-1] / max(toward[0], 1)

def det_IMP(hist, direction):
    if not ready(hist): return INSUFFICIENT, 0
    c = hist[-1]; ref = ref_delta(hist); s = sgn_of(direction)
    fired = s * c.delta >= CONFIG["IMP_DELTA_X"] * ref and rows_signed(c, direction) >= CONFIG["IMP_PROGRESS_ROWS"]
    return fired, s * c.delta / ref

def det_DISAGREE(hist):
    """Delta sign and body direction disagree, both material. Kept as its own observation."""
    if not ready(hist): return INSUFFICIENT, 0
    c = hist[-1]; ref = ref_delta(hist)
    body = (c.close - c.open) / CONFIG["ROW_SIZE"]
    fired = abs(c.delta) >= ref and abs(body) >= 1 and (c.delta > 0) != (body > 0)
    return fired, c.delta / ref

def det_STK(c):
    """Adjacent rows (exactly ROW_SIZE apart), each with volume ≥ STK_MIN_VOL and one side ≥ STK_RATIO × the other
       (a zero opposing side counts as imbalance when the winning side ≥ STK_MIN_VOL). Returns (fired, (side, run, rows))."""
    rows = c.rows(); best = (0, 0, []); run = 0; d_prev = 0; prev_r = None; run_rows = []
    for r in rows:
        b, s = c.row_buy[r], c.row_sell[r]
        if b + s < CONFIG["STK_MIN_VOL"]: d = 0
        elif b >= CONFIG["STK_RATIO"] * s: d = +1
        elif s >= CONFIG["STK_RATIO"] * b: d = -1
        else: d = 0
        adjacent = prev_r is not None and abs(r - prev_r - CONFIG["ROW_SIZE"]) < 1e-9
        if d != 0 and d == d_prev and adjacent: run += 1; run_rows.append(r)
        elif d != 0: run = 1; run_rows = [r]
        else: run = 0; run_rows = []
        if run > best[0]: best = (run, d, list(run_rows))
        d_prev = d if d != 0 else 0; prev_r = r
    return best[0] >= CONFIG["STK_ROWS"], best

def det_DIV(hist, cvd):
    n = CONFIG["DIV_LOOKBACK"]
    if len(hist) < 2 * n or len(cvd) < 2 * n: return INSUFFICIENT, 0
    now, before = hist[-n:], hist[-2*n:-n]; cn, cb = cvd[-n:], cvd[-2*n:-n]; R = CONFIG["ROW_SIZE"]
    bear = max(c.high for c in now) >= max(c.high for c in before) + R and max(cn) < max(cb)
    bull = min(c.low for c in now) <= min(c.low for c in before) - R and min(cn) > min(cb)
    return bear or bull, (-1 if bear else (+1 if bull else 0))

def det_SPEED(hist):
    """Verified executions per second vs the 10-candle reference. UNKNOWN when the tape is not verified."""
    if not ready(hist, 11): return INSUFFICIENT, 0
    if any(c.verified_frac < CONFIG["MIN_VERIFIED_FRAC"] for c in hist[-11:]): return "UNKNOWN", 0
    avg = sum(c.executions for c in hist[-11:-1]) / 10 or 1e-9
    return hist[-1].executions >= CONFIG["SPEED_X"] * avg, hist[-1].executions / avg

def dots(hist):
    """GROSS dots (draft 2): green = row with the most BUY volume, red = row with the most SELL volume.
       Reference = mean over the previous DOT_REF_WINDOW candles of each candle's largest gross row volume.
       Computed only from history ending at this candle; stored at finalize."""
    if not ready(hist): return None
    c = hist[-1]; xs = []
    for h in hist[-CONFIG["DOT_REF_WINDOW"]-1:-1]:
        m = max(list(h.row_buy.values()) + list(h.row_sell.values()) + [0]);
        if m: xs.append(m)
    ref = (sum(xs) / len(xs)) if xs else None
    if not ref: return None
    def size(v):
        r = v / ref
        return None if r < CONFIG["DOT_FLOOR"] else ("S" if r < CONFIG["DOT_MED"] else ("M" if r < CONFIG["DOT_LARGE"] else "L"))
    g = max(c.row_buy.items(), key=lambda x: x[1], default=(None, 0)); r = max(c.row_sell.items(), key=lambda x: x[1], default=(None, 0))
    return {"green_row": g[0], "green": size(g[1]) if g[0] is not None else None,
            "red_row": r[0], "red": size(r[1]) if r[0] is not None else None, "ref": ref}

# =====================================================================================
# 7. BREAK EPISODES — transition table (Spec §2.5, draft 2)
#    INSIDE --poke beyond--> START --close beyond (body colour)--> CONFIRMED --close inside--> INSIDE
#    START --close inside (no ✓)--> INSIDE (re-armed, a new poke prints START again)
# =====================================================================================
class BreakEpisodes:
    def __init__(self): self.state = {"ceiling": "INSIDE", "floor": "INSIDE"}
    def update(self, c, ceiling, floor):
        out = []
        for direction, level in (("ceiling", ceiling), ("floor", floor)):
            if level is None: continue
            st = self.state[direction]
            beyond_poke = c.high > level if direction == "ceiling" else c.low < level
            beyond_close = (c.close > level and c.close > c.open) if direction == "ceiling" else (c.close < level and c.close < c.open)
            inside_close = c.close <= level if direction == "ceiling" else c.close >= level
            tag = "C" if direction == "ceiling" else "F"
            if st == "INSIDE" and beyond_poke:
                st = "START"; out.append(f"{tag} BREAK START")
            if st in ("START",) and beyond_close:
                st = "CONFIRMED"; out.append(f"{tag} BREAK ✓")
            elif st == "START" and inside_close:
                st = "INSIDE"                                  # failed START re-arms
            elif st == "CONFIRMED" and inside_close:
                st = "INSIDE"
            self.state[direction] = st
        return out
    def text(self):
        c, f = self.state["ceiling"], self.state["floor"]
        if c == "CONFIRMED": return "ABOVE CEILING"
        if f == "CONFIRMED": return "BELOW FLOOR"
        if c == "START": return "C BREAK START seen, no ✓"
        if f == "START": return "F BREAK START seen, no ✓"
        return "inside band"

# =====================================================================================
# 8. CLOCK — one per level test; invalidates on idle, resets on ✓ or level change
# =====================================================================================
class AbsorptionClock:
    def __init__(self): self.start = None; self.level = None; self.last_contact = None
    def update(self, c, abs_fired, level, confirmed):
        if level != self.level: self.start = None; self.level = level
        if confirmed: self.start = None; return
        if in_contact(c, level): self.last_contact = c.start
        if self.start is not None and self.last_contact is not None and (c.start - self.last_contact) / 60 > CONFIG["CLOCK_MAX_IDLE_MIN"]:
            self.start = None                                  # idle too long → invalid
        if abs_fired is True and self.start is None: self.start = c.start
    def minutes(self, ts): return 0 if self.start is None else (ts - self.start) / 60
    def zone(self, ts):
        if self.start is None: return "OFF"
        m = self.minutes(ts)
        return "EARLY" if m < CONFIG["ABS_CLOCK_GREEN_MIN"] else ("GREEN" if m < CONFIG["ABS_CLOCK_RED_MIN"] else "RED")

# =====================================================================================
# 9. WITNESS — one verdict per option book, then the nine-cell truth table (Spec §11)
# =====================================================================================
def witness(hist, direction="ceiling"):
    """UP = Delta ≥ +1×ref with signed progress ≥ 0 (not falling); DOWN = Delta ≤ −1×ref with progress ≤ 0; else QUIET.
       Experimental: the sign of an option's Delta does not reveal opening/closing/hedging."""
    if not ready(hist): return INSUFFICIENT
    c = hist[-1]; ref = ref_delta(hist); body = (c.close - c.open)
    if c.delta >= ref and body >= 0: return "UP"
    if c.delta <= -ref and body <= 0: return "DOWN"
    return "QUIET"
WITNESS_TABLE = {
    ("UP", "DOWN"): "UP CONFIRMED", ("UP", "UP"): "BOTH BOUGHT — NO TRADE", ("UP", "QUIET"): "CE UP ALONE — WAIT",
    ("DOWN", "DOWN"): "BOTH SOLD — NO TRADE", ("DOWN", "UP"): "DOWN CONFIRMED", ("DOWN", "QUIET"): "CE DOWN ALONE — WAIT",
    ("QUIET", "DOWN"): "PE DOWN ALONE — WAIT", ("QUIET", "UP"): "PE UP ALONE — WAIT", ("QUIET", "QUIET"): "NO WITNESS",
}
def two_witness(ce, pe, ce_age=0, pe_age=0):
    if ce == INSUFFICIENT or pe == INSUFFICIENT: return "WITNESS NOT READY"
    if ce_age > CONFIG["WITNESS_MAX_AGE_SEC"] or pe_age > CONFIG["WITNESS_MAX_AGE_SEC"]: return "WITNESS STALE"
    return WITNESS_TABLE[(ce, pe)]

# =====================================================================================
# 10. ENGINE — the ordered event reducer. Live and replay use this same class.
# =====================================================================================
class Engine:
    def __init__(self, levels, direction_rule="auto"):
        """levels: list of {"from": ts, "ceiling": x|None, "floor": y|None} — versioned, effective from 'from'."""
        self.levels = sorted(levels, key=lambda L: L["from"]); self.ident = TradeIdentity(); self.aggr = Aggressor()
        self.book = Book(); self.breaks = BreakEpisodes(); self.clock = AbsorptionClock()
        self.candles: list[Candle] = []; self.cvd = 0; self.cvd_series = []; self.records = []
        self.traded_since_depth = defaultdict(int); self.last_ts = None; self.dropped = 0; self.last_sample_sec = None
        self.snapshots = []; self.last_snap = 0
    # --- levels effective at ts ---
    def level_at(self, ts):
        cur = {"ceiling": None, "floor": None, "version": None}
        for i, L in enumerate(self.levels):
            if L["from"] <= ts: cur = {"ceiling": L.get("ceiling"), "floor": L.get("floor"), "version": i}
        return cur
    def direction_level(self, ts, c):
        """Which test is live: the level the candle is in contact with; ceiling wins if both."""
        L = self.level_at(ts)
        if L["ceiling"] is not None and in_contact(c, L["ceiling"]): return "ceiling", L["ceiling"], L
        if L["floor"] is not None and in_contact(c, L["floor"]): return "floor", L["floor"], L
        if L["ceiling"] is not None and c.close <= L["ceiling"]: return "ceiling", L["ceiling"], L
        if L["floor"] is not None: return "floor", L["floor"], L
        return "ceiling", L["ceiling"], L
    # --- event entry ---
    def on_event(self, m):
        ts = m.get("ts")
        if m["t"] == "H": return
        if self.last_ts is not None and ts < self.last_ts - CONFIG["LATE_EVENT_SEC"]:
            self.dropped += 1
            if self.candles: self.candles[-1].quality_events.append("DROPPED_LATE")
            return
        self._roll(ts)
        if m["t"] == "Q": self._quote(m)
        elif m["t"] == "D": self._depth(m)
        self.last_ts = max(ts, self.last_ts or ts)
        sec = int(ts)
        if self.last_sample_sec is None or sec > self.last_sample_sec:
            L = self.level_at(ts); lvl = L["ceiling"] if L["ceiling"] is not None else L["floor"]
            self.book.sample(sec, lvl); self.last_sample_sec = sec
    def _roll(self, ts):
        """Finalize every candle whose end is at or before ts (empty minutes produce no candle)."""
        while self.candles and self.candles[-1].final is None and ts >= self.candles[-1].start + CONFIG["CANDLE_SEC"]:
            self._finalize(self.candles[-1])
    def _quote(self, m):
        ts, p = m["ts"], m["p"]
        kind, dv = self.ident.classify(m.get("q"), m.get("v"))
        if kind in ("START", "RESET") and self.candles: self.candles[-1].quality_events.append(kind)
        if kind in ("VERIFIED", "PROXY"):
            side = self.aggr.side(ts, p)                           # judged on the quote seen BEFORE this message
            start = int(ts // CONFIG["CANDLE_SEC"]) * CONFIG["CANDLE_SEC"]
            if not self.candles or self.candles[-1].start != start:
                if self.candles and self.candles[-1].final is None: self._finalize(self.candles[-1])
                self.candles.append(Candle(start, p, p, p, p)); self.cvd_series.append(self.cvd)
            c = self.candles[-1]; c.high = max(c.high, p); c.low = min(c.low, p); c.close = p
            r = row_of(p)
            if kind == "VERIFIED": c.verified_vol += dv; c.executions += 1
            else: c.proxy_vol += dv
            if side > 0: c.buy += dv; c.row_buy[r] += dv; self.cvd += dv
            elif side < 0: c.sell += dv; c.row_sell[r] += dv; self.cvd -= dv
            else: c.unknown += dv; c.row_unknown[r] += dv
            self.cvd_series[-1] = self.cvd
            self.traded_since_depth[p] += dv
        self.aggr.quote(ts, m.get("b"), m.get("a"))                 # the quote carried by this message is for the NEXT trade
    def _depth(self, m):
        self.book.update(m["ts"], m["bids"], m["asks"], self.traded_since_depth, m.get("snap", False)); self.traded_since_depth.clear()
        if m["ts"] - self.last_snap >= 10: self.snapshots.append((m["ts"], list(m["bids"]), list(m["asks"]))); self.last_snap = m["ts"]
    def finalize_eof(self):
        if self.candles and self.candles[-1].final is None: self.candles[-1].quality_events.append("EOF_FINALIZED"); self._finalize(self.candles[-1])
    # --- finalize: compute every feature from history ending here, store, never recompute ---
    def _finalize(self, c):
        hist = [x for x in self.candles if x.final is not None] + [c]
        ts_end = c.start + CONFIG["CANDLE_SEC"]
        direction, level, L = self.direction_level(c.start, c)
        quality = "OK" if c.verified_frac >= CONFIG["MIN_VERIFIED_FRAC"] else ("PROXY" if c.volume else "NO_TRADES")
        f = {}
        f["ABS"], f["ABS_v"] = det_ABS(hist, direction, level)
        f["EXH"], f["EXH_v"] = det_EXH(hist, direction, level)
        f["IMP"], f["IMP_v"] = det_IMP(hist, direction)
        f["DISAGREE"], _ = det_DISAGREE(hist)
        f["STK"], stk = det_STK(c); f["STK_side"] = stk[1]; f["STK_rows"] = stk[2]
        f["DIV"], f["DIV_v"] = det_DIV(hist, self.cvd_series[:len(hist)])
        f["SPEED"], f["SPEED_v"] = det_SPEED(hist)
        f["dots"] = dots(hist)
        sec = int(ts_end)
        f["PULL"] = self.book.pulling(direction, level, sec); f["STACK"] = self.book.stacking(direction, level, sec)
        w_side = "ask" if direction == "ceiling" else "bid"; w = self.book.wall(w_side, level)
        f["WALL"] = w; f["REPLENISH"] = self.book.replenishment_rows(); f["WITHDRAW"] = self.book.withdrawal_rows()
        f["breaks"] = self.breaks.update(c, L["ceiling"], L["floor"]); f["break_state"] = self.breaks.text()
        confirmed = any("✓" in b for b in f["breaks"])
        self.clock.update(c, f["ABS"], level, confirmed)
        f["clock_zone"] = self.clock.zone(ts_end); f["clock_min"] = round(self.clock.minutes(ts_end), 1)
        tags = [k for k in ("ABS", "EXH", "IMP", "STK", "DIV", "SPEED", "DISAGREE") if f[k] is True]
        c.final = {"time": dt.datetime.fromtimestamp(c.start).strftime("%a %d-%b %H:%M"), "start": c.start,
                   "direction": direction, "level": level, "level_version": L["version"], "ceiling": L["ceiling"], "floor": L["floor"],
                   "open": c.open, "high": c.high, "low": c.low, "close": c.close,
                   "delta": c.delta, "cvd": self.cvd_series[len(hist)-1], "buy": c.buy, "sell": c.sell, "unknown": c.unknown,
                   "verified_frac": round(c.verified_frac, 3), "executions": c.executions, "quality": quality,
                   "quality_events": list(c.quality_events), "ref_delta": ref_delta(hist), "tags": tags, **f}
        self.records.append(c.final)
    # --- the five-line running state (Spec §6.2) ---
    def running_state(self, ce="QUIET", pe="QUIET", ce_age=0, pe_age=0):
        if not self.records: return "no data"
        r = self.records[-1]; chain = []
        for rec in self.records[-15:]:
            for t in rec["tags"] + rec["breaks"]:
                if not chain or chain[-1] != t: chain.append(t)
        lvl = f"CEILING {r['ceiling']:.0f}" if r["direction"] == "ceiling" and r["ceiling"] else (f"FLOOR {r['floor']:.0f}" if r["floor"] else "no level")
        bk = ("thin" if r["PULL"] is True else ("firm" if r["PULL"] is False else "n/a")) + " / " + ("stacked" if r["STACK"] is True else ("normal" if r["STACK"] is False else "n/a"))
        side_txt = "ASK / BID" if r["direction"] == "ceiling" else "BID / ASK"
        return "\n".join([f"RUNNING STATE  {r['time']}  quality {r['quality']}",
                          f"1. At {lvl}: " + (" → ".join(chain[-8:]) if chain else "nothing yet"),
                          f"2. Book ({side_txt}): {bk}" + (f", wall {r['WALL'][0]:.0f}" if r["WALL"] else ""),
                          f"3. {r['break_state']}",
                          f"4. Witness: CE {ce} / PE {pe} → {two_witness(ce, pe, ce_age, pe_age)}",
                          f"5. Clock: {r['clock_zone']} ({r['clock_min']:.0f} min)"])

# =====================================================================================
# 11. CHART — drawn ONLY from stored records (no recomputation), heat from snapshots at real times
# =====================================================================================
TAG_COLOUR = {"ABS": "#d98e04", "EXH": "#d98e04", "IMP": "#1b8a4a", "STK": "#1b8a4a", "DIV": "#c62828", "SPEED": "#555", "DISAGREE": "#777",
              "C BREAK START": "black", "C BREAK ✓": "#1b8a4a", "F BREAK START": "black", "F BREAK ✓": "#c62828"}
def draw_main_chart(engine: Engine, out_png: str, state_text: str, last_n=60):
    import numpy as np, matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Rectangle
    GREEN, RED = "#1b8a4a", "#c62828"
    recs = engine.records[-last_n:]
    if not recs: return
    R = CONFIG["ROW_SIZE"]
    lo = min(r["low"] for r in recs) - 4 * R; hi = max(r["high"] for r in recs) + 4 * R
    rows = np.arange(row_of(lo), row_of(hi) + R, R)
    t0 = recs[0]["start"]; t1 = recs[-1]["start"] + CONFIG["CANDLE_SEC"]
    snaps = [s for s in engine.snapshots if t0 <= s[0] <= t1]
    fig, ax = plt.subplots(figsize=(15, 8))
    # heat: each snapshot painted from its own timestamp to the next (real time), bid and ask aggregated SEPARATELY,
    # a row holding both sides is split left (bid) / right (ask); scale = causal trailing max over the last 10 minutes
    trailing = deque()
    for i, (ts, bids, asks) in enumerate(snaps):
        ts_next = snaps[i+1][0] if i + 1 < len(snaps) else t1
        if ts_next - ts > 30: ax.axvspan(_x(ts, t0), _x(ts_next, t0), color="#ddd", alpha=0.6); continue   # feed gap masked
        rb, ra = defaultdict(int), defaultdict(int)
        for p, q in bids[:CONFIG["DEPTH_LEVELS_HEAT"]]: rb[row_of(p)] += q
        for p, q in asks[:CONFIG["DEPTH_LEVELS_HEAT"]]: ra[row_of(p)] += q
        trailing.append((ts, max(list(rb.values()) + list(ra.values()) + [1])))
        while trailing and ts - trailing[0][0] > 600: trailing.popleft()
        scale = max(v for _, v in trailing)
        x0, x1 = _x(ts, t0), _x(ts_next, t0)
        for r in set(rb) | set(ra):
            if not (rows[0] <= r <= rows[-1]): continue
            b, a = rb.get(r, 0) / scale, ra.get(r, 0) / scale
            if b and a:
                ax.add_patch(Rectangle((x0, r - R/2), (x1-x0)/2, R, fc=GREEN, alpha=0.1 + 0.65*min(b, 1), ec="none"))
                ax.add_patch(Rectangle((x0 + (x1-x0)/2, r - R/2), (x1-x0)/2, R, fc=RED, alpha=0.1 + 0.65*min(a, 1), ec="none"))
            elif b: ax.add_patch(Rectangle((x0, r - R/2), x1-x0, R, fc=GREEN, alpha=0.1 + 0.65*min(b, 1), ec="none"))
            elif a: ax.add_patch(Rectangle((x0, r - R/2), x1-x0, R, fc=RED, alpha=0.1 + 0.65*min(a, 1), ec="none"))
    ms = {"S": 7, "M": 12, "L": 18}
    for r in recs:
        x = _x(r["start"], t0) + 0.5; pc = GREEN if r["close"] >= r["open"] else RED
        ax.plot([x, x], [r["low"], r["high"]], color="black", lw=1)
        ax.add_patch(Rectangle((x - 0.3, min(r["open"], r["close"])), 0.6, max(abs(r["close"] - r["open"]), 1.5), fc="white", ec=pc, lw=2, alpha=0.95))
        d = r["dots"]
        if d and d["green"]: ax.plot(x, d["green_row"] + R/2, "o", color=GREEN, ms=ms[d["green"]], mec="black", mew=0.6, zorder=5)
        if d and d["red"]:   ax.plot(x, d["red_row"] + R/2,   "o", color=RED,   ms=ms[d["red"]],   mec="black", mew=0.6, zorder=5)
        for n_, lab in enumerate((r["breaks"] + r["tags"])[:3]):
            ax.text(x, r["high"] + 3 + n_ * 7, lab, ha="center", va="bottom", fontsize=7, weight="bold", color="white",
                    bbox=dict(boxstyle="round,pad=0.2", fc=TAG_COLOUR.get(lab, "#555"), ec="none"))
        if r["quality"] != "OK": ax.text(x, r["low"] - 4, "?", ha="center", fontsize=8, color="#999")
    if recs[-1]["ceiling"]: ax.axhline(recs[-1]["ceiling"], color=RED, ls="--", lw=1.2)
    if recs[-1]["floor"]:   ax.axhline(recs[-1]["floor"], color="#1e4fa3", ls="--", lw=1.2)
    ax.text(0.012, 0.97, state_text, transform=ax.transAxes, va="top", fontsize=8.5, family="monospace", bbox=dict(boxstyle="round", fc="white", ec="#999"))
    n = len(recs); ticks = list(range(0, n, max(1, n // 6)))
    ax.set_xticks([_x(recs[i]["start"], t0) + 0.5 for i in ticks]); ax.set_xticklabels([recs[i]["time"] for i in ticks], fontsize=8)
    ax.set_xlim(-0.5, _x(t1, t0) + 0.5); ax.set_ylim(rows[0], rows[-1])
    ax.set_title("1-min · heat = displayed resting size (green bids / red asks) · dots = row with most buy / most sell volume · '?' = low-quality candle", loc="left", weight="bold", fontsize=10)
    fig.savefig(out_png, dpi=140, bbox_inches="tight"); plt.close(fig)
def _x(ts, t0): return (ts - t0) / CONFIG["CANDLE_SEC"]

# =====================================================================================
# 12. CLI / STUDY — replay FUT (+ CE, PE) files, write the chart and the per-candle study rows
# =====================================================================================
def load_events(path):
    with open(path) as f:
        for line in f:
            if line.strip(): yield json.loads(line)
def replay(fut_path, levels, ce_path=None, pe_path=None, out_png=None, rows_csv=None):
    eng = Engine(levels); ce = Engine(levels) if ce_path else None; pe = Engine(levels) if pe_path else None
    streams = [("FUT", eng, load_events(fut_path))] + ([("CE", ce, load_events(ce_path))] if ce else []) + ([("PE", pe, load_events(pe_path))] if pe else [])
    # merge the streams in time order so CE/PE verdicts are synchronized with FUT candles
    import heapq
    heap = []
    for name, e, it in streams:
        m = next(it, None)
        if m: heapq.heappush(heap, (m.get("ts", 0), name, m, it))
    witnesses = {}
    while heap:
        ts, name, m, it = heapq.heappop(heap)
        {"FUT": eng, "CE": ce, "PE": pe}[name].on_event(m)
        nxt = next(it, None)
        if nxt: heapq.heappush(heap, (nxt.get("ts", 0), name, nxt, it))
        for nm, e in (("CE", ce), ("PE", pe)):
            if e and e.records and (nm not in witnesses or witnesses[nm][1] != e.records[-1]["start"]):
                hist = [c for c in e.candles if c.final is not None]
                witnesses[nm] = (witness(hist), e.records[-1]["start"])
    for e in (eng, ce, pe):
        if e: e.finalize_eof()
    rows = []
    for r in eng.records:
        row = {k: (json.dumps(v) if isinstance(v, (list, dict, tuple)) else v) for k, v in r.items()}
        row["ce_witness"] = next((w[0] for w in [witnesses.get("CE")] if w and w[1] <= r["start"]), None)
        row["pe_witness"] = next((w[0] for w in [witnesses.get("PE")] if w and w[1] <= r["start"]), None)
        rows.append(row)
    if rows_csv and rows:
        with open(rows_csv, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    cw = witnesses.get("CE", ("QUIET", 0))[0]; pw = witnesses.get("PE", ("QUIET", 0))[0]
    state = eng.running_state(cw, pw)
    if out_png: draw_main_chart(eng, out_png, state)
    return eng, rows, state

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Replay a logged day. Levels are versioned: --levels levels.json or --ceiling/--floor for the whole day.")
    ap.add_argument("fut"); ap.add_argument("--ce"); ap.add_argument("--pe")
    ap.add_argument("--ceiling", type=float); ap.add_argument("--floor", type=float); ap.add_argument("--levels")
    ap.add_argument("--png"); ap.add_argument("--rows")
    a = ap.parse_args()
    levels = json.load(open(a.levels)) if a.levels else [{"from": 0, "ceiling": a.ceiling, "floor": a.floor}]
    _, rows, state = replay(a.fut, levels, a.ce, a.pe, a.png, a.rows)
    print(state); print(f"{len(rows)} candles finalized")
