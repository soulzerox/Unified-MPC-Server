#!/usr/bin/env python3
"""Safely backfill missing CPG rows for already-indexed production files.

Older production databases may contain ``file_cache`` rows from before CPG-Lite
existed while ``code_symbols``/``code_edges`` are still empty for those files.
A normal incremental ``code_index`` can skip them because the content hash and
mtime have not changed. This script extracts only the missing CPG data; it does
not re-embed vector chunks.

Safety defaults:
- running with no flags is a read-only plan/dry-run;
- ``--apply`` is required before SQLite is mutated;
- an online SQLite backup is created before the first mutation;
- ambiguous or missing source paths are skipped rather than guessed;
- ``--only`` can limit work to named workspace prefixes.

Usage:
  venv/bin/python scripts/backfill_cpg.py
  venv/bin/python scripts/backfill_cpg.py --only thai-rag-mcp
  venv/bin/python scripts/backfill_cpg.py --apply --only thai-rag-mcp
"""
from __future__ import annotations

import argparse
import datetime as dt
import logging
import sqlite3
import sys
import time
from pathlib import Path
from typing import Iterable, Sequence

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from thai_rag.cpg_extractor import extract_cpg
from thai_rag.storage import StorageManager

DEFAULT_ROOTS: tuple[Path, ...] = (
    Path("/home/qwerty/Documents/Src Code"),
    Path("/home/qwerty"),
    Path("/mnt/562AEA8C2AEA6887"),
    Path("/home/qwerty/thai-rag-mcp"),
)

SUPPORTED_EXTS = frozenset({".py", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"})


def resolve_file(stored_path: str, roots: Sequence[Path] = DEFAULT_ROOTS) -> Path | None:
    """Resolve a stored canonical path conservatively.

    ``file_cache`` normally stores ``<workspace>/<relative-path>``. A root may
    either be the parent containing that workspace or the workspace directory
    itself. If more than one distinct file matches, return ``None`` rather than
    choosing an arbitrary source tree.
    """
    stored = Path(stored_path)
    if stored.is_absolute():
        return None
    parts = stored.parts
    if not parts:
        return None

    candidates: list[Path] = []
    for root in roots:
        root = Path(root)
        candidates.append(root / stored_path)
        if len(parts) >= 2:
            workspace = parts[0]
            relative = Path(*parts[1:])
            candidates.append(root / workspace / relative)
            if root.name == workspace:
                candidates.append(root / relative)

    matches: dict[str, Path] = {}
    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            resolved = candidate.resolve()
            matches[str(resolved)] = resolved
        except OSError:
            continue

    if len(matches) != 1:
        return None
    return next(iter(matches.values()))


def files_needing_backfill(storage: StorageManager, only: Iterable[str] | None = None) -> list[str]:
    """Return supported cached files that currently have no CPG symbols."""
    only_set = {entry for entry in (only or []) if entry}
    cur = storage.sqlite_conn.cursor()
    existing = {
        row[0]
        for row in cur.execute("SELECT DISTINCT file_path FROM code_symbols").fetchall()
        if row[0]
    }
    cached = [
        row[0]
        for row in cur.execute("SELECT DISTINCT file_path FROM file_cache").fetchall()
        if row[0]
    ]

    selected: list[str] = []
    for file_path in cached:
        if Path(file_path).suffix.lower() not in SUPPORTED_EXTS:
            continue
        if file_path in existing:
            continue
        workspace = file_path.split("/", 1)[0] if "/" in file_path else ""
        if only_set and workspace not in only_set:
            continue
        selected.append(file_path)
    return sorted(selected)


def backup_sqlite(storage: StorageManager) -> Path:
    """Create a consistent online backup of the SQLite database."""
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup_path = storage.sqlite_path.with_name(f"{storage.sqlite_path.name}.cpg-backfill-{stamp}.bak")
    with sqlite3.connect(str(backup_path)) as destination:
        storage.sqlite_conn.backup(destination)
    return backup_path


def run_backfill(
    storage: StorageManager,
    *,
    roots: Sequence[Path] = DEFAULT_ROOTS,
    only: Iterable[str] | None = None,
    apply: bool = False,
) -> dict[str, int]:
    """Plan or apply CPG backfill and return deterministic counters."""
    files = files_needing_backfill(storage, only)
    planned = applied = unresolved = failed = empty = 0

    for file_path in files:
        real_path = resolve_file(file_path, roots)
        if real_path is None:
            unresolved += 1
            logging.warning("unresolvable or ambiguous source path (skipped): %s", file_path)
            continue

        planned += 1
        if not apply:
            continue

        try:
            content = real_path.read_text(encoding="utf-8", errors="ignore")
            workspace = file_path.split("/", 1)[0] if "/" in file_path else ""
            symbols, edges = extract_cpg(file_path, content, workspace=workspace)
            storage.save_code_graph(file_path, symbols, edges, workspace=workspace)
            applied += 1
            if not symbols and not edges:
                empty += 1
                logging.info("no CPG symbols/edges extracted: %s", file_path)
        except Exception as exc:
            failed += 1
            logging.exception("CPG backfill failed for %s: %s", file_path, exc)

    return {
        "candidates": len(files),
        "planned": planned,
        "applied": applied,
        "unresolved": unresolved,
        "failed": failed,
        "empty": empty,
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write CPG rows after creating a SQLite backup")
    parser.add_argument("--only", nargs="+", default=None, metavar="WORKSPACE", help="limit to workspace prefix(es)")
    parser.add_argument(
        "--root",
        action="append",
        default=None,
        metavar="PATH",
        help="additional/alternate source root; repeat for multiple roots",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    roots = tuple(Path(value).expanduser() for value in args.root) if args.root else DEFAULT_ROOTS

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    storage = StorageManager()
    started = time.time()
    backup_path: Path | None = None
    try:
        candidates = files_needing_backfill(storage, args.only)
        print(f"Files needing CPG backfill: {len(candidates)}")
        if args.apply and candidates:
            backup_path = backup_sqlite(storage)
            print(f"SQLite backup: {backup_path}")
        elif not args.apply:
            print("Dry-run only. Re-run with --apply to write CPG rows.")

        result = run_backfill(storage, roots=roots, only=args.only, apply=args.apply)
        cur = storage.sqlite_conn.cursor()
        symbol_count = cur.execute("SELECT COUNT(*) FROM code_symbols").fetchone()[0]
        edge_count = cur.execute("SELECT COUNT(*) FROM code_edges").fetchone()[0]
    finally:
        storage.close()

    mode = "Backfill" if args.apply else "Plan"
    print(
        f"\n{mode} done in {round(time.time() - started, 1)}s: "
        f"{result['planned']} resolvable, {result['applied']} applied, "
        f"{result['unresolved']} unresolved, {result['failed']} failed, {result['empty']} empty"
    )
    print(f"code_symbols: {symbol_count}, code_edges: {edge_count}")
    if backup_path is not None:
        print(f"Backup retained at: {backup_path}")

    if args.apply and (result["unresolved"] or result["failed"]):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
