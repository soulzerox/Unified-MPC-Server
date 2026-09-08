import pytest
import tempfile
import shutil
from pathlib import Path
from thai_rag.storage import StorageManager
from thai_rag.ollama_adapter import OllamaEmbeddingAdapter
from thai_rag.code_chunker import CodeChunker
from thai_rag.retriever import HybridRetriever

@pytest.fixture
def temp_env():
    temp_dir = tempfile.mkdtemp()
    db_path = Path(temp_dir) / "test.db"
    chroma_path = str(Path(temp_dir) / "chroma")
    storage = StorageManager(sqlite_path=db_path, chroma_path=chroma_path)
    adapter = OllamaEmbeddingAdapter()
    chunker = CodeChunker()
    retriever = HybridRetriever(storage=storage, embedder=adapter, chunker=chunker)

    # Ingest a sample file
    code = """# ระบบคำนวณและประมวลผลทางการเงิน
def calculate_vat_thailand(amount: float) -> float:
    # คำนวณภาษีมูลค่าเพิ่ม 7% ของยอดเงิน
    return amount * 0.07

def process_refund_slip(slip_id: str):
    # ตรวจสอบสลิปและคืนเงินให้ลูกค้า
    return {"slip": slip_id, "status": "approved"}
"""
    retriever.index_file("finance.py", code)

    yield retriever, storage
    storage.close()
    shutil.rmtree(temp_dir, ignore_errors=True)

def test_hybrid_search_exact_symbol(temp_env):
    retriever, _ = temp_env
    results = retriever.search("calculate_vat_thailand", top_k=3)
    assert len(results) > 0
    top = results[0]
    assert top["file_path"] == "finance.py"
    assert "calculate_vat_thailand" in top["symbol_name"]
    assert "0.07" in top["content"]

def test_hybrid_search_thai_semantic(temp_env):
    retriever, _ = temp_env
    results = retriever.search("การคืนเงินให้ลูกค้า", top_k=3)
    assert len(results) > 0
    top = results[0]
    assert top["file_path"] == "finance.py"
    assert "refund" in top["content"] or "คืนเงิน" in top["content"]

def test_get_context_around_line(temp_env):
    retriever, _ = temp_env
    ctx = retriever.get_context("finance.py", line_number=3, window_lines=5)
    assert ctx is not None
    assert "calculate_vat_thailand" in ctx["content"]
    assert ctx["start_line"] <= 3 <= ctx["end_line"]
