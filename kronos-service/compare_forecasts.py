"""
kronos-service/compare_forecasts.py

THE SCORECARD. Reads every LIVE forecast forecast_now.py made (saved by
app.py in forecast_log.jsonl), fetches the real candles that have printed
since, and reports how often Kronos was actually right — per timeframe,
per "candles ahead", and per confidence level.

Run it any time (end of day is natural). It always re-scores the WHOLE
log, so the numbers grow as forecasts pile up day after day. Forecasts
whose candles haven't printed yet are just counted as "pending".

WHAT COUNTS AS RIGHT
  Each forecasted candle said UP or DOWN versus the close at the moment
  of the forecast. It's right if the real close of that candle ended up
  on that side. (Same rule as validate_nifty.py.)

HOW BARS ARE MATCHED
  By POSITION, not by clock: forecasted candle #3 is compared with the
  3rd real candle after the one the forecast was made from. This is
  correct even across nights, weekends and holidays, even if the holiday
  list in nse_calendar.py is out of date (a warning is printed if the
  clock times disagree, so you know to update it).

WHAT IS SCORED
  Only entries with mode = "live" (from forecast_now.py). Backtest calls
  (validate_nifty.py) and old untagged entries are skipped, unless you
  pass --include-untagged. If the same candle was forecast twice (e.g.
  --watch retried), only the latest forecast for it is kept.

RUN
  python compare_forecasts.py                       fetch real candles live from the backend
  python compare_forecasts.py --timeframe 15min     only score one timeframe
  python compare_forecasts.py --min-move 30         also show accuracy on moves of >= 30 points
  python compare_forecasts.py real.xlsx --timeframe 15min   offline: real candles from a Data Export file

Writes every scored candle to live_scores.csv (rebuilt each run) so you
can open it in Excel.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime

import numpy as np
import pandas as pd

from nse_calendar import RESOLUTION_MINUTES, bar_is_complete, ist_to_ms, ms_to_ist, now_ist

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, "forecast_log.jsonl")
SCORES_CSV = os.path.join(HERE, "live_scores.csv")
STRONG_CONFIDENCE = 77.0
AHEAD_GROUPS = [(1, 1), (2, 2), (3, 4), (5, 8), (9, 16), (17, 999)]
CONF_EDGES = [0, 60, 70, 80, 90, 101]


def die(msg: str):
    print(f"\nERROR: {msg}\n")
    sys.exit(1)


def pct(x: float) -> str:
    return "  n/a" if x != x else f"{100 * x:4.0f}%"


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


# ── Log ────────────────────────────────────────────────────────────────
def load_log(symbol: str | None, timeframe: str | None, include_untagged: bool):
    if not os.path.exists(LOG_PATH):
        die(f"No log yet at {LOG_PATH}. Run forecast_now.py first (with the Kronos service running).")
    entries, skipped_mode = [], 0
    with open(LOG_PATH, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                print(f"  (skipping unreadable line {line_no} in the log)")
                continue
            mode = e.get("mode")
            if mode != "live" and not (include_untagged and mode is None):
                skipped_mode += 1
                continue
            if symbol and e.get("symbol") != symbol:
                continue
            if timeframe and e.get("resolution") != timeframe:
                continue
            if "currentCloseTime" not in e:
                continue
            entries.append(e)

    # Same base candle forecast more than once -> keep the latest.
    latest = {}
    for e in entries:
        latest[(e.get("symbol"), e["resolution"], e["currentCloseTime"])] = e
    return list(latest.values()), skipped_mode, len(entries) - len(latest)


# ── Real candles ───────────────────────────────────────────────────────
def frame_to_series(df: pd.DataFrame, resolution: str):
    """-> (sorted list of finished-candle start times in ms, {ms: close})"""
    for c in ("Date", "Time", "Close"):
        if c not in df.columns:
            die(f"Real candle data is missing column {c}. Found: {list(df.columns)}")
    date_part = (df["Date"].dt.strftime("%Y-%m-%d")
                 if pd.api.types.is_datetime64_any_dtype(df["Date"]) else df["Date"].astype(str))
    ts = pd.to_datetime(date_part + " " + df["Time"].astype(str), errors="coerce")
    df = df.assign(_ts=ts).dropna(subset=["_ts", "Close"]).sort_values("_ts").drop_duplicates("_ts")
    now = now_ist()
    close = {}
    for t, c in zip(df["_ts"], df["Close"]):
        t = t.to_pydatetime()
        if bar_is_complete(t, resolution, now):  # a forming candle's close isn't final
            close[ist_to_ms(t)] = float(c)
    return sorted(close), close


def real_candles_live(symbol, resolution, oldest_ms, backend_url):
    from backend_candles import BackendCandleError, fetch_candles_df
    from_date = (ms_to_ist(oldest_ms).date()).strftime("%Y-%m-%d")
    try:
        df = fetch_candles_df(symbol, from_date, resolution, backend_url=backend_url)
    except BackendCandleError as e:
        die(str(e))
    return frame_to_series(df, resolution)


def real_candles_file(path, resolution):
    if not os.path.exists(path):
        die(f"File not found: {path}")
    try:
        df = pd.read_excel(path)
    except ImportError:
        die("Reading .xlsx needs openpyxl. Run:  pip install openpyxl")
    return frame_to_series(df, resolution)


# ── Scoring ────────────────────────────────────────────────────────────
def score(entries, times, close):
    index_of = {t: i for i, t in enumerate(times)}
    rows, pending, no_base, clock_mismatch = [], 0, 0, 0
    for e in entries:
        i0 = index_of.get(e["currentCloseTime"])
        if i0 is None:
            no_base += 1
            continue
        cur = float(e["currentClose"])
        made = ms_to_ist(e["currentCloseTime"]).strftime("%Y-%m-%d %H:%M")
        for k, bar in enumerate(e["path"], 1):
            j = i0 + k
            if j >= len(times):
                pending += 1
                continue
            real_t = times[j]
            if real_t != bar["time"]:
                clock_mismatch += 1
            actual = close[real_t]
            act_dir = "up" if actual > cur else "down" if actual < cur else "flat"
            rows.append({
                "symbol": e.get("symbol") or "",
                "timeframe": e["resolution"],
                "forecast_from_candle": made,
                "candle": ms_to_ist(real_t).strftime("%Y-%m-%d %H:%M"),
                "ahead": k,
                "direction": bar["direction"],
                "confidence": float(bar["confidence"]),
                "current_close": cur,
                "predicted_close": float(bar["predictedClose"]),
                "actual_close": actual,
                "actual_move": round(actual - cur, 2),
                "actual_direction": act_dir,
                "correct": "" if bar["direction"] == "neutral" else bar["direction"] == act_dir,
            })
    return rows, pending, no_base, clock_mismatch


def line(label, grp):
    calls = [r for r in grp if r["direction"] != "neutral"]
    if not calls:
        return f"  {label:<12}{'no calls':>10}"
    k = sum(1 for r in calls if r["correct"] is True)
    strong = [r for r in calls if r["confidence"] >= STRONG_CONFIDENCE]
    ks = sum(1 for r in strong if r["correct"] is True)
    s = f"{pct(ks / len(strong))} ({ks}/{len(strong)})" if strong else "   -"
    return f"  {label:<12}{pct(k / len(calls)):>6} ({k}/{len(calls)}){'':<4}{s}"


def report(tf, rows, n_forecasts, min_move):
    calls = [r for r in rows if r["direction"] != "neutral"]
    print("\n" + "=" * 68)
    print(f"{tf}  —  {n_forecasts} forecasts, {len(rows)} candles scored, {len(calls)} UP/DOWN calls")
    print("=" * 68)
    if not calls:
        print("No UP/DOWN calls to score yet.")
        return

    k = sum(1 for r in calls if r["correct"] is True)
    ups = sum(1 for r in calls if r["actual_direction"] == "up")
    downs = sum(1 for r in calls if r["actual_direction"] == "down")
    base = max(ups, downs) / len(calls)
    lo, hi = wilson(k, len(calls))
    print(f"All calls        : {pct(k / len(calls))}  ({k}/{len(calls)})   rough 95% range {pct(lo)} - {pct(hi)}")
    print(f"Base rate        : {pct(base)}  (always guessing '{'up' if ups >= downs else 'down'}' — "
          f"NIFTY went up {ups}x, down {downs}x)")

    print(f"\nBy candles ahead          all calls      calls >= {STRONG_CONFIDENCE:.0f}% conf")
    for a, b in AHEAD_GROUPS:
        grp = [r for r in rows if a <= r["ahead"] <= b]
        if grp:
            print(line(str(a) if a == b else f"{a}-{b if b < 999 else '+'}", grp))

    print("\nBy confidence (should rise if confidence means anything)")
    for a, b in zip(CONF_EDGES[:-1], CONF_EDGES[1:]):
        grp = [r for r in calls if a <= r["confidence"] < b]
        if grp:
            g = sum(1 for r in grp if r["correct"] is True)
            print(f"  {a:>3}-{min(b, 100):<3}%    {pct(g / len(grp))}  ({g}/{len(grp)})")

    if min_move:
        big = [r for r in calls if abs(r["actual_move"]) >= min_move]
        if big:
            g = sum(1 for r in big if r["correct"] is True)
            print(f"\nMoves >= {min_move:g} pts only: {pct(g / len(big))}  ({g}/{len(big)})")

    mae_k = float(np.mean([abs(r["predicted_close"] - r["actual_close"]) for r in rows]))
    mae_n = float(np.mean([abs(r["current_close"] - r["actual_close"]) for r in rows]))
    print(f"\nPrice error: Kronos {mae_k:.1f} pts vs 'no change' {mae_n:.1f} pts -> "
          f"{'BETTER' if mae_k < mae_n else 'NOT better'} than assuming price stays put.")

    print("\nReading:")
    if lo > max(base, 0.5):
        print("  Whole range is above coin-flip AND base rate: possible edge. Keep collecting.")
    else:
        print("  Range still includes coin-flip or base rate: no edge proven yet.")
    print(f"  Candles from the same forecast move together, so the real certainty is closer to "
          f"{n_forecasts} samples than {len(calls)} — the range above is optimistic.")


def main():
    ap = argparse.ArgumentParser(description="Score live Kronos forecasts against what really happened.")
    ap.add_argument("xlsx", nargs="?", default=None,
                    help="optional Data Export .xlsx with real candles (needs --timeframe). Default: fetch live.")
    ap.add_argument("--symbol", default="NSE:NIFTY50-INDEX")
    ap.add_argument("--timeframe", default=None, help="only score this timeframe (default: all in the log)")
    ap.add_argument("--min-move", type=float, default=0, help="also report accuracy on real moves of >= this many points")
    ap.add_argument("--backend-url", default="http://localhost:5280")
    ap.add_argument("--include-untagged", action="store_true",
                    help="also score old log entries without a mode (made before forecast_now.py existed)")
    args = ap.parse_args()

    if args.xlsx and not args.timeframe:
        die("With an .xlsx file, also pass --timeframe (the file holds one timeframe).")
    if args.timeframe and args.timeframe not in RESOLUTION_MINUTES:
        die(f"Unknown timeframe. Use: {', '.join(RESOLUTION_MINUTES)}")

    entries, skipped_mode, dupes = load_log(args.symbol or None, args.timeframe, args.include_untagged)
    print(f"Live forecasts in log: {len(entries)}"
          + (f"  (skipped {skipped_mode} backtest/untagged)" if skipped_mode else "")
          + (f"  (dropped {dupes} repeats of the same candle)" if dupes else ""))
    if not entries:
        die("Nothing to score. Run forecast_now.py during market hours first.")

    by_tf = defaultdict(list)
    for e in entries:
        by_tf[e["resolution"]].append(e)

    all_rows = []
    order = sorted(by_tf, key=lambda t: RESOLUTION_MINUTES[t])
    for tf in order:
        es = by_tf[tf]
        if args.xlsx:
            times, close = real_candles_file(args.xlsx, tf)
        else:
            oldest = min(e["currentCloseTime"] for e in es)
            print(f"Fetching real {tf} candles since {ms_to_ist(oldest):%Y-%m-%d}...")
            sym = args.symbol or es[0].get("symbol") or "NSE:NIFTY50-INDEX"
            times, close = real_candles_live(sym, tf, oldest, args.backend_url)
        rows, pending, no_base, mismatch = score(es, times, close)
        if pending:
            print(f"  {tf}: {pending} forecasted candles haven't printed yet (pending).")
        if no_base:
            print(f"  {tf}: {no_base} forecasts skipped — their starting candle isn't in the real data.")
        if mismatch:
            print(f"  {tf}: WARNING {mismatch} candles printed at a different time than forecast — "
                  f"probably a holiday missing from nse_calendar.py. Scores are still correct.")
        report(tf, rows, len(es), args.min_move)
        all_rows.extend(rows)

    if all_rows:
        with open(SCORES_CSV, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
            w.writeheader()
            w.writerows(all_rows)
        print(f"\nEvery scored candle saved to {SCORES_CSV}")
    print()


if __name__ == "__main__":
    main()
