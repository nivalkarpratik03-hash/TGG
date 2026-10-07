"""
kronos-service/app.py

Chunk 2 — the FastAPI wrapper around the Kronos model set up in Chunk 1.
This is what the Node backend calls over HTTP (same pattern it already
uses for Fyers — an external service call, not an import).

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
own sample_count fixed at 1), each an independently-seeded run. From
those N independent forecasts:
  - direction = whichever way (up/down) the MAJORITY of the N runs agree on
  - confidence = what fraction of the N runs agreed with that majority
  - predictedClose = the mean of the N runs' final predicted close
This is the same Monte-Carlo-via-repeated-sampling approach a real
third-party Kronos API wrapper (github.com/fengwm64/kronos-api) already
uses for its own "confidence" field — confirms this is a sound, existing
pattern, not something invented for this project.

RUNNING THIS (manually, before PM2 is wired up):
    cd kronos-service
    .venv\\Scripts\\Activate.ps1        (Windows, from Chunk 1's setup)
    pip install fastapi uvicorn         (new deps, not in Chunk 1's requirements.txt)
    uvicorn app:app --host 0.0.0.0 --port 8001

Then confirm it's alive: http://localhost:8001/health
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from model import Kronos, KronosTokenizer, KronosPredictor

app = FastAPI(title="Kronos Forecast Service", version="1.0")

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

# Resolution label -> minutes, mirrors the labels the Node side already
# uses (candleExport.js's TIMEFRAME_TO_MINUTES) so nothing new is invented
# on this side either.
RESOLUTION_MINUTES = {
    "1min": 1, "3min": 3, "5min": 5, "15min": 15,
    "1hr": 60, "1day": 1440,
}


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


class ForecastResponse(BaseModel):
    direction: Literal["up", "down", "neutral"]
    confidence: float  # 0-100
    currentClose: float
    predictedClose: float
    horizon: int
    resolution: str
    sampleCount: int
    computeSeconds: float


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

    x_timestamp = pd.Series([
        datetime.fromtimestamp(c.time / 1000) for c in candles
    ])

    interval_minutes = RESOLUTION_MINUTES[req.resolution]
    last_ts = x_timestamp.iloc[-1]
    y_timestamp = pd.Series([
        last_ts + timedelta(minutes=interval_minutes * (i + 1))
        for i in range(req.horizon)
    ])

    current_close = candles[-1].close
    final_closes = []

    # N independent runs — see this file's header for exactly why this
    # loop exists instead of relying on predict()'s own sample_count.
    for i in range(req.sample_count):
        pred_df = predictor.predict(
            df=df,
            x_timestamp=x_timestamp,
            y_timestamp=y_timestamp,
            pred_len=req.horizon,  # required explicitly, confirmed from the
                                    # official README's real example — not
                                    # inferred from y_timestamp's length alone
            T=1.0,
            top_p=0.9,
            sample_count=1,  # =1 deliberately, not req.sample_count — see
                              # this file's header: the official docs
                              # confirm sample_count>1 in ONE call returns
                              # an already-averaged result, not individual
                              # paths, so this file calls predict() in a
                              # loop instead to get genuinely independent
                              # runs for its own confidence calculation
            verbose=False,
        )
        final_closes.append(float(pred_df["close"].iloc[-1]))

    final_closes = np.array(final_closes)
    up_count = int(np.sum(final_closes > current_close))
    down_count = int(np.sum(final_closes < current_close))
    flat_count = req.sample_count - up_count - down_count

    if up_count > down_count and up_count > flat_count:
        direction = "up"
        confidence = 100.0 * up_count / req.sample_count
    elif down_count > up_count and down_count > flat_count:
        direction = "down"
        confidence = 100.0 * down_count / req.sample_count
    else:
        # Two ways to land here: a genuine flat majority (rare — the
        # sampled paths would have to land on the exact current close),
        # or an exact up/down tie (up_count == down_count, more plausible
        # with a smaller sample_count). Either way this reports
        # direction="neutral" with confidence = flat_count/N, which is 0%
        # in the tie case since literally 0 samples were flat — that's
        # correct as "0% agreed on neutral," just worth knowing this
        # collapses "50% up / 50% down, no majority" and "everyone
        # predicted exactly flat" into the same label. Confirmed via
        # testing this happens on real coin-flip-ish inputs, not
        # theoretical — a future version could return the full
        # up/down/flat split instead of one collapsed label+number.
        direction = "neutral"
        confidence = 100.0 * flat_count / req.sample_count

    return ForecastResponse(
        direction=direction,
        confidence=round(confidence, 2),
        currentClose=current_close,
        predictedClose=round(float(np.mean(final_closes)), 4),
        horizon=req.horizon,
        resolution=req.resolution,
        sampleCount=req.sample_count,
        computeSeconds=round(time.time() - t0, 3),
    )
