import pytest
import tempfile
import shutil
from pathlib import Path
from thai_rag.server import LocalContextServer
from tests.fakes import DeterministicEmbeddingAdapter

@pytest.fixture
def diag_server():
    temp_dir = tempfile.mkdtemp()
    db_path = Path(temp_dir) / "diag.db"
    chroma_path = str(Path(temp_dir) / "diag_chroma")
    server = LocalContextServer(sqlite_path=db_path, chroma_path=chroma_path)
    fake_embedder = DeterministicEmbeddingAdapter()
    server.embedder = fake_embedder
    server.retriever.embedder = fake_embedder
    yield server
    server.close()
    shutil.rmtree(temp_dir, ignore_errors=True)

def test_fts5_special_characters_no_crash(diag_server):
    # Queries with FTS5 operators and punctuation
    queries = [
        "def test():",
        "-minus_term",
        "AND OR NOT *",
        "() * ^ % $ # @ !",
        "calculate_tax() -> float:",
        '"""docstring"""'
    ]
    for q in queries:
        # Must not raise an exception, must return clean string
        res = diag_server.code_search(q)
        assert isinstance(res, str)

def test_empty_and_whitespace_inputs(diag_server):
    assert "cannot be empty" in diag_server.remember("   ")
    assert "cannot be empty" in diag_server.recall("   ")
    assert "cannot be empty" in diag_server.forget("   ")
    assert "cannot be empty" in diag_server.code_search("   ")

def test_binary_and_unusual_files_in_workspace(diag_server):
    temp_ws = tempfile.mkdtemp()
    ws_path = Path(temp_ws)

    # Valid code
    (ws_path / "app.py").write_text("def run(): pass", encoding="utf-8")

    # Binary file disguised as python
    (ws_path / "corrupt.py").write_bytes(b"\x00\xff\xfe\x00\x01\x02\x03\x80\x90")

    # Empty file
    (ws_path / "empty.py").write_text("", encoding="utf-8")

    # Indexing must not crash
    res = diag_server.code_index(temp_ws)
    assert "Code Indexing Completed" in res
    assert "Indexed:" in res

    shutil.rmtree(temp_ws, ignore_errors=True)

def test_code_context_nonexistent_file(diag_server):
    res = diag_server.code_context("non_existent_file.py", line_number=100)
    assert "No context found" in res

@pytest.mark.integration
def test_ollama_health_check():
    from thai_rag.ollama_adapter import OllamaEmbeddingAdapter

    assert OllamaEmbeddingAdapter().is_alive() is True

def test_ollama_unreachable_handling():
    from thai_rag.ollama_adapter import OllamaEmbeddingAdapter
    bad_adapter = OllamaEmbeddingAdapter(base_url="http://127.0.0.1:99999", timeout=1.0)
    assert bad_adapter.is_alive() is False

def test_long_document_auto_truncation(diag_server):
    # Very long text that would otherwise exceed 512 context tokens in Ollama
    very_long_doc = "นี่คือข้อความทดสอบขนาดยาวมาก " * 200 + "def very_long_function(): pass\n" * 100
    res = diag_server.remember(very_long_doc, category="test_long")
    assert "Remembered" in res

    # Long search query
    very_long_query = "ค้นหาคำที่มีความยาวเกินปกติ " * 50
    search_res = diag_server.recall(very_long_query)
    assert isinstance(search_res, str)
