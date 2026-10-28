"""
kronos-service/app.py

The FastAPI wrapper around the Kronos model set up in Chunk 1. Pure
backend service — no UI, matches the "Kronos as an external forecast
service" direction. This is what the Node backend / any script calls
over HTTP (same pattern already used for Fyers — an external service
call, not an import).

WHAT /forecast RETURNS (changed — see "full per-bar path" below):
Earlier version only returned ONE number: where the price ends up at
the FINAL bar of the horizon. The actual ask is a full forecast —
every future candle, each with its own direction + confidence, so you
can watch it bar by bar (e.g. "said up at 90% for the 9:15 candle, still
up at 85% by 10:00...") and compare each one against the real candle
once it prints. So now `path` in the response has one entry per
forecasted bar, not just the last one.

HOW CONFIDENCE IS COMPUTED (documented here since it's a real design
decision, not something obvious from reading Kronos's own docs):
Kronos's predict() is stochastic (temperature/top_p sampling) — call it
twice with the same input and you can get two different forecasts.
The official README explicitly confirms sample_count passed to a SINGLE
predict() call is "Number of forecast paths to generate and average" —
i.e. one call with sample_count=N returns ONE already-averaged result,
not the N individual paths. That's not useful for a confidence score (an
average hides exactly the agreement/disagreement between runs that a
confidence figure needs). So this wrapper calls predict() N SEPARATE
times itself (N = sample_count from the request, each with the library's
own sample_count fixed at 1), each an independently-seeded run, and now
keeps EVERY bar of every run (not just the final bar). For each bar b:
  - direction[b] = whichever way (up/down) the MAJORITY of the N runs
    agree on, for that bar, vs the real last close
  - confidence[b] = what fraction of the N runs agreed with that majority
  - predictedClose[b] = the MEDIAN of the N runs' close at that bar
    (median, not mean: with an odd N it always sits on the same side of
    the current close as the majority direction, so price and call never
    contradict each other; one wild run can't drag it either)
This is the same Monte-Carlo-via-repeated-sampling approach a real
third-party Kronos API wrapper (github.com/fengwm64/kronos-api) already
uses for its own "confidence" field — confirms this is a sound, existing
pattern, not something invented for this project.

LOGGING, FOR THE "COMPARE AT DAY END" PART:
Every forecast this service makes gets appended to forecast_log.jsonl
(one JSON object per line) in this same folder — symbol, every bar's
prediction, and the real timestamp each bar is FOR. Nothing is deleted
or rotated automatically. compare_forecasts.py (separate script) reads
this log later and checks each bar against the real candle once the
market has printed it, using the same kind of Data Export file
validate_nifty.py already reads.

MARKET-HOURS TIMESTAMPS (fixed Oct 2026):
Future bar times now follow the real NSE session (nse_calendar.py): the
bar after 15:15 is the next trading day's 09:15, skipping weekends and
holidays. Before, the times just kept adding 15 min (16:00, 18:00...)
and those bars could never be compared. All times are explicit IST, so
the result no longer depends on the PC's clock setting.

SPEED: the N runs now go through ONE batched predict_batch() call (N
copies of the same input, each sampled independently) instead of N
separate predict() calls. Same maths, fewer passes through the model.

ONE REQUEST AT A TIME: a lock makes concurrent /forecast calls wait in
line instead of running the model in parallel (which crashed before).

RUNNING THIS (manually, before PM2 is wired up):
    cd kronos-service
    .venv\\Scripts\\Activate.ps1        (Windows, from Chunk 1's setup)
    pip install fastapi uvicorn         (new deps, not in Chunk 1's requirements.txt)
    uvicorn app:app --host 0.0.0.0 --port 8001

Then confirm it's alive: http://localhost:8001/health
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
from typing import Literal, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from model import Kronos, KronosTokenizer, KronosPredictor
from nse_calendar import IST, RESOLUTION_MINUTES, future_bar_starts, ist_to_ms, ms_to_ist

app = FastAPI(title="Kronos Forecast Service", version="1.0")

# Append-only log every /forecast call writes to — see this file's header
# ("LOGGING...") and compare_forecasts.py, the script that reads it back.
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "forecast_log.jsonl")

# ── Model loaded ONCE at process startup, not per-request ──────────────
# This is the whole reason this has to be a long-running process (PM2,
# not a one-off script) — loading these from Hugging Face / into memory
# takes real time, and Node calling this per-symbol across ~350 symbols
# needs the model already warm.
MAX_CONTEXT = 512  # hard architectural limit for Kronos-small — confirmed
                    # from the official repo, not a chosen setting

print("[Kronos] Loading tokenizer + model — this happens once at startup...")
_t0 = time.time()
tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=MAX_CONTEXT)
print(f"[Kronos] Ready in {time.time() - _t0:.1f}s")

# Only one forecast runs at a time (see header, "ONE REQUEST AT A TIME").
_model_lock = threading.Lock()
# RESOLUTION_MINUTES now lives in nse_calendar.py (same labels as before,
# mirroring candleExport.js's TIMEFRAME_TO_MINUTES).


class Candle(BaseModel):
    time: int  # epoch milliseconds — same unit every candle object in
               # the Node backend already uses (fyers/client.js's
               # parseIntraday()/parseRaw() both produce time in ms)
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class ForecastRequest(BaseModel):
    candles: list[Candle] = Field(..., description="Historical candles, oldest first")
    resolution: Literal["1min", "3min", "5min", "15min", "1hr", "1day"]
    horizon: int = Field(16, ge=1, le=120, description="Bars ahead to forecast — changeable per-request, nothing hardcoded")
    sample_count: int = Field(20, ge=1, le=100, description="Independent forecast runs for the confidence calculation")
    symbol: Optional[str] = Field(None, description="Optional — only used to label the log entry for compare_forecasts.py. Forecast math doesn't depend on it.")
    mode: Optional[str] = Field(None, description="'live' (forecast_now.py), 'backtest' (validate_nifty.py) or empty. compare_forecasts.py only scores 'live'.")


class BarForecast(BaseModel):
    time: int  # epoch ms (bar START) this forecasted bar is FOR — what compare_forecasts.py matches against the real candle
    timeIST: str  # same moment, readable, e.g. "2026-10-23 09:15"
    direction: Literal["up", "down", "neutral"]
    confidence: float  # 0-100
    predictedClose: float


class ForecastResponse(BaseModel):
    # Kept for backward compatibility with anything still reading the
    # single-number shape (e.g. kronosDirection.js's Scanner integration,
    # currently paused per the "no UI, pure forecast service" direction,
    # but not deleted — see the chat reply alongside this file for why).
    # These three always equal path[-1]'s direction/confidence/predictedClose.
    direction: Literal["up", "down", "neutral"]
    confidence: float
    predictedClose: float

    currentClose: float
    horizon: int
    resolution: str
    sampleCount: int
    computeSeconds: float

    # NEW — the actual ask: every forecasted bar, not just the last one.
    path: list[BarForecast]


@app.get("/health")
def health():
    return {"status": "ok", "model": "Kronos-small", "maxContext": MAX_CONTEXT}


@app.post("/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest):
    t0 = time.time()

    if len(req.candles) < 30:
        # Kronos CAN technically run on fewer, but a forecast built on a
        # tiny handful of candles isn't meaningful — this is a sanity
        # floor, not the 512 ceiling.
        raise HTTPException(400, f"Need at least 30 candles, got {len(req.candles)}")

    # Kronos-small's hard cap — truncate to the most recent MAX_CONTEXT
    # candles rather than erroring, since KronosPredictor does this
    # automatically anyway per its own docs; doing it explicitly here
    # means the request/response makes it obvious how much was actually used.
    candles = req.candles[-MAX_CONTEXT:]

    df = pd.DataFrame([{
        "open": c.open, "high": c.high, "low": c.low,
        "close": c.close, "volume": c.volume,
    } for c in candles])

    # IST wall-clock, explicitly — the model's time features (hour,
    # minute, weekday) must be market time no matter what the PC's clock
    # is set to.
    x_timestamp = pd.Series([ms_to_ist(c.time) for c in candles])

    # Real NSE session times for the future bars (see header,
    # "MARKET-HOURS TIMESTAMPS").
    last_ts = x_timestamp.iloc[-1].to_pydatetime()
    y_timestamp = pd.Series(future_bar_starts(last_ts, req.resolution, req.horizon))

    current_close = candles[-1].close

    # all_closes[sample_index][bar_index] — EVERY bar of EVERY run. Each
    # run must be kept separately for the confidence count (the library's
    # own sample_count averages runs together, which hides the agreement).
    # N copies of the same input in one batch = N independent runs.
    n = req.sample_count
    with _model_lock:
        pred_dfs = predictor.predict_batch(
            df_list=[df] * n,
            x_timestamp_list=[x_timestamp] * n,
            y_timestamp_list=[y_timestamp] * n,
            pred_len=req.horizon,
            T=1.0,
            top_p=0.9,
            sample_count=1,  # =1 deliberately — see this file's header
            verbose=False,
        )
    all_closes = np.stack([p["close"].to_numpy() for p in pred_dfs])

    def direction_and_confidence(closes_for_bar: np.ndarray):
        up = int(np.sum(closes_for_bar > current_close))
        down = int(np.sum(closes_for_bar < current_close))
        flat = req.sample_count - up - down
        if up > down and up > flat:
            return "up", 100.0 * up / req.sample_count
        if down > up and down > flat:
            return "down", 100.0 * down / req.sample_count
        # Tie or genuine flat majority — see the old version's comment,
        # same reasoning, now applied per-bar instead of once.
        return "neutral", 100.0 * flat / req.sample_count

    path: list[BarForecast] = []
    for b in range(req.horizon):
        bar_closes = all_closes[:, b]
        bdir, bconf = direction_and_confidence(bar_closes)
        bar_dt = y_timestamp.iloc[b].to_pydatetime()
        path.append(BarForecast(
            time=ist_to_ms(bar_dt), timeIST=bar_dt.strftime("%Y-%m-%d %H:%M"),
            direction=bdir, confidence=round(bconf, 2),
            predictedClose=round(float(np.median(bar_closes)), 4),
        ))

    compute_seconds = round(time.time() - t0, 3)
    final_bar = path[-1]

    response = ForecastResponse(
        direction=final_bar.direction,
        confidence=final_bar.confidence,
        predictedClose=final_bar.predictedClose,
        currentClose=current_close,
        horizon=req.horizon,
        resolution=req.resolution,
        sampleCount=req.sample_count,
        computeSeconds=compute_seconds,
        path=path,
    )

    # ── Log every forecast — see this file's header, "LOGGING..." ──────
    # Append-only, one line per forecast. Never blocks/fails the actual
    # response if writing the log has a problem (e.g. disk full) — a
    # forecast you can't later compare is better than no forecast at all.
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "requestedAt": datetime.now(IST).isoformat(),
                "mode": req.mode,
                "symbol": req.symbol,
                "resolution": req.resolution,
                "horizon": req.horizon,
                "sampleCount": req.sample_count,
                "currentClose": current_close,
                "currentCloseTime": candles[-1].time,
                "path": [p.model_dump() for p in path],
                "computeSeconds": compute_seconds,
            }) + "\n")
    except Exception as log_err:  # noqa: BLE001 — logging must never break the response
        print(f"[Kronos] WARNING: could not write to {LOG_PATH}: {log_err}")

    return response