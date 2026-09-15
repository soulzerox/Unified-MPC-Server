from pathlib import Path

from scripts import backfill_cpg
from thai_rag.storage import StorageManager


def _storage(tmp_path: Path) -> StorageManager:
    return StorageManager(
        sqlite_path=tmp_path / "local_context.db",
        chroma_path=str(tmp_path / "chroma"),
    )


def test_backfill_is_dry_run_by_default_and_apply_is_idempotent(tmp_path, monkeypatch):
    source_parent = tmp_path / "sources"
    source = source_parent / "demo" / "app.py"
    source.parent.mkdir(parents=True)
    source.write_text("def hello():\n    return 1\n", encoding="utf-8")

    storage = _storage(tmp_path / "state")
    try:
        storage.set_file_hash("demo/app.py", 1.0, "abc")

        def fake_extract(file_path, content, workspace=""):
            assert file_path == "demo/app.py"
            assert "def hello" in content
            assert workspace == "demo"
            return ([{
                "file_path": file_path,
                "symbol_name": "hello",
                "symbol_type": "function",
                "line_start": 1,
                "line_end": 2,
                "workspace": workspace,
            }], [])

        monkeypatch.setattr(backfill_cpg, "extract_cpg", fake_extract)

        planned = backfill_cpg.run_backfill(storage, roots=[source_parent])
        assert planned == {
            "candidates": 1,
            "planned": 1,
            "applied": 0,
            "unresolved": 0,
            "failed": 0,
            "empty": 0,
        }
        assert storage.sqlite_conn.execute("SELECT COUNT(*) FROM code_symbols").fetchone()[0] == 0

        applied = backfill_cpg.run_backfill(storage, roots=[source_parent], apply=True)
        assert applied["applied"] == 1
        assert storage.sqlite_conn.execute("SELECT COUNT(*) FROM code_symbols").fetchone()[0] == 1

        repeated = backfill_cpg.run_backfill(storage, roots=[source_parent], apply=True)
        assert repeated["candidates"] == 0
        assert repeated["applied"] == 0
        assert storage.sqlite_conn.execute("SELECT COUNT(*) FROM code_symbols").fetchone()[0] == 1
    finally:
        storage.close()


def test_backfill_refuses_ambiguous_source_paths(tmp_path):
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    for root in (first_root, second_root):
        source = root / "demo" / "same.py"
        source.parent.mkdir(parents=True)
        source.write_text("def same():\n    pass\n", encoding="utf-8")

    assert backfill_cpg.resolve_file("demo/same.py", [first_root, second_root]) is None


def test_backfill_refuses_absolute_stored_paths(tmp_path):
    outside = tmp_path / "outside.py"
    outside.write_text("def outside():\n    pass\n", encoding="utf-8")

    assert backfill_cpg.resolve_file(str(outside), [tmp_path / "allowed-root"]) is None


def test_backup_sqlite_copies_current_state(tmp_path):
    storage = _storage(tmp_path / "state")
    try:
        storage.set_file_hash("demo/app.py", 1.0, "abc")
        backup_path = backfill_cpg.backup_sqlite(storage)
        assert backup_path.is_file()

        import sqlite3

        with sqlite3.connect(str(backup_path)) as backup:
            count = backup.execute("SELECT COUNT(*) FROM file_cache WHERE file_path = ?", ("demo/app.py",)).fetchone()[0]
        assert count == 1
    finally:
        storage.close()
