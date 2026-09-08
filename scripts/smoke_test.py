#!/usr/bin/env python3
"""Smoke test script verifying the running MCP server and local context tools."""
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from thai_rag.server import LocalContextServer

def main():
    print("=" * 60)
    print("🚀 Running Thai Context & Code RAG Smoke Test...")
    print("=" * 60)

    server = LocalContextServer()

    # 1. Health Check
    print("\n1️⃣ Checking Local Ollama Health:")
    if server.embedder.is_alive():
        print("  ✅ Local Ollama is up and reachable at http://127.0.0.1:11434")
    else:
        print("  ❌ Local Ollama is unreachable!")
        sys.exit(1)

    # 2. Memory Test
    print("\n2️⃣ Testing Agent Memory Subsystem:")
    mem_resp = server.remember("โปรเจกต์นี้ทำงานแบบ 100% Local โดยไม่ต้องเปิด Tailscale", category="architecture")
    print(f"  {mem_resp.splitlines()[0]}")

    recall_resp = server.recall("Tailscale และ local")
    print("  Recall Response:\n" + "\n".join(f"    {line}" for line in recall_resp.splitlines()[:5]))

    # 3. Code Indexing Self Test
    print("\n3️⃣ Testing Code Indexing on Current Repo:")
    repo_root = str(Path(__file__).resolve().parent.parent)
    index_resp = server.code_index(repo_root)
    print("  Index Summary:\n" + "\n".join(f"    {line}" for line in index_resp.splitlines()))

    # 4. Hybrid Code Search
    print("\n4️⃣ Testing Hybrid Search (Exact Symbol + Thai):")
    res_symbol = server.code_search("OllamaEmbeddingAdapter", top_k=1)
    print("  Exact Symbol Match:\n" + "\n".join(f"    {line}" for line in res_symbol.splitlines()[:6]))

    res_thai = server.code_search("การค้นหาโค้ดแบบไฮบริด", top_k=1)
    print("  Thai Semantic Match:\n" + "\n".join(f"    {line}" for line in res_thai.splitlines()[:6]))

    # 5. Enclosing Context Lookup
    print("\n5️⃣ Testing Enclosing Context Lookup:")
    ctx = server.code_context("thai_rag/retriever.py", line_number=35)
    print("  Context Snippet:\n" + "\n".join(f"    {line}" for line in ctx.splitlines()[:8]))

    server.close()
    print("\n" + "=" * 60)
    print("🎉 All Smoke Tests Passed Successfully!")
    print("=" * 60)

if __name__ == "__main__":
    main()
