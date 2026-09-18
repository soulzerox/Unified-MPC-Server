"""Deterministic hermetic test doubles shared across the unit suite."""
from __future__ import annotations

import hashlib
import math
import re
from typing import Iterable


class DeterministicEmbeddingAdapter:
    """Small deterministic embedder with no network or external model dependency.

    The dimension is configurable so tests do not encode the current production
    model dimension into the fake's contract.
    """

    def __init__(self, dimension: int = 768):
        if dimension < 1:
            raise ValueError("dimension must be positive")
        self.dimension = dimension
        self.base_url = "fake://hermetic"
        self.model = f"deterministic-test-{dimension}d"
        self._fallback_count = 0

    def is_alive(self) -> bool:
        return True

    def _embed(self, text: str) -> list[float]:
        value = str(text or "").strip().lower()
        for prefix in ("search_query:", "search_document:"):
            if value.startswith(prefix):
                value = value[len(prefix):].strip()

        compact = re.sub(r"\s+", " ", value)
        terms = re.findall(r"[a-z0-9_./-]+|[\u0e00-\u0e7f]+", compact)
        no_space = re.sub(r"\s+", "", compact)
        terms.extend(no_space[i : i + 2] for i in range(max(0, len(no_space) - 1)))
        terms.extend(no_space[i : i + 3] for i in range(max(0, len(no_space) - 2)))
        if not terms:
            terms = ["__empty__"]

        vector = [0.0] * self.dimension
        for term in terms:
            digest = hashlib.sha256(term.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimension
            vector[index] += 1.0

        norm = math.sqrt(sum(component * component for component in vector)) or 1.0
        return [float(component / norm) for component in vector]

    def embed_query(self, query: str) -> list[float]:
        return self._embed(query)

    def embed_document(self, document: str) -> list[float]:
        return self._embed(document)

    def embed_documents(self, documents: Iterable[str]) -> list[list[float]]:
        return [self._embed(document) for document in documents]
