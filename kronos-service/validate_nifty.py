"""
kronos-service/validate_nifty.py

ONE symbol (NIFTY50), outside the dashboard. Answers a single question
with real data instead of opinion: when Kronos says "up/down with X%
confidence", how often is it right about what NIFTY actually does next?

HOW IT WORKS
  1. Reads a Data Export .xlsx of real NIFTY50-INDEX candles (the same
     file your Data Export page downloads: Date, Time, Open, High, Low,
     Close, Volume).
  2. Picks past moments ("cutoffs"). For each one it sends ONLY the
     candles up to that moment (last 512) to the running Kronos service,
     exactly like the dashboard would, and gets a direction + confidence.
  3. Looks at the real candle HORIZON bars later and scores the call.
  4. Sends ONE request at a time. Kronos crashes when several requests hit
     it at once (seen in your terminal), so this never does that.
  5. Prints a summary: accuracy vs the base rate, accuracy by confidence
     bucket, and whether Kronos's predicted price beats "no change".

  Every finished forecast is written to a CSV immediately. Ctrl+C is safe,
  and running the same command again resumes where it stopped.

REQUIRES  the Kronos service already running (uvicorn app:app --port 8001),
          and  pip install openpyxl  (pandas needs it to read .xlsx).
          Do NOT click Scan Now in the dashboard while this runs.

RUN       python validate_nifty.py "C:\\path\\to\\NSE_NIFTY50-INDEX_15min_....xlsx"
          python validate_nifty.py "file.xlsx" --max-tests 10      (quick trial)
          python validate_nifty.py "file.xlsx" --summary-only      (re-print results)

KNOWN LIMITATION (checked by reading app.py, effect on accuracy unknown):
  app.py builds future timestamps by adding fixed steps to the last candle
  and does not skip the overnight gap or market close. To keep the test
  honest this script only scores windows that stay inside ONE trading day,
  where that timeline matches reality. Forecasts whose window would cross
  15:30 are NOT validated here.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

# ── Defaults (all overridable from the command line) ────────────────────
DEFAULT_URL = "http://localhost:8001"
DEFAULT_HORIZON = 16      # bars ahead; 16 x 15min = 4 hours (same default as the dashboard)
# Forecast runs per call. Keep this ODD: with an even number, an exact up/down
# tie (e.g. 5 vs 5) is possible and app.py reports it as "neutral" = no call.
# An odd number can't tie. With 9 runs, confidence moves in steps of ~11%
# (55.6, 66.7, 77.8, 88.9, 100), so the dashboard's 65% line means "6 of 9 agree".
DEFAULT_SAMPLES = 9
DEFAULT_CONTEXT = 512     # candles sent to the model (Kronos-small's cap)
DEFAULT_MAX_TESTS = 40    # how many past moments to score
MIN_HISTORY = 200         # a cutoff needs at least this many earlier candles
FOUND_THRESHOLD = 65.0    # the dashboard's "found" line (kronosDirection.js)
REQUEST_TIMEOUT_S = 900
MAX_CONSECUTIVE_ERRORS = 3

IST = timezone(timedelta(hours=5, minutes=30))
RESOLUTION_BY_MINUTES = {1: "1min", 3: "3min", 5: "5min", 15: "15min", 60: "1hr"}

CSV_FIELDS = [
    "cutoff_time", "cutoff_index", "horizon", "samples", "context",
    "current_close", "predicted_close", "actual_close",
    "direction", "confidence", "actual_direction", "correct",
    "wall_seconds", "compute_seconds",
]


def die(msg: str):
    print(f"\nERROR: {msg}\n")
    sys.exit(1)


# ── Reading the candles ─────────────────────────────────────────────────
def load_candles(path: str):
    if not os.path.exists(path):
        die(f"File not found: {path}")
    try:
        df = pd.read_excel(path)
    except ImportError:
        die("Reading .xlsx needs openpyxl. Run:  pip install openpyxl")
    except Exception as e:  # noqa: BLE001 — surface whatever pandas says
        die(f"Could not read {path}: {e}")

    need = ["Date", "Time", "Open", "High", "Low", "Close"]
    missing = [c for c in need if c not in df.columns]
    if missing:
        die(f"Missing columns {missing}. Expected a Data Export file (Date, Time, Open, High, Low, Close, Volume). Found: {list(df.columns)}")
    if "Volume" not in df.columns:
        df["Volume"] = 0

    date_part = (df["Date"].dt.strftime("%Y-%m-%d")
                 if pd.api.types.is_datetime64_any_dtype(df["Date"]) else df["Date"].astype(str))
    ts = pd.to_datetime(date_part + " " + df["Time"].astype(str), errors="coerce")
    if ts.isna().any():
        die(f"{int(ts.isna().sum())} rows have an unreadable Date/Time.")

    df = df.assign(_ts=ts).dropna(subset=["Open", "High", "Low", "Close"])
    df = df.sort_values("_ts").drop_duplicates("_ts").reset_index(drop=True)
    if len(df) < MIN_HISTORY + 50:
        die(f"Only {len(df)} candles in the file. Download a longer range (a few months of 15-minute data).")

    # Timestamps in the export are IST wall-clock. Convert to epoch ms the
    # same way the Node backend's candle objects carry `time`.
    times_ms = [int(t.to_pydatetime().replace(tzinfo=IST).timestamp() * 1000) for t in df["_ts"]]
    return {
        "times_ms": times_ms,
        "labels": df["_ts"].dt.strftime("%Y-%m-%d %H:%M").tolist(),
        "open": df["Open"].astype(float).tolist(),
        "high": df["High"].astype(float).tolist(),
        "low": df["Low"].astype(float).tolist(),
        "close": df["Close"].astype(float).tolist(),
        "volume": df["Volume"].fillna(0).astype(float).tolist(),
    }


def infer_bar_minutes(times_ms):
    # Median gap between neighbouring candles, ignoring overnight/weekend jumps.
    gaps = [(times_ms[i] - times_ms[i - 1]) / 60000 for i in range(1, len(times_ms))]
    gaps = [g for g in gaps if g <= 120]
    if not gaps:
        die("Could not work out the candle size from the timestamps.")
    med = int(round(float(np.median(gaps))))
    if med not in RESOLUTION_BY_MINUTES:
        die(f"Candles look like {med}-minute bars. This script supports {sorted(RESOLUTION_BY_MINUTES)}-minute data — download 15-minute candles.")
    return med


# ── Choosing which past moments to test ─────────────────────────────────
def choose_test_points(times_ms, bar_min, horizon, max_tests):
    step_ms = bar_min * 60_000
    valid = [
        i for i in range(MIN_HISTORY - 1, len(times_ms) - horizon)
        # candle i+horizon must sit exactly horizon bars after candle i:
        # no missing candles, and no overnight jump inside the window.
        if times_ms[i + horizon] - times_ms[i] == horizon * step_ms
    ]
    if not valid:
        return [], 0, valid
    if len(valid) <= max_tests:
        return valid, len(valid), valid
    picks = sorted(set(np.linspace(0, len(valid) - 1, max_tests).round().astype(int).tolist()))
    return [valid[j] for j in picks], len(valid), valid


# ── Talking to the Kronos service ───────────────────────────────────────
def service_alive(url: str) -> bool:
    try:
        with urllib.request.urlopen(url + "/health", timeout=10) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def call_forecast(url, data, i, context, resolution, horizon, samples):
    lo = max(0, i + 1 - context)
    payload = json.dumps({
        "candles": [
            {"time": data["times_ms"][k], "open": data["open"][k], "high": data["high"][k],
             "low": data["low"][k], "close": data["close"][k], "volume": data["volume"][k]}
            for k in range(lo, i + 1)
        ],
        "resolution": resolution,
        "horizon": horizon,
        "sample_count": samples,
    }).encode("utf-8")
    req = urllib.request.Request(url + "/forecast", data=payload,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"service returned {e.code}: {e.read().decode('utf-8')[:300]}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"could not reach service: {e.reason}") from e


# ── Scoring ─────────────────────────────────────────────────────────────
def actual_direction(current: float, actual: float) -> str:
    return "up" if actual > current else "down" if actual < current else "flat"


def wilson(k: int, n: int, z: float = 1.96):
    """95% range for a win rate k/n — shows how much a small sample can be trusted."""
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def pct(x: float) -> str:
    return "n/a" if x != x else f"{100 * x:.0f}%"


def summarize(rows, title: str):
    print("\n" + "=" * 68)
    print(f"RESULTS  {title}")
    print("=" * 68)
    n = len(rows)
    if n == 0:
        print("No finished forecasts yet.")
        return

    for r in rows:
        r["confidence"] = float(r["confidence"])
        r["current_close"] = float(r["current_close"])
        r["predicted_close"] = float(r["predicted_close"])
        r["actual_close"] = float(r["actual_close"])

    calls = [r for r in rows if r["direction"] in ("up", "down")]
    neutral = n - len(calls)
    print(f"Forecasts scored: {n}   |  directional calls: {len(calls)}   |  neutral (no call): {neutral}")

    if calls:
        right = sum(1 for r in calls if r["direction"] == r["actual_direction"])
        lo, hi = wilson(right, len(calls))
        ups = sum(1 for r in calls if r["actual_direction"] == "up")
        downs = sum(1 for r in calls if r["actual_direction"] == "down")
        base = max(ups, downs) / len(calls)
        print(f"\nDirection accuracy, all calls : {pct(right / len(calls))}  ({right}/{len(calls)}),  95% range {pct(lo)} to {pct(hi)}")
        print(f"Base rate (always guess the more common outcome): {pct(base)}   [NIFTY went up {ups}x, down {downs}x in these windows]")

        found = [r for r in calls if r["confidence"] >= FOUND_THRESHOLD]
        if found:
            fr = sum(1 for r in found if r["direction"] == r["actual_direction"])
            flo, fhi = wilson(fr, len(found))
            print(f"Calls at >= {FOUND_THRESHOLD:.0f}% confidence (what the dashboard marks 'found'): {pct(fr / len(found))}  ({fr}/{len(found)}),  95% range {pct(flo)} to {pct(fhi)}")
        else:
            print(f"No calls reached {FOUND_THRESHOLD:.0f}% confidence, so the dashboard would have shown 0 'found' signals on these windows.")

        print("\nBy confidence bucket (if Kronos is useful, accuracy should rise as confidence rises):")
        edges = [0, 60, 70, 80, 90, 101]
        for a, b in zip(edges[:-1], edges[1:]):
            grp = [r for r in calls if a <= r["confidence"] < b]
            label = f"{a}-{min(b, 100)}%"
            if grp:
                g = sum(1 for r in grp if r["direction"] == r["actual_direction"])
                print(f"  {label:>8} : {pct(g / len(grp)):>5}  ({g}/{len(grp)})")
            else:
                print(f"  {label:>8} : no calls")

        # Plain-language reading, based only on the numbers above.
        print("\nReading:")
        if lo > max(base, 0.5):
            print("  The whole 95% range is above both a coin flip and the base rate: a POSSIBLE edge.")
            print("  Still needs more data and a different time period before trusting it.")
        else:
            print("  The 95% range still includes a coin flip or the base rate: NO EDGE SHOWN yet.")
            print("  (That is not proof there is none. A small sample can't show one either way.)")
    else:
        print("\nNo directional calls were made, so direction accuracy can't be scored.")

    mae_k = float(np.mean([abs(r["predicted_close"] - r["actual_close"]) for r in rows]))
    mae_n = float(np.mean([abs(r["current_close"] - r["actual_close"]) for r in rows]))
    verdict = "BETTER than" if mae_k < mae_n else "NOT better than"
    print(f"\nPrice error: Kronos {mae_k:.1f} pts vs 'no change' {mae_n:.1f} pts  -> Kronos is {verdict} simply assuming the price stays put.")

    secs = [float(r["wall_seconds"]) for r in rows if r.get("wall_seconds") not in (None, "")]
    if secs:
        print(f"Time per forecast: {np.mean(secs):.1f}s average")

    print("\nCaveats: windows overlap on the same day, so the ranges above are a bit optimistic.")
    if n < 100:
        print(f"n = {n} is small. Treat this as an early look, not a verdict.")


# ── Main ────────────────────────────────────────────────────────────────
def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def main():
    ap = argparse.ArgumentParser(description="Score Kronos forecasts against real NIFTY50 candles.")
    ap.add_argument("xlsx", help="Data Export file with NIFTY50-INDEX candles (15-minute)")
    ap.add_argument("--horizon", type=int, default=DEFAULT_HORIZON, help="bars ahead to forecast")
    ap.add_argument("--samples", type=int, default=DEFAULT_SAMPLES, help="forecast runs per call")
    ap.add_argument("--context", type=int, default=DEFAULT_CONTEXT, help="candles sent to the model (max 512)")
    ap.add_argument("--max-tests", type=int, default=DEFAULT_MAX_TESTS, help="how many past moments to score")
    ap.add_argument("--url", default=DEFAULT_URL, help="Kronos service address")
    ap.add_argument("--summary-only", action="store_true", help="just re-print results from the saved CSV")
    args = ap.parse_args()

    if not 1 <= args.context <= 512:
        die("--context must be between 1 and 512 (Kronos-small's limit).")

    data = load_candles(args.xlsx)
    bar_min = infer_bar_minutes(data["times_ms"])
    resolution = RESOLUTION_BY_MINUTES[bar_min]

    stem = os.path.splitext(os.path.basename(args.xlsx))[0]
    out_path = f"validation_{stem}_h{args.horizon}_s{args.samples}_c{args.context}.csv"
    title = f"({stem}, horizon {args.horizon} bars = {args.horizon * bar_min} min, {args.samples} samples, {args.context} candles)"

    if args.summary_only:
        summarize(read_rows(out_path), title)
        return

    picks, n_valid, valid = choose_test_points(data["times_ms"], bar_min, args.horizon, args.max_tests)
    if not picks:
        die("No usable test moments: need windows fully inside one trading day with enough earlier history. Try a smaller --horizon or a longer file.")

    tod = sorted({data["labels"][i][11:] for i in valid})
    print(f"Candles: {len(data['times_ms'])}  ({data['labels'][0]}  ->  {data['labels'][-1]}),  {bar_min}-minute bars")
    print(f"Windows fully inside one trading day: {n_valid}  (cutoff times of day span {tod[0]} to {tod[-1]})")
    print(f"Testing {len(picks)} of them.  Results file: {out_path}")

    if not service_alive(args.url):
        die(f"Kronos service not reachable at {args.url}.\nStart it in another window first:  uvicorn app:app --host 0.0.0.0 --port 8001")

    done = {r["cutoff_time"] for r in read_rows(out_path)}
    todo = [i for i in picks if data["labels"][i] not in done]
    if done:
        print(f"Resuming: {len(picks) - len(todo)} already done, {len(todo)} left.")
    print("Do NOT click Scan Now in the dashboard while this runs. Ctrl+C is safe.\n")

    new_file = not os.path.exists(out_path)
    errors_in_a_row = 0
    walls = []
    try:
        with open(out_path, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
            if new_file:
                w.writeheader()
            for n, i in enumerate(todo, 1):
                t0 = time.time()
                try:
                    res = call_forecast(args.url, data, i, args.context, resolution, args.horizon, args.samples)
                except RuntimeError as e:
                    errors_in_a_row += 1
                    print(f"[{n}/{len(todo)}] {data['labels'][i]}  FAILED: {e}")
                    if errors_in_a_row >= MAX_CONSECUTIVE_ERRORS:
                        print(f"\n{MAX_CONSECUTIVE_ERRORS} failures in a row — stopping. Check the Kronos service window.")
                        break
                    continue
                errors_in_a_row = 0
                wall = time.time() - t0
                walls.append(wall)

                current = data["close"][i]
                actual = data["close"][i + args.horizon]
                act_dir = actual_direction(current, actual)
                if res["direction"] == "neutral":
                    correct = ""
                else:
                    correct = str(res["direction"] == act_dir)
                w.writerow({
                    "cutoff_time": data["labels"][i], "cutoff_index": i,
                    "horizon": args.horizon, "samples": args.samples, "context": args.context,
                    "current_close": current, "predicted_close": res["predictedClose"],
                    "actual_close": actual, "direction": res["direction"],
                    "confidence": res["confidence"], "actual_direction": act_dir,
                    "correct": correct, "wall_seconds": round(wall, 2),
                    "compute_seconds": res.get("computeSeconds", ""),
                })
                f.flush()

                eta_min = (len(todo) - n) * (sum(walls) / len(walls)) / 60
                mark = "" if correct == "" else ("ok" if correct == "True" else "MISS")
                move = 100 * (actual - current) / current
                print(f"[{n}/{len(todo)}] {data['labels'][i]}  said {res['direction']:>7} {res['confidence']:>5.1f}%"
                      f"  | actual {act_dir:>4} ({move:+.2f}%)  {mark:>4}  | {wall:5.1f}s  | ~{eta_min:.1f} min left")
    except KeyboardInterrupt:
        print("\nStopped by you. Everything finished so far is saved.")

    summarize(read_rows(out_path), title)


if __name__ == "__main__":
    main()
