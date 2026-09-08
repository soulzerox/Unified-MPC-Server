import pytest
import tempfile
from pathlib import Path
from scripts.e2e_stress_session_test import (
    extract_session_dialogue,
    run_stress_test,
    run_retrieval_smoke_test,
    run_cpg_indexing_and_blast_radius_test,
    run_pre_edit_verification_test
)
from thai_rag.server import LocalContextServer

@pytest.fixture
def session_server():
    with tempfile.TemporaryDirectory() as tmpdir:
        sqlite_file = Path(tmpdir) / "e2e_pytest.db"
        chroma_folder = Path(tmpdir) / "e2e_chroma"
        server = LocalContextServer(
            sqlite_path=sqlite_file,
            chroma_path=str(chroma_folder)
        )
        yield server
        server.close()

def test_active_session_e2e_stress_and_smoke(session_server):
    dialogue = extract_session_dialogue()
    assert len(dialogue) >= 5
    
    # 1. Stress Ingestion of session dialogue
    run_stress_test(session_server, dialogue)
    
    # 2. Retrieval Smoke Test
    run_retrieval_smoke_test(session_server)
    
    # 3. CPG Indexing and Blast Radius
    run_cpg_indexing_and_blast_radius_test(session_server)
    
    # 4. Pre-Edit JIT Verification
    run_pre_edit_verification_test(session_server)

