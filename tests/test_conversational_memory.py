import pytest
import tempfile
import time
from pathlib import Path
from thai_rag.storage import StorageManager
from thai_rag.retriever import HybridRetriever
from thai_rag.ollama_adapter import OllamaEmbeddingAdapter
from thai_rag.code_chunker import CodeChunker
from thai_rag.server import LocalContextServer

@pytest.fixture
def temp_env():
    td = tempfile.mkdtemp()
    sqlite_p = Path(td) / "test_context.db"
    chroma_p = Path(td) / "chroma"
    storage = StorageManager(sqlite_path=sqlite_p, chroma_path=str(chroma_p))
    embedder = OllamaEmbeddingAdapter()
    chunker = CodeChunker()
    retriever = HybridRetriever(storage=storage, embedder=embedder, chunker=chunker)
    yield storage, retriever, embedder, chunker
    storage.close()


def test_conversation_turn_storage_and_search(temp_env):
    storage, retriever, embedder, chunker = temp_env

    # 1. Save conversation turn
    turn_id = "turn_001"
    content = "เราได้ตัดสินใจไม่แตะต้อง regex THOUGHT_VERB_RE ใน quote_fixer.ts เพื่อป้องกันการแปลเพี้ยน"
    summary = "Design decision: Do not alter THOUGHT_VERB_RE in quote_fixer.ts"
    tags = ["decision", "webtrans", "quote_fixer"]

    # Mock or dummy embedding
    emb = [0.1] * 768

    storage.save_conversation_turn(
        turn_id=turn_id,
        workspace="webtrans",
        role="user",
        content=content,
        summary=summary,
        tags=tags,
        embedding=emb
    )

    # 2. Search by FTS keyword
    fts_results = storage.search_conversation_turns(query="THOUGHT_VERB_RE", workspace="webtrans")
    assert len(fts_results) >= 1
    assert fts_results[0]["turn_id"] == turn_id
    assert "quote_fixer.ts" in fts_results[0]["content"]

    # 3. Search constraints for specific file
    constraints = storage.get_file_constraints(file_path="quote_fixer.ts", workspace="webtrans")
    assert len(constraints) >= 1
    assert any("THOUGHT_VERB_RE" in c["content"] for c in constraints)


def test_pre_edit_context_integration(temp_env):
    storage, retriever, embedder, chunker = temp_env

    # Setup a dummy server
    server = LocalContextServer(
        sqlite_path=storage.sqlite_path,
        chroma_path=storage.chroma_path
    )

    # Ingest a constraint for a file
    storage.save_conversation_turn(
        turn_id="turn_002",
        workspace="webtrans_violentmonkey",
        role="assistant",
        content="สำคัญมาก: ห้ามแก้ฟังก์ชัน restoreMissingQuotationMarks ใน src/webtrans/quote_fixer.ts ให้คงตรรกะเดิมไว้",
        summary="Constraint on restoreMissingQuotationMarks",
        tags=["constraint", "quote_fixer"],
        embedding=[0.05] * 768
    )

    # Call pre_edit_context
    result = server.pre_edit_context(
        file_path="src/webtrans/quote_fixer.ts",
        workspace="webtrans_violentmonkey"
    )

    assert result["can_proceed"] is True
    assert result["file_path"] == "src/webtrans/quote_fixer.ts"
    assert len(result["constraints"]) >= 1
    assert "restoreMissingQuotationMarks" in result["constraints"][0]["content"]

    server.close()


def test_resave_same_turn_id_no_fts_duplicate(temp_env):
    """BUG-3 regression: re-saving the same turn_id must not duplicate FTS rows."""
    storage, *_ = temp_env
    turn_id = "turn_dup_check"
    content = "unique marker content for duplicate check"

    storage.save_conversation_turn(turn_id=turn_id, workspace="ws", role="user", content=content, embedding=None)
    storage.save_conversation_turn(turn_id=turn_id, workspace="ws", role="user", content=content, embedding=None)

    n = storage.sqlite_conn.execute(
        "SELECT COUNT(*) FROM fts_conversation WHERE turn_id = ?", (turn_id,)
    ).fetchone()[0]
    assert n == 1

    rows = storage.search_conversation_turns("unique marker duplicate")
    assert len([r for r in rows if r["turn_id"] == turn_id]) == 1


def test_recall_category_returns_turns(temp_env):
    """BUG-8 regression: recall(category=...) must return remember_turn turns, not drop them."""
    storage, retriever, embedder, chunker = temp_env
    server = LocalContextServer(sqlite_path=storage.sqlite_path, chroma_path=storage.chroma_path)
    if not embedder.is_alive():
        # Skip when Ollama is unavailable (only embeddings need it)
        server.close()
        pytest.skip("Ollama not available")
    server.remember_turn(role="user", content="ตัดสินใจ: ใช้ JWT ไม่ใช่ session", workspace="ws", tags=["decision"])
    server.remember("ผู้ใช้ชอบธีมสีมืด", category="preference")
    res = server.recall("ตัดสินใจ JWT", category="decision", limit=5)
    assert "JWT" in res, f"recall(category=decision) should return the turn, got: {res[:200]}"
    server.close()


def test_turn_tags_stored_as_list_not_perchar(temp_env):
    """BUG-9 regression: a string tag must be stored as-is, not per-character."""
    storage, *_ = temp_env
    storage.save_conversation_turn(turn_id="turn_tags_str", workspace="ws", role="user",
                                   content="c", summary="s", tags="decision", embedding=None)
    stored = dict(storage.sqlite_conn.execute(
        "SELECT tags FROM conversation_turns WHERE turn_id='turn_tags_str'").fetchone())
    assert stored["tags"] == "decision", f"got per-char tags: {stored['tags']}"


def test_recall_turn_shows_date_and_category(temp_env):
    """BUG-8b regression: turn results carry created_at + category in metadata."""
    storage, retriever, embedder, chunker = temp_env
    server = LocalContextServer(sqlite_path=storage.sqlite_path, chroma_path=storage.chroma_path)
    if not embedder.is_alive():
        server.close()
        pytest.skip("Ollama not available")
    server.remember_turn(role="assistant", content="สรุป bug fix", workspace="ws", tags=["constraint"], summary="bug")
    res = server.recall("bug fix", limit=5)
    assert "Date:" in res
    assert "Category:" in res
    # Turn category must be displayed (max shown via metadata), never empty date for a typed turn
    assert "`constraint`" in res or "Date: `" in res
    server.close()

