"""Regression tests for the production-grade bug audit.

Covers:
- BUG-1: silent CPG extraction failure in retriever.index_file
- BUG-2: thread-safety of _INDEX_JOBS background job writes
- BUG-3: FTS5 rejection of symbolic/operator words (no syntax error)
- BUG-4: remember_turn surfaces a warning when embedding fails
- BUG-5: ingest_turns success-counting logic
"""
import logging
import tempfile
from pathlib import Path
from unittest import mock

import pytest

from thai_rag.server import LocalContextServer, _INDEX_JOBS, _INDEX_JOBS_LOCK, _new_index_job
from thai_rag.retriever import HybridRetriever

# --- BUG-1: CPG failure must be logged, not silently swallowed ---


def test_cpg_extraction_error_is_logged(monkeypatch, caplog):
    """index_file logs a warning but still stores parent docs when CPG raises."""
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            def _boom(*a, **k):
                raise RuntimeError("synthetic CPG failure")

            monkeypatch.setattr(
                "thai_rag.cpg_extractor.extract_cpg", _boom, raising=True
            )

            with caplog.at_level(logging.WARNING):
                result = server.retriever.index_file("finance.py", "def calc():\n    return 2\n")

            # Parent doc still stored — indexing not broken by CPG failure
            assert result >= 1
            # Failure is now visible in the log
            assert any("CPG extraction failed" in r.message for r in caplog.records)
        finally:
            server.close()


# --- BUG-2: _INDEX_JOBS writes must be lock-protected ---


def test_index_jobs_thread_safety():
    """Daemon-style concurrent writes + reads on _INDEX_JOBS do not lose updates."""
    import threading
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            job = _new_index_job("ws", False)

            def writer():
                for _ in range(200):
                    with _INDEX_JOBS_LOCK:
                        job["indexed_files"] += 1

            def reader():
                for _ in range(200):
                    with _INDEX_JOBS_LOCK:
                        _ = {k: job[k] for k in ("status", "indexed_files", "skipped_files")}

            threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            with _INDEX_JOBS_LOCK:
                assert job["indexed_files"] == 200
        finally:
            server.close()

# --- BUG-3: FTS5 must not raise on operator/symbol words ---


def test_fts_special_keywords_no_error():
    """search_code_fts handles words like OR/AND/NOT as literals, no MATCH syntax crash."""
    with tempfile.TemporaryDirectory() as tmpdir:
        storage, retriever = _make_storage_retriever(tmpdir)
        try:
            retriever.index_file("ops.py", "def or_function():\n    pass\n")
            for q in ["or", "and", "not", "near", "save OR load"]:
                res = storage.search_code_fts(q, top_k=5)
                assert isinstance(res, list)
        finally:
            storage.close()


# --- BUG-4: remember_turn must warn when embedding fails ---


def test_remember_turn_warns_on_embed_failure(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            monkeypatch.setattr(server.embedder, "is_alive", lambda: True)
            monkeypatch.setattr(
                server.embedder, "embed_document",
                lambda *a, **k: (_ for _ in ()).throw(RuntimeError("embed down")),
            )

            res = server.remember_turn(role="user", content="decision: use jwt", tags=["decision"])
            assert "⚠️" in res
            cur = server.storage.sqlite_conn.cursor()
            row = cur.execute(
                "SELECT COUNT(*) FROM conversation_turns WHERE content = ?",
                ("decision: use jwt",),
            ).fetchone()
            assert row[0] == 1
        finally:
            server.close()


# --- BUG-5: ingest_turns counts successes correctly ---


def test_ingest_turns_counts_correctly(monkeypatch):
    from scripts.embed_session_audit import ingest_turns
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            turns = [{"role": "user", "content": f"turn {i}", "summary": f"s{i}", "step_index": i} for i in range(5)]

            def fake_remember_turn_ok(**kw):
                return "✅ Conversation turn recorded [ID: turn_x]"

            monkeypatch.setattr(server, "remember_turn", fake_remember_turn_ok)
            ok, failures, _ = ingest_turns(server, turns)
            assert ok == 5, f"expected 5 successes, got {ok}: {failures}"
        finally:
            server.close()


# =====================================================================
# Round-2 regression tests (R1: code_search FTS-only degrade,
# R2: canonical file_path on write, R3: workspace-scoped lookups)
# =====================================================================


def _no_embed(monkeypatch, embedder):
    """Force hermetically deterministic embeddings (no network)."""
    monkeypatch.setattr(embedder, "is_alive", lambda: True)
    monkeypatch.setattr(embedder, "embed_documents", lambda docs: [[0.0] * 8 for _ in docs])
    monkeypatch.setattr(embedder, "embed_document", lambda doc: [0.0] * 8)
    monkeypatch.setattr(embedder, "embed_query", lambda q: [0.1] * 8)


# --- R1: code_search must degrade to FTS-only when Ollama is unreachable ---


def test_code_search_fts_only_when_ollama_down(monkeypatch):
    """BUG-R1: code_search returns FTS results (not an Ollama error) when embedder is down."""
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            _no_embed(monkeypatch, server.embedder)
            server.retriever.index_file(
                "ws1/calc.py", "def calculate_vat(amount):\n    return amount\n", workspace="ws1"
            )

            # Now kill the embedder — retrieval must NOT error out, it must use FTS only
            monkeypatch.setattr(server.embedder, "is_alive", lambda: False)
            monkeypatch.setattr(
                server.embedder, "embed_query",
                lambda *a, **k: (_ for _ in ()).throw(RuntimeError("ollama down")),
            )

            res = server.code_search("calculate_vat", top_k=3)
            assert "server is unreachable" not in res, f"should not hard-error on Ollama, got: {res[:200]}"
            assert "calculate_vat" in res, f"FTS-only match expected, got: {res[:200]}"
            assert "degraded" in res, f"degradation notice expected, got: {res[:200]}"
        finally:
            server.close()


# --- R2: index_file must store canonical <ws>/<rel> paths ---


def test_index_file_canonicalizes_bare_path(monkeypatch):
    """BUG-R2: parents/chunks/cpg all store the workspace-prefixed canonical path."""
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            _no_embed(monkeypatch, server.embedder)
            server.retriever.index_file("plan.md", "# Title\n\nSome plan content.\n", workspace="ws1")

            cur = server.storage.sqlite_conn.cursor()
            row = cur.execute("SELECT file_path FROM parent_documents LIMIT 1").fetchone()
            assert row is not None and row[0] == "ws1/plan.md", f"got: {row}"
            sym_row = cur.execute("SELECT DISTINCT file_path FROM code_symbols LIMIT 1").fetchone()
            if sym_row is not None:
                assert sym_row[0] == "ws1/plan.md", f"cpg path got: {sym_row[0]}"
        finally:
            server.close()


# --- R2: get_file_symbols tolerates both stored formats ---


def test_get_file_symbols_matches_bare_and_canonical():
    """BUG-R3: lookup must resolve legacy bare rows and canonical rows for the same file."""
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            st = server.storage
            # Seed a canonical row AND a legacy bare row for the same file/workspace
            st.save_code_graph(
                "ws1/plan.md",
                [{"file_path": "ws1/plan.md", "symbol_name": "plan_doc", "symbol_type": "document",
                  "line_start": 1, "line_end": 5, "workspace": "ws1"}],
                [], workspace="ws1",
            )
            st.sqlite_conn.execute(
                "INSERT OR REPLACE INTO code_symbols (file_path, symbol_name, symbol_type, line_start, line_end, workspace) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("plan.md", "plan_doc", "document", 1, 5, ""),
            )
            st.sqlite_conn.commit()

            found = st.get_file_symbols("plan.md", workspace="ws1")
            paths = {r["file_path"] for r in found}
            assert "ws1/plan.md" in paths, f"canonical row not found: {found}"
            assert "plan.md" in paths, f"legacy bare row not found (R3 regression): {found}"
        finally:
            server.close()


# --- R3: workspace-scoped blast radius stays isolated ---


def test_blast_radius_workspace_scoping():
    """BUG-R3: symbol identical in two workspaces must not leak callers across workspaces."""
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            st = server.storage
            # ws1 calls save_conversation_turn
            st.save_code_graph(
                "ws1/ingest.py",
                [{"file_path": "ws1/ingest.py", "symbol_name": "run_ingest", "symbol_type": "function",
                  "line_start": 1, "line_end": 3, "workspace": "ws1"}],
                [{"source_symbol": "run_ingest", "source_file": "ws1/ingest.py",
                  "target_symbol": "save_conversation_turn", "target_file": "ws1/storage.py",
                  "edge_type": "function", "workspace": "ws1"}],
                workspace="ws1",
            )
            # ws2 has an UNRELATED call to the same symbol — must be excluded
            st.save_code_graph(
                "ws2/other.py",
                [{"file_path": "ws2/other.py", "symbol_name": "run_other", "symbol_type": "function",
                  "line_start": 1, "line_end": 3, "workspace": "ws2"}],
                [{"source_symbol": "run_other", "source_file": "ws2/other.py",
                  "target_symbol": "save_conversation_turn", "target_file": "ws2/storage.py",
                  "edge_type": "function", "workspace": "ws2"}],
                workspace="ws2",
            )

            blast = st.get_symbol_blast_radius("save_conversation_turn", workspace="ws1")
            caller_files = [c.get("source_file", "") for c in blast["callers"]]
            assert any("ws1/ingest.py" in f for f in caller_files), f"ws1 caller missing: {caller_files}"
            assert not any("ws2/" in f for f in caller_files), f"ws2 leaked into ws1 scope: {caller_files}"
        finally:
            server.close()


# --- R2: bare-path migration is idempotent ---


def test_normalize_bare_paths_idempotent():
    """BUG-R2: normalize_bare_paths converts bare rows once; a second run migrates 0."""
    from scripts.normalize_bare_paths import normalize_bare_paths

    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            st = server.storage
            # One bare parent row that resolves to a known workspace via file_cache
            st.set_file_hash("ws1/plan.md", 12345.0, "abc")
            st.sqlite_conn.execute(
                "INSERT INTO parent_documents (id, file_path, start_line, end_line, content, symbol_name, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("p_bare", "plan.md", 1, 5, "content", "plan_doc", "2026-01-01T00:00:00+00:00"),
            )
            st.sqlite_conn.commit()

            first = normalize_bare_paths(st)
            assert first["migrated"] >= 1, f"expected >=1 migrated, got: {first}"
            row = st.sqlite_conn.execute(
                "SELECT file_path FROM parent_documents WHERE id = 'p_bare'"
            ).fetchone()
            assert row[0] == "ws1/plan.md", f"bare row not canonicalized: {row[0]}"

            second = normalize_bare_paths(st)
            assert second["migrated"] == 0, f"second run should be no-op, got: {second}"
        finally:
            server.close()


# --- BUG-R5: search_code_vector path_filter fetch pool too small ---


def test_path_filter_vector_search_does_not_deplete_fetch_pool():
    """Exact-file path_filter must still hit a vector even when the file is NOT
    among Chroma's nearest top_k — the python-side path filter needs a larger
    candidate pool than top_k."""
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            st = server.storage
            n = 200
            docs = [f"def func_{i}(): return {i}" for i in range(n)]
            ids = [f"c_{i}" for i in range(n)]
            metas = [
                {
                    "parent_id": f"p_{i}",
                    "file_path": f"wsA/module{i}.py",
                    "start_line": 1,
                    "end_line": 1,
                    "symbol_name": f"func_{i}",
                    "workspace": "wsA",
                }
                for i in range(n)
            ]
            # Injected vectors: all docs share dims, so Chroma's nearest-k order
            # is arbitrary — the target file will not reliably rank in top-5.
            vectors = [[1.0 + (i % 7) * 0.5] * 8 for i in range(n)]
            st.save_child_vectors(ids, vectors, docs, metas)

            q = [3.5] * 8

            exact = st.search_code_vector(q, top_k=5, path_filter="wsA/module199.py")
            assert len(exact) >= 1, (
                "exact-file path_filter dropped an indexed file: expected >=1 vector hit, got 0"
            )
            assert exact[0]["metadata"]["file_path"] == "wsA/module199.py"

            # directory-prefix filter keeps working
            pref = st.search_code_vector(q, top_k=5, path_filter="wsA/module1")
            assert all(
                "wsA/module1" in r["metadata"]["file_path"] for r in pref
            ), "prefix path_filter leaked non-matching files"
        finally:
            server.close()


# --- BUG-R5b: index_workspace silently swallows programmer errors as 'skipped' ---


def test_index_workspace_logs_errors_instead_of_silent_skip(tmp_path, caplog):
    """When index_file raises (e.g. a chunker NameError), index_workspace must
    surface it in logs — a blanket except previously hid real bugs (R4)."""
    work = tmp_path / "ws"
    work.mkdir()
    (work / "good.py").write_text("def add(a, b):\n    return a + b\n")
    (work / "bad.py").write_text("def boom():\n    return 1\n")

    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            original = server.chunker.chunk_file

            def _explode(file_path, content):
                if file_path.endswith("bad.py"):
                    raise NotImplementedError("synthetic chunker failure")
                return original(file_path, content)

            server.chunker.chunk_file = _explode

            with caplog.at_level(logging.WARNING, logger="thai_rag.retriever"):
                res = server.retriever.index_workspace(str(work))

            # one file indexed, one skipped
            assert res["indexed"] == 1, res
            assert res["skipped"] == 1, res
            # failure is visible, not silent
            assert any(
                r.message and "bad.py" in r.message and "synthetic" in r.message
                for r in caplog.records
            ), "index_workspace hid the chunker failure — no log record"
        finally:
            server.close()


# --- BUG-R6: get_context must normalize absolute paths to stored rel form ---


def test_get_context_normalizes_absolute_path(tmp_path):
    """code_context-style lookup with an absolute file path must resolve to the
    <ws>/<rel> parent doc that index_file stored (BUG-10 class)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        server = LocalContextServer(
            sqlite_path=Path(tmpdir) / "t.db",
            chroma_path=str(Path(tmpdir) / "chroma"),
        )
        try:
            st = server.storage
            st.save_parent_doc(
                "p_ctx",
                "prepaid/tsconfig.json",
                1, 20,
                "{\n  \"compilerOptions\": {}\n}",
                "tsconfig_json",
            )

            # relative form works (baseline)
            rel = server.retriever.get_context("prepaid/tsconfig.json", 5)
            assert rel and rel["file_path"] == "prepaid/tsconfig.json"

            # absolute form must resolve via suffix normalization
            abs_path = "/home/qwerty/Documents/Src Code/prepaid/tsconfig.json"
            got = server.retriever.get_context(abs_path, 5)
            assert got, f"absolute path_filter should resolve, got None: {abs_path}"
            assert got["file_path"] == "prepaid/tsconfig.json", got
        finally:
            server.close()


# --- BUG-R7: TS arrow regex must require '=>' (avoid const x = call( ) false match) ---


def test_ts_arrow_regex_rejects_assignment_with_call_rhs():
    """`const customEndpointUrl = (this.el.querySelector('x'))` is an assignment,
    not an arrow function — it must not hijack current_func for call edges."""
    from thai_rag.cpg_extractor import extract_ts_cpg, RE_TS_ARROW

    # precision: regex itself rejects the assignment-with-call form
    assert not RE_TS_ARROW.search(
        "const customEndpointUrl = (this.modalElement.querySelector('#wt-custom-endpoint'))"
    ), "RE_TS_ARROW matched a plain assignment whose RHS is a call"

    # still matches real arrow functions (paren and bare styles)
    assert RE_TS_ARROW.search("const handler = async (e) => {")
    assert RE_TS_ARROW.search("const fn = (a, b) => a + b")

    content = (
        "class Settings {\n"
        "  private save(): void {\n"
        "    const customEndpointUrl = (this.el.querySelector('#wt-custom-endpoint')).value;\n"
        "    const res = testApiKey(customEndpointUrl);\n"
        "  }\n"
        "}\n"
    )
    symbols, edges = extract_ts_cpg("settings-modal.ts", content, "webtrans_prepaid")
    call_edges = [e for e in edges if e["target_symbol"] == "testApiKey"]
    assert call_edges, "expected a testApiKey call edge"
    # caller must be the real enclosing method, not the assignment variable
    assert call_edges[0]["source_symbol"] == "Settings.save", call_edges[0]
    assert "customEndpointUrl" not in {e["source_symbol"] for e in edges}


# --- helpers ---


def _make_storage_retriever(tmpdir):
    from thai_rag.storage import StorageManager
    from thai_rag.ollama_adapter import OllamaEmbeddingAdapter
    from thai_rag.code_chunker import CodeChunker

    storage = StorageManager(sqlite_path=Path(tmpdir) / "t.db", chroma_path=str(Path(tmpdir) / "chroma"))
    retriever = HybridRetriever(
        storage=storage,
        embedder=OllamaEmbeddingAdapter(),
        chunker=CodeChunker(),
    )
    return storage, retriever

