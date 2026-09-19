from __future__ import annotations

import hashlib
import inspect
import sqlite3
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
    _CANONICAL_SCOPE_OPERATIONS = frozenset({"remember", "remember_turn", "recall", "record_event", "forget"})
    _CANONICAL_CODE_OPERATIONS = frozenset({"pre_edit_context", "code_search", "code_context", "code_blast_radius", "code_index", "index_status"})

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
        global_ready = self._is_ready(readiness)
        scope_ready = workspace_id is None or readiness["workspace_ready"]
        ready = global_ready and scope_ready
        unavailable = not readiness["storage_ready"] or not readiness["fts_ready"] or not scope_ready
        status = ProviderStatus.UNAVAILABLE if unavailable else (ProviderStatus.OK if ready else ProviderStatus.DEGRADED)
        warnings = []
        if not readiness["storage_ready"]:
            warnings.append("storage unavailable")
        if not readiness["fts_ready"]:
            warnings.append("FTS retrieval unavailable")
        if not readiness["vector_store_ready"]:
            warnings.append("vector store unavailable")
        if workspace_id is not None and not readiness["workspace_ready"]:
            warnings.append("canonical workspace scope unavailable")
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
            errors=self._readiness_errors(readiness, workspace_id, scope_ready),
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

    def remember_turn(
        self,
        role: str,
        content: str,
        workspace_id: Optional[str] = None,
        summary: Optional[str] = None,
        tags: Optional[list[str]] = None,
        turn_id: Optional[str] = None,
    ) -> ProviderResult:
        return self._scoped(
            "remember_turn",
            workspace_id,
            lambda: self._remember_turn(role, content, workspace_id, summary, tags, turn_id),
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
            if not self._supports_canonical_code_scope():
                raise ScopeContractError("core does not prove canonical code workspace ownership")
            method = self.core.pre_edit_context
            self._canonical_scope_name(method, "pre_edit_context")
            kwargs: dict[str, Any] = {
                "file_path": file_path,
                "workspace_id": workspace_id,
                "proposed_symbol": proposed_symbol,
            }
            raw = method(**kwargs)
            if not isinstance(raw, dict):
                raise TypeError("core pre_edit_context must return a mapping")
            constraints = raw.get("constraints") or []
            raw_evidence = raw.get("evidence")
            evidence = dict(raw_evidence or {})
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
            elif not raw_evidence and not raw.get("code_context") and not raw.get("blast_radius"):
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_unavailable"
                can_proceed = False
            elif not evidence_fresh:
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_stale"
                can_proceed = False
            elif evidence.get("storage") in {"unknown", "stale", "missing", "unavailable"}:
                status = ProviderStatus.UNAVAILABLE if evidence["storage"] == "unavailable" else ProviderStatus.DEGRADED
                evidence_state = f"storage_{evidence['storage']}"
                can_proceed = False
            elif evidence.get("code_index") in {"unknown", "stale", "missing", "unavailable"}:
                status = ProviderStatus.DEGRADED
                evidence_state = f"code_index_{evidence['code_index']}"
                can_proceed = False
            elif evidence.get("cpg") in {"unknown", "stale", "missing", "unavailable"}:
                status = ProviderStatus.DEGRADED
                evidence_state = f"cpg_{evidence['cpg']}"
                can_proceed = False
            elif not evidence_fresh:
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_stale"
                can_proceed = False
            elif not raw.get("code_context") or not raw.get("blast_radius"):
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_partial"
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

    def _remember_turn(
        self,
        role: str,
        content: str,
        workspace_id: str,
        summary: Optional[str],
        tags: Optional[list[str]],
        turn_id: Optional[str],
    ) -> Any:
        method = getattr(self.core, "remember_turn")
        scope_name = self._canonical_scope_name(method, "remember_turn")
        return method(
            role=role,
            content=content,
            **{scope_name: workspace_id},
            summary=summary,
            tags=tags or [],
            turn_id=turn_id,
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
        scope_name = self._canonical_scope_name(record_event, "record_event")
        return record_event(
            event_type=event_type,
            content=content,
            **{scope_name: workspace_id},
            summary=summary,
            tags=tags or [],
        )

    def _call_scoped(self, method_name: str, value: Any, workspace_id: str, **kwargs: Any) -> Any:
        method = getattr(self.core, method_name)
        scope_name = self._canonical_scope_name(method, method_name) if method_name in self._CANONICAL_CODE_OPERATIONS else self._scope_name(method, method_name)
        if method_name in self._CANONICAL_SCOPE_OPERATIONS and scope_name != "workspace_id":
            raise ScopeContractError(f"core method {method_name} does not expose canonical workspace_id scope")
        named = {scope_name: workspace_id, **kwargs}
        if method_name in self._CANONICAL_CODE_OPERATIONS and "structured" in inspect.signature(method).parameters:
            named["structured"] = True
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
        if operation in self._CANONICAL_CODE_OPERATIONS and not self._supports_canonical_code_scope():
            return self._failure(operation, workspace_id, ScopeContractError("core does not expose canonical workspace_id scope"))
        try:
            data = action()
            if isinstance(data, str) and (data.startswith("Error") or "unknown job" in data.lower()):
                code = self._error_code(data)
                return self._error(
                    self._error_status(data),
                    code,
                    data,
                    operation=operation,
                    workspace_id=workspace_id,
                )
            if operation in self._CANONICAL_CODE_OPERATIONS and not isinstance(data, dict):
                raise TypeError(f"core method {operation} must return structured mapping")
            if operation == "index_status" and isinstance(data, dict) and data.get("status") in {"unknown", "scope_denied"}:
                code = ErrorCode.WORKSPACE_NOT_FOUND if data["status"] == "unknown" else ErrorCode.SCOPE_DENIED
                message = "index job is unknown" if data["status"] == "unknown" else "index job is outside workspace scope"
                return self._error(
                    ProviderStatus.UNAVAILABLE,
                    code,
                    message,
                    operation=operation,
                    workspace_id=workspace_id,
                    job_id=data.get("job_id"),
                )
            warnings = self._result_warnings(data)
            status = self._result_status(data, warnings)
            if operation in self._CANONICAL_CODE_OPERATIONS and isinstance(data, dict) and (
                status not in {ProviderStatus.OK, ProviderStatus.DEGRADED}
                or data.get("code") is not None
                or data.get("error") is not None
            ):
                return self._structured_error(operation, workspace_id, data)
            return ProviderResult(
                status=status,
                data=data,
                workspace_id=workspace_id,
                warnings=warnings,
                metadata=self._metadata(workspace_id),
            )
        except Exception as exc:
            return self._failure(operation, workspace_id, exc)

    @staticmethod
    def _result_warnings(data: Any) -> list[str]:
        if isinstance(data, dict):
            raw = data.get("warnings", [])
            return [str(warning) for warning in raw] if isinstance(raw, list) else [str(raw)]
        if isinstance(data, str) and any(term in data.lower() for term in ("warning", "degraded", "embedding failed", "without vector")):
            return [data]
        return []

    def _result_status(self, data: Any, warnings: list[str]) -> ProviderStatus:
        if isinstance(data, dict) and data.get("status"):
            try:
                status = ProviderStatus(data["status"])
                return ProviderStatus.DEGRADED if status is ProviderStatus.OK and warnings else status
            except ValueError:
                pass
        return ProviderStatus.DEGRADED if warnings else ProviderStatus.OK

    def _scope_name(self, method: Callable[..., Any], operation: str) -> str:
        parameters = inspect.signature(method).parameters
        if "workspace_id" in parameters:
            return "workspace_id"
        if "workspace" in parameters:
            return "workspace"
        raise ScopeContractError(f"core method {operation} does not expose workspace scope")

    def _canonical_scope_name(self, method: Callable[..., Any], operation: str) -> str:
        if "workspace_id" not in inspect.signature(method).parameters:
            raise ScopeContractError(f"core method {operation} does not expose canonical workspace_id scope")
        return "workspace_id"

    def _supports_canonical_scope(self) -> bool:
        return getattr(self.core, "supports_canonical_workspace_scope", False) is True

    def _supports_canonical_code_scope(self) -> bool:
        return getattr(self.core, "supports_canonical_code_scope", False) is True

    def _scope_error(self, operation: str) -> ProviderResult:
        return self._error(
            ProviderStatus.UNAVAILABLE,
            ErrorCode.WORKSPACE_SCOPE_REQUIRED,
            "canonical workspace_id is required",
            operation=operation,
        )

    def _failure(self, operation: str, workspace_id: Optional[str], exc: Exception) -> ProviderResult:
        code = self._exception_code(exc)
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

    def _exception_code(self, exc: Exception) -> ErrorCode:
        if isinstance(exc, ScopeContractError):
            return ErrorCode.SCOPE_DENIED
        if isinstance(exc, sqlite3.Error):
            return ErrorCode.STORAGE_UNAVAILABLE
        return self._error_code(str(exc))

    def _readiness_errors(self, readiness: dict[str, bool], workspace_id: Optional[str], scope_ready: bool) -> list[ProviderError]:
        errors = []
        if not readiness["storage_ready"]:
            errors.append(ProviderError(ErrorCode.STORAGE_UNAVAILABLE, "SQLite storage unavailable", {"operation": "health"}))
        if not readiness["fts_ready"]:
            errors.append(ProviderError(ErrorCode.LEXICAL_RETRIEVAL_UNAVAILABLE, "SQLite FTS unavailable", {"operation": "health"}))
        if not readiness["vector_store_ready"]:
            errors.append(ProviderError(ErrorCode.VECTOR_RETRIEVAL_DEGRADED, "vector store unavailable", {"operation": "health"}))
        if not readiness["embedding_ready"]:
            errors.append(ProviderError(ErrorCode.EMBEDDING_UNAVAILABLE, "embedding backend unavailable", {"operation": "health"}))
        if not scope_ready:
            errors.append(ProviderError(ErrorCode.SCOPE_DENIED, "canonical code workspace ownership unavailable", {"operation": "health", "workspace_id": workspace_id}))
        return errors

    def _structured_error(self, operation: str, workspace_id: str, data: dict[str, Any]) -> ProviderResult:
        message = str(data.get("error") or data.get("message") or f"{operation} failed")
        code = self._error_code_value(data.get("code")) or self._error_code(message)
        status = self._provider_status(data.get("status"), message)
        details = {key: value for key, value in data.items() if key not in {"status", "code", "error", "message"}}
        details.update({"operation": operation, "workspace_id": workspace_id})
        return self._error(status, code, message, **details)

    @staticmethod
    def _error_code_value(value: Any) -> Optional[ErrorCode]:
        try:
            return ErrorCode(value) if value is not None else None
        except ValueError:
            return None

    def _provider_status(self, value: Any, message: str) -> ProviderStatus:
        try:
            return ProviderStatus(value)
        except ValueError:
            return self._error_status(message)

    def _error_status(self, message: str) -> ProviderStatus:
        return ProviderStatus.DEGRADED if self._error_code(message) in {
            ErrorCode.EMBEDDING_UNAVAILABLE,
            ErrorCode.VECTOR_RETRIEVAL_DEGRADED,
        } else ProviderStatus.UNAVAILABLE

    def _error_code(self, message: str) -> ErrorCode:
        lower = message.lower()
        if "embedding" in lower or "ollama" in lower:
            return ErrorCode.EMBEDDING_UNAVAILABLE
        if "fts" in lower or "lexical" in lower:
            return ErrorCode.LEXICAL_RETRIEVAL_UNAVAILABLE
        if "storage" in lower or "sqlite" in lower or "chroma" in lower:
            return ErrorCode.STORAGE_UNAVAILABLE
        if "outside workspace scope" in lower or "scope" in lower and "workspace" in lower:
            return ErrorCode.SCOPE_DENIED
        if "workspace" in lower and ("not" in lower or "unknown" in lower):
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
            "lifecycle_state": "ready" if self._is_ready(readiness) else "degraded",
            "state": "ready" if self._is_ready(readiness) else "degraded",
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

    @staticmethod
    def _is_ready(readiness: dict[str, bool]) -> bool:
        return all(readiness[key] for key in ("storage_ready", "fts_ready", "vector_store_ready", "embedding_ready"))

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
                    fts_ready = connection.execute(
                        "SELECT 1 FROM fts_code_symbols LIMIT 1"
                    ).fetchone() is not None
            except Exception:
                pass
            collection = getattr(storage, "code_collection", None)
            try:
                collection.count()
                vector_ready = True
            except Exception:
                vector_ready = False
        embedder = getattr(self.core, "embedder", None)
        try:
            embedding_ready = bool(embedder is None or not hasattr(embedder, "is_alive") or embedder.is_alive())
        except Exception:
            embedding_ready = False
        workspace_ready = bool(
            workspace_id
            and self._supports_canonical_code_scope()
            and self._has_owned_code_index(storage, workspace_id)
        )
        return {
            "storage_ready": storage_ready,
            "fts_ready": fts_ready,
            "vector_store_ready": vector_ready,
            "embedding_ready": embedding_ready,
            "workspace_ready": workspace_ready,
        }

    def _has_owned_code_index(self, storage: Any, workspace_id: str) -> bool:
        if not self._has_scoped_code_api():
            return False
        connection = getattr(storage, "sqlite_conn", None)
        if connection is None:
            return False
        try:
            row = connection.execute(
                """
                SELECT 1
                FROM fts_code_symbols f
                JOIN code_symbols s ON s.file_path = f.file_path
                WHERE s.workspace = ?
                LIMIT 1
                """,
                (workspace_id,),
            ).fetchone()
            return row is not None
        except Exception:
            return False

    def _has_scoped_code_api(self) -> bool:
        for name in ("pre_edit_context", "code_index", "index_status", "code_search", "code_context", "code_blast_radius"):
            method = getattr(self.core, name, None)
            if method is None:
                return False
            try:
                self._canonical_scope_name(method, name)
            except ScopeContractError:
                return False
        return True
