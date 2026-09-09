#!/usr/bin/env python3
"""CPG-only overwrite refresh for the production index.

Finishes the R7 fix on disk: the TS arrow/method regex fix changed how symbols
and edges are extracted, but incremental code_index skips unchanged files, so
the stale (misattributed) edges stay. This script re-runs CPG extraction for
every indexed file and overwrites symbols/edges — no re-embed of chunks.

Usage: venv/bin/python scripts/refresh_cpg.py [--only wsA wsB ...]
"""
import logging
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from thai_rag.storage import StorageManager
from thai_rag.cpg_extractor import extract_cpg

ROOTS = [
    Path("/home/qwerty/Documents/Src Code"),
    Path("/home/qwerty"),
    Path("/home/qwerty/thai-rag-mcp"),
]

SUPPORTED_EXTS = {".py", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"}


def resolve_file(rel_path: str) -> Path | None:
    parts = Path(rel_path).parts
    candidates = []
    for root in ROOTS:
        candidates.append(root / rel_path)
        if len(parts) >= 2:
            candidates.append(root / "/".join(parts[1:]))
    for cand in candidates:
        try:
            if cand.is_file():
                return cand
        except Exception:
            continue
    return None


def main() -> int:
    only = None
    if "--only" in sys.argv:
        i = sys.argv.index("--only")
        only = set(sys.argv[i + 1:])

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    storage = StorageManager()
    cur = storage.sqlite_conn.cursor()
    files = [r[0] for r in cur.execute("SELECT DISTINCT file_path FROM file_cache").fetchall()]
    if only:
        files = [f for f in files if f.split("/")[0] in only]

    print(f"Files to refresh CPG: {len(files)}")
    t0 = time.time()
    ok, failed = 0, 0
    for fp in files:
        if Path(fp).suffix not in SUPPORTED_EXTS:
            continue
        real = resolve_file(fp)
        if real is None:
            failed += 1
            print(f"  SKIP (unresolvable): {fp}")
            continue
        try:
            content = real.read_text(encoding="utf-8", errors="ignore")
            ws = fp.split("/")[0] if "/" in fp else ""
            symbols, edges = extract_cpg(fp, content, workspace=ws)
            storage.save_code_graph(fp, symbols, edges, workspace=ws)
            ok += 1
        except Exception as e:
            failed += 1
            print(f"  FAIL: {fp}: {e}")

    n_sym = cur.execute("SELECT COUNT(*) FROM code_symbols").fetchone()[0]
    n_edge = cur.execute("SELECT COUNT(*) FROM code_edges").fetchone()[0]
    print(f"\nRefresh done: {ok} OK, {failed} failed, {round(time.time()-t0,1)}s")
    print(f"code_symbols now: {n_sym}, code_edges now: {n_edge}")
    storage.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())