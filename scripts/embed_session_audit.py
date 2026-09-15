#!/usr/bin/env python3
"""Embed Session Audit - ingest live Antigravity transcript into isolated temp RAG + probe for bugs."""
import json
import re
import sys
import time
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
from thai_rag.server import LocalContextServer

TRANSCRIPT = Path("/home/qwerty/.gemini/antigravity/brain/20499698-6d2f-4539-b942-92421d974b99/.system_generated/logs/transcript.jsonl")
WORKSPACE = "thai-rag-mcp"
AUDIT_TAGS = ["session-audit", "embed-test"]

def extract_turns(transcript_path=TRANSCRIPT, max_chars=2000):
    turns = []
    with open(transcript_path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue
            itype = item.get("type", "")
            content = item.get("content") or ""
            if itype == "USER_INPUT" and content:
                m = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", content, re.DOTALL)
                clean = m.group(1).strip() if m else content
                if len(clean) >= 10:
                    turns.append({"role": "user", "content": clean[:max_chars], "summary": clean[:150], "step_index": item.get("step_index"), "created_at": item.get("created_at", "")})
            elif itype == "PLANNER_RESPONSE" and content and len(content) > 30:
                turns.append({"role": "assistant", "content": content[:max_chars], "summary": content[:150], "step_index": item.get("step_index"), "created_at": item.get("created_at", "")})
    return turns

def ingest_turns(server, turns):
    ok, failures = 0, []
    t0 = time.time()
    for t in turns:
        try:
            res = server.remember_turn(role=t["role"], content=t["content"], workspace=WORKSPACE, summary=t["summary"], tags=list(AUDIT_TAGS))
            if res.startswith("✅") or "recorded" in res.lower():
                ok += 1
            else:
                failures.append("step %s: %s" % (t["step_index"], res[:120]))
        except Exception as e:
            failures.append("step %s: %s: %s" % (t["step_index"], type(e).__name__, e))
    return ok, failures, round(time.time() - t0, 2)

def probe_recall(server):
    cases = [("JWT authentication", None), ("MCP server priority", "decision"), ("openviking replacement", None), ("", None)]
    out = []
    for query, category in cases:
        try:
            res = server.recall(query, category=category, limit=5)
            out.append({"query": query[:60], "category": category, "ok": (not res.startswith("Error")) and ("No relevant" not in res), "preview": res[:300]})
        except Exception as e:
            out.append({"query": query[:60], "category": category, "ok": False, "preview": "%s: %s" % (type(e).__name__, e)})
    return out

def probe_code_search(server, do_index=True):
    out = {}
    if do_index:
        t0 = time.time()
        out["index"] = server.code_index(workspace_path=str(PROJECT_ROOT / "thai_rag"))
        out["index_s"] = round(time.time() - t0, 2)
    abs_filter = str(PROJECT_ROOT / "thai_rag" / "storage.py")
    for label, pf in [("none", None), ("relative", "thai_rag"), ("absolute", abs_filter)]:
        try:
            res = server.code_search("save_conversation_turn", top_k=3, path_filter=pf)
            out[label] = {"ok": "No code snippets" not in res, "preview": res[:250]}
        except Exception as e:
            out[label] = {"ok": False, "preview": "%s: %s" % (type(e).__name__, e)}
    return out

def probe_pre_edit(server):
    try:
        res = server.pre_edit_context(file_path=str(PROJECT_ROOT / "thai_rag" / "storage.py"), workspace=WORKSPACE, proposed_symbol="save_conversation_turn")
        return {"can_proceed": res.get("can_proceed"), "constraints": len(res.get("constraints", [])), "callers": len(res.get("blast_radius", {}).get("callers", [])), "callees": len(res.get("blast_radius", {}).get("callees", []))}
    except Exception as e:
        return {"error": "%s: %s" % (type(e).__name__, e)}

def main():
    quick = "--quick" in sys.argv
    turns = extract_turns()
    if quick:
        turns = turns[:50]
    report = {"total_turns": len(turns), "quick": quick, "ollama_alive": None, "bugs_found": []}
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(sqlite_path=Path(tmpdir) / "audit.db", chroma_path=str(Path(tmpdir) / "audit_chroma"))
        try:
            report["ollama_alive"] = server.embedder.is_alive()
            ok, failures, secs = ingest_turns(server, turns)
            report.update({"ingested_ok": ok, "ingest_failures": failures, "ingest_s": secs, "rate": round(ok / max(secs, 0.001), 1)})
            report["recall"] = probe_recall(server)
            for r in report["recall"]:
                if r["query"] == "" and r["ok"]:
                    report["bugs_found"].append("BUG?: empty recall query returned results instead of error/empty")
            report["code_search"] = probe_code_search(server, do_index=not quick)
            if not quick:
                cs = report["code_search"]
                if cs.get("none", {}).get("ok") and not cs.get("absolute", {}).get("ok"):
                    report["bugs_found"].append("BUG-10?: absolute path_filter returns nothing while no-filter hits")
            report["pre_edit"] = probe_pre_edit(server)
        finally:
            server.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
