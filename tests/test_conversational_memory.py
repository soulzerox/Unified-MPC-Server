import pytest
import tempfile
import time
from pathlib import Path
from thai_rag.storage import StorageManager
from thai_rag.retriever import HybridRetriever
from thai_rag.code_chunker import CodeChunker
from thai_rag.server import LocalContextServer
from tests.fakes import DeterministicEmbeddingAdapter


def _hermetic_server(*args, **kwargs):
    server = LocalContextServer(*args, **kwargs)
    fake_embedder = DeterministicEmbeddingAdapter()
    server.embedder = fake_embedder
    server.retriever.embedder = fake_embedder
    return server

@pytest.fixture
def temp_env():
    td = tempfile.mkdtemp()
    sqlite_p = Path(td) / "test_context.db"
    chroma_p = Path(td) / "chroma"
    storage = StorageManager(sqlite_path=sqlite_p, chroma_path=str(chroma_p))
    embedder = DeterministicEmbeddingAdapter()
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
    server = _hermetic_server(
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

    assert result["can_proceed"] is False
    assert result["evidence"]["code_index"] == "missing"
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


def test_remember_turn_accepts_stable_turn_id_and_retries_idempotently(temp_env, monkeypatch):
    """A caller-supplied turn_id must survive ambiguous retries without duplicate rows."""
    storage, *_ = temp_env
    server = _hermetic_server(
        sqlite_path=storage.sqlite_path,
        chroma_path=storage.chroma_path,
    )
    monkeypatch.setattr(server.embedder, "is_alive", lambda: False)
    turn_id = "turn_stable_retry_001"
    kwargs = {
        "role": "user",
        "content": "persist this once even if the caller retries",
        "workspace": "ws",
        "summary": "stable retry",
        "tags": ["audit"],
        "turn_id": turn_id,
    }

    try:
        first = server.remember_turn(**kwargs)
        second = server.remember_turn(**kwargs)

        assert f"[ID: {turn_id}]" in first
        assert f"[ID: {turn_id}]" in second
        assert server.storage.sqlite_conn.execute(
            "SELECT COUNT(*) FROM conversation_turns WHERE turn_id = ?", (turn_id,)
        ).fetchone()[0] == 1
        assert server.storage.sqlite_conn.execute(
            "SELECT COUNT(*) FROM fts_conversation WHERE turn_id = ?", (turn_id,)
        ).fetchone()[0] == 1
    finally:
        server.close()


def test_mcp_remember_turn_exposes_optional_turn_id():
    """FastMCP derives its remember_turn input schema from the public wrapper signature."""
    import inspect
    from thai_rag import server as server_module

    params = inspect.signature(server_module.remember_turn).parameters
    assert "turn_id" in params
    assert params["turn_id"].default == ""


def test_recall_category_returns_turns(temp_env):
    """BUG-8 regression: recall(category=...) must return remember_turn turns, not drop them."""
    storage, retriever, embedder, chunker = temp_env
    server = _hermetic_server(sqlite_path=storage.sqlite_path, chroma_path=storage.chroma_path)
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
    server = _hermetic_server(sqlite_path=storage.sqlite_path, chroma_path=storage.chroma_path)
    server.remember_turn(role="assistant", content="สรุป bug fix", workspace="ws", tags=["constraint"], summary="bug")
    res = server.recall("bug fix", limit=5)
    assert "Date:" in res
    assert "Category:" in res
    # Turn category must be displayed (max shown via metadata), never empty date for a typed turn
    assert "`constraint`" in res or "Date: `" in res
    server.close()


def test_untagged_turn_passes_category_filter(temp_env):
    """(A) Untagged/general turns must pass any category query (wildcard)."""
    storage, retriever, embedder, chunker = temp_env
    server = _hermetic_server(sqlite_path=storage.sqlite_path, chroma_path=storage.chroma_path)
    server.remember_turn(
        role="user",
        content="ตัดสินใจใช้ JWT สำหรับ auth flow ใหม่ทั้งหมด",
        workspace="ws",
        tags=["session-audit"],
        summary="JWT auth decision",
    )
    res = server.recall("ตัดสินใจใช้ JWT", category="decision", limit=5)
    assert "JWT" in res, f"untagged turn should pass category filter, got: {res[:300]}"
    server.close()


def test_explicit_mismatch_still_excluded(temp_env):
    """(A) A concrete non-matching category must still be filtered out."""
    storage, retriever, embedder, chunker = temp_env
    server = _hermetic_server(sqlite_path=storage.sqlite_path, chroma_path=storage.chroma_path)
    server.remember_turn(
        role="user",
        content="ผู้ใช้ชอบธีมสีมืดสำหรับการ coding ตอนกลางคืนมาก",
        workspace="ws",
        tags=["preference"],
        summary="dark theme preference",
    )
    res = server.recall("ธีมสีมืด", category="decision", limit=5)
    # The turn was correctly excluded — verify the query term only appears in the
    # "No memories found" fallback message, not as actual returned content.
    assert "dark theme preference" not in res, f"preference turn must not match decision filter, got: {res[:300]}"
    server.close()

