import pytest
import tempfile
import shutil
from pathlib import Path
from thai_rag.storage import StorageManager

@pytest.fixture
def temp_storage():
    temp_dir = tempfile.mkdtemp()
    db_path = Path(temp_dir) / "test_context.db"
    chroma_path = str(Path(temp_dir) / "test_chroma")
    storage = StorageManager(sqlite_path=db_path, chroma_path=chroma_path)
    yield storage
    storage.close()
    shutil.rmtree(temp_dir, ignore_errors=True)

def test_storage_init(temp_storage):
    assert temp_storage is not None
    # Check tables exist
    cur = temp_storage.sqlite_conn.cursor()
    tables = [row[0] for row in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    assert "parent_documents" in tables
    assert "memories" in tables
    assert "file_cache" in tables

def test_parent_doc_crud(temp_storage):
    temp_storage.save_parent_doc(
        doc_id="parent_1",
        file_path="src/main.py",
        start_line=1,
        end_line=20,
        content="def test():\n    pass",
        symbol_name="test"
    )
    doc = temp_storage.get_parent_doc("parent_1")
    assert doc is not None
    assert doc["file_path"] == "src/main.py"
    assert doc["symbol_name"] == "test"
    assert doc["start_line"] == 1
    assert doc["end_line"] == 20
    assert "def test()" in doc["content"]

def test_memory_crud_and_vector_search(temp_storage):
    # Orthogonal 768-dim vectors
    vec1 = [1.0] + [0.0] * 767
    vec2 = [0.0, 1.0] + [0.0] * 766
    temp_storage.save_memory("mem_1", "ใช้ Zorin OS บนแล็ปท็อป", "preference", vec1)
    temp_storage.save_memory("mem_2", "โปรเจกต์ใช้ FastMCP", "architecture", vec2)

    results = temp_storage.search_memories_vector(vec1, limit=1)
    assert len(results) == 1
    assert results[0]["id"] == "mem_1"
    assert "Zorin OS" in results[0]["content"]

    # Filter by category
    results_cat = temp_storage.search_memories_vector(vec1, limit=5, category="architecture")
    assert len(results_cat) == 1
    assert results_cat[0]["id"] == "mem_2"

    # Delete
    deleted = temp_storage.delete_memory("mem_1")
    assert deleted is True
    assert temp_storage.get_memory("mem_1") is None

def test_file_cache_and_cleanup(temp_storage):
    temp_storage.set_file_hash("src/app.py", 1700000000.0, "abcdef123456")
    cached = temp_storage.get_file_hash("src/app.py")
    assert cached is not None
    assert cached["sha256"] == "abcdef123456"

    # Delete file data
    temp_storage.save_parent_doc("p_app", "src/app.py", 1, 10, "code", "app")
    temp_storage.delete_file_data("src/app.py")
    assert temp_storage.get_parent_doc("p_app") is None
    assert temp_storage.get_file_hash("src/app.py") is None

def test_fts5_code_symbols_search(temp_storage):
    temp_storage.save_parent_doc("p1", "src/tax.py", 10, 30, "def calculate_vat_thailand(amount):\n    return amount * 0.07", "calculate_vat_thailand")
    temp_storage.save_parent_doc("p2", "src/user.py", 1, 15, "class UserSession:\n    pass", "UserSession")

    matches = temp_storage.search_code_fts("calculate_vat_thailand")
    assert len(matches) > 0
    assert matches[0]["doc_id"] == "p1"
    assert matches[0]["symbol_name"] == "calculate_vat_thailand"


def test_search_code_vector_with_path_filter(temp_storage):
    vec1 = [1.0] + [0.0] * 767
    vec2 = [0.0, 1.0] + [0.0] * 766
    temp_storage.save_child_vectors(
        ids=["c1", "c2"],
        embeddings=[vec1, vec2],
        documents=["doc 1", "doc 2"],
        metadatas=[
            {"file_path": "webtrans_violentmonkey/src/api.ts", "parent_id": "p1"},
            {"file_path": "other_project/src/api.ts", "parent_id": "p2"}
        ]
    )

    # When querying with path_filter, it MUST NOT raise ValueError and must return only matching file_path
    results = temp_storage.search_code_vector(vec1, top_k=5, path_filter="webtrans_violentmonkey")
    assert len(results) == 1
    assert results[0]["id"] == "c1"
