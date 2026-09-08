import pytest
import tempfile
import shutil
from pathlib import Path
from thai_rag.server import LocalContextServer

@pytest.fixture
def bench_server():
    temp_dir = tempfile.mkdtemp()
    db_path = Path(temp_dir) / "bench.db"
    chroma_path = str(Path(temp_dir) / "bench_chroma")
    server = LocalContextServer(sqlite_path=db_path, chroma_path=chroma_path)
    yield server
    server.close()
    shutil.rmtree(temp_dir, ignore_errors=True)

def test_migration_and_recall_precision(bench_server):
    # Sample memories from OpenViking
    mem1 = """# Summary
Implemented Thai QR Payment/PromptPay frame integration using HTML5 Canvas and Base64 Data URL in src/ui/wizard/promptpay-frame.ts for zero-network client-side rendering.
User: ในหน้าชำระเงินที่แสดง QR code ให้เอา QR code ไปใส่ในกรอบ Thai QR Payment / PromptPay โดยใส่ลงตรงกลางกรอบที่เป็นสีดำ
Assistant: นำกรอบรูป Thai QR Payment / PromptPay มาฝังเป็น Base64 Data URL และใช้ HTML5 Canvas Compositor ใน src/ui/wizard/promptpay-frame.ts
"""
    mem2 = """# ดำน้ำ (Damnam)
- Status: Bulk management enabled
- Version: 0.2.7 (commit e0bea38)
- Architecture: Implemented per-user namespace isolation via storageAdapter; DEFAULT_SERVER_ORIGIN set to https://damnam.753153268.xyz.
"""
    # Ingest
    bench_server.remember(mem1, category="events")
    bench_server.remember(mem2, category="software_project")

    # Recall Thai PromptPay Canvas
    res1 = bench_server.recall("การใส่กรอบ Thai QR PromptPay ใน canvas")
    assert "promptpay-frame.ts" in res1
    assert "Canvas" in res1

    # Recall Damnam Origin
    res2 = bench_server.recall("DEFAULT_SERVER_ORIGIN ของ ดำน้ำ")
    assert "damnam.753153268.xyz" in res2
    assert "0.2.7" in res2
