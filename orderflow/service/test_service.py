"""
test_service.py - tests that run anywhere (they build their own small synthetic day, no real data needed).
Run from the orderflow folder, venv active:   python -m pytest -q service\\test_service.py
Needs:  pip install pytest httpx
"""
import json
import math
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = tempfile.mkdtemp(prefix="of_data_")
os.environ["ORDERFLOW_DATA"] = TMP
for p in (ROOT, HERE):
    sys.path.insert(0, p)

import pytest                                   # noqa: E402
from fastapi.testclient import TestClient       # noqa: E402

T0 = 1791950220                                  # 09:27 IST on 14-Oct-2026, a whole minute


def write_symbol(day, name, base, minutes=8):
    d = os.path.join(TMP, day, "symbols", name)
    os.makedirs(d, exist_ok=True)
    vol, lines = 1_000_000, [json.dumps({"t": "H", "schema": 2, "symbol": name, "depth_levels": 50})]
    for s in range(minutes * 60):
        ts = T0 + s
        px = base + 8 * math.sin(s / 40.0)
        if s % 2 == 0:
            vol += 50 if (s // 6) % 2 == 0 else 25
            lines.append(json.dumps({"t": "Q", "ts": ts + 0.1, "p": round(px, 1), "q": 25, "v": vol,
                                     "b": round(px - 0.5, 1), "a": round(px + 0.5, 1)}))
        if s % 2 == 1:
            bids = [[round(px - 0.5 - 0.5 * i, 1), 100 + 10 * i] for i in range(10)]
            asks = [[round(px + 0.5 + 0.5 * i, 1), 90 + 12 * i] for i in range(10)]
            lines.append(json.dumps({"t": "D", "ts": ts + 0.2, "bids": bids, "asks": asks, "snap": False}))
    open(os.path.join(d, "engine.jsonl"), "w").write("\n".join(lines) + "\n")


@pytest.fixture(scope="module")
def client():
    day = "2026-10-14_test"
    write_symbol(day, "NSE_NIFTY26OCTFUT", 22740)
    write_symbol(day, "NSE_NIFTY26O1922700CE", 120)
    write_symbol(day, "NSE_NIFTY26O1922700PE", 110)
    os.makedirs(os.path.join(TMP, "2026-10-14_noFUT", "symbols", "NSE_NIFTY26O1922700CE"), exist_ok=True)
    pq = os.path.join(TMP, "2026-10-14_pq", "symbols", "NSE_NIFTY26OCTFUT")
    os.makedirs(pq, exist_ok=True)
    open(os.path.join(pq, "engine.parquet"), "wb").write(b"PAR1")
    from service.app import app
    return TestClient(app)


def test_health_and_days(client):
    assert client.get("/health").json()["ok"] is True
    days = {d["day"]: d for d in client.get("/days").json()["days"]}
    assert days["2026-10-14_test"]["strikes"] == [22700]


def test_candles_shape(client):
    r = client.get("/candles", params={"day": "2026-10-14_test", "ceiling": 22750})
    assert r.status_code == 200
    j = r.json()
    assert len(j["candles"]) >= 5
    c = j["candles"][0]
    for k in ("time", "open", "high", "low", "close", "delta", "cvd", "labels", "quality", "low_quality"):
        assert k in c
    assert all(j["candles"][i]["time"] < j["candles"][i + 1]["time"] for i in range(len(j["candles"]) - 1))
    assert j["levels"]["ceiling"] == 22750
    assert j["meta"]["strike_used"] == 22700 and j["meta"]["ce_symbol"].endswith("CE")
    lines = j["state"]["lines"]                          # header + the 5 numbered lines
    assert len(lines) == 6 and lines[0].startswith("RUNNING STATE") and lines[5].startswith("5.")
    json.dumps(j, allow_nan=False)                       # strictly valid JSON (no NaN)


def test_heat_structure(client):
    h = client.get("/candles", params={"day": "2026-10-14_test", "ceiling": 22750}).json()["heat"]
    assert h["row_size"] == 5.0 and len(h["snapshots"]) > 10
    for s in h["snapshots"][:20]:
        assert s["t1"] > s["t0"]
        for row, b, a in s["cells"]:
            assert 0 <= b <= 1 and 0 <= a <= 1 and row % 5 == 0


def test_options_and_errors(client):
    p = {"day": "2026-10-14_test", "ceiling": 22750}
    assert client.get("/candles", params={**p, "heat": 0}).json()["heat"] is None
    assert len(client.get("/candles", params={**p, "last_n": 3}).json()["candles"]) == 3
    assert client.get("/candles", params={**p, "strike": 99999}).status_code == 404
    assert client.get("/candles", params={"day": "missing"}).status_code == 404
    assert client.get("/candles", params={"day": "..\\x"}).status_code == 400
    assert client.get("/candles", params={"day": "2026-10-14_noFUT"}).status_code == 404


def test_parquet_is_clearly_not_implemented_yet(client):
    r = client.get("/candles", params={"day": "2026-10-14_pq"})
    assert r.status_code == 501 and "Parquet" in r.json()["detail"]
