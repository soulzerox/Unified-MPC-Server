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
