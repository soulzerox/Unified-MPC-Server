#!/usr/bin/env python3
"""One-off migration: canonicalize bare (non-prefixed) file_path rows.

Prod DB has mixed formats (BUG-R2): some rows 'ws/rel', some bare 'rel'.
This rewrites bare rows to '<ws>/<rel>' when the workspace is determinable.
Idempotent — second run migrates 0. No re-embedding.

Usage: venv/bin/python scripts/normalize_bare_paths.py
"""
import sys
import logging
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from thai_rag.storage import StorageManager

WORKSPACE_ROOTS = [
    Path("/home/qwerty/Documents/Src Code"),
    Path("/home/qwerty"),
    Path("/mnt/562AEA8C2AEA6887"),
    Path("/home/qwerty/Documents/Src Code/sync tab"),
]


def _workspace_for(fp: str, storage: StorageManager) -> str | None:
    """Best-effort workspace name for a bare path, else None."""
    # 1. a file_cache canonical row whose '<ws>/<rel>' suffix equals fp exactly
    cur = storage.sqlite_conn.cursor()
    rows = cur.execute(
        "SELECT DISTINCT file_path FROM file_cache WHERE file_path LIKE ?",
        (f"%/{fp}",),
    ).fetchall()
    candidates = []
    for (cand,) in rows:
        if "/" in cand:
            head, rest = cand.split("/", 1)
            if head and rest == fp:
                candidates.append(head)
    if candidates:
        return candidates[0]
    # 2. literally-exists under a known workspace root
    for root in WORKSPACE_ROOTS:
        for cand in (root / fp, root / fp.lstrip("/")):
            try:
                if cand.is_file():
                    return cand.parts[-2]
            except Exception:
                continue
    return None


def normalize_bare_paths(storage: StorageManager) -> dict:
    """Canonicalize bare file_path rows in SQLite + Chroma. Idempotent."""
    migrated = 0
    unresolved = 0
    con = storage.sqlite_conn
    cur = con.cursor()

    bare = set()
    for table, col in (
        ("parent_documents", "file_path"),
        ("code_symbols", "file_path"),
        ("file_cache", "file_path"),
        ("code_edges", "source_file"),
        ("code_edges", "target_file"),
    ):
        try:
            for (fp,) in cur.execute(f"SELECT DISTINCT {col} FROM {table}").fetchall():
                if fp and "/" not in fp:
                    bare.add(fp)
        except Exception as e:
            logging.warning("scan %s.%s failed: %s", table, col, e)

    for fp in sorted(bare):
        ws = _workspace_for(fp, storage)
        if not ws:
            unresolved += 1
            logging.warning("unresolvable bare path (skipped): %s", fp)
            continue
        canonical = f"{ws}/{fp}"
        try:
            with con:
                for table, col in (
                    ("parent_documents", "file_path"),
                    ("code_symbols", "file_path"),
                    ("file_cache", "file_path"),
                ):
                    cur.execute(f"UPDATE {table} SET {col} = ? WHERE {col} = ?", (canonical, fp))
                cur.execute("UPDATE code_edges SET source_file = ? WHERE source_file = ?", (canonical, fp))
                cur.execute("UPDATE code_edges SET target_file = ? WHERE target_file = ?", (canonical, fp))
            migrated += 1
        except Exception as e:
            logging.warning("migrate %s -> %s failed: %s", fp, canonical, e)
            unresolved += 1

        # Chroma child metadata rewrite (file_path + workspace)
        try:
            count = storage.code_collection.count()
            if count:
                got = storage.code_collection.get(where={"file_path": fp}, limit=count)
                ids = (got or {}).get("ids", []) or []
                metas = (got or {}).get("metadatas", []) or []
                if ids:
                    new_metas = []
                    for m in metas:
                        nm = dict(m or {})
                        nm["file_path"] = canonical
                        if not nm.get("workspace"):
                            nm["workspace"] = ws
                        new_metas.append(nm)
                    storage.code_collection.update(ids=ids, metadatas=new_metas)
        except Exception as e:
            logging.warning("chroma rewrite for %s failed: %s", fp, e)

    return {"migrated": migrated, "unresolvable": unresolved}


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    storage = StorageManager()
    try:
        result = normalize_bare_paths(storage)
        n_bare = storage.sqlite_conn.cursor().execute(
            "SELECT COUNT(*) FROM parent_documents WHERE file_path NOT LIKE '%/%'"
        ).fetchone()[0]
        print(f"\nMigration done: {result['migrated']} migrated, "
              f"{result['unresolvable']} skipped. Remaining bare parent rows: {n_bare}")
    finally:
        storage.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())