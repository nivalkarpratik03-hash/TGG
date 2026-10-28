"""
kronos-service/backend_candles.py

Fetches candles straight from the running Node backend's Data Export
route (/api/data-export/download) instead of a manually downloaded
Excel file. Shared by validate_nifty.py and compare_forecasts.py so
there's one fetch implementation, not two.

WHY THIS EXISTS: the backend is already logged into Fyers (same token
your dashboard uses), already has this exact route built and tested
(see oi-iv-data-export-handoff.md), and streams back the same file
shape a manual Data Export download would — just fresh, with no manual
download step. Reusing it means no second Fyers login/token setup is
needed in Python at all.

REQUIRES: the backend running (npm run dev, same as always) and a valid
Fyers token (same requirement Data Export already has in the dashboard —
if the token's expired, this fails with the same clear message the
dashboard would show).
"""

from __future__ import annotations

import io
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import pandas as pd

DEFAULT_BACKEND_URL = "http://localhost:5280"
IST = timezone(timedelta(hours=5, minutes=30))


class BackendCandleError(Exception):
    pass


def fetch_candles_df(symbol: str, from_date: str, timeframe: str, to_date: str | None = None,
                      backend_url: str = DEFAULT_BACKEND_URL) -> pd.DataFrame:
    """
    Fetches candles for `symbol` from `from_date` (YYYY-MM-DD) through
    today (or `to_date` if given) at `timeframe` (e.g. "15min"), via the
    backend's real /api/data-export/download route — the exact same
    route and params the dashboard's Data Export page itself uses.

    Returns a DataFrame with the same columns the route's .xlsx always
    has: Symbol, Date, Time, Open, High, Low, Close, Volume.

    Raises BackendCandleError with a clear, specific reason on failure
    (backend not running, token expired/invalid, no candles for that
    range) — never returns an empty/partial result silently.
    """
    params = {"symbol": symbol, "from": from_date, "timeframe": timeframe}
    if to_date:
        params["to"] = to_date
    url = f"{backend_url}/api/data-export/download?{urllib.parse.urlencode(params)}"

    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code == 401:
            raise BackendCandleError(
                "Fyers token is expired or invalid (same as the dashboard would show). "
                "Open the dashboard and re-generate it at /admin, then retry."
            ) from e
        if e.code == 404:
            raise BackendCandleError(f"No candles found for {symbol} in that date range. Response: {body}") from e
        raise BackendCandleError(f"Backend returned HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise BackendCandleError(
            f"Could not reach the backend at {backend_url} — is it running? (npm run dev, same as always). "
            f"Underlying error: {e.reason}"
        ) from e

    try:
        df = pd.read_excel(io.BytesIO(raw))
    except Exception as e:  # noqa: BLE001 — the backend returned something that isn't a valid xlsx
        raise BackendCandleError(
            f"Backend responded, but it wasn't a readable Excel file — got {len(raw)} bytes. "
            f"First 200 bytes: {raw[:200]!r}"
        ) from e

    need = ["Date", "Time", "Open", "High", "Low", "Close"]
    missing = [c for c in need if c not in df.columns]
    if missing:
        raise BackendCandleError(f"Backend's file is missing columns {missing}. Found: {list(df.columns)}")
    if "Volume" not in df.columns:
        df["Volume"] = 0
    return df


def default_from_date(days_back: int) -> str:
    return (datetime.now(IST) - timedelta(days=days_back)).strftime("%Y-%m-%d")


if __name__ == "__main__":
    # Quick manual check: python backend_candles.py NSE:NIFTY50-INDEX 15min 5
    if len(sys.argv) < 4:
        print("Usage: python backend_candles.py <symbol> <timeframe> <days_back> [backend_url]")
        sys.exit(1)
    symbol, timeframe, days_back = sys.argv[1], sys.argv[2], int(sys.argv[3])
    backend_url = sys.argv[4] if len(sys.argv) > 4 else DEFAULT_BACKEND_URL
    try:
        df = fetch_candles_df(symbol, default_from_date(days_back), timeframe, backend_url=backend_url)
        print(f"Fetched {len(df)} candles for {symbol}")
        print(df.head(3).to_string())
        print(df.tail(3).to_string())
    except BackendCandleError as e:
        print(f"\nERROR: {e}\n")
        sys.exit(1)
