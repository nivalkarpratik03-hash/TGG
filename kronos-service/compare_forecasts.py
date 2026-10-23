"""
kronos-service/compare_forecasts.py

The "day end" half of the ask: app.py logs every forecast it makes
(forecast_log.jsonl, one line per /forecast call, every bar it predicted
and the real timestamp each bar is FOR). This script reads that log,
matches each forecasted bar against the REAL candle once the market has
printed it, and reports how often Kronos was right — same scoring style
as validate_nifty.py, so the numbers mean the same thing.

Difference from validate_nifty.py: that script tests Kronos on PAST data
you already have, calling the service itself. This script does NOT call
Kronos at all — it only reads forecasts the service already logged
(real, live calls made earlier today or on previous days) and checks them
against a real candle file you download afterwards. Run this AFTER
market close, once you've downloaded that day's (or week's) real candles
from the Data Export page.

RUN
    python compare_forecasts.py "C:\\path\\to\\real_candles.xlsx"
    python compare_forecasts.py "C:\\path\\to\\real_candles.xlsx" --symbol NSE:NIFTY50-INDEX

If --symbol is omitted, every symbol found in the log is compared
against the same candle file (fine if the file only covers one symbol,
which is the normal case — Data Export downloads one symbol at a time).

A forecasted bar is only scored once its real candle's time has actually
passed (skips anything still in the future) AND that candle exists in
the file you gave it. Partially-covered days are fine — whatever can be
matched gets scored, the rest is silently skipped (not an error).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time as time_module
from datetime import timezone, timedelta

import numpy as np
import pandas as pd

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forecast_log.jsonl")
IST = timezone(timedelta(hours=5, minutes=30))


def die(msg: str):
    print(f"\nERROR: {msg}\n")
    sys.exit(1)


def load_real_candles(path: str):
    if not os.path.exists(path):
        die(f"File not found: {path}")
    try:
        df = pd.read_excel(path)
    except ImportError:
        die("Reading .xlsx needs openpyxl. Run:  pip install openpyxl")
    except Exception as e:  # noqa: BLE001
        die(f"Could not read {path}: {e}")

    need = ["Date", "Time", "Close"]
    missing = [c for c in need if c not in df.columns]
    if missing:
        die(f"Missing columns {missing}. Expected a Data Export file. Found: {list(df.columns)}")

    date_part = (df["Date"].dt.strftime("%Y-%m-%d")
                 if pd.api.types.is_datetime64_any_dtype(df["Date"]) else df["Date"].astype(str))
    ts = pd.to_datetime(date_part + " " + df["Time"].astype(str), errors="coerce")
    df = df.assign(_ts=ts).dropna(subset=["Close", "_ts"])

    close_by_time_ms = {}
    for t, c in zip(df["_ts"], df["Close"]):
        epoch_ms = int(t.to_pydatetime().replace(tzinfo=IST).timestamp() * 1000)
        close_by_time_ms[epoch_ms] = float(c)
    return close_by_time_ms


def load_log(symbol_filter: str | None):
    if not os.path.exists(LOG_PATH):
        die(f"No log file yet at {LOG_PATH} — run some /forecast calls first (the dashboard, "
            f"a test script, or validate_nifty.py all write to it automatically).")
    entries = []
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
            if symbol_filter and e.get("symbol") != symbol_filter:
                continue
            entries.append(e)
    return entries


def pct(x: float) -> str:
    return "n/a" if x != x else f"{100 * x:.0f}%"


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def main():
    ap = argparse.ArgumentParser(description="Score logged Kronos forecasts against real candles.")
    ap.add_argument("xlsx", help="Data Export file with the REAL candles for the symbol(s) being checked")
    ap.add_argument("--symbol", default=None, help="Only score forecasts logged for this exact symbol string (e.g. NSE:NIFTY50-INDEX). Default: all symbols in the log.")
    args = ap.parse_args()

    real = load_real_candles(args.xlsx)
    print(f"Loaded {len(real)} real candles from {os.path.basename(args.xlsx)}")

    entries = load_log(args.symbol)
    if not entries:
        die("No matching forecasts found in the log" + (f" for symbol {args.symbol}" if args.symbol else "") + ".")
    print(f"Loaded {len(entries)} logged forecast call(s)" + (f" for {args.symbol}" if args.symbol else " (all symbols)"))

    # Flatten every bar of every logged forecast into one row per bar —
    # each bar is scored independently (a forecast made at 9:15 for the
    # 9:30, 9:45, 10:00... candles produces one row per candle here).
    rows = []
    unmatched = 0
    still_future = 0
    for e in entries:
        current_close = e["currentClose"]
        for bar in e["path"]:
            actual = real.get(bar["time"])
            if actual is None:
                unmatched += 1
                continue
            rows.append({
                "symbol": e.get("symbol") or "(unlabeled)",
                "forecast_made_at": e["requestedAt"],
                "bar_time_ms": bar["time"],
                "direction": bar["direction"],
                "confidence": bar["confidence"],
                "predicted_close": bar["predictedClose"],
                "current_close": current_close,
                "actual_close": actual,
                "actual_direction": "up" if actual > current_close else "down" if actual < current_close else "flat",
            })

    now_ms = int(time_module.time() * 1000)
    rows = [r for r in rows if r["bar_time_ms"] <= now_ms]
    # (still_future isn't tracked precisely since unmatched already covers
    #  "not in the file yet" — a future bar simply won't be in a file you
    #  downloaded before it happened, same bucket, no need to double-count.)

    print(f"Bars matched to a real candle: {len(rows)}   |   bars with no matching real candle (not downloaded, or still in the future): {unmatched}")

    if not rows:
        die("Nothing to score — either the log's forecasts don't overlap this candle file's time range, "
            "or none of them have reached their forecasted time yet.")

    print("\n" + "=" * 64)
    print("RESULTS — logged forecasts vs real data")
    print("=" * 64)

    calls = [r for r in rows if r["direction"] in ("up", "down")]
    neutral = len(rows) - len(calls)
    print(f"Bars scored: {len(rows)}   |  directional calls: {len(calls)}   |  neutral: {neutral}")

    if calls:
        right = sum(1 for r in calls if r["direction"] == r["actual_direction"])
        lo, hi = wilson(right, len(calls))
        ups = sum(1 for r in calls if r["actual_direction"] == "up")
        downs = sum(1 for r in calls if r["actual_direction"] == "down")
        base = max(ups, downs) / len(calls) if calls else float("nan")
        print(f"\nDirection accuracy : {pct(right / len(calls))}  ({right}/{len(calls)}),  95% range {pct(lo)} to {pct(hi)}")
        print(f"Base rate (always guess the more common outcome): {pct(base)}")

        print("\nBy confidence bucket:")
        edges = [0, 60, 70, 80, 90, 101]
        for a, b in zip(edges[:-1], edges[1:]):
            grp = [r for r in calls if a <= r["confidence"] < b]
            label = f"{a}-{min(b, 100)}%"
            if grp:
                g = sum(1 for r in grp if r["direction"] == r["actual_direction"])
                print(f"  {label:>8} : {pct(g / len(grp)):>5}  ({g}/{len(grp)})")
            else:
                print(f"  {label:>8} : no calls")

        mae = float(np.mean([abs(r["predicted_close"] - r["actual_close"]) for r in rows]))
        mae_naive = float(np.mean([abs(r["current_close"] - r["actual_close"]) for r in rows]))
        verdict = "BETTER than" if mae < mae_naive else "NOT better than"
        print(f"\nPrice error: Kronos {mae:.1f} pts vs 'no change' {mae_naive:.1f} pts  -> Kronos is {verdict} assuming the price stays put.")
    else:
        print("\nNo directional calls to score (every logged bar came back neutral).")

    if len(rows) < 100:
        print(f"\nn = {len(rows)} is small — same caveat as validate_nifty.py: treat this as an early look, not a verdict.")
    print()


if __name__ == "__main__":
    main()
