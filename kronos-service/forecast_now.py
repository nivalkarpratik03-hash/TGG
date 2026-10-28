"""
kronos-service/forecast_now.py

THE DAILY PREDICTION TOOL. Not a backtest. Run it during (or before)
market hours and it tells you, for NIFTY spot, what Kronos expects for
each upcoming candle: direction (UP / DOWN) + confidence + predicted
close, with the real NSE times those candles will print at.

WHAT IT DOES
  1. Fetches the latest real candles from your running Node backend
     (same Fyers login the dashboard uses — backend_candles.py).
  2. Drops the candle that is still forming (its close isn't final yet).
  3. Sends the last 512 finished candles to the Kronos service.
  4. Prints one line per future candle.
  5. The service saves the forecast (mode = "live") to forecast_log.jsonl,
     so compare_forecasts.py can score it once those candles have printed.

HOW TO READ CONFIDENCE
  Each forecast runs Kronos --samples times (default 9). "UP 78%" means
  7 of 9 runs ended that candle above the current close. It is agreement
  between runs, NOT a guaranteed hit rate. compare_forecasts.py tells you
  how often each confidence level is actually right; trust that number.
  (Backtest so far, 15min / 16 bars ahead: 90%+ calls were right ~71%.)

  Every forecasted candle is compared with the CURRENT close (the last
  finished candle), i.e. "will NIFTY be above or below where it is now,
  at 10:30?", which is what matters for picking a CE or PE.

REQUIRES  Kronos service running:  uvicorn app:app --host 0.0.0.0 --port 8001
          Node backend running (npm run dev) with a valid Fyers token.

RUN
  python forecast_now.py                          15min, rest of today's session
  python forecast_now.py --timeframe 1hr          1-hour candles
  python forecast_now.py --timeframe 5min --horizon 12
  python forecast_now.py --timeframe 15min,1hr    several timeframes, one after another
  python forecast_now.py --watch                  re-run after every new candle closes, until 15:30

--horizon: a number of candles, or "eod" (default) = until today's close.
If the market is closed, "eod" means the whole next trading session.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from nse_calendar import (RESOLUTION_MINUTES, SESSION_CLOSE, SESSION_OPEN, bar_is_complete,
                          future_bar_starts, ms_to_ist, now_ist)

DEFAULT_SYMBOL = "NSE:NIFTY50-INDEX"
DEFAULT_KRONOS_URL = "http://localhost:8001"
DEFAULT_BACKEND_URL = "http://localhost:5280"
DEFAULT_SAMPLES = 9          # odd = no up/down ties; 9 matches the backtest so its accuracy numbers apply
STRONG_CONFIDENCE = 77.0     # 7 of 9 runs agree -> marked with "<<"
MAX_CONTEXT = 512
MAX_HORIZON = 120            # app.py's limit
REQUEST_TIMEOUT_S = 900


def die(msg: str):
    print(f"\nERROR: {msg}\n")
    sys.exit(1)


def session_minutes() -> int:
    o = datetime.combine(datetime.today(), SESSION_OPEN)
    c = datetime.combine(datetime.today(), SESSION_CLOSE)
    return int((c - o).total_seconds() // 60)


def bars_per_day(resolution: str) -> int:
    if resolution == "1day":
        return 1
    return math.ceil(session_minutes() / RESOLUTION_MINUTES[resolution])


def days_to_fetch(resolution: str) -> int:
    """Calendar days of history needed to get ~512 finished candles."""
    trading_days = math.ceil(MAX_CONTEXT / bars_per_day(resolution)) + 2
    return math.ceil(trading_days * 7 / 5) + 10  # weekends + holiday buffer


def eod_horizon(last_bar_start: datetime, resolution: str) -> int:
    """Candles from the one after last_bar_start up to and including the
    last candle of that session. If last_bar_start already is the last
    candle of its session, the whole next session."""
    if resolution == "1day":
        return 5
    nxt = future_bar_starts(last_bar_start, resolution, bars_per_day(resolution) + 1)
    same_day = [t for t in nxt if t.date() == last_bar_start.date()]
    return len(same_day) if same_day else bars_per_day(resolution)


def fetch_finished_candles(symbol, resolution, backend_url):
    from backend_candles import BackendCandleError, default_from_date, fetch_candles_df
    import pandas as pd

    try:
        df = fetch_candles_df(symbol, default_from_date(days_to_fetch(resolution)), resolution,
                              backend_url=backend_url)
    except BackendCandleError as e:
        die(str(e))

    date_part = (df["Date"].dt.strftime("%Y-%m-%d")
                 if pd.api.types.is_datetime64_any_dtype(df["Date"]) else df["Date"].astype(str))
    df = df.assign(_ts=pd.to_datetime(date_part + " " + df["Time"].astype(str), errors="coerce"))
    df = df.dropna(subset=["_ts", "Open", "High", "Low", "Close"])
    df = df.sort_values("_ts").drop_duplicates("_ts").reset_index(drop=True)

    now = now_ist()
    complete = [bar_is_complete(t.to_pydatetime(), resolution, now) for t in df["_ts"]]
    dropped = len(df) - sum(complete)
    df = df[complete].reset_index(drop=True)
    if len(df) < 30:
        die(f"Only {len(df)} finished {resolution} candles came back — need at least 30.")

    from nse_calendar import ist_to_ms
    candles = [{
        "time": ist_to_ms(t.to_pydatetime()),
        "open": float(o), "high": float(h), "low": float(l), "close": float(c),
        "volume": float(v) if v == v else 0.0,
    } for t, o, h, l, c, v in zip(df["_ts"], df["Open"], df["High"], df["Low"], df["Close"],
                                   df["Volume"] if "Volume" in df.columns else [0.0] * len(df))]
    return candles[-MAX_CONTEXT:], dropped


def call_kronos(url, payload):
    req = urllib.request.Request(url + "/forecast", data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        die(f"Kronos service returned {e.code}: {e.read().decode('utf-8')[:300]}")
    except urllib.error.URLError as e:
        die(f"Could not reach the Kronos service at {url} — is it running? "
            f"(uvicorn app:app --host 0.0.0.0 --port 8001). Underlying error: {e.reason}")


def run_once(symbol, resolution, horizon_arg, samples, kronos_url, backend_url):
    print(f"\nFetching {symbol} {resolution} candles...")
    candles, dropped = fetch_finished_candles(symbol, resolution, backend_url)
    last = ms_to_ist(candles[-1]["time"])
    horizon = eod_horizon(last, resolution) if horizon_arg == "eod" else int(horizon_arg)
    horizon = max(1, min(horizon, MAX_HORIZON))

    note = f" (skipped {dropped} still-forming candle)" if dropped else ""
    print(f"Using {len(candles)} finished candles, last one {last:%Y-%m-%d %H:%M}{note}. "
          f"Forecasting {horizon} candles x {samples} runs...")

    t0 = time.time()
    res = call_kronos(kronos_url, {
        "candles": candles, "resolution": resolution, "horizon": horizon,
        "sample_count": samples, "symbol": symbol, "mode": "live",
    })
    took = time.time() - t0

    cur = res["currentClose"]
    print()
    print(f"{symbol}  {resolution}  |  now {cur:,.2f} (candle {last:%d %b %H:%M})  |  took {took:.0f}s")
    print("-" * 66)
    print(f"{'Candle (IST)':<18}{'Call':<9}{'Conf':>6}   {'Pred close':>11}{'vs now':>10}")
    print("-" * 66)
    prev_day = None
    for b in res["path"]:
        t = b.get("timeIST") or ms_to_ist(b["time"]).strftime("%Y-%m-%d %H:%M")
        day, hm = t[:10], t[11:]
        if prev_day is not None and day != prev_day:
            print(f"  -- next session {day} --")
        label = f"{datetime.strptime(day, '%Y-%m-%d'):%d %b} {hm}"
        call = {"up": "UP", "down": "DOWN", "neutral": "-"}[b["direction"]]
        mark = "  <<" if b["direction"] != "neutral" and b["confidence"] >= STRONG_CONFIDENCE else ""
        diff = b["predictedClose"] - cur
        print(f"{label:<18}{call:<9}{b['confidence']:>5.0f}%   {b['predictedClose']:>11,.2f}{diff:>+10.1f}{mark}")
        prev_day = day
    print("-" * 66)
    print(f"<< = at least {STRONG_CONFIDENCE:.0f}% of runs agree. Confidence = run agreement, not hit rate "
          f"(see compare_forecasts.py).")
    return last


def seconds_until_next_close(last_bar_start: datetime, resolution: str) -> float | None:
    """Seconds until the candle after last_bar_start has closed (+20s for
    the data to arrive). None once today's session is over."""
    nxt = future_bar_starts(last_bar_start, resolution, 1)[0]
    now = now_ist()
    if nxt.date() != now.date():
        return None
    end = min(nxt + timedelta(minutes=RESOLUTION_MINUTES[resolution]),
              datetime.combine(nxt.date(), SESSION_CLOSE))
    return max(0.0, (end - now).total_seconds()) + 20


def main():
    ap = argparse.ArgumentParser(description="Kronos forecast for the next candles, right now.")
    ap.add_argument("--symbol", default=DEFAULT_SYMBOL)
    ap.add_argument("--timeframe", default="15min",
                    help=f"one or more of {', '.join(RESOLUTION_MINUTES)}, comma-separated")
    ap.add_argument("--horizon", default="eod", help='candles ahead, or "eod" (default) = until today\'s close')
    ap.add_argument("--samples", type=int, default=DEFAULT_SAMPLES, help="Kronos runs per forecast (keep it odd)")
    ap.add_argument("--url", default=DEFAULT_KRONOS_URL, help="Kronos service address")
    ap.add_argument("--backend-url", default=DEFAULT_BACKEND_URL, help="Node backend address")
    ap.add_argument("--watch", action="store_true",
                    help="keep running: new forecast after every new candle closes, until 15:30 (one timeframe only)")
    args = ap.parse_args()

    tfs = [t.strip() for t in args.timeframe.split(",") if t.strip()]
    bad = [t for t in tfs if t not in RESOLUTION_MINUTES]
    if bad:
        die(f"Unknown timeframe {bad}. Use: {', '.join(RESOLUTION_MINUTES)}")
    if args.horizon != "eod" and not args.horizon.isdigit():
        die('--horizon must be a number or "eod"')
    if args.samples % 2 == 0:
        print(f"Note: --samples {args.samples} is even, so a 50/50 split shows as '-' (no call). Odd is better.")
    if args.watch and (len(tfs) != 1 or tfs[0] == "1day"):
        die("--watch works with exactly one intraday timeframe.")

    if not args.watch:
        for tf in tfs:
            run_once(args.symbol, tf, args.horizon, args.samples, args.url, args.backend_url)
        print()
        return

    tf = tfs[0]
    try:
        while True:
            last = run_once(args.symbol, tf, args.horizon, args.samples, args.url, args.backend_url)
            wait = seconds_until_next_close(last, tf)
            if wait is None:
                print("\nSession over for today — stopping watch.")
                break
            print(f"\nNext forecast after the next {tf} candle closes (~{wait / 60:.0f} min). Ctrl+C to stop.")
            time.sleep(wait)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
