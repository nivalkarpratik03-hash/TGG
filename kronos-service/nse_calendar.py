"""
kronos-service/nse_calendar.py

NSE trading calendar, shared by app.py, forecast_now.py and
compare_forecasts.py so all three agree on what "the next candle" is.

WHY THIS EXISTS: the old app.py made future bar times by adding 15 min
again and again from the last candle. A forecast made at 14:00 for 16
bars got times like 16:00 and 18:00, which never exist, so those bars
could never be compared. Here, the bar after the last bar of a session
is the FIRST bar of the next trading day (skipping weekends + holidays).

All times are IST wall-clock. NSE regular session: 09:15 - 15:30.

UPDATE NSE_HOLIDAYS EVERY YEAR (NSE publishes the list in December).
2026 list from NSE's equity / F&O holiday circular (weekday ones only).
If a holiday is missing here, forecasts still get scored correctly
(compare_forecasts.py matches by bar POSITION, not by clock time), only
the printed times for bars after that day would be off by a day.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
SESSION_OPEN = time(9, 15)
SESSION_CLOSE = time(15, 30)

NSE_HOLIDAYS = {
    # 2026
    date(2026, 1, 15), date(2026, 1, 26), date(2026, 3, 3), date(2026, 3, 26),
    date(2026, 3, 31), date(2026, 4, 3), date(2026, 4, 14), date(2026, 5, 1),
    date(2026, 5, 28), date(2026, 6, 26), date(2026, 9, 14), date(2026, 10, 2),
    date(2026, 10, 20), date(2026, 11, 10), date(2026, 11, 24), date(2026, 12, 25),
}

RESOLUTION_MINUTES = {"1min": 1, "3min": 3, "5min": 5, "15min": 15, "1hr": 60, "1day": 1440}


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in NSE_HOLIDAYS


def next_trading_day(d: date) -> date:
    d += timedelta(days=1)
    while not is_trading_day(d):
        d += timedelta(days=1)
    return d


def ms_to_ist(ms: int) -> datetime:
    """epoch ms -> naive IST wall-clock datetime (same on any machine)."""
    return datetime.fromtimestamp(ms / 1000, tz=IST).replace(tzinfo=None)


def ist_to_ms(dt: datetime) -> int:
    """naive IST wall-clock datetime -> epoch ms."""
    return int(dt.replace(tzinfo=IST).timestamp() * 1000)


def now_ist() -> datetime:
    return datetime.now(IST).replace(tzinfo=None)


def future_bar_starts(last_bar_start: datetime, resolution: str, n: int) -> list[datetime]:
    """Start times (naive IST) of the next n bars after last_bar_start,
    following the real NSE session: skips post-15:30, nights, weekends and
    holidays. For '1day', returns the next n trading dates at the same
    clock time as last_bar_start."""
    minutes = RESOLUTION_MINUTES[resolution]
    out: list[datetime] = []
    cur = last_bar_start
    if resolution == "1day":
        d = cur.date()
        for _ in range(n):
            d = next_trading_day(d)
            out.append(datetime.combine(d, cur.time()))
        return out

    step = timedelta(minutes=minutes)
    for _ in range(n):
        nxt = cur + step
        session_close = datetime.combine(cur.date(), SESSION_CLOSE)
        if nxt >= session_close or not is_trading_day(nxt.date()):
            nxt = datetime.combine(next_trading_day(cur.date()), SESSION_OPEN)
        out.append(nxt)
        cur = nxt
    return out


def bar_is_complete(bar_start: datetime, resolution: str, now: datetime | None = None) -> bool:
    """True once the candle starting at bar_start has fully closed.
    The last bar of a session ends at 15:30 even if it is shorter
    (e.g. the 15:15 1hr bar)."""
    now = now or now_ist()
    if resolution == "1day":
        return now >= datetime.combine(bar_start.date(), SESSION_CLOSE)
    end = bar_start + timedelta(minutes=RESOLUTION_MINUTES[resolution])
    end = min(end, datetime.combine(bar_start.date(), SESSION_CLOSE))
    return now >= end
