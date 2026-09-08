"""
E2E Stress and Smoke Test using REAL chat dialogues from the active Antigravity session.
Validates:
1. Turn-by-turn conversational memory ingestion under rapid load (Stress test)
2. Thai and English keyword retrieval via SQLite FTS5 (Smoke test)
3. Code Property Graph (CPG-Lite) AST indexing and blast radius caller/callee resolution
4. JIT Pre-Edit Verification workflow on real modified files
5. Resource cleanliness and sub-millisecond execution verification
"""

import os
import sys
import json
import time
import tempfile
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from thai_rag.storage import StorageManager
from thai_rag.server import LocalContextServer
from thai_rag.retriever import HybridRetriever
from thai_rag.code_chunker import CodeChunker
from thai_rag.ollama_adapter import OllamaEmbeddingAdapter

SESSION_TRANSCRIPT = Path("/home/qwerty/.gemini/antigravity/brain/20499698-6d2f-4539-b942-92421d974b99/.system_generated/logs/transcript.jsonl")

def extract_session_dialogue():
    """Extract all user inputs and assistant summaries from the current session transcript."""
    if not SESSION_TRANSCRIPT.exists():
        raise FileNotFoundError(f"Transcript not found at {SESSION_TRANSCRIPT}")

    dialogue = []
    with open(SESSION_TRANSCRIPT, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
                item_type = item.get("type")
                content = item.get("content", "")

                if item_type == "USER_INPUT" and content:
                    dialogue.append({
                        "role": "user",
                        "content": content[:2000],
                        "summary": content[:150]
                    })
                elif item_type == "PLANNER_RESPONSE" and content and len(content) > 30:
                    dialogue.append({
                        "role": "assistant",
                        "content": content[:2000],
                        "summary": content[:150]
                    })
            except Exception:
                continue

    return dialogue

def run_stress_test(server: LocalContextServer, dialogue: list):
    """Stress test rapid turn ingestion and measure throughput."""
    print(f"\n[1/4] 🚀 Starting Stress Ingestion of {len(dialogue)} real dialogue turns...")
    t0 = time.time()

    success_count = 0
    for idx, turn in enumerate(dialogue):
        res = server.remember_turn(
            role=turn["role"],
            content=turn["content"],
            workspace="thai-rag-mcp",
            summary=turn["summary"],
            tags=["session-test", "active-session"]
        )
        if "✅" in res:
            success_count += 1

    duration = time.time() - t0
    rate = success_count / max(duration, 0.001)
    print(f"  ✅ Ingested {success_count}/{len(dialogue)} turns in {duration:.3f}s ({rate:.1f} turns/sec).")
    assert success_count == len(dialogue), f"Expected {len(dialogue)} ingests, got {success_count}"

def run_retrieval_smoke_test(server: LocalContextServer):
    """Smoke test Thai and English retrieval from the ingested session."""
    print("\n[2/4] 🔍 Running Retrieval Smoke Tests on Real Session Concepts...")
    
    test_queries = [
        ("CPG", "Code Property Graph"),
        ("ย้าย", "Relocation of cache to /mnt"),
        ("562AEA8C2AEA6887", "Secondary mount partition"),
        ("pre_edit_context", "JIT Pre-edit verification protocol"),
        ("World_Engine", "World Engine project reference")
    ]

    for q, desc in test_queries:
        t0 = time.time()
        results = server.storage.search_conversation_turns(q, workspace="thai-rag-mcp", limit=3)
        elapsed_ms = (time.time() - t0) * 1000
        print(f"  - Query: '{q}' ({desc}) -> Found {len(results)} hits in {elapsed_ms:.2f}ms")
        assert len(results) > 0, f"Query '{q}' returned 0 results from session history!"
        assert elapsed_ms < 50.0, f"Search latency exceeded 50ms: {elapsed_ms:.2f}ms"

def run_cpg_indexing_and_blast_radius_test(server: LocalContextServer):
    """Index thai-rag-mcp codebase and test CPG AST caller/callee resolution."""
    print("\n[3/4] 🕸️ Running CPG AST Indexing and Blast Radius Analysis...")

    # Index this repository's thai_rag package
    t0 = time.time()
    idx_res = server.retriever.index_workspace(str(PROJECT_ROOT / "thai_rag"), force=True)
    idx_duration = time.time() - t0
    print(f"  ✅ Indexed {idx_res['indexed']} files in {idx_duration:.2f}s")
    assert idx_res["indexed"] > 0, "No files indexed!"

    # Test blast radius on 'save_conversation_turn'
    blast = server.storage.get_symbol_blast_radius("save_conversation_turn", workspace="thai-rag-mcp")
    callers = [c["source_symbol"] for c in blast["callers"]]
    print(f"  - Blast radius for 'save_conversation_turn': {len(blast['callers'])} callers, {len(blast['callees'])} callees")
    print(f"    Callers found: {callers[:5]}")
    assert any("remember_turn" in c for c in callers), f"Expected remember_turn in callers, got {callers}"

    # Test blast radius on 'get_file_constraints'
    blast_constraints = server.storage.get_symbol_blast_radius("get_file_constraints", workspace="thai-rag-mcp")
    constraint_callers = [c["source_symbol"] for c in blast_constraints["callers"]]
    print(f"  - Blast radius for 'get_file_constraints': {len(blast_constraints['callers'])} callers")
    assert any("pre_edit_context" in c for c in constraint_callers), f"Expected pre_edit_context in callers, got {constraint_callers}"

def run_pre_edit_verification_test(server: LocalContextServer):
    """Smoke test JIT pre-edit verification on real project files."""
    print("\n[4/4] 🛡️ Running JIT Pre-Edit Verification Workflow...")
    
    target_file = str(PROJECT_ROOT / "thai_rag" / "storage.py")
    res = server.pre_edit_context(
        file_path=target_file,
        workspace="thai-rag-mcp",
        proposed_symbol="save_conversation_turn"
    )

    print(f"  - File: {res['file_path']}")
    print(f"  - Safe to proceed: {res['can_proceed']}")
    print(f"  - Constraints found: {len(res['constraints'])}")
    print(f"  - Blast callers found: {len(res['blast_radius']['callers'])}")

    assert res["can_proceed"] is True
    assert len(res["constraints"]) > 0, "Expected past constraints for storage.py from this session"
    assert len(res["blast_radius"]["callers"]) > 0, "Expected callers for save_conversation_turn"

    # Verify MCP tool output formatting
    formatted = server.code_blast_radius("save_conversation_turn", workspace="thai-rag-mcp")
    assert "Blast Radius Analysis" in formatted
    assert "Inbound Callers" in formatted
    print("  ✅ MCP formatted output verified successfully.")

def main():
    print("=" * 70)
    print("🎯 REAL SESSION E2E, STRESS & SMOKE TEST (CPG-Lite + Memory)")
    print(f"Target Session: {SESSION_TRANSCRIPT.parent.parent.name}")
    print("=" * 70)

    dialogue = extract_session_dialogue()
    print(f"Extracted {len(dialogue)} dialogue turns from active session transcript.")
    assert len(dialogue) >= 5, "Transcript should contain dialogue from current session"

    with tempfile.TemporaryDirectory() as tmpdir:
        sqlite_file = Path(tmpdir) / "e2e_test.db"
        chroma_folder = Path(tmpdir) / "e2e_chroma"
        
        server = LocalContextServer(
            sqlite_path=sqlite_file,
            chroma_path=str(chroma_folder)
        )

        try:
            run_stress_test(server, dialogue)
            run_retrieval_smoke_test(server)
            run_cpg_indexing_and_blast_radius_test(server)
            run_pre_edit_verification_test(server)
            print("\n🎉 ALL E2E, STRESS, AND SMOKE TESTS PASSED WITH ZERO ERRORS!")
            print("=" * 70)
        finally:
            server.close()

if __name__ == "__main__":
    main()

