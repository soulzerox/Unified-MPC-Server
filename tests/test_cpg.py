import os
import tempfile
import pytest
from pathlib import Path
from thai_rag.cpg_extractor import extract_cpg
from thai_rag.storage import StorageManager
from thai_rag.server import LocalContextServer

PYTHON_SAMPLE = """
import os
from datetime import datetime

class BaseEngine:
    def execute(self):
        pass

class WorkflowEngine(BaseEngine):
    def run_job(self, job_id):
        self.validate(job_id)
        self.execute()

    def validate(self, job_id):
        clean_id = self.sanitize(job_id)
        return clean_id

    def sanitize(self, raw):
        return raw.strip()

def top_level_launcher():
    engine = WorkflowEngine()
    engine.run_job("job_123")
"""

TS_SAMPLE = """
import { helper } from './utils';
import axios from 'axios';

class ApiClient {
    async fetchData(url: string) {
        helper();
        return axios.get(url);
    }
}

export function handleRequest(req: any) {
    const client = new ApiClient();
    client.fetchData(req.url);
}
"""

def test_cpg_python_extraction():
    symbols, edges = extract_cpg("engine.py", PYTHON_SAMPLE, workspace="test_ws")
    
    # Check symbols
    symbol_names = [s["symbol_name"] for s in symbols]
    assert "BaseEngine" in symbol_names
    assert "WorkflowEngine" in symbol_names
    assert any("run_job" in s for s in symbol_names)
    assert "top_level_launcher" in symbol_names

    # Check edges
    edge_pairs = [(e["source_symbol"], e["edge_type"], e["target_symbol"]) for e in edges]
    # Inheritance
    assert ("WorkflowEngine", "inherits", "BaseEngine") in edge_pairs
    # Calls
    run_job_calls = [target for src, edge_type, target in edge_pairs if "run_job" in src and edge_type == "calls"]
    assert "validate" in run_job_calls
    assert "execute" in run_job_calls
    launcher_calls = [target for src, edge_type, target in edge_pairs if "top_level_launcher" in src and edge_type == "calls"]
    assert "run_job" in launcher_calls

    # Imports
    import_targets = [target for _, edge_type, target in edge_pairs if edge_type == "imports"]
    assert "os" in import_targets

def test_cpg_ts_extraction():
    symbols, edges = extract_cpg("client.ts", TS_SAMPLE, workspace="test_ws")
    symbol_names = [s["symbol_name"] for s in symbols]
    assert "ApiClient" in symbol_names
    assert "handleRequest" in symbol_names

    edge_pairs = [(e["source_symbol"], e["edge_type"], e["target_symbol"]) for e in edges]
    import_targets = [target for _, edge_type, target in edge_pairs if edge_type == "imports"]
    assert any("axios" in t or "utils" in t for t in import_targets)

def test_storage_cpg_graph_and_recursive_queries():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        chroma_dir = os.path.join(tmpdir, "chroma")
        storage = StorageManager(sqlite_path=db_path, chroma_path=chroma_dir)

        symbols, edges = extract_cpg("engine.py", PYTHON_SAMPLE, workspace="test_ws")
        storage.save_code_graph("engine.py", symbols, edges, workspace="test_ws")

        # 1. Direct callers of validate
        callers = storage.find_callers("validate", workspace="test_ws", max_depth=1)
        caller_sources = [c["source_symbol"] for c in callers]
        assert any("run_job" in c for c in caller_sources)

        # 2. Multi-hop callers of sanitize (sanitize <- validate <- run_job <- top_level_launcher)
        callers_multihop = storage.find_callers("sanitize", workspace="test_ws", max_depth=3)
        multihop_sources = [c["source_symbol"] for c in callers_multihop]
        assert any("validate" in c for c in multihop_sources)
        assert any("run_job" in c for c in multihop_sources)
        assert any("top_level_launcher" in c for c in multihop_sources)

        # 3. Callees of top_level_launcher
        callees = storage.find_callees("top_level_launcher", workspace="test_ws", max_depth=2)
        callee_targets = [c["target_symbol"] for c in callees]
        assert "run_job" in callee_targets

        # 4. Blast radius
        blast = storage.get_symbol_blast_radius("sanitize", file_path="engine.py", workspace="test_ws")
        assert blast["symbol"] == "sanitize"
        assert len(blast["callers"]) >= 2

        # 5. Cleanup on delete_file_data
        storage.delete_file_data("engine.py")
        callers_after = storage.find_callers("validate", workspace="test_ws")
        assert len(callers_after) == 0

        storage.close()

def test_pre_edit_context_with_cpg_blast_radius():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "test.db")
        chroma_dir = os.path.join(tmpdir, "chroma")
        storage = StorageManager(sqlite_path=db_path, chroma_path=chroma_dir)

        file_path = os.path.join(tmpdir, "engine.py")
        Path(file_path).write_text(PYTHON_SAMPLE, encoding="utf-8")

        symbols, edges = extract_cpg(file_path, PYTHON_SAMPLE, workspace="test_ws")
        storage.save_code_graph(file_path, symbols, edges, workspace="test_ws")

        server = LocalContextServer(storage=storage)
        res = server.pre_edit_context(file_path=file_path, proposed_symbol="validate", workspace="test_ws")
        
        assert res["can_proceed"] is True
        assert "blast_radius" in res
        assert any("run_job" in c["source_symbol"] for c in res["blast_radius"]["callers"])

        # Check formatted MCP tool output
        mcp_res = server.code_blast_radius("validate", workspace="test_ws")
        assert "run_job" in mcp_res

        server.close()

def test_find_callers_excludes_own_callees():
    """BUG-1 regression: caller graph must root only on target_symbol matches."""
    with tempfile.TemporaryDirectory() as tmpdir:
        storage = StorageManager(sqlite_path=os.path.join(tmpdir, "t.db"), chroma_path=os.path.join(tmpdir, "chroma"))
        symbols, edges = extract_cpg("engine.py", PYTHON_SAMPLE, workspace="test_ws")
        storage.save_code_graph("engine.py", symbols, edges, workspace="test_ws")

        callers = storage.find_callers("validate", max_depth=1)
        # Every caller row must be an edge whose TARGET is validate
        assert all(c["target_symbol"] == "validate" for c in callers)
        # run_job -> validate must be found
        assert any("run_job" in c["source_symbol"] for c in callers)
        # Own outgoing calls (validate -> sanitize) must NOT appear as callers
        assert not any(
            c["source_symbol"].endswith("validate") and c["target_symbol"] != "validate"
            for c in callers
        )
        storage.close()

def test_cpg_workspace_filter_exact_case():
    """BUG-2 regression: workspace filter must match the stored value regardless of dash/case."""
    with tempfile.TemporaryDirectory() as tmpdir:
        storage = StorageManager(sqlite_path=os.path.join(tmpdir, "t.db"), chroma_path=os.path.join(tmpdir, "chroma"))
        symbols, edges = extract_cpg("engine.py", PYTHON_SAMPLE, workspace="My-WorkSpace")
        storage.save_code_graph("engine.py", symbols, edges, workspace="My-WorkSpace")

        unfiltered = storage.find_callers("validate", max_depth=1)
        filtered = storage.find_callers("validate", workspace="My-WorkSpace", max_depth=1)
        assert len(unfiltered) > 0
        assert len(filtered) == len(unfiltered)

        filtered_callees = storage.find_callees("run_job", workspace="My-WorkSpace", max_depth=1)
        assert any("validate" in c["target_symbol"] for c in filtered_callees)
        storage.close()
