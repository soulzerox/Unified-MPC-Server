import pytest
from thai_rag.ollama_adapter import OllamaEmbeddingAdapter

def test_ollama_adapter_init():
    adapter = OllamaEmbeddingAdapter(base_url="http://127.0.0.1:11434", model="nomic-embed-text-v2-moe:latest")
    assert adapter.base_url == "http://127.0.0.1:11434"
    assert adapter.model == "nomic-embed-text-v2-moe:latest"

def test_ollama_embed_query():
    adapter = OllamaEmbeddingAdapter()
    vec = adapter.embed_query("ทดสอบค้นหาฟังก์ชัน")
    assert isinstance(vec, list)
    assert len(vec) == 768
    assert all(isinstance(x, float) for x in vec)

def test_ollama_embed_document():
    adapter = OllamaEmbeddingAdapter()
    vec = adapter.embed_document("def hello(): return 'world'")
    assert isinstance(vec, list)
    assert len(vec) == 768

def test_ollama_embed_documents_batch():
    adapter = OllamaEmbeddingAdapter()
    docs = ["เอกสารที่หนึ่ง", "def second(): pass"]
    vectors = adapter.embed_documents(docs)
    assert len(vectors) == 2
    assert len(vectors[0]) == 768
    assert len(vectors[1]) == 768

def test_embed_query_raises_when_ollama_dead(monkeypatch):
    """IMP-1 regression: query path must raise instead of silently returning a zero vector."""
    import requests as _requests

    def _boom(*args, **kwargs):
        raise IOError("ollama down")

    adapter = OllamaEmbeddingAdapter()
    monkeypatch.setattr(_requests, "get", _boom)
    monkeypatch.setattr(_requests, "post", _boom)
    try:
        adapter.embed_query("ทดสอบการค้นหา")
        raised = False
    except Exception:
        raised = True
    assert raised, "embed_query should raise when Ollama is unreachable"
