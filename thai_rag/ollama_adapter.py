import time

import requests
from typing import List, Optional
from thai_rag.config import OLLAMA_BASE_URL, EMBEDDING_MODEL

class OllamaEmbeddingAdapter:
    """Ollama Embedding Adapter for nomic-embed-text-v2-moe with proper task prefixes."""
    
    # Safe character budget: nomic-v2 GGUF has 512 context tokens. Dense Base64/code fits comfortably in 750 chars.
    MAX_PAYLOAD_CHARS = 750

    def __init__(
        self,
        base_url: str = OLLAMA_BASE_URL,
        model: str = EMBEDDING_MODEL,
        timeout: float = 60.0
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.embed_url = f"{self.base_url}/api/embeddings"
        # Health cache: avoid re-probing Ollama on every tool call
        self._alive_cached = False
        self._alive_until = 0.0
        # Number of ingestion embeddings that fell back to a zero vector
        self._fallback_count = 0

    def is_alive(self) -> bool:
        """Check if the local Ollama server is running and reachable (cached: 60s on success, 5s on failure)."""
        now = time.time()
        if now < self._alive_until:
            return self._alive_cached
        try:
            resp = requests.get(f"{self.base_url}/api/tags", timeout=2.0)
            alive = resp.status_code == 200
        except Exception:
            alive = False
        self._alive_cached = alive
        self._alive_until = now + (60.0 if alive else 5.0)
        return alive

    def _truncate_payload(self, text: str) -> str:
        """Safely truncate text to prevent exceeding Ollama's 512 context tokens limit."""
        clean = text.strip()
        if len(clean) > self.MAX_PAYLOAD_CHARS:
            return clean[:self.MAX_PAYLOAD_CHARS]
        return clean
        
    def _post_embedding(self, prompt: str) -> List[float]:
        resp = requests.post(
            self.embed_url,
            json={"model": self.model, "prompt": prompt},
            timeout=self.timeout
        )
        resp.raise_for_status()
        return resp.json()["embedding"]

    def _get_embedding(self, prompt: str, allow_zero_fallback: bool = True) -> List[float]:
        try:
            return self._post_embedding(prompt)
        except Exception:
            # Retry once with a halved prompt for dense token strings
            if len(prompt) > 200:
                try:
                    return self._post_embedding(prompt[: len(prompt) // 2])
                except Exception:
                    pass
            if not allow_zero_fallback:
                # Query path must never return a fake zero vector — surface the failure
                raise
            # Ingestion-only fallback: zero vector keeps indexing alive; counted for reporting
            self._fallback_count += 1
            return [0.0] * 768

    def embed_query(self, query: str) -> List[float]:
        """Embed a search query with task prefix and length guard. Raises if Ollama fails."""
        truncated = self._truncate_payload(query)
        prompt = f"search_query: {truncated}"
        return self._get_embedding(prompt, allow_zero_fallback=False)

    def embed_document(self, document: str) -> List[float]:
        """Embed a document/code chunk with task prefix and length guard."""
        truncated = self._truncate_payload(document)
        prompt = f"search_document: {truncated}"
        return self._get_embedding(prompt)

    def embed_documents(self, documents: List[str]) -> List[List[float]]:
        """Embed a batch of documents. Tries the batched /api/embed endpoint first,
        then falls back to sequential per-document embedding."""
        non_empty = [d for d in documents if d.strip()]
        if not non_empty:
            return [[0.0] * 768 for _ in documents]
        try:
            resp = requests.post(
                f"{self.base_url}/api/embed",
                json={"model": self.model, "input": [self._truncate_payload(d) for d in non_empty]},
                timeout=self.timeout
            )
            resp.raise_for_status()
            embeddings = resp.json().get("embeddings")
            if not embeddings or len(embeddings) != len(non_empty):
                raise ValueError("Unexpected /api/embed response shape")
            it = iter(embeddings)
            return [next(it) if d.strip() else [0.0] * 768 for d in documents]
        except Exception:
            # Legacy endpoint or batch unsupported → sequential per-document embedding
            return [self.embed_document(d) for d in documents]

    # ChromaDB Custom EmbeddingFunction protocol
    def __call__(self, input: List[str]) -> List[List[float]]:
        return self.embed_documents(input)
