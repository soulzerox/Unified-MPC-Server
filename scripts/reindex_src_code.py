#!/usr/bin/env python3
"""Re-index every project under /home/qwerty/Documents/Src Code into the PRODUCTION DB.

One workspace at a time (like sessions) so the embed wait per unit stays short.
Incremental SHA256 cache makes unchanged files cheap; reports per-workspace
indexed/skipped/duration.

Usage:
  venv/bin/python scripts/reindex_src_code.py --dry-run   # list workspaces only
  venv/bin/python scripts/reindex_src_code.py
  venv/bin/python scripts/reindex_src_code.py --only webtrans_prepaid Translate
"""
import json
import logging
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from thai_rag.server import LocalContextServer

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("reindex")

SRC_ROOT = Path("/home/qwerty/Documents/Src Code")

# dirs whose names clash with the default excludes / are noise
SKIP_DIRS = {".mcp_test_temp", ".pytest_cache", ".scratch", "venv", ".venv", "node_modules", "test"}


def list_workspaces():
    out = []
    for d in sorted(SRC_ROOT.iterdir()):
        if not d.is_dir() or d.name.startswith(".") or d.name in SKIP_DIRS:
            continue
        out.append(d.name)
    return out


def reindex_one(server, name: str, only_names):
    if only_names and name not in only_names:
        return None
    root = SRC_ROOT / name
    t0 = time.time()
    try:
        res = server.retriever.index_workspace(str(root), force=False, progress_reporter=None)
        return {
            "workspace": name,
            "indexed": res.get("indexed", 0),
            "skipped": res.get("skipped", 0),
            "seconds": round(time.time() - t0, 2),
            "error": None,
        }
    except Exception as e:
        return {"workspace": name, "indexed": 0, "skipped": 0,
                "seconds": round(time.time() - t0, 2), "error": str(e)[:200]}


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    only = None
    if "--only" in sys.argv:
        i = sys.argv.index("--only")
        only = set(sys.argv[i + 1:])

    names = list_workspaces()
    if dry_run:
        print(f"Workspaces ({len(names)}): {', '.join(names)}")
        return 0

    server = LocalContextServer()
    try:
        results = []
        for name in names:
            r = reindex_one(server, name, only)
            if r:
                results.append(r)
                log.info("%s: indexed=%s skipped=%s %ss err=%s", r["workspace"],
                         r["indexed"], r["skipped"], r["seconds"], r["error"])
        print(json.dumps(results, ensure_ascii=False, indent=1))
        failed = [r for r in results if r["error"]]
        if failed:
            print(f"\n⚠️ {len(failed)} workspace(s) errored: " + ", ".join(r["workspace"] for r in failed))
    finally:
        server.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())