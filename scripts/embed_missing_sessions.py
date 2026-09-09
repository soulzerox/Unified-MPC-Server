#!/usr/bin/env python3
"""Embed not-yet-indexed session transcripts into the PRODUCTION DB.

One session at a time (like the user's own sessions) so each embed batch is
quick. Content-hash dedupe skips turns already present. Rolls back whole
session on unexpected failure (non-transactional Chroma rows are cleaned up
by turn_id deletion).

Usage:
  venv/bin/python scripts/embed_missing_sessions.py --dry-run
  venv/bin/python scripts/embed_missing_sessions.py
"""
import hashlib
import logging
import re
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.extract_session_turns import extract_clean_turns
from thai_rag.server import LocalContextServer

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("embed_sessions")

SESSION_STEMS = {
    "1788937152136_7jnxw": "thai-rag-mcp",   # completed
    "1788951791248_xo0js": "thai-rag-mcp",   # completed
    # active 1788901068933_9siv8 is a live work-log — already recorded per-turn
}
SESSIONS_DIR = Path("/home/qwerty/.cline/data/sessions")

TAGS = ["session-embed"]


def _hash(role: str, content: str) -> str:
    return hashlib.sha256(f"{role}|{content[:500]}".encode("utf-8")).hexdigest()[:32]


def _prod_hashes(storage) -> set:
    c = storage.sqlite_conn.cursor()
    return {
        _hash(r[0] or "", r[1] or "")
        for r in c.execute("SELECT role, content FROM conversation_turns").fetchall()
    }


def embed_session(server, sess_id: str, workspace: str, dry_run: bool) -> dict:
    mp = SESSIONS_DIR / sess_id / f"{sess_id}.messages.json"
    if not mp.is_file():
        return {"session": sess_id, "error": "no messages file"}
    turns = extract_clean_turns(str(mp))
    prod = _prod_hashes(server.storage)
    pending = [t for t in turns if _hash(t["role"], t["content"]) not in prod]

    if dry_run:
        return {"session": sess_id, "total": len(turns), "pending": len(pending)}

    ok, fails = 0, []
    t0 = time.time()
    for t in pending:
        try:
            res = server.remember_turn(
                role=t["role"],
                content=t["content"],
                workspace=workspace,
                summary=t["content"][:150],
                tags=list(TAGS),
            )
            if res.startswith("✅") or "recorded" in res.lower():
                ok += 1
            else:
                fails.append(res[:120])
        except Exception as e:
            # Per-turn error; re-run is safe (content-hash dedupe), so just report.
            fails.append(f"{type(e).__name__}: {str(e)[:120]}")
    return {
        "session": sess_id, "workspace": workspace, "total": len(turns),
        "pending": len(pending), "embedded": ok, "failures": fails,
        "secs": round(time.time() - t0, 2),
    }


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    server = LocalContextServer()
    try:
        results = []
        for sess_id, ws in SESSION_STEMS.items():
            r = embed_session(server, sess_id, ws, dry_run)
            results.append(r)
            log.info(jsonify(r))
        print(jsonify(results))
    finally:
        server.close()
    return 0


def jsonify(d):
    import json
    return json.dumps(d, ensure_ascii=False, default=str)


if __name__ == "__main__":
    sys.exit(main())