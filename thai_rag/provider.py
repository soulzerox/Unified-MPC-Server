from __future__ import annotations

import hashlib
import inspect
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

CONTRACT_VERSION = "1.0"
PROVIDER_SCHEMA_VERSION = 1
PROVIDER_ID = "thai-rag"
PROVIDER_VERSION = "0.1.0"
COMPATIBILITY_RANGE = {"min": CONTRACT_VERSION, "max": "1.x"}
INDEX_JOB_CONTRACT_VERSION = "1.0"
EMBEDDING_INDEX_GENERATION = 1
_CONTRACT_SHAPE = {
    "operations": [
        "remember",
        "recall",
        "record_event",
        "forget",
        "pre_edit_context",
        "code_search",
        "code_context",
        "code_blast_radius",
        "code_index",
        "index_status",
        "health",
        "version",
    ],
    "statuses": ["ok", "review_required", "degraded", "unavailable"],
    "scope": "explicit_workspace_id",
    "index_job_contract_version": INDEX_JOB_CONTRACT_VERSION,
}
CONTRACT_FINGERPRINT = hashlib.sha256(
    json.dumps(_CONTRACT_SHAPE, sort_keys=True, separators=(",", ":")).encode("utf-8")
).hexdigest()


class ProviderStatus(str, Enum):
    OK = "ok"
    REVIEW_REQUIRED = "review_required"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


class ScopeContractError(RuntimeError):
    pass


class ErrorCode(str, Enum):
    INVALID_INPUT = "invalid_input"
    WORKSPACE_SCOPE_REQUIRED = "workspace_scope_required"
    WORKSPACE_NOT_FOUND = "workspace_not_found"
    SCOPE_DENIED = "scope_denied"
    STORAGE_UNAVAILABLE = "storage_unavailable"
    LEXICAL_RETRIEVAL_UNAVAILABLE = "lexical_retrieval_unavailable"
    VECTOR_RETRIEVAL_DEGRADED = "vector_retrieval_degraded"
    EMBEDDING_UNAVAILABLE = "embedding_unavailable"
    STALE_INDEX = "stale_index"
    INCOMPATIBLE_INDEX = "incompatible_index"
    INDEXING_CONFLICT = "indexing_conflict"
    CANCELLATION = "cancellation"
    INTERNAL_FAILURE = "internal_failure"


@dataclass(frozen=True)
class ProviderError:
    code: ErrorCode
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class ProviderResult:
    status: ProviderStatus
    data: Any = None
    workspace_id: Optional[str] = None
    operation_id: Optional[str] = None
    generation: Optional[str] = None
    warnings: list[str] = field(default_factory=list)
    errors: list[ProviderError] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "data": self.data,
            "workspace_id": self.workspace_id,
            "operation_id": self.operation_id,
            "generation": self.generation,
            "warnings": list(self.warnings),
            "errors": [
                {
                    "code": error.code.value,
                    "message": error.message,
                    "details": dict(error.details),
                }
                for error in self.errors
            ],
            "metadata": dict(self.metadata),
        }


class ThaiRagProvider:
    capabilities = frozenset(_CONTRACT_SHAPE["operations"])
    _CANONICAL_SCOPE_OPERATIONS = frozenset({"remember", "recall", "record_event", "forget"})

    def __init__(self, core: Any, provider_version: str = PROVIDER_VERSION):
        self.core = core
        self.provider_version = provider_version

    def version(self, workspace_id: Optional[str] = None) -> ProviderResult:
        return ProviderResult(
            status=ProviderStatus.OK,
            data=self._contract_data(workspace_id),
            workspace_id=workspace_id,
            metadata=self._metadata(workspace_id),
        )

    def health(self, workspace_id: Optional[str] = None) -> ProviderResult:
        readiness = self._readiness(workspace_id)
        embedding_ready = readiness["embedding_ready"]
        ready = readiness["storage_ready"] and readiness["fts_ready"]
        status = ProviderStatus.OK if ready and embedding_ready else ProviderStatus.DEGRADED
        warnings = []
        if not readiness["storage_ready"]:
            warnings.append("storage unavailable")
        if not readiness["fts_ready"]:
            warnings.append("FTS retrieval unavailable")
        if not embedding_ready:
            warnings.append("embedding backend unavailable; lexical retrieval may be degraded")
        return ProviderResult(
            status=status,
            data={
                **self._contract_data(workspace_id),
                "ready": ready and embedding_ready,
                "embedding_ready": embedding_ready,
                "readiness": readiness,
            },
            workspace_id=workspace_id,
            warnings=warnings,
            metadata=self._metadata(workspace_id),
        )

    def remember(self, content: str, workspace_id: Optional[str] = None, category: str = "general") -> ProviderResult:
        return self._scoped(
            "remember",
            workspace_id,
            lambda: self._call_scoped("remember", content, workspace_id, category=category),
        )

    def recall(
        self,
        query: str,
        workspace_id: Optional[str] = None,
        category: Optional[str] = None,
        limit: int = 5,
    ) -> ProviderResult:
        return self._scoped(
            "recall",
            workspace_id,
            lambda: self._call_scoped("recall", query, workspace_id, category=category, limit=limit),
        )

    def forget(self, memory_id: str, workspace_id: Optional[str] = None) -> ProviderResult:
        return self._scoped(
            "forget",
            workspace_id,
            lambda: self._call_scoped("forget", memory_id, workspace_id),
        )

    def record_event(
        self,
        event_type: str,
        content: str,
        workspace_id: Optional[str] = None,
        summary: Optional[str] = None,
        tags: Optional[list[str]] = None,
    ) -> ProviderResult:
        if not event_type.strip() or not content.strip():
            return self._error(
                ProviderStatus.UNAVAILABLE,
                ErrorCode.INVALID_INPUT,
                "event_type and content cannot be empty",
                operation="record_event",
            )
        allowed = {
            "decision",
            "requirement",
            "constraint",
            "preference",
            "milestone",
            "handoff",
            "root_cause_fix",
            "explicit_remember",
        }
        if event_type not in allowed:
            return self._error(
                ProviderStatus.UNAVAILABLE,
                ErrorCode.INVALID_INPUT,
                "unsupported event type",
                operation="record_event",
                event_type=event_type,
            )
        return self._scoped(
            "record_event",
            workspace_id,
            lambda: self._record_event(event_type, content, workspace_id, summary, tags),
        )

    def pre_edit_context(
        self,
        file_path: str,
        workspace_id: Optional[str] = None,
        proposed_symbol: Optional[str] = None,
    ) -> ProviderResult:
        if not file_path.strip():
            return self._error(
                ProviderStatus.UNAVAILABLE,
                ErrorCode.INVALID_INPUT,
                "file_path cannot be empty",
                operation="pre_edit_context",
            )
        if not workspace_id or not workspace_id.strip():
            return self._scope_error("pre_edit_context")
        try:
            method = self.core.pre_edit_context
            scope_name = self._scope_name(method, "pre_edit_context")
            kwargs: dict[str, Any] = {
                "file_path": file_path,
                scope_name: workspace_id,
                "proposed_symbol": proposed_symbol,
            }
            raw = method(**kwargs)
            if not isinstance(raw, dict):
                raise TypeError("core pre_edit_context must return a mapping")
            constraints = raw.get("constraints") or []
            evidence = dict(raw.get("evidence") or {})
            evidence.setdefault("code_context", "available" if raw.get("code_context") else "missing")
            evidence.setdefault("cpg", "available" if raw.get("blast_radius") else "missing")
            evidence.setdefault("code_index", "unknown")
            evidence.setdefault("storage", "unknown")
            evidence_fresh = raw.get("evidence_fresh", True)
            evidence_state = "evidence_available"
            status = ProviderStatus.OK
            can_proceed = True
            if constraints:
                status = ProviderStatus.REVIEW_REQUIRED
                evidence_state = "constraints_found"
                can_proceed = False
            elif evidence.get("storage") in {"unavailable", "missing"}:
                status = ProviderStatus.UNAVAILABLE
                evidence_state = "storage_unavailable"
                can_proceed = False
            elif not raw.get("code_context") and not raw.get("blast_radius") and not raw.get("evidence"):
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_unavailable"
                can_proceed = False
            elif evidence.get("code_index") in {"stale", "missing", "unavailable"}:
                status = ProviderStatus.DEGRADED
                evidence_state = f"code_index_{evidence['code_index']}"
                can_proceed = False
            elif evidence.get("cpg") in {"stale", "missing", "unavailable"}:
                status = ProviderStatus.DEGRADED
                evidence_state = f"cpg_{evidence['cpg']}"
                can_proceed = False
            elif not evidence_fresh:
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_stale"
                can_proceed = False
            elif not raw.get("code_context") and not raw.get("blast_radius"):
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_unavailable"
                can_proceed = False
            data = dict(raw)
            data.update(
                {
                    "status": status.value,
                    "evidence": evidence,
                    "evidence_state": evidence_state,
                    "evidence_fresh": bool(evidence_fresh and can_proceed),
                    "can_proceed": can_proceed,
                }
            )
            return ProviderResult(
                status=status,
                data=data,
                workspace_id=workspace_id,
                metadata=self._metadata(workspace_id),
            )
        except Exception as exc:
            return self._failure("pre_edit_context", workspace_id, exc)

    def code_search(
        self,
        query: str,
        workspace_id: Optional[str],
        top_k: int = 5,
        path_filter: Optional[str] = None,
    ) -> ProviderResult:
        return self._scoped(
            "code_search",
            workspace_id,
            lambda: self._call_scoped("code_search", query, workspace_id, top_k=top_k, path_filter=path_filter),
        )

    def code_context(
        self,
        file_path: str,
        line_number: int,
        workspace_id: Optional[str],
        window: int = 25,
    ) -> ProviderResult:
        return self._scoped(
            "code_context",
            workspace_id,
            lambda: self._call_scoped("code_context", file_path, workspace_id, line_number=line_number, window=window),
        )

    def code_blast_radius(
        self,
        symbol_name: str,
        workspace_id: Optional[str],
        max_depth: int = 2,
    ) -> ProviderResult:
        return self._scoped(
            "code_blast_radius",
            workspace_id,
            lambda: self._call_scoped("code_blast_radius", symbol_name, workspace_id, max_depth=max_depth),
        )

    def code_index(
        self,
        workspace_path: str,
        workspace_id: Optional[str],
        force: bool = False,
        background: bool = False,
    ) -> ProviderResult:
        return self._scoped(
            "code_index",
            workspace_id,
            lambda: self._call_scoped(
                "code_index",
                workspace_path,
                workspace_id,
                force=force,
                background=background,
            ),
        )

    def index_status(self, job_id: str, workspace_id: Optional[str]) -> ProviderResult:
        return self._scoped(
            "index_status",
            workspace_id,
            lambda: self._call_scoped("index_status", job_id, workspace_id),
        )

    def _record_event(
        self,
        event_type: str,
        content: str,
        workspace_id: str,
        summary: Optional[str],
        tags: Optional[list[str]],
    ) -> Any:
        if not self._supports_canonical_scope():
            raise ScopeContractError("core does not prove canonical workspace ownership")
        record_event = getattr(self.core, "record_event", None)
        if record_event is None:
            raise ScopeContractError("core does not provide canonical selective event storage")
        scope_name = self._scope_name(record_event, "record_event")
        return record_event(
            event_type=event_type,
            content=content,
            **{scope_name: workspace_id},
            summary=summary,
            tags=tags or [],
        )

    def _call_scoped(self, method_name: str, value: Any, workspace_id: str, **kwargs: Any) -> Any:
        method = getattr(self.core, method_name)
        scope_name = self._scope_name(method, method_name)
        named = {scope_name: workspace_id, **kwargs}
        if method_name == "code_search":
            return method(value, **named)
        if method_name == "code_context":
            return method(value, **named)
        if method_name == "code_blast_radius":
            return method(value, **named)
        if method_name == "code_index":
            return method(value, **named)
        if method_name == "index_status":
            return method(value, **named)
        return method(value, **named)

    def _scoped(self, operation: str, workspace_id: Optional[str], action: Callable[[], Any]) -> ProviderResult:
        if not workspace_id or not workspace_id.strip():
            return self._scope_error(operation)
        if operation in self._CANONICAL_SCOPE_OPERATIONS and not self._supports_canonical_scope():
            return self._failure(operation, workspace_id, ScopeContractError("core does not prove canonical workspace ownership"))
        try:
            data = action()
            if isinstance(data, str) and data.startswith("Error"):
                code = self._error_code(data)
                return self._error(
                    self._error_status(data),
                    code,
                    data,
                    operation=operation,
                    workspace_id=workspace_id,
                )
            return ProviderResult(
                status=ProviderStatus.OK,
                data=data,
                workspace_id=workspace_id,
                metadata=self._metadata(workspace_id),
            )
        except Exception as exc:
            return self._failure(operation, workspace_id, exc)

    def _scope_name(self, method: Callable[..., Any], operation: str) -> str:
        parameters = inspect.signature(method).parameters
        if "workspace_id" in parameters:
            return "workspace_id"
        if "workspace" in parameters:
            return "workspace"
        raise ScopeContractError(f"core method {operation} does not expose workspace scope")

    def _supports_canonical_scope(self) -> bool:
        return getattr(self.core, "supports_canonical_workspace_scope", False) is True

    def _scope_error(self, operation: str) -> ProviderResult:
        return self._error(
            ProviderStatus.UNAVAILABLE,
            ErrorCode.WORKSPACE_SCOPE_REQUIRED,
            "canonical workspace_id is required",
            operation=operation,
        )

    def _failure(self, operation: str, workspace_id: Optional[str], exc: Exception) -> ProviderResult:
        code = ErrorCode.SCOPE_DENIED if isinstance(exc, ScopeContractError) else ErrorCode.INTERNAL_FAILURE
        return ProviderResult(
            status=ProviderStatus.UNAVAILABLE,
            workspace_id=workspace_id,
            errors=[
                ProviderError(
                    code=code,
                    message=str(exc),
                    details={"operation": operation, "exception": type(exc).__name__},
                )
            ],
            metadata=self._metadata(workspace_id),
        )

    def _error_status(self, message: str) -> ProviderStatus:
        return ProviderStatus.DEGRADED if self._error_code(message) in {
            ErrorCode.EMBEDDING_UNAVAILABLE,
            ErrorCode.VECTOR_RETRIEVAL_DEGRADED,
        } else ProviderStatus.UNAVAILABLE

    def _error_code(self, message: str) -> ErrorCode:
        lower = message.lower()
        if "embedding" in lower or "ollama" in lower:
            return ErrorCode.EMBEDDING_UNAVAILABLE
        if "storage" in lower or "sqlite" in lower or "chroma" in lower:
            return ErrorCode.STORAGE_UNAVAILABLE
        if "workspace" in lower and "not" in lower:
            return ErrorCode.WORKSPACE_NOT_FOUND
        return ErrorCode.INTERNAL_FAILURE

    def _error(self, status: ProviderStatus, code: ErrorCode, message: str, **details: Any) -> ProviderResult:
        return ProviderResult(
            status=status,
            errors=[ProviderError(code=code, message=message, details=details)],
            metadata=self._metadata(details.get("workspace_id")),
        )

    def _contract_data(self, workspace_id: Optional[str]) -> dict[str, Any]:
        readiness = self._readiness(workspace_id)
        return {
            "schema_version": PROVIDER_SCHEMA_VERSION,
            "schemaVersion": PROVIDER_SCHEMA_VERSION,
            "provider_id": PROVIDER_ID,
            "providerId": PROVIDER_ID,
            "provider_version": self.provider_version,
            "providerVersion": self.provider_version,
            "contract_version": CONTRACT_VERSION,
            "compatibility_range": dict(COMPATIBILITY_RANGE),
            "lifecycle_state": "ready" if readiness["storage_ready"] else "degraded",
            "state": "ready" if readiness["storage_ready"] else "degraded",
            "embedding_index_generation": EMBEDDING_INDEX_GENERATION,
            "embeddingIndexGeneration": EMBEDDING_INDEX_GENERATION,
            "started_at": None,
            "ready_at": None,
            "owner_id": None,
            "contract_fingerprint": CONTRACT_FINGERPRINT,
            "index_job_contract_version": INDEX_JOB_CONTRACT_VERSION,
            "capabilities": sorted(self.capabilities),
            "workspace_scope_model": "explicit_workspace_id",
            "result_model": "structured_provider_result",
            "error_model": "machine_readable_error",
            "generation": self._generation(),
            "embedding": self._embedding_metadata(),
            "readiness": readiness,
            "components": {
                "worker_reachable": True,
                "sqlite_available": readiness["storage_ready"],
                "fts_available": readiness["fts_ready"],
                "vector_store_available": readiness["vector_store_ready"],
                "embedder_available": readiness["embedding_ready"],
                "lexical_retrieval_available": readiness["fts_ready"],
                "semantic_retrieval_available": readiness["vector_store_ready"] and readiness["embedding_ready"],
                "active_jobs": [],
            },
            "degradation": [
                key for key, value in (
                    ("storage-unavailable", readiness["storage_ready"]),
                    ("fts-unavailable", readiness["fts_ready"]),
                    ("embedder-unavailable", readiness["embedding_ready"]),
                ) if not value
            ],
            "workspaces": [] if workspace_id is None else [{
                "workspaceId": workspace_id,
                "indexGeneration": EMBEDDING_INDEX_GENERATION,
                "ready": readiness["workspace_ready"],
                "reason": None if readiness["workspace_ready"] else "workspace scope unavailable",
            }],
        }

    def _metadata(self, workspace_id: Optional[str]) -> dict[str, Any]:
        return {
            "provider_name": "thai-rag",
            "provider_version": self.provider_version,
            "contract_version": CONTRACT_VERSION,
            "contract_fingerprint": CONTRACT_FINGERPRINT,
            "compatibility_range": dict(COMPATIBILITY_RANGE),
            "index_job_contract_version": INDEX_JOB_CONTRACT_VERSION,
            "generation": self._generation(),
            "embedding": self._embedding_metadata(),
            "readiness": self._readiness(workspace_id),
        }

    def _embedding_metadata(self) -> dict[str, Any]:
        embedder = getattr(self.core, "embedder", None)
        model = getattr(embedder, "model", "unknown")
        dimension = getattr(embedder, "dimension", 768)
        return {
            "profile": model,
            "model": model,
            "dimension": dimension,
            "ready": bool(embedder is None or not hasattr(embedder, "is_alive") or embedder.is_alive()),
        }

    def _generation(self) -> dict[str, str]:
        storage = getattr(self.core, "storage", None)
        storage_generation = getattr(storage, "generation", None) or "sqlite"
        index_generation = getattr(storage, "index_generation", None) or "unknown"
        return {
            "contract": CONTRACT_FINGERPRINT,
            "embedding": str(self._embedding_metadata()["profile"]),
            "index": str(index_generation),
            "storage": str(storage_generation),
        }

    def _readiness(self, workspace_id: Optional[str]) -> dict[str, bool]:
        storage = getattr(self.core, "storage", None)
        storage_ready = False
        fts_ready = False
        vector_ready = False
        if storage is not None:
            connection = getattr(storage, "sqlite_conn", None)
            try:
                if connection is not None:
                    connection.execute("SELECT 1").fetchone()
                    storage_ready = True
                    connection.execute("SELECT 1 FROM fts_conversation LIMIT 1").fetchone()
                    fts_ready = True
            except Exception:
                pass
            vector_ready = getattr(storage, "memory_collection", None) is not None
        embedder = getattr(self.core, "embedder", None)
        try:
            embedding_ready = bool(embedder is None or not hasattr(embedder, "is_alive") or embedder.is_alive())
        except Exception:
            embedding_ready = False
        workspace_ready = bool(workspace_id and (self._supports_canonical_scope() or self._has_scoped_code_api()))
        return {
            "storage_ready": storage_ready,
            "fts_ready": fts_ready,
            "vector_store_ready": vector_ready,
            "embedding_ready": embedding_ready,
            "workspace_ready": workspace_ready,
        }

    def _has_scoped_code_api(self) -> bool:
        for name in ("code_index", "code_search", "code_context", "code_blast_radius"):
            method = getattr(self.core, name, None)
            if method is None:
                return False
            try:
                self._scope_name(method, name)
            except ScopeContractError:
                return False
        return True
