import os
from pathlib import Path

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "nomic-embed-text-v2-moe:latest")

CACHE_DIR = Path(os.environ.get("THAI_RAG_CACHE_DIR", Path.home() / ".cache" / "thai-rag-mcp"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

SQLITE_PATH = CACHE_DIR / "local_context.db"
CHROMA_PATH = str(CACHE_DIR / "chroma_vectors")

# Chunking budget (nomic-embed-text-v2-moe GGUF has 512 context tokens)
TARGET_CHUNK_TOKENS = 350
CHUNK_OVERLAP_TOKENS = 40
