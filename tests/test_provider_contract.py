from dataclasses import dataclass

from thai_rag.provider import (
    CONTRACT_VERSION,
    ErrorCode,
    ProviderStatus,
    ThaiRagProvider,
)


@dataclass
class RecordingCore:
    pre_edit_result: dict
    supports_canonical_workspace_scope = True
    supports_canonical_code_scope = True

    def remember(self, content, workspace_id, category="general"):
        return f"remembered:{content}:{workspace_id}:{category}"

    def record_event(self, event_type, content, workspace_id, summary=None, tags=None):
        return {"event_type": event_type, "content": content, "workspace_id": workspace_id, "summary": summary, "tags": tags or []}

    def recall(self, query, workspace_id, category=None, limit=5):
        return {"query": query, "workspace_id": workspace_id, "category": category, "limit": limit, "items": []}

    def forget(self, memory_id, workspace_id):
        return f"forgot:{memory_id}:{workspace_id}"

    def code_search(self, query, workspace_id, top_k=5, path_filter=None):
        return {"query": query, "workspace_id": workspace_id, "top_k": top_k, "path_filter": path_filter, "items": []}

    def code_context(self, file_path, workspace_id, line_number, window=25):
        return {"file_path": file_path, "workspace_id": workspace_id, "line_number": line_number, "window": window}

    def code_blast_radius(self, symbol_name, workspace_id, max_depth=2):
        return {"symbol_name": symbol_name, "workspace_id": workspace_id, "max_depth": max_depth}

    def code_index(self, workspace_path=".", workspace_id=None, force=False, background=False):
        return {"workspace_path": workspace_path, "force": force, "background": background, "workspace": workspace_id}

    def index_status(self, job_id, workspace_id):
        return {"job_id": job_id, "workspace_id": workspace_id, "status": "done"}

    def pre_edit_context(self, file_path, workspace_id=None, proposed_symbol=None):
        return self.pre_edit_result


def test_readme_describes_selective_remember_turn_contract():
    from pathlib import Path

    readme = (Path(__file__).parents[1] / "README.md").read_text()

    assert "not an automatic mandatory primitive" in readme
    assert "record_event(event_type, content, workspace_id, summary, tags)" in readme


def test_provider_exposes_versioned_capabilities_and_scope_contract():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.version()

    assert result.status is ProviderStatus.OK
    assert result.data["contract_version"] == CONTRACT_VERSION
    assert result.data["workspace_scope_model"] == "explicit_workspace_id"
    assert "record_event" in result.data["capabilities"]
    assert result.metadata["provider_name"] == "thai-rag"


def test_health_reports_degraded_embedding_state():
    class Core:
        class Embedder:
            @staticmethod
            def is_alive():
                return False

        embedder = Embedder()

    result = ThaiRagProvider(core=Core()).health()

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.data["embedding_ready"] is False
    assert result.data["ready"] is False
    assert result.data["state"] == "degraded"
    assert result.warnings


def test_health_probes_code_fts_instead_of_conversation_fts():
    import sqlite3

    class Collection:
        @staticmethod
        def count():
            return 0

    class Storage:
        sqlite_conn = sqlite3.connect(":memory:")
        code_collection = Collection()

    Storage.sqlite_conn.execute("CREATE TABLE fts_conversation (content TEXT)")

    class Embedder:
        @staticmethod
        def is_alive():
            return True

    class Core:
        storage = Storage()
        embedder = Embedder()

    result = ThaiRagProvider(core=Core()).health()

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.data["readiness"]["fts_ready"] is False
    assert ErrorCode.LEXICAL_RETRIEVAL_UNAVAILABLE in {error.code for error in result.errors}


def test_health_verifies_workspace_has_owned_index_rows():
    import sqlite3

    class Collection:
        @staticmethod
        def count():
            return 0

    class Storage:
        sqlite_conn = sqlite3.connect(":memory:")
        code_collection = Collection()

    Storage.sqlite_conn.execute(
        "CREATE VIRTUAL TABLE fts_code_symbols USING fts5(doc_id UNINDEXED, symbol_name, file_path, content)"
    )
    Storage.sqlite_conn.execute(
        "CREATE TABLE code_symbols (file_path TEXT, symbol_name TEXT, workspace TEXT)"
    )
    Storage.sqlite_conn.execute(
        "INSERT INTO code_symbols VALUES ('ws-a/auth.py', 'auth', 'ws-a')"
    )
    Storage.sqlite_conn.execute(
        "INSERT INTO fts_code_symbols (doc_id, symbol_name, file_path, content) VALUES ('doc-1', 'auth', 'ws-a/auth.py', 'def auth(): pass')"
    )

    class Embedder:
        @staticmethod
        def is_alive():
            return True

    class Core:
        storage = Storage()
        embedder = Embedder()
        supports_canonical_code_scope = True

        def pre_edit_context(self, file_path, workspace_id=None, proposed_symbol=None): return {}
        def code_index(self, workspace_path, workspace_id, force=False, background=False): return {}
        def index_status(self, job_id, workspace_id): return {}
        def code_search(self, query, workspace_id, top_k=5, path_filter=None): return {}
        def code_context(self, file_path, workspace_id, line_number, window=25): return {}
        def code_blast_radius(self, symbol_name, workspace_id, max_depth=2): return {}

    provider = ThaiRagProvider(core=Core())
    owned = provider.health(workspace_id="ws-a")
    foreign = provider.health(workspace_id="ws-b")

    assert owned.status is ProviderStatus.OK
    assert owned.data["readiness"]["workspace_ready"] is True
    assert foreign.status is ProviderStatus.UNAVAILABLE
    assert foreign.data["readiness"]["workspace_ready"] is False


def test_health_fails_closed_when_vector_or_workspace_readiness_is_missing():
    import sqlite3

    class Embedder:
        model = "test"

        @staticmethod
        def is_alive():
            return True

    class Storage:
        sqlite_conn = sqlite3.connect(":memory:")
        code_collection = None

    class Core:
        storage = Storage()
        embedder = Embedder()
        supports_canonical_code_scope = True

        def code_search(self, query, workspace_id, top_k=5, path_filter=None):
            return []

        def code_context(self, file_path, workspace_id, line_number, window=25):
            return None

        def code_blast_radius(self, symbol_name, workspace_id, max_depth=2):
            return None

        def code_index(self, workspace_path, workspace_id, force=False, background=False):
            return None

    Core.storage.sqlite_conn.execute("CREATE TABLE fts_conversation (content TEXT)")
    result = ThaiRagProvider(core=Core()).health(workspace_id="ws-123")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.data["ready"] is False
    assert result.data["readiness"]["vector_store_ready"] is False
    assert result.data["readiness"]["workspace_ready"] is False


def test_provider_converts_legacy_error_string_to_structured_error():
    class Core:
        supports_canonical_code_scope = True

        def code_search(self, query, workspace_id, top_k=5, path_filter=None):
            return "Error: storage unavailable"

    result = ThaiRagProvider(core=Core()).code_search(query="auth", workspace_id="ws-123")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.STORAGE_UNAVAILABLE


def test_provider_forwards_explicit_workspace_id_without_transport():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.code_index(workspace_path="/repo", workspace_id="ws-123")

    assert result.status is ProviderStatus.OK
    assert result.workspace_id == "ws-123"
    assert result.data["workspace"] == "ws-123"


def test_core_code_index_rejects_missing_workspace_id(tmp_path):
    from thai_rag.server import LocalContextServer

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    try:
        result = server.code_index(str(tmp_path))
        assert result == "Error: canonical workspace_id is required."
        assert not server.storage.sqlite_conn.execute("SELECT COUNT(*) FROM parent_documents").fetchone()[0]
    finally:
        server.close()


def test_provider_rejects_missing_workspace_id_for_scoped_memory():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.remember(content="decision")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.WORKSPACE_SCOPE_REQUIRED
    assert result.errors[0].details["operation"] == "remember"


def test_provider_records_selective_event_without_turn_id():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.record_event(
        event_type="decision",
        content="Use SQLite",
        workspace_id="ws-123",
    )

    assert result.status is ProviderStatus.OK
    assert result.data["event_type"] == "decision"
    assert result.data["workspace_id"] == "ws-123"
    assert "turn_id" not in result.data


def test_provider_propagates_core_degraded_status_and_warnings_for_events():
    class Core(RecordingCore):
        def record_event(self, event_type, content, workspace_id, summary=None, tags=None):
            return {
                "status": "degraded",
                "event_type": event_type,
                "workspace_id": workspace_id,
                "warnings": ["embedding failed; FTS storage succeeded"],
            }

    result = ThaiRagProvider(core=Core({"constraints": [], "code_context": None})).record_event(
        "decision", "Use SQLite", workspace_id="ws-123"
    )

    assert result.status is ProviderStatus.DEGRADED
    assert result.warnings == ["embedding failed; FTS storage succeeded"]
    assert result.data["event_type"] == "decision"


def test_provider_rejects_unscoped_remember_turn():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.remember_turn(role="user", content="decision")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.WORKSPACE_SCOPE_REQUIRED


def test_core_rejects_unscoped_event_write(tmp_path):
    from thai_rag.server import LocalContextServer

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    try:
        try:
            server.record_event("decision", "must be scoped", workspace_id=None)
        except ValueError as exc:
            assert str(exc) == "canonical workspace_id is required"
        else:
            raise AssertionError("unscoped event write was accepted")
        assert server.storage.sqlite_conn.execute(
            "SELECT COUNT(*) FROM conversation_turns WHERE content = ?",
            ("must be scoped",),
        ).fetchone()[0] == 0
    finally:
        server.close()


def test_pre_edit_reports_review_required_when_constraints_exist():
    provider = ThaiRagProvider(
        core=RecordingCore(
            {
                "constraints": [{"content": "Keep return type boolean"}],
                "code_context": {"file_path": "auth.py"},
                "blast_radius": {"callers": []},
            }
        )
    )

    result = provider.pre_edit_context(file_path="auth.py", workspace_id="ws-123")

    assert result.status is ProviderStatus.REVIEW_REQUIRED
    assert result.data["evidence_state"] == "constraints_found"
    assert result.data["can_proceed"] is False
    assert result.data["constraints"]


def test_pre_edit_reports_degraded_when_evidence_is_stale():
    provider = ThaiRagProvider(
        core=RecordingCore(
            {
                "constraints": [],
                "code_context": {"file_path": "auth.py"},
                "blast_radius": {"callers": []},
                "evidence_fresh": False,
            }
        )
    )

    result = provider.pre_edit_context(file_path="auth.py", workspace_id="ws-123")

    assert result.status is ProviderStatus.DEGRADED
    assert result.data["evidence_state"] == "evidence_stale"
    assert result.data["can_proceed"] is False


def test_pre_edit_reports_degraded_when_evidence_is_missing():
    provider = ThaiRagProvider(
        core=RecordingCore(
            {
                "constraints": [],
                "code_context": None,
                "blast_radius": None,
            }
        )
    )

    result = provider.pre_edit_context(file_path="auth.py", workspace_id="ws-123")

    assert result.status is ProviderStatus.DEGRADED
    assert result.data["evidence_state"] == "evidence_unavailable"
    assert result.data["can_proceed"] is False


def test_pre_edit_fails_closed_for_partial_evidence():
    provider = ThaiRagProvider(
        core=RecordingCore(
            {
                "constraints": [],
                "code_context": {"file_path": "auth.py"},
                "blast_radius": None,
                "evidence": {"storage": "ready", "code_index": "ready"},
            }
        )
    )

    result = provider.pre_edit_context(file_path="auth.py", workspace_id="ws-123")

    assert result.status is ProviderStatus.DEGRADED
    assert result.data["evidence_state"] == "cpg_missing"
    assert result.data["can_proceed"] is False


def test_pre_edit_fails_closed_for_unknown_storage_and_index_evidence():
    provider = ThaiRagProvider(
        core=RecordingCore(
            {
                "constraints": [],
                "code_context": {"file_path": "auth.py"},
                "blast_radius": {"callers": []},
                "evidence": {"storage": "unknown", "code_index": "ready"},
            }
        )
    )

    result = provider.pre_edit_context(file_path="auth.py", workspace_id="ws-123")

    assert result.status is ProviderStatus.DEGRADED
    assert result.data["evidence_state"] == "storage_unknown"
    assert result.data["can_proceed"] is False

    provider = ThaiRagProvider(
        core=RecordingCore(
            {
                "constraints": [],
                "code_context": {"file_path": "auth.py"},
                "blast_radius": {"callers": []},
                "evidence": {"storage": "ready", "code_index": "unknown"},
            }
        )
    )

    result = provider.pre_edit_context(file_path="auth.py", workspace_id="ws-123")

    assert result.status is ProviderStatus.DEGRADED
    assert result.data["evidence_state"] == "code_index_unknown"
    assert result.data["can_proceed"] is False


def test_provider_rejects_core_without_canonical_scope_instead_of_fuzzy_delegation():
    class LegacyCore:
        def recall(self, query, category=None, limit=5):
            return {"query": query, "category": category, "limit": limit}

    provider = ThaiRagProvider(core=LegacyCore())

    result = provider.recall(query="decision", workspace_id="ws-123")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.SCOPE_DENIED


def test_provider_converts_core_failures_to_machine_readable_errors():
    class BrokenCore(RecordingCore):
        def code_search(self, query, workspace_id, top_k=5, path_filter=None):
            raise RuntimeError("storage down")

    provider = ThaiRagProvider(core=BrokenCore({"constraints": [], "code_context": None}))

    result = provider.code_search(query="auth", workspace_id="ws-123")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.STORAGE_UNAVAILABLE
    assert result.errors[0].details["exception"] == "RuntimeError"


def test_provider_adapts_legacy_workspace_core_signature_without_type_error():
    class LegacyScopedCore:
        def code_search(self, query, top_k=5, path_filter=None, workspace=None):
            return {"query": query, "workspace": workspace, "top_k": top_k, "path_filter": path_filter}

    result = ThaiRagProvider(core=LegacyScopedCore()).code_search(
        query="auth", workspace_id="ws-123", top_k=3
    )

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.SCOPE_DENIED


def test_real_core_memory_and_event_operations_isolate_two_workspaces(tmp_path):
    from thai_rag.server import LocalContextServer
    from tests.fakes import DeterministicEmbeddingAdapter

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    embedder = DeterministicEmbeddingAdapter()
    server.embedder = embedder
    try:
        provider = server.provider()
        memory_a = provider.remember("alpha workspace decision", workspace_id="ws-a")
        memory_b = provider.remember("beta workspace decision", workspace_id="ws-b")
        event_a = provider.record_event(
            event_type="decision",
            content="alpha workspace event",
            workspace_id="ws-a",
        )
        event_b = provider.record_event(
            event_type="decision",
            content="beta workspace event",
            workspace_id="ws-b",
        )

        assert memory_a.status is ProviderStatus.OK
        assert memory_b.status is ProviderStatus.OK
        assert event_a.status is ProviderStatus.OK
        assert event_b.status is ProviderStatus.OK
        recall_a = provider.recall("workspace decision", workspace_id="ws-a")
        recall_b = provider.recall("workspace decision", workspace_id="ws-b")
        assert recall_a.status is ProviderStatus.OK
        assert "alpha workspace decision" in recall_a.data
        assert "beta workspace decision" not in recall_a.data
        assert "beta workspace decision" in recall_b.data
        assert "alpha workspace decision" not in recall_b.data
        events_a = server.storage.search_conversation_turns("workspace event", workspace="ws-a")
        events_b = server.storage.search_conversation_turns("workspace event", workspace="ws-b")
        assert [item["content"] for item in events_a] == ["alpha workspace event"]
        assert [item["content"] for item in events_b] == ["beta workspace event"]
        recalled_events_a = provider.recall("workspace event", workspace_id="ws-a")
        recalled_events_b = provider.recall("workspace event", workspace_id="ws-b")
        assert "alpha workspace event" in recalled_events_a.data
        assert "beta workspace event" not in recalled_events_a.data
        event_row = server.storage.sqlite_conn.execute(
            "SELECT event_type FROM conversation_turns WHERE workspace = ? AND content = ?",
            ("ws-a", "alpha workspace event"),
        ).fetchone()
        assert event_row[0] == "decision"
        assert "beta workspace event" in recalled_events_b.data
        assert "alpha workspace event" not in recalled_events_b.data
        memory_id = memory_a.data.split("[ID: ", 1)[1].split("]", 1)[0]
        denied = provider.forget(memory_id, workspace_id="ws-b")
        assert denied.status is ProviderStatus.UNAVAILABLE
        assert denied.errors[0].code is ErrorCode.SCOPE_DENIED
    finally:
        server.close()


def test_recall_keeps_scoped_event_when_vector_results_are_unrelated(tmp_path, monkeypatch):
    from thai_rag.server import LocalContextServer
    from tests.fakes import DeterministicEmbeddingAdapter

    server = LocalContextServer(sqlite_path=tmp_path / "context.db", chroma_path=str(tmp_path / "chroma"))
    embedder = DeterministicEmbeddingAdapter()
    server.embedder = embedder
    try:
        server.provider().record_event("decision", "scoped event marker", workspace_id="ws-a")
        monkeypatch.setattr(
            server.storage,
            "search_memories_vector",
            lambda *args, **kwargs: [{
                "id": "unrelated",
                "content": "unrelated vector result",
                "metadata": {"workspace_id": "ws-a", "category": "general"},
                "distance": 0.01,
            }],
        )

        result = server.provider().recall("scoped event marker", workspace_id="ws-a", limit=1)

        assert result.status is ProviderStatus.OK
        assert "scoped event marker" in result.data
        assert "unrelated vector result" not in result.data
    finally:
        server.close()


def test_record_event_preserves_embedding_failure_truthfully(tmp_path, monkeypatch):
    from thai_rag.server import LocalContextServer
    from tests.fakes import DeterministicEmbeddingAdapter

    server = LocalContextServer(sqlite_path=tmp_path / "context.db", chroma_path=str(tmp_path / "chroma"))
    embedder = DeterministicEmbeddingAdapter()
    server.embedder = embedder
    monkeypatch.setattr(embedder, "is_alive", lambda: True)
    monkeypatch.setattr(embedder, "embed_document", lambda value: (_ for _ in ()).throw(RuntimeError("embed down")))
    try:
        result = server.provider().record_event("decision", "event content", workspace_id="ws-a")

        assert result.status is ProviderStatus.DEGRADED
        assert result.warnings == ["embedding failed: embed down; FTS storage succeeded"]
        assert result.data["warnings"] == ["embedding failed: embed down; FTS storage succeeded"]
        row = server.storage.sqlite_conn.execute(
            "SELECT event_type FROM conversation_turns WHERE workspace = ? AND content = ?",
            ("ws-a", "event content"),
        ).fetchone()
        assert row[0] == "decision"
    finally:
        server.close()


def test_provider_rejects_unscoped_memory_writes():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.remember(content="decision")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.WORKSPACE_SCOPE_REQUIRED


def test_provider_rejects_legacy_memory_workspace_aliases():
    class LegacyMemoryCore:
        supports_canonical_workspace_scope = True

        def remember(self, content, workspace, category="general"):
            return {"content": content, "workspace": workspace, "category": category}

        def recall(self, query, workspace, category=None, limit=5):
            return {"query": query, "workspace": workspace, "category": category, "limit": limit}

        def forget(self, memory_id, workspace):
            return {"memory_id": memory_id, "workspace": workspace}

        def record_event(self, event_type, content, workspace, summary=None, tags=None):
            return {"event_type": event_type, "content": content, "workspace": workspace}

    provider = ThaiRagProvider(core=LegacyMemoryCore())
    results = [
        provider.remember("decision", workspace_id="ws-123"),
        provider.recall("decision", workspace_id="ws-123"),
        provider.forget("mem-1", workspace_id="ws-123"),
        provider.record_event("decision", "Use SQLite", workspace_id="ws-123"),
    ]

    assert all(result.status is ProviderStatus.UNAVAILABLE for result in results)
    assert all(result.errors[0].code is ErrorCode.SCOPE_DENIED for result in results)


def test_provider_real_core_pre_edit_adapts_workspace_argument(tmp_path):
    from thai_rag.server import LocalContextServer
    from tests.fakes import DeterministicEmbeddingAdapter

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    server.embedder = DeterministicEmbeddingAdapter()
    try:
        result = server.provider().pre_edit_context(
            file_path="missing.py", workspace_id="ws-123"
        )

        assert result.status is ProviderStatus.DEGRADED
        assert result.data["evidence_state"] == "code_index_missing"
        assert result.workspace_id == "ws-123"
    finally:
        server.close()


def test_provider_metadata_contains_unified_handshake_fields():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.version()

    assert result.data["contract_fingerprint"]
    assert result.data["compatibility_range"] == {"min": CONTRACT_VERSION, "max": "1.x"}
    assert result.data["index_job_contract_version"]
    assert result.data["generation"]
    assert "embedding" in result.data["generation"]
    assert "storage" in result.data["generation"]
    assert "fts_ready" in result.data["readiness"]
    assert "workspace_ready" in result.data["readiness"]


def test_pre_edit_distinguishes_stale_index_from_missing_evidence():
    provider = ThaiRagProvider(
        core=RecordingCore(
            {
                "constraints": [],
                "code_context": {"file_path": "auth.py"},
                "blast_radius": None,
                "evidence": {
                    "code_index": "stale",
                    "cpg": "unavailable",
                    "storage": "ready",
                },
            }
        )
    )

    result = provider.pre_edit_context(file_path="auth.py", workspace_id="ws-123")

    assert result.status is ProviderStatus.DEGRADED
    assert result.data["evidence_state"] == "code_index_stale"
    assert result.data["evidence"]["cpg"] == "unavailable"
    assert result.data["can_proceed"] is False


def test_real_core_code_provider_isolates_two_workspaces(tmp_path):
    from thai_rag.server import LocalContextServer
    from tests.fakes import DeterministicEmbeddingAdapter

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    embedder = DeterministicEmbeddingAdapter()
    server.embedder = embedder
    server.retriever.embedder = embedder
    ws_a = tmp_path / "workspace-a"
    ws_b = tmp_path / "workspace-b"
    ws_a.mkdir()
    ws_b.mkdir()
    (ws_a / "auth.py").write_text("def auth_a():\n    return 'A'\n")
    (ws_b / "auth.py").write_text("def auth_b():\n    return 'B'\n")
    try:
        index_a = server.provider().code_index(str(ws_a), workspace_id="ws-a")
        index_b = server.provider().code_index(str(ws_b), workspace_id="ws-b")
        assert index_a.status is ProviderStatus.OK
        assert index_b.status is ProviderStatus.OK
        assert isinstance(index_a.data, dict)
        assert index_a.data["workspace_id"] == "ws-a"
        assert index_a.data["indexed"] == 1
        core_search = server.code_search("auth", workspace_id="ws-a", structured=True)
        core_context = server.code_context("auth.py", 1, workspace_id="ws-a", structured=True)
        core_blast = server.code_blast_radius("auth_a", workspace_id="ws-a", structured=True)
        assert isinstance(core_search, dict)
        assert isinstance(core_context, dict)
        assert isinstance(core_blast, dict)
        assert core_search["items"]
        assert core_context["context"]["file_path"] == "ws-a/auth.py"
        assert core_blast["symbol_name"] == "auth_a"

        result_a = server.provider().code_search("auth", workspace_id="ws-a")
        result_b = server.provider().code_search("auth", workspace_id="ws-b")

        assert "auth_a" in result_a.data["items"][0]["content"]
        assert all("auth_b" not in item["content"] for item in result_a.data["items"])
        assert "auth_b" in result_b.data["items"][0]["content"]
        assert all("auth_a" not in item["content"] for item in result_b.data["items"])
    finally:
        server.close()


def test_real_core_pre_edit_propagates_workspace_id_to_context(tmp_path, monkeypatch):
    from thai_rag.server import LocalContextServer
    from tests.fakes import DeterministicEmbeddingAdapter

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    server.embedder = DeterministicEmbeddingAdapter()
    file_path = tmp_path / "auth.py"
    file_path.write_text("def auth():\n    return True\n")
    seen = []

    def get_context(file_path, line_number, window_lines=25, workspace=None):
        seen.append(workspace)
        return {"file_path": file_path, "start_line": 1, "end_line": 2, "content": "def auth():", "symbol_name": "auth"}

    monkeypatch.setattr(server.retriever, "get_context", get_context)
    try:
        result = server.provider().pre_edit_context(str(file_path), workspace_id="ws-a")

        assert seen == ["ws-a"]
        assert result.workspace_id == "ws-a"
        assert result.data["evidence"]["storage"] == "ready"
    finally:
        server.close()


def test_provider_rejects_legacy_memory_workspace_even_with_capability_flag():
    class LegacyMemoryCore:
        supports_canonical_workspace_scope = True
        supports_canonical_code_scope = True

        def remember(self, content, workspace, category="general"):
            return {"content": content, "workspace": workspace, "category": category}

    result = ThaiRagProvider(core=LegacyMemoryCore()).remember("decision", workspace_id="ws-123")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.SCOPE_DENIED


def test_provider_returns_structured_code_data():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    search = provider.code_search("auth", workspace_id="ws-123")
    context = provider.code_context("auth.py", line_number=1, workspace_id="ws-123")
    blast = provider.code_blast_radius("auth", workspace_id="ws-123")

    assert search.data["items"] == []
    assert context.data["file_path"] == "auth.py"
    assert blast.data["symbol_name"] == "auth"


def test_provider_returns_structured_unknown_index_status():
    class Core(RecordingCore):
        def index_status(self, job_id, workspace_id, structured=False):
            return {"status": "unknown", "job_id": job_id} if structured else "Warning: Unknown job"

    result = ThaiRagProvider(core=Core({"constraints": [], "code_context": None})).index_status(
        "idx-missing", workspace_id="ws-123"
    )

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.WORKSPACE_NOT_FOUND


def test_real_core_code_provider_preserves_workspace_scope(tmp_path):
    from thai_rag.server import LocalContextServer
    from tests.fakes import DeterministicEmbeddingAdapter

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    server.embedder = DeterministicEmbeddingAdapter()
    try:
        search = server.provider().code_search(query="auth", workspace_id="ws-123")
        context = server.provider().code_context(
            file_path="auth.py",
            line_number=1,
            workspace_id="ws-123",
        )

        assert search.status is ProviderStatus.OK
        assert context.status is ProviderStatus.OK
        assert search.workspace_id == "ws-123"
        assert context.workspace_id == "ws-123"
    finally:
        server.close()


def test_real_core_index_status_rejects_other_workspace(tmp_path):
    from thai_rag.server import LocalContextServer, _new_index_job

    server = LocalContextServer(
        sqlite_path=tmp_path / "context.db",
        chroma_path=str(tmp_path / "chroma"),
    )
    try:
        job = _new_index_job("/repo", force=False, workspace="ws-a")
        result = server.provider().index_status(job_id=job["job_id"], workspace_id="ws-b")

        assert result.status is ProviderStatus.UNAVAILABLE
        assert result.errors[0].code is ErrorCode.SCOPE_DENIED
        assert "outside workspace scope" in result.errors[0].message
    finally:
        server.close()


def test_code_context_scoped_parent_document_uses_exact_workspace(tmp_path):
    from thai_rag.server import LocalContextServer

    server = LocalContextServer(sqlite_path=tmp_path / "context.db", chroma_path=str(tmp_path / "chroma"))
    try:
        server.storage.save_parent_doc("ws-a", "ws-a/src/auth.py", 1, 10, "A", "auth")
        server.storage.save_parent_doc("ws-b", "ws-b/src/auth.py", 1, 10, "B", "auth")

        result = server.provider().code_context("src/auth.py", line_number=5, workspace_id="ws-a")

        assert result.data["context"]["content"] == "A"
    finally:
        server.close()


def test_standalone_health_and_version_delegate_to_provider(monkeypatch):
    from thai_rag import server as server_module

    class Result:
        def __init__(self, value):
            self.value = value

        def to_dict(self):
            return self.value

    class Provider:
        def health(self, workspace_id=None):
            return Result({"status": "ok", "workspace_id": workspace_id})

        def version(self, workspace_id=None):
            return Result({"status": "ok", "workspace_id": workspace_id})

    class Server:
        def provider(self):
            return Provider()

    monkeypatch.setattr(server_module, "get_server", lambda: Server())

    assert server_module.health("ws-123")["workspace_id"] == "ws-123"
    assert server_module.version("ws-123")["workspace_id"] == "ws-123"


def test_standalone_code_search_formats_provider_results(monkeypatch):
    from thai_rag import server as server_module

    class Result:
        def to_dict(self):
            return {
                "status": "ok",
                "data": {
                    "query": "auth",
                    "items": [{
                        "file_path": "ws-123/auth.py",
                        "start_line": 1,
                        "end_line": 2,
                        "symbol_name": "auth",
                        "score": 0.5,
                        "content": "def auth(): pass",
                    }],
                    "warnings": [],
                },
                "workspace_id": "ws-123",
            }

    class Provider:
        def code_search(self, **kwargs):
            return Result()

    class Server:
        def provider(self):
            return Provider()

    monkeypatch.setattr(server_module, "get_server", lambda: Server())

    result = server_module.code_search("auth", workspace_id="ws-123")

    assert result.startswith("### 🔎 Code Matches for 'auth':")
    assert "ws-123/auth.py:1-2" in result
    assert "def auth(): pass" in result


def test_standalone_code_search_formats_empty_provider_results(monkeypatch):
    from thai_rag import server as server_module

    class Result:
        def to_dict(self):
            return {"status": "ok", "data": {"query": "auth", "items": []}, "workspace_id": "ws-123"}

    class Provider:
        def code_search(self, **kwargs):
            assert kwargs == {
                "query": "auth",
                "workspace_id": "ws-123",
                "top_k": 5,
                "path_filter": None,
            }
            return Result()

    class Server:
        def provider(self):
            return Provider()

    monkeypatch.setattr(server_module, "get_server", lambda: Server())

    result = server_module.code_search("auth", workspace_id="ws-123")

    assert result == "No code snippets found matching 'auth'."


def test_standalone_remember_turn_delegates_to_provider_with_canonical_scope(monkeypatch):
    from thai_rag import server as server_module

    class Result:
        def to_dict(self):
            return {"status": "ok", "data": {"turn_id": "turn-1"}}

    class Provider:
        def remember_turn(self, **kwargs):
            assert kwargs == {
                "role": "assistant",
                "content": "decision",
                "workspace_id": "ws-123",
                "summary": "summary",
                "tags": ["decision"],
                "turn_id": "turn-1",
            }
            return Result()

    class Server:
        def provider(self):
            return Provider()

    monkeypatch.setattr(server_module, "get_server", lambda: Server())

    result = server_module.remember_turn(
        role="assistant",
        content="decision",
        workspace="ws-123",
        summary="summary",
        tags="decision",
        turn_id="turn-1",
    )

    assert result["status"] == "ok"


def test_standalone_record_event_delegates_to_provider_with_structured_scope(monkeypatch):
    from thai_rag import server as server_module

    class Result:
        def to_dict(self):
            return {"status": "ok", "workspace_id": "ws-123"}

    class Provider:
        def record_event(self, **kwargs):
            assert kwargs == {
                "event_type": "decision",
                "content": "Use SQLite",
                "workspace_id": "ws-123",
                "summary": "storage",
                "tags": ["architecture", "decision"],
            }
            return Result()

    class Server:
        def provider(self):
            return Provider()

    monkeypatch.setattr(server_module, "get_server", lambda: Server())

    result = server_module.record_event(
        event_type="decision",
        content="Use SQLite",
        workspace_id="ws-123",
        summary="storage",
        tags="architecture, decision",
    )

    assert result["workspace_id"] == "ws-123"


def test_standalone_wrapper_delegates_to_provider_and_returns_structured_result(monkeypatch):
    from thai_rag import server as server_module

    class Provider:
        def remember(self, **kwargs):
            assert kwargs == {"content": "decision", "workspace_id": "ws-123", "category": "general"}
            return RecordingCore({}).__class__

    class Result:
        def to_dict(self):
            return {"status": "ok", "data": {"id": "mem-1"}}

    class ProviderWithResult:
        def remember(self, **kwargs):
            assert kwargs["workspace_id"] == "ws-123"
            return Result()

    class Server:
        def provider(self):
            return ProviderWithResult()

    monkeypatch.setattr(server_module, "get_server", lambda: Server())

    result = server_module.remember("decision", workspace_id="ws-123")

    assert result == {"status": "ok", "data": {"id": "mem-1"}}


def test_pre_edit_rejects_core_without_canonical_code_ownership():
    class MatchingOnlyCore(RecordingCore):
        supports_canonical_code_scope = False

    result = ThaiRagProvider(core=MatchingOnlyCore({"constraints": [], "code_context": {}, "blast_radius": {}})).pre_edit_context(
        file_path="auth.py", workspace_id="ws-123"
    )

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.SCOPE_DENIED


def test_provider_preserves_structured_core_error_status_and_code():
    class Core(RecordingCore):
        def code_index(self, workspace_path=".", workspace_id=None, force=False, background=False, structured=False):
            return {"status": "degraded", "code": "embedding_unavailable", "error": "embedding backend unavailable", "workspace_id": workspace_id}

        def index_status(self, job_id, workspace_id, structured=False):
            return {"status": "unavailable", "code": "storage_unavailable", "error": "storage unavailable", "job_id": job_id, "workspace_id": workspace_id}

    provider = ThaiRagProvider(core=Core({"constraints": [], "code_context": None}))
    index = provider.code_index("/repo", workspace_id="ws-123")
    status = provider.index_status("idx-1", workspace_id="ws-123")

    assert index.status is ProviderStatus.DEGRADED
    assert index.errors[0].code is ErrorCode.EMBEDDING_UNAVAILABLE
    assert status.status is ProviderStatus.UNAVAILABLE
    assert status.errors[0].code is ErrorCode.STORAGE_UNAVAILABLE


def test_global_health_reports_ready_without_workspace_scope():
    import sqlite3

    class Collection:
        @staticmethod
        def count():
            return 0

    class Storage:
        sqlite_conn = sqlite3.connect(":memory:")
        code_collection = Collection()

    Storage.sqlite_conn.execute(
        "CREATE VIRTUAL TABLE fts_code_symbols USING fts5(doc_id UNINDEXED, symbol_name, file_path, content)"
    )
    Storage.sqlite_conn.execute(
        "INSERT INTO fts_code_symbols (doc_id, symbol_name, file_path, content) VALUES ('doc-1', 'health', 'ws-other/health.py', 'def health(): pass')"
    )

    class Embedder:
        model = "test"

        @staticmethod
        def is_alive():
            return True

    class Core:
        storage = Storage()
        embedder = Embedder()
        supports_canonical_code_scope = True

        def pre_edit_context(self, file_path, workspace_id=None, proposed_symbol=None): return {}
        def code_index(self, workspace_path, workspace_id, force=False, background=False): return {}
        def index_status(self, job_id, workspace_id): return {}
        def code_search(self, query, workspace_id, top_k=5, path_filter=None): return {}
        def code_context(self, file_path, workspace_id, line_number, window=25): return {}
        def code_blast_radius(self, symbol_name, workspace_id, max_depth=2): return {}

    provider = ThaiRagProvider(core=Core())
    global_health = provider.health()
    scoped_health = provider.health(workspace_id="ws-exact")

    assert global_health.status is ProviderStatus.OK
    assert global_health.data["ready"] is True
    assert global_health.data["readiness"]["workspace_ready"] is False
    assert global_health.errors == []
    assert scoped_health.status is ProviderStatus.UNAVAILABLE
    assert scoped_health.data["readiness"]["workspace_ready"] is False


def test_standalone_index_adapters_return_structured_errors(monkeypatch):
    from thai_rag import server as server_module

    class Result:
        def __init__(self, value): self.value = value
        def to_dict(self): return self.value

    class Provider:
        def code_index(self, **kwargs): return Result({"status": "unavailable", "errors": [{"code": "storage_unavailable"}]})
        def index_status(self, **kwargs): return Result({"status": "unavailable", "errors": [{"code": "workspace_not_found"}]})

    class Server:
        def provider(self): return Provider()

    monkeypatch.setattr(server_module, "get_server", lambda: Server())
    assert server_module.code_index(workspace_id="ws-123") == {"status": "unavailable", "errors": [{"code": "storage_unavailable"}]}
    assert server_module.index_status("idx-missing", workspace_id="ws-123") == {"status": "unavailable", "errors": [{"code": "workspace_not_found"}]}


def test_health_distinguishes_storage_unavailable_from_degraded_components():
    import sqlite3

    class Embedder:
        @staticmethod
        def is_alive():
            return False

    class BrokenStorage:
        sqlite_conn = sqlite3.connect(":memory:")
        code_collection = None

    BrokenStorage.sqlite_conn.close()

    class Core:
        storage = BrokenStorage()
        embedder = Embedder()
        supports_canonical_code_scope = True

        def pre_edit_context(self, file_path, workspace_id=None, proposed_symbol=None):
            return {}

        def code_index(self, workspace_path, workspace_id, force=False, background=False):
            return None

        def index_status(self, job_id, workspace_id):
            return None

        def code_search(self, query, workspace_id, top_k=5, path_filter=None):
            return []

        def code_context(self, file_path, workspace_id, line_number, window=25):
            return None

        def code_blast_radius(self, symbol_name, workspace_id, max_depth=2):
            return None

    result = ThaiRagProvider(core=Core()).health(workspace_id="ws-123")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert ErrorCode.STORAGE_UNAVAILABLE in {error.code for error in result.errors}
    assert ErrorCode.EMBEDDING_UNAVAILABLE in {error.code for error in result.errors}
