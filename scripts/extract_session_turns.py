#!/usr/bin/env python3
"""Extract user/assistant text turns from a Cline session .messages.json and
report which are already present in the prod DB (content-hash dedupe)."""
import json, hashlib, re, sys
from pathlib import Path

PROJECT_ROOT = Path("/home/qwerty/thai-rag-mcp")
sys.path.insert(0, str(PROJECT_ROOT))


def extract_turns(messages_path: str, max_chars: int = 4000):
    """Parse Cline .messages.json -> list of (role, content, ts)."""
    turns = []
    data = json.load(open(messages_path, encoding="utf-8", errors="ignore"))
    msgs = data.get("messages", []) if isinstance(data, dict) else data
    for m in msgs:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        text_parts = []
        if isinstance(content, str):
            text_parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "thinking":
                    text_parts.append(f"[thinking] {block.get('thinking', '')}")
                elif btype == "tool_result":
                    c = block.get("content")
                    if isinstance(c, str):
                        text_parts.append(f"[tool_result] {c}")
                    elif isinstance(c, list):
                        for b2 in c:
                            if isinstance(b2, dict) and b2.get("type") == "text":
                                text_parts.append(f"[tool_result] {b2.get('text', '')}")
                elif btype == "tool_use":
                    text_parts.append(f"[tool_use {block.get('name', '')}]")
        text = "\n".join(p for p in text_parts if p).strip()
        if len(text) >= 10:
            nl = re.sub(r"\s+", " ", text).strip()
            turns.append({
                "role": role,
                "content": nl[:max_chars],
                "ts": m.get("ts") or m.get("timestamp", ""),
            })
    return turns


def extract_clean_turns(messages_path: str, max_chars: int = 4000, include_thinking: bool = False):
    """Like extract_turns but keeps ONLY durable user prompts and assistant answers —
    drops tool_result/tool_use noise and (optionally) thinking blocks."""
    turns = []
    data = json.load(open(messages_path, encoding="utf-8", errors="ignore"))
    msgs = data.get("messages", []) if isinstance(data, dict) else data
    for m in msgs:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        content = m.get("content")
        text_parts = []
        if isinstance(content, str):
            text_parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "thinking" and include_thinking:
                    text_parts.append(f"[thinking] {block.get('thinking', '')}")
                # tool_use/tool_result intentionally dropped
        text = "\n".join(p for p in text_parts if p).strip()
        if len(text) < 10:
            continue
        nl = re.sub(r"\s+", " ", text).strip()
        turns.append({
            "role": role,
            "content": nl[:max_chars],
            "ts": m.get("ts") or m.get("timestamp", ""),
        })
    return turns


def hash_turn(role, content):
    return hashlib.sha256(f"{role}|{content[:500]}".encode("utf-8")).hexdigest()[:32]


def main():
    import sqlite3
    con = sqlite3.connect("/home/qwerty/.cache/thai-rag-mcp/local_context.db")
    c = con.cursor()
    prod_hashes = set()
    for (role, content) in c.execute("SELECT role, content FROM conversation_turns").fetchall():
        prod_hashes.add(hash_turn(role or "", content or ""))
    con.close()

    sessions = {
        "9siv8 (ACTIVE current)": "/home/qwerty/.cline/data/sessions/1788901068933_9siv8/1788901068933_9siv8.messages.json",
        "7jnxw (completed)": "/home/qwerty/.cline/data/sessions/1788937152136_7jnxw/1788937152136_7jnxw.messages.json",
        "xo0js (completed)": "/home/qwerty/.cline/data/sessions/1788951791248_xo0js/1788951791248_xo0js.messages.json",
    }
    total_new = 0
    for label, path in sessions.items():
        try:
            turns = extract_turns(path)
        except Exception as e:
            print(f"{label}: EXTRACT ERROR {e}")
            continue
        new = [t for t in turns if hash_turn(t["role"], t["content"]) not in prod_hashes]
        total_new += len(new)
        print(f"{label}: {len(turns)} turns, {len(new)} not-in-prod")
        for t in new[:3]:
            print(f"   {t['role']}: {t['content'][:90]}")
    print("TOTAL NEW (candidate embed):", total_new)


if __name__ == "__main__":
    main()