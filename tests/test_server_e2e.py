import pytest
import tempfile
import shutil
from pathlib import Path
from thai_rag.server import LocalContextServer

@pytest.fixture
def test_server():
    temp_dir = tempfile.mkdtemp()
    db_path = Path(temp_dir) / "test_mcp.db"
    chroma_path = str(Path(temp_dir) / "test_chroma")
    server = LocalContextServer(sqlite_path=db_path, chroma_path=chroma_path)
    
    # Create a small dummy workspace
    ws_dir = Path(temp_dir) / "workspace"
    ws_dir.mkdir()
    (ws_dir / "auth.py").write_text("""# ระบบยืนยันตัวตน
def authenticate_user(username: str, token: str) -> bool:
    # ตรวจสอบโทเค็นของผู้ใช้
    if username == "admin" and token == "secret":
        return True
    return False
""", encoding="utf-8")

    yield server, ws_dir
    server.close()
    shutil.rmtree(temp_dir, ignore_errors=True)

def test_memory_tools_lifecycle(test_server):
    server, _ = test_server
    
    # 1. Remember
    res = server.remember("ผู้ใช้ชอบใช้ธีมสีมืดและคีย์ลัด vim", category="preference")
    assert "Remembered" in res
    
    # 2. Recall
    recall_res = server.recall("คีย์ลัดที่ผู้ใช้ชอบ")
    assert "คีย์ลัด vim" in recall_res

    # 3. Recall with filter
    recall_cat = server.recall("ผู้ใช้", category="preference")
    assert "ธีมสีมืด" in recall_cat

    # 4. Forget
    mem_id = [line for line in recall_res.splitlines() if "ID:" in line][0].split("ID:")[1].split("]")[0].strip()
    forget_res = server.forget(mem_id)
    assert "Deleted" in forget_res

    # 5. Verify forgotten
    after_forget = server.recall("คีย์ลัด vim")
    assert mem_id not in after_forget

def test_code_rag_tools_lifecycle(test_server):
    server, ws_dir = test_server

    # 1. Code Index
    index_res = server.code_index(str(ws_dir))
    assert "Indexed: `1 files`" in index_res

    # 2. Incremental Index (should skip unchanged)
    reindex_res = server.code_index(str(ws_dir))
    assert "Skipped (unchanged): `1 files`" in reindex_res

    # 3. Code Search exact symbol
    search_symbol = server.code_search("authenticate_user")
    assert "auth.py" in search_symbol
    assert "authenticate_user" in search_symbol

    # 4. Code Search Thai semantic
    search_thai = server.code_search("การยืนยันตัวตน")
    assert "auth.py" in search_thai
    assert "authenticate_user" in search_thai

    # 5. Code Context
    ctx_res = server.code_context("auth.py", line_number=3)
    assert "authenticate_user" in ctx_res
    assert "auth.py" in ctx_res

def test_code_index_force_reindex(test_server):
    server, ws_dir = test_server

    # First index
    res1 = server.code_index(str(ws_dir))
    assert "Indexed: `1 files`" in res1

    # Normal reindex skips
    res2 = server.code_index(str(ws_dir), force=False)
    assert "Skipped (unchanged): `1 files`" in res2

    # Forced reindex re-indexes all
    res3 = server.code_index(str(ws_dir), force=True)
    assert "Indexed: `1 files`" in res3
    assert "Skipped (unchanged): `0 files`" in res3


def test_remember_turn_and_pre_edit_context_e2e(test_server):
    server, ws_dir = test_server

    # 1. Record a live conversational turn with constraint on auth.py
    turn_res = server.remember_turn(
        role="user",
        content="คำสั่งสำคัญ: ฟังก์ชัน authenticate_user ใน auth.py ห้ามเปลี่ยน return type เป็น dict ให้ใช้ boolean เท่านั้น",
        workspace="test_ws",
        summary="Constraint on authenticate_user return type",
        tags=["security", "auth"]
    )
    assert "✅ Conversation turn recorded" in turn_res

    # 2. Call pre_edit_context on auth.py
    pre_res = server.pre_edit_context(
        file_path="auth.py",
        workspace="test_ws"
    )
    assert pre_res["can_proceed"] is True
    assert len(pre_res["constraints"]) >= 1
    assert "authenticate_user" in pre_res["constraints"][0]["content"]
    assert "boolean" in pre_res["constraints"][0]["content"]


def test_background_index_returns_job_id_immediately(test_server):
    """(B) background=True must return a job_id string immediately (<2s)."""
    import time as _time

    server, ws_dir = test_server
    t0 = _time.time()
    res = server.code_index(str(ws_dir), background=True)
    elapsed = _time.time() - t0
    assert "Job:" in res, f"expected job_id in response, got: {res[:200]}"
    assert elapsed < 2.0, f"background call must return fast, took {elapsed:.2f}s"
    job_id = res.split("Job:")[1].split("]")[0].strip()
    assert job_id.startswith("idx_")


def test_index_status_transitions_to_done(test_server):
    """(B) Poll index_status until the background job reaches done."""
    import time as _time

    server, ws_dir = test_server
    res = server.code_index(str(ws_dir), background=True)
    job_id = res.split("Job:")[1].split("]")[0].strip()
    final = ""
    for _ in range(60):
        final = server.index_status(job_id)
        if "complete" in final or "failed" in final:
            break
        _time.sleep(1.0)
    assert "complete" in final, f"job should finish, got: {final[:300]}"
    assert "auth.py" in server.code_search("authenticate_user")


def test_index_status_unknown_job(test_server):
    """(B) Unknown job_id must return a warning, not raise."""
    server, _ = test_server
    res = server.index_status("idx_doesnotexist")
    assert "unknown" in res.lower() or "Warning" in res

