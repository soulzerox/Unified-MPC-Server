import pytest
import tempfile
import shutil
from pathlib import Path
from thai_rag.storage import StorageManager
from tests.fakes import DeterministicEmbeddingAdapter
from thai_rag.code_chunker import CodeChunker
from thai_rag.retriever import HybridRetriever

@pytest.fixture
def temp_env():
    temp_dir = tempfile.mkdtemp()
    db_path = Path(temp_dir) / "test.db"
    chroma_path = str(Path(temp_dir) / "chroma")
    storage = StorageManager(sqlite_path=db_path, chroma_path=chroma_path)
    adapter = DeterministicEmbeddingAdapter()
    chunker = CodeChunker()
    retriever = HybridRetriever(storage=storage, embedder=adapter, chunker=chunker)

    # Ingest a sample file
    code = """# ระบบคำนวณและประมวลผลทางการเงิน
def calculate_vat_thailand(amount: float) -> float:
    # คำนวณภาษีมูลค่าเพิ่ม 7% ของยอดเงิน
    return amount * 0.07

def process_refund_slip(slip_id: str):
    # ตรวจสอบสลิปและคืนเงินให้ลูกค้า
    return {"slip": slip_id, "status": "approved"}
"""
    retriever.index_file("finance.py", code)

    yield retriever, storage
    storage.close()
    shutil.rmtree(temp_dir, ignore_errors=True)

def test_hybrid_search_exact_symbol(temp_env):
    retriever, _ = temp_env
    results = retriever.search("calculate_vat_thailand", top_k=3)
    assert len(results) > 0
    top = results[0]
    assert top["file_path"] == "finance.py"
    assert "calculate_vat_thailand" in top["symbol_name"]
    assert "0.07" in top["content"]

def test_hybrid_search_thai_semantic(temp_env):
    retriever, _ = temp_env
    results = retriever.search("การคืนเงินให้ลูกค้า", top_k=3)
    assert len(results) > 0
    top = results[0]
    assert top["file_path"] == "finance.py"
    assert "refund" in top["content"] or "คืนเงิน" in top["content"]

def test_get_context_around_line(temp_env):
    retriever, _ = temp_env
    ctx = retriever.get_context("finance.py", line_number=3, window_lines=5)
    assert ctx is not None
    assert "calculate_vat_thailand" in ctx["content"]
    assert ctx["start_line"] <= 3 <= ctx["end_line"]


def test_retriever_search_with_path_filter(temp_env):
    retriever, _ = temp_env
    retriever.index_file("project_a/core.py", "def compute_alpha(): return 42")
    retriever.index_file("project_b/core.py", "def compute_beta(): return 99")

    res_a = retriever.search("compute", top_k=5, path_filter="project_a")
    assert all("project_a" in r["file_path"] for r in res_a)

    res_b = retriever.search("compute", top_k=5, path_filter="project_b")
    assert all("project_b" in r["file_path"] for r in res_b)


def test_retriever_excludes_backup_and_lockfiles(temp_env):
    retriever, storage = temp_env
    ws_dir = Path(tempfile.mkdtemp())
    try:
        # Create normal file
        (ws_dir / "src").mkdir(parents=True)
        (ws_dir / "src" / "index.ts").write_text("export const run = () => 1;", encoding="utf-8")

        # Create lockfile
        (ws_dir / "package-lock.json").write_text('{"name": "test", "lockfileVersion": 3}', encoding="utf-8")

        # Create Backup folder
        (ws_dir / "Backup").mkdir(parents=True)
        (ws_dir / "Backup" / "index.ts").write_text("export const run = () => 0;", encoding="utf-8")

        res = retriever.index_workspace(str(ws_dir))
        assert res["indexed"] == 1
        
        cur = storage.sqlite_conn.cursor()
        rows = cur.execute("SELECT file_path FROM parent_documents").fetchall()
        paths = [r[0] for r in rows]
        assert any("index.ts" in p and "Backup" not in p for p in paths)
        assert not any("package-lock.json" in p for p in paths)
        assert not any("Backup" in p for p in paths)
    finally:
        shutil.rmtree(ws_dir, ignore_errors=True)


def test_retriever_excludes_sensitive_credentials_and_secrets(temp_env):
    retriever, storage = temp_env
    ws_dir = Path(tempfile.mkdtemp())
    try:
        # Create valid file
        (ws_dir / "app.py").write_text("print('safe')", encoding="utf-8")

        # Create sensitive and minified files
        (ws_dir / "client_secrets.json").write_text('{"client_id": "secret123"}', encoding="utf-8")
        (ws_dir / "google_credentials.json").write_text('{"private_key": "pk"}', encoding="utf-8")
        (ws_dir / "service_account.json").write_text('{"type": "service_account"}', encoding="utf-8")
        (ws_dir / "token.json").write_text('{"access_token": "xyz"}', encoding="utf-8")
        (ws_dir / "server.pem").write_text("-----BEGIN RSA PRIVATE KEY-----", encoding="utf-8")
        (ws_dir / "TOKEN_ENC_KEY.txt").write_text("183c8f911cf073f9f0a5e3bbaeebd610", encoding="utf-8")
        (ws_dir / ".dev.vars").write_text("SECRET_KEY=supersecret", encoding="utf-8")
        (ws_dir / "app.min.js").write_text("var a=1,b=2;", encoding="utf-8")
        (ws_dir / "engine-core.hash.js").write_text("var x=1;" + "a" * 25000, encoding="utf-8")

        res = retriever.index_workspace(str(ws_dir))
        assert res["indexed"] == 1

        cur = storage.sqlite_conn.cursor()
        rows = cur.execute("SELECT file_path FROM parent_documents").fetchall()
        paths = [r[0] for r in rows]
        assert any("app.py" in p for p in paths)
        assert not any("client_secrets" in p for p in paths)
        assert not any("credentials" in p for p in paths)
        assert not any("service_account" in p for p in paths)
        assert not any("token.json" in p for p in paths)
        assert not any(".pem" in p for p in paths)
        assert not any("TOKEN_ENC_KEY" in p for p in paths)
        assert not any(".dev.vars" in p for p in paths)
        assert not any(".min.js" in p for p in paths)
        assert not any("engine-core" in p for p in paths)
    finally:
        shutil.rmtree(ws_dir, ignore_errors=True)


def test_retriever_indexes_shebang_scripts_without_extension(temp_env):
    retriever, storage = temp_env
    ws_dir = Path(tempfile.mkdtemp())
    try:
        # Script without extension starting with #!
        (ws_dir / "live").write_text("#!/bin/bash\nexec python3 app.py\n", encoding="utf-8")
        # Standard Makefile
        (ws_dir / "Makefile").write_text("all:\n\techo build\n", encoding="utf-8")
        # Binary file without extension (should be skipped)
        (ws_dir / "binary_blob").write_bytes(b"\x00\x01\x02\x03\x04")

        res = retriever.index_workspace(str(ws_dir))
        assert res["indexed"] >= 2

        cur = storage.sqlite_conn.cursor()
        rows = cur.execute("SELECT file_path FROM parent_documents").fetchall()
        paths = [r[0] for r in rows]
        assert any("live" in p for p in paths)
        assert any("Makefile" in p for p in paths)
        assert not any("binary_blob" in p for p in paths)
    finally:
        shutil.rmtree(ws_dir, ignore_errors=True)


def test_retriever_indexes_web_frontend_extensions_and_excludes_meta_js(temp_env):
    retriever, storage = temp_env
    ws_dir = Path(tempfile.mkdtemp())
    try:
        # Create web frontend files
        (ws_dir / "index.html").write_text("<!DOCTYPE html><html><body><h1>Title</h1></body></html>", encoding="utf-8")
        (ws_dir / "style.css").write_text(".container { display: flex; color: #333; }", encoding="utf-8")
        (ws_dir / "app.vue").write_text("<template><div>Vue</div></template>", encoding="utf-8")
        (ws_dir / "widget.svelte").write_text("<script>let count = 0;</script>", encoding="utf-8")

        # Create meta.js userscript header (should be excluded)
        (ws_dir / "script.user.js.meta.js").write_text("// ==UserScript==\n// @version 1.0\n// ==/UserScript==", encoding="utf-8")

        res = retriever.index_workspace(str(ws_dir))
        assert res["indexed"] == 4

        cur = storage.sqlite_conn.cursor()
        rows = cur.execute("SELECT file_path FROM parent_documents").fetchall()
        paths = [r[0] for r in rows]
        assert any("index.html" in p for p in paths)
        assert any("style.css" in p for p in paths)
        assert any("app.vue" in p for p in paths)
        assert any("widget.svelte" in p for p in paths)
        assert not any(".meta.js" in p for p in paths)
    finally:
        shutil.rmtree(ws_dir, ignore_errors=True)


def test_incremental_skip_by_mtime():
    """IMP-2 regression: unchanged mtime must skip without re-indexing; changed mtime must re-index."""
    import os
    import time as _time

    temp_dir = tempfile.mkdtemp()
    try:
        db_path = Path(temp_dir) / "t.db"
        chroma_path = str(Path(temp_dir) / "chroma")
        storage = StorageManager(sqlite_path=db_path, chroma_path=chroma_path)
        retriever = HybridRetriever(
            storage=storage,
            embedder=DeterministicEmbeddingAdapter(),
            chunker=CodeChunker(),
        )
        ws_dir = Path(temp_dir) / "ws"
        ws_dir.mkdir()
        f = ws_dir / "mod.py"
        f.write_text("def alpha():\n    return 1\n", encoding="utf-8")

        res1 = retriever.index_workspace(str(ws_dir))
        assert res1["indexed"] == 1

        # Second run: nothing changed → skipped
        res2 = retriever.index_workspace(str(ws_dir))
        assert res2["indexed"] == 0 and res2["skipped"] == 1

        # Change content but restore the old mtime → mtime short-circuit must skip
        st = f.stat()
        f.write_text("def beta():\n    return 2\n", encoding="utf-8")
        os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns))
        res3 = retriever.index_workspace(str(ws_dir))
        assert res3["indexed"] == 0 and res3["skipped"] == 1

        # Bump mtime → must re-index
        _time.sleep(0.01)
        os.utime(f, None)
        res4 = retriever.index_workspace(str(ws_dir))
        assert res4["indexed"] == 1
        assert "embed_fallbacks" in res4

        storage.close()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_code_search_absolute_path_filter():
    """BUG-10 regression: absolute path_filter must match relative indexed paths."""
    temp_dir = tempfile.mkdtemp()
    try:
        storage = StorageManager(sqlite_path=str(Path(temp_dir) / "t.db"), chroma_path=str(Path(temp_dir) / "ch"))
        retriever = HybridRetriever(storage=storage, embedder=DeterministicEmbeddingAdapter(), chunker=CodeChunker())
        ws_dir = Path(temp_dir) / "finance"
        ws_dir.mkdir()
        f = ws_dir / "calc.py"
        f.write_text("# คำนวณภาษี\n\ndef calculate_vat_thailand(amount: float) -> float:\n    return amount * 0.07\n", encoding="utf-8")
        retriever.index_workspace(str(ws_dir))

        # Relative stored path is "finance/calc.py"; search with the full absolute file path
        rel = storage._normalize_abs_to_rel(str(f))
        assert rel.endswith("finance/calc.py"), rel

        results = retriever.search("calculate_vat_thailand", top_k=3, path_filter=str(f))
        assert len(results) > 0, f"absolute path_filter should match, got: {results}"
        assert any("calc.py" in r["file_path"] for r in results)

        storage.close()
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_index_workspace_uses_explicit_namespace_after_realpath_resolution(temp_env):
    """Explicit namespaces survive symlink resolution and same-basename roots."""
    retriever, storage = temp_env
    temp_dir = Path(tempfile.mkdtemp())
    try:
        first_root = temp_dir / "first" / "repo"
        second_root = temp_dir / "second" / "repo"
        first_root.mkdir(parents=True)
        second_root.mkdir(parents=True)
        (first_root / "module.py").write_text("def first_workspace_symbol():\n    return 1\n", encoding="utf-8")
        (second_root / "module.py").write_text("def second_workspace_symbol():\n    return 2\n", encoding="utf-8")
        first_alias = temp_dir / "first-source"
        first_alias.symlink_to(first_root, target_is_directory=True)

        first_namespace = "11111111-1111-4111-8111-111111111111"
        second_namespace = "22222222-2222-4222-8222-222222222222"
        retriever.index_workspace(str(first_alias), workspace=first_namespace)
        retriever.index_workspace(str(second_root), workspace=second_namespace)

        rows = storage.sqlite_conn.cursor().execute(
            "SELECT file_path FROM parent_documents WHERE file_path LIKE '%/module.py'"
        ).fetchall()
        paths = {row[0] for row in rows}
        assert f"{first_namespace}/module.py" in paths
        assert f"{second_namespace}/module.py" in paths
        assert not any(path.startswith("repo/") for path in paths)

        first_results = retriever.search("workspace_symbol", path_filter=first_namespace)
        second_results = retriever.search("workspace_symbol", path_filter=second_namespace)
        assert all(result["file_path"].startswith(f"{first_namespace}/") for result in first_results)
        assert all(result["file_path"].startswith(f"{second_namespace}/") for result in second_results)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_index_workspace_migrates_legacy_namespace(temp_env):
    retriever, storage = temp_env
    temp_dir = Path(tempfile.mkdtemp())
    try:
        workspace_root = temp_dir / "legacy-repo"
        workspace_root.mkdir()
        source_file = workspace_root / "module.py"
        source_file.write_text("def legacy_symbol():\n    return 1\n", encoding="utf-8")
        retriever.index_workspace(str(workspace_root))

        source_file.write_text("def migrated_symbol():\n    return 2\n", encoding="utf-8")
        namespace = "33333333-3333-4333-8333-333333333333"
        retriever.index_workspace(str(workspace_root), force=True, workspace=namespace)

        rows = storage.sqlite_conn.cursor().execute(
            "SELECT file_path FROM parent_documents"
        ).fetchall()
        paths = {row[0] for row in rows}
        assert "legacy-repo/module.py" not in paths
        assert f"{namespace}/module.py" in paths
        assert retriever.search("migrated_symbol", path_filter="legacy-repo") == []
        assert any(result["file_path"] == f"{namespace}/module.py" for result in retriever.search("migrated_symbol", path_filter=namespace))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_index_workspace_rejects_multi_segment_namespace(temp_env):
    retriever, _ = temp_env
    temp_dir = Path(tempfile.mkdtemp())
    try:
        workspace_root = temp_dir / "repo"
        workspace_root.mkdir()
        (workspace_root / "module.py").write_text("def symbol():\n    return 1\n", encoding="utf-8")
        with pytest.raises(ValueError, match="single identifier"):
            retriever.index_workspace(str(workspace_root), workspace="foo/bar")
        with pytest.raises(ValueError, match="single identifier"):
            retriever.index_workspace(str(workspace_root), workspace="foo\\bar")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def test_delete_workspace_namespace_escapes_like_wildcards(temp_env):
    _, storage = temp_env
    storage.save_parent_doc("legacy-doc", "legacy_repo/module.py", 1, 1, "legacy", "legacy")
    storage.save_parent_doc("sibling-doc", "legacyXrepo/module.py", 1, 1, "sibling", "sibling")

    storage.delete_workspace_namespace("legacy_repo")

    rows = storage.sqlite_conn.cursor().execute(
        "SELECT file_path FROM parent_documents"
    ).fetchall()
    paths = {row[0] for row in rows}
    assert "legacy_repo/module.py" not in paths
    assert "legacyXrepo/module.py" in paths
