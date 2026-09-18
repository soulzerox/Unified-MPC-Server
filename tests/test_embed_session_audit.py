"""Pytest wrapper for the embed-session audit harness (temp isolated storage only)."""
import sys
import pytest

pytestmark = pytest.mark.stress
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from scripts.embed_session_audit import (
    extract_turns, ingest_turns, probe_recall, probe_code_search, probe_pre_edit,
)
from thai_rag.server import LocalContextServer
import tempfile


def _no_memories(res: str) -> bool:
    return "No memories found" in res or "No relevant" in res


def test_transcript_extracts_dialogue():
    turns = extract_turns()
    assert len(turns) >= 5
    assert any(t["role"] == "user" for t in turns)
    assert any(t["role"] == "assistant" for t in turns)


@pytest.fixture
def audit_server():
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "audit.db",
            chroma_path=str(Path(tmpdir) / "audit_chroma"),
        )
        yield server
        server.close()


def test_ingest_sample_turns_succeed(audit_server):
    turns = extract_turns()[:10]
    ok, failures, _ = ingest_turns(audit_server, turns)
    assert ok == len(turns), f"failures: {failures[:3]}"


def test_recall_and_empty_guard(audit_server):
    if not audit_server.embedder.is_alive():
        pytest.skip("Ollama down — vector recall skipped")
    turns = extract_turns()[:10]
    ingest_turns(audit_server, turns)
    res = audit_server.recall("openviking replacement", limit=3)
    assert not res.startswith("Error")
    assert audit_server.recall("", limit=3).startswith("Error")


def test_pre_edit_returns_context(audit_server):
    res = probe_pre_edit(audit_server)
    assert res.get("can_proceed") is True
