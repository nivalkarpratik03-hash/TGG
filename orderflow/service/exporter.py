"""
exporter.py - turns the engine's two result lists into JSON for Lightweight Charts.

  engine.records    one entry per finished candle      -> candles, labels, dots, levels
  engine.snapshots  order book copy every >=10 seconds -> heat map

It does NOT change sir's engine. It only mirrors, in numbers, what draw_main_chart() draws in the PNG:
  * labels  = (breaks + tags)[:3] per candle, with TAG_COLOUR colours
  * '?'     = candle quality != "OK"
  * dots    = green/red dot at (row + ROW_SIZE/2) with size S/M/L
  * heat    = first DEPTH_LEVELS_HEAT levels per side, summed into ROW_SIZE-point rows, scaled by a causal
              10-minute trailing maximum; a snapshot lasts until the next one; gaps over 30 s are reported
              as gaps (the PNG greys them out).  PNG alpha for a cell = 0.1 + 0.65 * min(value, 1)
If sir changes his drawing rules, this file is the one place to update.
"""
import datetime as dt
import math
from collections import defaultdict, deque

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
BIG_FIELDS = {"WITHDRAW"}            # ~10 KB per candle, not drawn in the PNG; included only with full=1
SIGNAL_KEYS = ("ABS", "EXH", "IMP", "DISAGREE", "STK", "DIV", "SPEED", "PULL", "STACK", "WALL", "REPLENISH")


def clean(x):
    """Make anything JSON-safe (NaN/inf -> null, tuples/sets -> lists)."""
    if isinstance(x, float):
        return None if (math.isnan(x) or math.isinf(x)) else x
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set)):
        return [clean(v) for v in x]
    return x


def label(ts):
    return dt.datetime.fromtimestamp(ts, IST).strftime("%a %d-%b %H:%M")


def build_heat(oe, eng, t0, t1):
    R, L = oe.CONFIG["ROW_SIZE"], oe.CONFIG["DEPTH_LEVELS_HEAT"]
    snaps = [s for s in eng.snapshots if t0 <= s[0] <= t1]
    trailing, out, gaps = deque(), [], []
    for i, (ts, bids, asks) in enumerate(snaps):
        ts_next = snaps[i + 1][0] if i + 1 < len(snaps) else t1
        if ts_next - ts > 30:
            gaps.append([ts, ts_next])
            continue
        rb, ra = defaultdict(float), defaultdict(float)
        for p, q in bids[:L]:
            rb[oe.row_of(p)] += q
        for p, q in asks[:L]:
            ra[oe.row_of(p)] += q
        trailing.append((ts, max(list(rb.values()) + list(ra.values()) + [1])))
        while trailing and ts - trailing[0][0] > 600:
            trailing.popleft()
        scale = max(v for _, v in trailing)
        cells = []
        for r in sorted(set(rb) | set(ra)):
            b, a = rb.get(r, 0) / scale, ra.get(r, 0) / scale
            cells.append([r, round(min(b, 1), 3), round(min(a, 1), 3)])
        out.append({"t0": ts, "t1": ts_next, "cells": cells})
    return {"row_size": R, "levels_each_side": L, "alpha": "0.1 + 0.65 * value", "gaps": gaps, "snapshots": out}


def export(oe, eng, state_text, last_n=None, heat=True, full=False):
    R, cs = oe.CONFIG["ROW_SIZE"], oe.CONFIG["CANDLE_SEC"]
    recs = eng.records[-last_n:] if last_n else eng.records
    candles, dots = [], []
    shown = ("start", "time", "open", "high", "low", "close", "delta", "cvd", "buy", "sell", "unknown", "quality",
             "verified_frac", "executions", "dots", "tags", "breaks", "ceiling", "floor")
    for r in recs:
        labs = (r["breaks"] + r["tags"])[:3]
        extras = {k: v for k, v in r.items() if k not in shown and (full or k not in BIG_FIELDS)}
        candles.append({
            "time": r["start"], "label": label(r["start"]),
            "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"],
            "delta": r["delta"], "cvd": r["cvd"], "buy": r["buy"], "sell": r["sell"], "unknown": r["unknown"],
            "executions": r["executions"], "quality": r["quality"], "verified_frac": r["verified_frac"],
            "low_quality": r["quality"] != "OK",
            "labels": [{"text": t, "colour": oe.TAG_COLOUR.get(t, "#555")} for t in labs],
            "tags": r["tags"], "breaks": r["breaks"],
            "signals": {k: r[k] for k in SIGNAL_KEYS if k in r},
            "extras": extras,
        })
        d = r["dots"]
        if d and d.get("green"):
            dots.append({"time": r["start"], "price": d["green_row"] + R / 2, "side": "buy", "size": d["green"]})
        if d and d.get("red"):
            dots.append({"time": r["start"], "price": d["red_row"] + R / 2, "side": "sell", "size": d["red"]})
    last = recs[-1] if recs else {}
    t0 = recs[0]["start"] if recs else 0
    t1 = (recs[-1]["start"] + cs) if recs else 0
    lines = state_text.split("\n") if state_text else []
    return clean({
        "state": {"lines": lines, "text": state_text},
        "candles": candles,
        "dots": dots,
        "levels": {"ceiling": last.get("ceiling"), "floor": last.get("floor")},
        "heat": build_heat(oe, eng, t0, t1) if (heat and recs) else None,
        "tag_colours": dict(oe.TAG_COLOUR),
        "candle_sec": cs, "row_size": R,
        "time": {"unit": "epoch seconds (UTC)", "display_offset_seconds": 19800,
                 "note": "Lightweight Charts shows UTC. Add display_offset_seconds to show IST."},
    })
