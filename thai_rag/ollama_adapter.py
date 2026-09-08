import requests
from typing import List, Optional
from thai_rag.config import OLLAMA_BASE_URL, EMBEDDING_MODEL

class OllamaEmbeddingAdapter:
    """Ollama Embedding Adapter for nomic-embed-text-v2-moe with proper task prefixes."""
    
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
        
    def _get_embedding(self, prompt: str) -> List[float]:
        resp = requests.post(
            self.embed_url,
            json={"model": self.model, "prompt": prompt},
            timeout=self.timeout
        )
        resp.raise_for_status()
        data = resp.json()
        return data["embedding"]

    def embed_query(self, query: str) -> List[float]:
        """Embed a search query with task prefix."""
        prompt = f"search_query: {query.strip()}"
        return self._get_embedding(prompt)

    def embed_document(self, document: str) -> List[float]:
        """Embed a document/code chunk with task prefix."""
        prompt = f"search_document: {document.strip()}"
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
