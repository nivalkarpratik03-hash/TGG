"""
app.py - Order-flow engine service (FastAPI). Same idea as kronos-service: the Node backend calls it over HTTP.

Start (inside the orderflow folder, with the venv active):
    pip install -r service\\requirements.txt
    python -m uvicorn service.app:app --port 8002

    GET /health
    GET /days                                   day folders found in the stable input folder
    GET /candles?day=<folder>&ceiling=22750&floor=22600&strike=22700&last_n=60&heat=1&full=0
"""
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
for p in (ROOT, HERE, os.environ.get("ORDERFLOW_ENGINE_DIR", "")):
    if p and p not in sys.path:
        sys.path.insert(0, p)

from fastapi import FastAPI, HTTPException, Query            # noqa: E402
from fastapi.middleware.cors import CORSMiddleware           # noqa: E402

import inputs                                                  # noqa: E402
import exporter                                                # noqa: E402

try:
    import orderflow_engine as oe                              # sir's file, untouched
except ImportError as e:                                       # pragma: no cover
    raise SystemExit("orderflow_engine.py not found. It must sit in the orderflow folder "
                     f"({ROOT}) or in ORDERFLOW_ENGINE_DIR. ({e})")
inputs.install_reader(oe)

app = FastAPI(title="orderflow-service", version="0.1")
app.add_middleware(CORSMiddleware, allow_methods=["GET"], allow_headers=["*"],
                   allow_origins=os.environ.get("ORDERFLOW_CORS", "http://localhost:3000,http://localhost:3001").split(","))

_cache, _lock = {}, threading.Lock()


@app.get("/health")
def health():
    return {"ok": True, "engine": getattr(oe, "__file__", "?"), "data_dir": inputs.DATA_DIR,
            "days": len(inputs.list_days())}


@app.get("/days")
def days():
    return {"data_dir": inputs.DATA_DIR, "days": inputs.list_days()}


@app.get("/candles")
def candles(day: str, ceiling: float | None = None, floor: float | None = None, strike: int | None = None,
            last_n: int | None = Query(None, ge=1), heat: int = 1, full: int = 0):
    try:
        sel = inputs.resolve(day, strike)
    except inputs.InputError as e:
        raise HTTPException(e.status, str(e))
    files = [sel["fut_file"], sel["ce_file"], sel["pe_file"]]
    stamp = tuple((f, os.path.getmtime(f), os.path.getsize(f)) for f in files if f)
    key = (day, ceiling, floor, sel["strike"], last_n, heat, full, stamp)
    with _lock:
        if key in _cache:
            return _cache[key]
    levels = [{"from": 0, "ceiling": ceiling, "floor": floor}]
    try:
        eng, rows, state = oe.replay(sel["fut_file"], levels, sel["ce_file"], sel["pe_file"], None, None)
    except inputs.InputError as e:
        raise HTTPException(e.status, str(e))
    except Exception as e:
        raise HTTPException(500, f"Engine failed: {type(e).__name__}: {e}")
    if not eng.records:
        raise HTTPException(422, "The engine finalized 0 candles from these files (is there enough data?).")
    out = exporter.export(oe, eng, state, last_n=last_n, heat=bool(heat), full=bool(full))
    out["meta"] = {
        "day": day, "fut_symbol": sel["fut_symbol"], "strike_used": sel["strike"], "strike_reason": sel["strike_reason"],
        "ce_symbol": sel["ce_symbol"], "pe_symbol": sel["pe_symbol"], "n_candles": len(out["candles"]),
        "first_label": out["candles"][0]["label"], "last_label": out["candles"][-1]["label"],
        "strikes_available": sel["strikes_available"], "atm_changes": sel["atm_changes"],
        "witness_note": "CE/PE witness uses ONE strike's files only; strikes are not stitched yet.",
        "levels_source": "query parameters" if (ceiling is not None or floor is not None) else "none given",
    }
    with _lock:
        if len(_cache) > 20:
            _cache.clear()
        _cache[key] = out
    return out
