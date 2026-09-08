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

    def is_alive(self) -> bool:
        """Check if the local Ollama server is running and reachable."""
        try:
            resp = requests.get(f"{self.base_url}/api/tags", timeout=2.0)
            return resp.status_code == 200
        except Exception:
            return False

    def _truncate_payload(self, text: str) -> str:
        """Safely truncate text to prevent exceeding Ollama's 512 context tokens limit."""
        clean = text.strip()
        if len(clean) > self.MAX_PAYLOAD_CHARS:
            return clean[:self.MAX_PAYLOAD_CHARS]
        return clean
        
    def _get_embedding(self, prompt: str) -> List[float]:
        try:
            resp = requests.post(
                self.embed_url,
                json={"model": self.model, "prompt": prompt},
                timeout=self.timeout
            )
            resp.raise_for_status()
            data = resp.json()
            return data["embedding"]
        except Exception as e:
            # Fallback for dense token strings: halve prompt length and retry
            if len(prompt) > 200:
                try:
                    shorter = prompt[: len(prompt) // 2]
                    resp = requests.post(
                        self.embed_url,
                        json={"model": self.model, "prompt": shorter},
                        timeout=self.timeout
                    )
                    resp.raise_for_status()
                    return resp.json()["embedding"]
                except Exception:
                    pass
            # Final fallback: return zero vector so index process never crashes
            return [0.0] * 768

    def embed_query(self, query: str) -> List[float]:
        """Embed a search query with task prefix and length guard."""
        truncated = self._truncate_payload(query)
        prompt = f"search_query: {truncated}"
        return self._get_embedding(prompt)

    def embed_document(self, document: str) -> List[float]:
        """Embed a document/code chunk with task prefix and length guard."""
        truncated = self._truncate_payload(document)
        prompt = f"search_document: {truncated}"
        return self._get_embedding(prompt)

    def embed_documents(self, documents: List[str]) -> List[List[float]]:
        """Embed a batch of documents sequentially or in chunks."""
        results = []
        for doc in documents:
            if not doc.strip():
                results.append([0.0] * 768)
            else:
                results.append(self.embed_document(doc))
        return results

    # ChromaDB Custom EmbeddingFunction protocol
    def __call__(self, input: List[str]) -> List[List[float]]:
        return self.embed_documents(input)
