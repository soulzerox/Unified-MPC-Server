"""Unit tests for ProgressReporter, EWMA ETA calculation, and IPC socket communication."""
import os
import time
import json
import socket
import select
import threading
import tempfile
from pathlib import Path
import pytest

from thai_rag.progress import (
    ProgressReporter,
    NullProgressReporter,
    ProgressEvent,
    format_duration,
)
from thai_rag.retriever import HybridRetriever
from thai_rag.storage import StorageManager
from thai_rag.code_chunker import CodeChunker


def test_format_duration():
    assert format_duration(0) == "0s"
    assert format_duration(30) == "30s"
    assert format_duration(60) == "1m 00s"
    assert format_duration(75) == "1m 15s"
    assert format_duration(3600) == "1h 00m"
    assert format_duration(3665) == "1h 01m"


def test_progress_reporter_ewma_and_eta():
    # Use a dummy non-existent socket with auto_launch_hud=False
    dummy_sock = Path(tempfile.gettempdir()) / f"test_dummy_{time.time()}.sock"
    reporter = ProgressReporter(sock_path=dummy_sock, alpha=0.5, auto_launch_hud=False)

    reporter.notify_start(total_files=10, workspace="/test")
    assert reporter.total_files == 10

    # Simulate step 1
    time.sleep(0.05)
    reporter.notify_step("file1.ts", index=1, total=10, skipped=False, chunks=2)
    assert reporter.ewma_time_per_file > 0
    eta_1 = 9 * reporter.ewma_time_per_file

    # Simulate step 2
    time.sleep(0.05)
    reporter.notify_step("file2.ts", index=2, total=10, skipped=False, chunks=3)
    assert reporter.ewma_time_per_file > 0

    # Simulate skipped step
    reporter.notify_step("file3.ts", index=3, total=10, skipped=True, chunks=0)
    # Skipped file should not alter ewma speed drastically
    reporter.notify_finish(indexed=2, skipped=1, duration_s=0.15)


def test_progress_reporter_ipc_communication():
    """Verify that ProgressReporter sends well-formed JSON events over Unix domain socket."""
    sock_dir = tempfile.mkdtemp()
    sock_path = Path(sock_dir) / "test_progress.sock"

    received_events = []
    server_ready = threading.Event()
    stop_server = threading.Event()

    def socket_server():
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(sock_path))
        server.listen(1)
        server_ready.set()

        server.settimeout(0.3)
        conn = None
        while not stop_server.is_set():
            try:
                conn, _ = server.accept()
                break
            except socket.timeout:
                continue

        if conn:
            buffer = ""
            while not stop_server.is_set():
                r, _, _ = select.select([conn], [], [], 0.1)
                if not r:
                    continue
                data = conn.recv(4096)
                if not data:
                    break
                buffer += data.decode("utf-8")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    if line.strip():
                        received_events.append(json.loads(line.strip()))
            conn.close()
        server.close()
        try:
            sock_path.unlink()
        except Exception:
            pass

    t = threading.Thread(target=socket_server, daemon=True)
    t.start()
    assert server_ready.wait(timeout=2.0)

    # Reporter connecting to the mock socket
    reporter = ProgressReporter(sock_path=sock_path, auto_launch_hud=False)
    reporter.notify_start(total_files=5, workspace="/my/workspace")
    time.sleep(0.02)
    reporter.notify_step("src/main.ts", index=1, total=5, skipped=False, chunks=2)
    time.sleep(0.02)
    reporter.notify_step("src/util.ts", index=2, total=5, skipped=True, chunks=0)
    time.sleep(0.02)
    reporter.notify_finish(indexed=1, skipped=1, duration_s=0.06)

    # Give reader thread a moment to drain
    time.sleep(0.1)
    stop_server.set()
    t.join(timeout=1.0)

    # Validate received events
    event_types = [e.get("event_type") for e in received_events]
    assert "start" in event_types
    assert "progress" in event_types
    assert "finish" in event_types

    progress_event = [e for e in received_events if e.get("event_type") == "progress"][0]
    assert progress_event["file_name"] == "src/main.ts"
    assert progress_event["current_index"] == 1
    assert progress_event["total_files"] == 5
    assert progress_event["percent"] == 20.0
    assert "eta_str" in progress_event


def test_null_progress_reporter_safety():
    """NullProgressReporter should be a safe no-op that never throws."""
    null_rep = NullProgressReporter()
    null_rep.notify_start(100, "/tmp")
    null_rep.notify_step("a.py", 1, 100, False, 1)
    null_rep.notify_finish(1, 0, 0.5)
    null_rep.notify_error("test error")
    null_rep.close()


def test_index_workspace_calls_progress_reporter(tmp_path):
    """Test that retriever.index_workspace calls progress reporter hooks."""
    # Create mock workspace
    f1 = tmp_path / "hello.py"
    f1.write_text("def hello():\n    return 'world'\n")
    f2 = tmp_path / "calc.py"
    f2.write_text("def add(a, b):\n    return a + b\n")

    db_path = tmp_path / "test.db"
    chroma_dir = tmp_path / "chroma"
    storage = StorageManager(sqlite_path=db_path, chroma_path=str(chroma_dir))

    class MockEmbedder:
        def embed_documents(self, docs):
            return [[0.1] * 768 for _ in docs]
        def embed_document(self, doc):
            return [0.1] * 768

    retriever = HybridRetriever(
        storage=storage,
        embedder=MockEmbedder(),
        chunker=CodeChunker()
    )

    class RecordingReporter(NullProgressReporter):
        def __init__(self):
            self.starts = []
            self.steps = []
            self.finishes = []

        def notify_start(self, total, ws):
            self.starts.append((total, ws))

        def notify_step(self, fname, idx, total, skipped=False, chunks=0):
            self.steps.append((fname, idx, total, skipped, chunks))

        def notify_finish(self, idx_count, skp_count, dur):
            self.finishes.append((idx_count, skp_count, dur))

    rec = RecordingReporter()
    res = retriever.index_workspace(str(tmp_path), progress_reporter=rec)

    assert res["indexed"] == 2
    assert len(rec.starts) == 1
    assert rec.starts[0][0] == 2  # 2 files
    assert len(rec.steps) == 2
    assert len(rec.finishes) == 1
    assert rec.finishes[0][0] == 2  # 2 indexed
