"""
kronos-service/test_forecast.py

Chunk 2 verification — call the REAL /forecast endpoint (not /health) to
confirm the actual model produces sane output end-to-end. Run this AFTER
app.py is already running (uvicorn app:app ...) in another terminal.

Uses realistic synthetic NIFTY-like candles (not fetched from Fyers) —
good enough to confirm the pipeline works: request shape accepted,
Kronos runs, response comes back with sensible direction/confidence.
This does NOT prove Kronos's predictions are accurate for real trading
— only that the wiring works. Accuracy validation is a separate,
later step (backtest/research mode, already agreed on).

HOW TO RUN:
    cd kronos-service
    .venv\\Scripts\\Activate.ps1
    python test_forecast.py
"""

import time
import random
import json
import urllib.request
import urllib.error

URL = "http://localhost:8001/forecast"

# ── Build 100 realistic-ish 15-min NIFTY candles, oldest first ────────
random.seed(42)  # reproducible run-to-run, so re-running this file for
                  # comparison isn't fighting fresh random data every time
base_time_ms = int(time.time() * 1000) - 100 * 15 * 60 * 1000
price = 23500.0
candles = []
for i in range(100):
    open_ = price
    move = random.uniform(-15, 15)
    close = open_ + move
    high = max(open_, close) + random.uniform(0, 8)
    low = min(open_, close) - random.uniform(0, 8)
    candles.append({
        "time": base_time_ms + i * 15 * 60 * 1000,
        "open": round(open_, 2),
        "high": round(high, 2),
        "low": round(low, 2),
        "close": round(close, 2),
        "volume": random.randint(50000, 200000),
    })
    price = close

print(f"Sending {len(candles)} synthetic candles, last close = {candles[-1]['close']}")
print("Waiting for response (first real call may take a few seconds on CPU)...\n")

t0 = time.time()
payload = json.dumps({
    "candles": candles,
    "resolution": "15min",
    "horizon": 16,       # ~4 hours ahead at 15min — the default agreed on
    "sample_count": 20,  # keep modest for a quick manual test; the
                          # real speed benchmark (Chunk 3 prerequisite)
                          # will test larger counts properly
}).encode("utf-8")
req = urllib.request.Request(URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        status = resp.status
        body_text = resp.read().decode("utf-8")
except urllib.error.HTTPError as e:
    status = e.code
    body_text = e.read().decode("utf-8")
except urllib.error.URLError:
    print("ERROR: couldn't connect to", URL)
    print("Is uvicorn actually running? (uvicorn app:app --host 0.0.0.0 --port 8001)")
    raise SystemExit(1)

elapsed = time.time() - t0
print(f"HTTP {status} in {elapsed:.1f}s (wall-clock, includes network — compare to the response's own computeSeconds below)\n")

if status != 200:
    print("Response body:", body_text)
    raise SystemExit(1)

body = json.loads(body_text)
for k, v in body.items():
    print(f"  {k}: {v}")

print()
print("── Sanity checks ──")
print("direction is one of up/down/neutral:", body["direction"] in ("up", "down", "neutral"))
print("confidence is 0-100:", 0 <= body["confidence"] <= 100)
print("horizon echoed matches request (16):", body["horizon"] == 16)
print("sampleCount echoed matches request (20):", body["sampleCount"] == 20)
print()
print(f"Per-symbol compute time: {body['computeSeconds']}s")
print(f"  -> Rough estimate for a 350-symbol scan (sequential, no parallelism): "
      f"{body['computeSeconds'] * 350 / 60:.1f} minutes")
print("  This is the real speed number Chunk 3 needs before wiring the full scanner —")
print("  if this is too slow, options are: fewer sample_count, Kronos-mini instead of")
print("  Kronos-small, or running symbols in parallel batches (same pattern the")
print("  scanner already uses for its normal strategies).")
