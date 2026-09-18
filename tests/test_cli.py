from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from thai_rag.cli import build_parser
from thai_rag.config import CACHE_DIR
from tests.fakes import DeterministicEmbeddingAdapter


def test_cli_parser_exposes_standalone_and_index_modes():
    parser = build_parser()
    assert parser.parse_args(["--stdio"]).stdio is True
    parsed = parser.parse_args(["--index", "/tmp/example", "--force"])
    assert parsed.index == "/tmp/example"
    assert parsed.force is True


def test_cli_help_does_not_create_cache_directory(tmp_path):
    cache_dir = tmp_path / "cache"
    env = os.environ.copy()
    env["THAI_RAG_CACHE_DIR"] = str(cache_dir)
    result = subprocess.run(
        [sys.executable, "-m", "thai_rag.cli", "--help"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "thai-rag-mcp" in result.stdout
    assert not cache_dir.exists()


def test_deterministic_embedding_fake_is_finite_nonzero_and_dimension_aware():
    adapter = DeterministicEmbeddingAdapter(dimension=17)
    vector = adapter.embed_document("ทดสอบ deterministic embedding")
    assert len(vector) == 17
    assert any(value != 0.0 for value in vector)
    assert all(value == value and abs(value) != float("inf") for value in vector)
    assert vector == adapter.embed_document("ทดสอบ deterministic embedding")


def test_pytest_bootstrap_redirects_application_cache():
    configured = Path(os.environ["THAI_RAG_CACHE_DIR"]).resolve()
    assert CACHE_DIR.resolve() == configured
    assert "thai-rag-mcp-pytest-" in configured.name
