"""
inputs.py - finds the day folders in the stable input folder and picks the files for one day.

Stable input folder (default: <orderflow>\\data, or set ORDERFLOW_DATA):
    data\\<day folder name>\\symbols\\<SYMBOL>\\engine.jsonl        (+ atm_changes.jsonl next to symbols\\)
The day folder can have any name (2026-10-14, 2026-10-14_copy ...). You copy it in from the recorder project.

Readers: only JSONL is implemented, because that is the only format I have seen. The Parquet reader is a
clearly marked stub (read_events_parquet) - it gets written when the real Parquet files are available.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # <orderflow>
DATA_DIR = os.path.abspath(os.environ.get("ORDERFLOW_DATA") or os.path.join(ROOT, "data"))

FUT_RE = re.compile(r"^NSE_NIFTY\d{2}[A-Z]{3}FUT$")
OPT_RE = re.compile(r"(\d{5})(CE|PE)$")          # NIFTY strikes are 5 digits (22700)


class InputError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def engine_file(symbol_dir):
    """The file the engine reads for one symbol. JSONL today; Parquet is a placeholder."""
    p = os.path.join(symbol_dir, "engine.jsonl")
    if os.path.exists(p):
        return p
    pq = os.path.join(symbol_dir, "engine.parquet")
    if os.path.exists(pq):
        return pq
    return None


def read_events_parquet(path):
    raise InputError(
        "Parquet input is not implemented yet. It will be added once real Parquet files (and their columns) are "
        "available. Until then the day folder must contain symbols/<SYMBOL>/engine.jsonl.", status=501)


def install_reader(oe):
    """Make the engine's file loader accept the formats we support (engine file itself stays untouched)."""
    original = oe.load_events

    def load_events(path):
        if str(path).lower().endswith(".parquet"):
            return read_events_parquet(path)
        return original(path)

    oe.load_events = load_events


def day_path(day):
    if not day or any(c in day for c in ("/", "\\", "..")):
        raise InputError("Invalid day name.")
    p = os.path.join(DATA_DIR, day)
    if not os.path.isdir(p):
        raise InputError(f"Day folder not found: {p}", status=404)
    return p


def list_days():
    out = []
    if not os.path.isdir(DATA_DIR):
        return out
    for name in sorted(os.listdir(DATA_DIR)):
        sym = os.path.join(DATA_DIR, name, "symbols")
        if os.path.isdir(sym):
            syms = sorted(d for d in os.listdir(sym) if os.path.isdir(os.path.join(sym, d)))
            strikes = sorted({int(m.group(1)) for s in syms for m in [OPT_RE.search(s)] if m})
            out.append({"day": name, "symbols": syms, "strikes": strikes,
                        "has_atm_changes": os.path.exists(os.path.join(DATA_DIR, name, "atm_changes.jsonl"))})
    return out


def resolve(day, strike=None):
    """Pick the FUT file and one CE/PE pair. Returns paths + a description of what was chosen and why."""
    base = day_path(day)
    sym_root = os.path.join(base, "symbols")
    if not os.path.isdir(sym_root):
        raise InputError(f"No 'symbols' folder inside {base}", status=404)
    names = sorted(d for d in os.listdir(sym_root) if os.path.isdir(os.path.join(sym_root, d)))
    futs = [n for n in names if FUT_RE.match(n)]
    if not futs:
        raise InputError("No NIFTY futures folder (NSE_NIFTYyyMMMFUT) found in symbols/.", status=404)
    fut_file = engine_file(os.path.join(sym_root, futs[0]))
    if not fut_file:
        raise InputError(f"No engine.jsonl in {futs[0]}", status=404)

    pairs = {}                                       # strike -> {"CE": (name, file), "PE": (name, file)}
    for n in names:
        m = OPT_RE.search(n)
        f = engine_file(os.path.join(sym_root, n)) if m else None
        if m and f:
            pairs.setdefault(int(m.group(1)), {})[m.group(2)] = (n, f)
    avail = {k: {"CE": "CE" in v, "PE": "PE" in v,
                 "bytes": sum(os.path.getsize(x[1]) for x in v.values())} for k, v in sorted(pairs.items())}
    chosen, why = None, ""
    if strike is not None:
        if int(strike) not in pairs:
            raise InputError(f"Strike {strike} not found. Available: {sorted(pairs)}", status=404)
        chosen, why = int(strike), "requested"
    else:
        full = {k: v for k, v in pairs.items() if "CE" in v and "PE" in v}
        pool = full or pairs
        if pool:
            chosen = max(pool, key=lambda k: sum(os.path.getsize(x[1]) for x in pool[k].values()))
            why = "most data (the engine reads ONE CE and ONE PE file; strikes are not stitched yet)"
    ce = pairs.get(chosen, {}).get("CE") if chosen else None
    pe = pairs.get(chosen, {}).get("PE") if chosen else None

    changes = []
    p = os.path.join(base, "atm_changes.jsonl")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8"):
            if line.strip():
                try:
                    changes.append(json.loads(line))
                except ValueError:
                    pass
    return {
        "fut_symbol": futs[0], "fut_file": fut_file,
        "strike": chosen, "strike_reason": why,
        "ce_symbol": ce[0] if ce else None, "ce_file": ce[1] if ce else None,
        "pe_symbol": pe[0] if pe else None, "pe_file": pe[1] if pe else None,
        "strikes_available": avail, "atm_changes": changes,
    }
