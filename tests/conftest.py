"""Pytest bootstrap that fences all default application cache writes into temp."""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path


_ORIGINAL_CACHE_DIR = os.environ.get("THAI_RAG_CACHE_DIR")
_PYTEST_CACHE_DIR = Path(tempfile.mkdtemp(prefix="thai-rag-mcp-pytest-"))
os.environ["THAI_RAG_CACHE_DIR"] = str(_PYTEST_CACHE_DIR)


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_PYTEST_CACHE_DIR, ignore_errors=True)
    if _ORIGINAL_CACHE_DIR is None:
        os.environ.pop("THAI_RAG_CACHE_DIR", None)
    else:
        os.environ["THAI_RAG_CACHE_DIR"] = _ORIGINAL_CACHE_DIR
