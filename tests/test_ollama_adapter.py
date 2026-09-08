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
