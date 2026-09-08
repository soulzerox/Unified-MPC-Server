#!/usr/bin/env python3
"""One-off & On-demand Historical Chat & Decision Ingestion Script.

Harvests historical decisions and chat logs from:
1. Cline Knowledge Graph (~/.cline/data/memory/knowledge-graph.jsonl)
2. Antigravity Brain Transcripts (~/.gemini/antigravity/brain/*/transcript.jsonl)

Transforms them into searchable RAG memories (SQLite FTS5 + ChromaDB Vectors).
"""
import os
import re
import sys
import json
import uuid
import hashlib
from pathlib import Path
from typing import List, Dict, Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from thai_rag.server import get_server

def generate_stable_id(prefix: str, content: str) -> str:
    h = hashlib.sha256(content.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{h}"

def ingest_cline_knowledge_graph(server, kg_path: Path) -> int:
    if not kg_path.is_file():
        print(f"⚠️ Knowledge graph file not found at: {kg_path}")
        return 0

    count = 0
    print(f"📖 Ingesting Cline Knowledge Graph from: {kg_path}")
    with open(kg_path, "r", encoding="utf-8", errors="ignore") as fp:
        for line in fp:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception:
                continue

            if item.get("type") == "entity":
                name = item.get("name", "")
                etype = item.get("entityType", "general")
                obs_list = item.get("observations", [])

                # Determine workspace from name/obs
                combined_text = f"{name} " + " ".join(obs_list)
                ws = "general"
                for known_ws in ["webtrans_prepaid", "webtrans_violentmonkey", "World_Engine", "Voice Novel", "Translate", "livetranslate", "thai-rag-mcp"]:
                    if known_ws.lower() in combined_text.lower():
                        ws = known_ws
                        break

                for obs in obs_list:
                    turn_id = generate_stable_id("cline_kg", f"{name}:{obs}")
                    tags = [etype, ws, name]

                    # Save to storage
                    vector = None
                    if server.embedder.is_alive():
                        try:
                            vector = server.embedder.embed_document(f"[{ws}] {name}: {obs}")
                        except Exception:
                            pass

                    server.storage.save_conversation_turn(
                        turn_id=turn_id,
                        workspace=ws,
                        role="cline_memory",
                        content=f"[{name}] {obs}",
                        summary=name,
                        tags=tags,
                        embedding=vector
                    )
                    count += 1

    print(f"✅ Ingested {count} observations from Cline Knowledge Graph.")
    return count

def ingest_antigravity_transcripts(server, brain_dir: Path) -> int:
    if not brain_dir.is_dir():
        print(f"⚠️ Brain directory not found at: {brain_dir}")
        return 0

    count = 0
    print(f"🧠 Ingesting Antigravity Brain Transcripts from: {brain_dir}")
    
    # Find all transcript.jsonl
    transcript_files = list(brain_dir.glob("*/.system_generated/logs/transcript.jsonl"))
    if not transcript_files:
        transcript_files = list(brain_dir.glob("*/transcript.jsonl"))

    for tf in transcript_files:
        conv_id = tf.parent.parent.name if ".system_generated" in str(tf) else tf.parent.name
        print(f"  Reading transcript: {conv_id} ({tf.name})")

        with open(tf, "r", encoding="utf-8", errors="ignore") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                try:
                    step = json.loads(line)
                except Exception:
                    continue

                content = step.get("content", "")
                step_type = step.get("type", "")

                # Only ingest user inputs and significant user requests
                if step_type == "USER_INPUT" and content:
                    # Clean tags like <USER_REQUEST>
                    clean_content = content
                    m = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", content, re.DOTALL)
                    if m:
                        clean_content = m.group(1).strip()

                    if len(clean_content) < 10:
                        continue

                    # Determine workspace
                    ws = "general"
                    for known_ws in ["webtrans_prepaid", "webtrans_violentmonkey", "World_Engine", "Voice Novel", "Translate", "livetranslate", "thai-rag-mcp"]:
                        if known_ws.lower() in clean_content.lower():
                            ws = known_ws
                            break

                    turn_id = generate_stable_id("agy_turn", f"{conv_id}:{step.get('step_index')}:{clean_content[:100]}")
                    vector = None
                    if server.embedder.is_alive():
                        try:
                            vector = server.embedder.embed_document(f"[{ws}] User Prompt: {clean_content}")
                        except Exception:
                            pass

                    server.storage.save_conversation_turn(
                        turn_id=turn_id,
                        workspace=ws,
                        role="user",
                        content=clean_content,
                        summary=f"User request in {conv_id}",
                        tags=["user_request", ws],
                        embedding=vector
                    )
                    count += 1

    print(f"✅ Ingested {count} user interactions from Antigravity Transcripts.")
    return count

def main():
    server = get_server()
    cline_kg = Path("/home/qwerty/.cline/data/memory/knowledge-graph.jsonl")
    brain_dir = Path("/home/qwerty/.gemini/antigravity/brain")

    total_cline = ingest_cline_knowledge_graph(server, cline_kg)
    total_agy = ingest_antigravity_transcripts(server, brain_dir)

    print("\n" + "="*50)
    print(f"🎉 Historical Ingestion Complete!")
    print(f"Total Cline Observations Ingested: {total_cline}")
    print(f"Total Antigravity User Turns Ingested: {total_agy}")
    print(f"Grand Total: {total_cline + total_agy} memories saved to Local RAG.")
    print("="*50)

if __name__ == "__main__":
    main()
