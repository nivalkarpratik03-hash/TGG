"""
inspect_parquet.py - shows what is inside Parquet files: columns + types, row counts, first rows, time range, symbols.
It only READS. Use it to tell me exactly what the 3 Parquet files (index / fut / opt) contain.

Run from the orderflow folder, venv active (one-time:  pip install pyarrow):
    python service\\inspect_parquet.py <a .parquet file OR a folder>
Examples:
    python service\\inspect_parquet.py data\\2026-10-16\\parquet
    python service\\inspect_parquet.py C:\\Users\\USER\\Desktop\\Project\\Pratik\\backend\\orderflow_data\\2026-10-16\\parquet
Copy the whole printed output and send it.
"""
import os
import sys

try:
    import pyarrow.parquet as pq
except ImportError:
    raise SystemExit("pyarrow is missing. Run:  pip install pyarrow")

MAX_FILES = 12
SYMBOL_NAMES = {"symbol", "sym", "ticker", "tradingsymbol", "instrument"}
TIME_HINTS = ("time", "ts", "date", "ms", "stamp")


def short(v, n=70):
    s = repr(v)
    return s if len(s) <= n else s[:n] + "...(" + str(len(s)) + " chars)"


def stats_range(pf, col_idx):
    lo = hi = None
    md = pf.metadata
    for g in range(md.num_row_groups):
        st = md.row_group(g).column(col_idx).statistics
        if st is None or not st.has_min_max:
            return None
        lo = st.min if lo is None else min(lo, st.min)
        hi = st.max if hi is None else max(hi, st.max)
    return lo, hi


def show(path):
    pf = pq.ParquetFile(path)
    md, schema = pf.metadata, pf.schema_arrow
    print(f"\nFILE {path}")
    print(f"  size {os.path.getsize(path) / 1e6:.2f} MB | rows {md.num_rows} | row groups {md.num_row_groups} | columns {len(schema)}")
    print("  columns:")
    for i, f in enumerate(schema):
        print(f"    {i:2d}  {f.name:24s} {f.type}")
    try:
        batch = next(pf.iter_batches(batch_size=2))
        rows = batch.to_pylist()
        print("  first rows:")
        for r in rows:
            print("    " + ", ".join(f"{k}={short(v)}" for k, v in r.items()))
    except StopIteration:
        print("  (no rows)")
    ranges = []
    for i, f in enumerate(schema):
        if any(h in f.name.lower() for h in TIME_HINTS):
            rg = stats_range(pf, i) if str(f.type).startswith(("int", "uint", "double", "float", "timestamp", "date")) else None
            if rg:
                ranges.append(f"{f.name}: {rg[0]} .. {rg[1]}")
    if ranges:
        print("  time-like columns (min .. max):")
        for r in ranges:
            print("    " + r)
    for f in schema:
        if f.name.lower() in SYMBOL_NAMES:
            seen, n = set(), 0
            for b in pf.iter_batches(batch_size=100000, columns=[f.name]):
                for v in b.column(0).to_pylist():
                    seen.add(v)
                n += b.num_rows
                if n >= 2_000_000 or len(seen) > 400:
                    break
            print(f"  symbols in '{f.name}' (scanned {n} rows): {len(seen)} distinct, e.g. {sorted(map(str, seen))[:8]}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    target = sys.argv[1]
    if os.path.isfile(target):
        files = [target]
    elif os.path.isdir(target):
        files = []
        for root, _, names in os.walk(target):
            files += [os.path.join(root, n) for n in sorted(names) if n.lower().endswith(".parquet")]
    else:
        raise SystemExit(f"Not found: {target}")
    if not files:
        raise SystemExit("No .parquet files found there.")
    print(f"{len(files)} parquet file(s) found; showing the first {min(len(files), MAX_FILES)}")
    for p in files[:MAX_FILES]:
        try:
            show(p)
        except Exception as e:
            print(f"\nFILE {p}\n  could not read: {type(e).__name__}: {e}")
    if len(files) > MAX_FILES:
        print(f"\n... and {len(files) - MAX_FILES} more file(s):")
        for p in files[MAX_FILES:MAX_FILES + 20]:
            print("  " + p)


if __name__ == "__main__":
    main()
