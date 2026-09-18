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

    assert result.status is ProviderStatus.DEGRADED
    assert result.data["embedding_ready"] is False
    assert result.warnings


def test_provider_converts_legacy_error_string_to_structured_error():
    class Core:
        def code_search(self, query, workspace_id, top_k=5, path_filter=None):
            return "Error: storage unavailable"

    result = ThaiRagProvider(core=Core()).code_search(query="auth", workspace_id="ws-123")

    assert result.status is ProviderStatus.UNAVAILABLE
    assert result.errors[0].code is ErrorCode.INTERNAL_FAILURE


def test_provider_forwards_explicit_workspace_id_without_transport():
    provider = ThaiRagProvider(core=RecordingCore({"constraints": [], "code_context": None}))

    result = provider.code_index(workspace_path="/repo", workspace_id="ws-123")

    assert result.status is ProviderStatus.OK
    assert result.workspace_id == "ws-123"
    assert result.data["workspace"] == "ws-123"


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
    assert result.errors[0].code is ErrorCode.INTERNAL_FAILURE
    assert result.errors[0].details["exception"] == "RuntimeError"
