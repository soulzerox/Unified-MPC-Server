from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

CONTRACT_VERSION = "1.0"
PROVIDER_VERSION = "0.1.0"


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
    capabilities = frozenset(
        {
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
        }
    )

    def __init__(self, core: Any, provider_version: str = PROVIDER_VERSION):
        self.core = core
        self.provider_version = provider_version

    def version(self) -> ProviderResult:
        return ProviderResult(
            status=ProviderStatus.OK,
            data={
                "provider_version": self.provider_version,
                "contract_version": CONTRACT_VERSION,
                "capabilities": sorted(self.capabilities),
                "workspace_scope_model": "explicit_workspace_id",
                "result_model": "structured_provider_result",
                "error_model": "machine_readable_error",
            },
            metadata=self._metadata(),
        )

    def health(self) -> ProviderResult:
        embedder = getattr(self.core, "embedder", None)
        embedding_ready = True
        if embedder is not None and hasattr(embedder, "is_alive"):
            embedding_ready = bool(embedder.is_alive())
        status = ProviderStatus.OK if embedding_ready else ProviderStatus.DEGRADED
        warnings = [] if embedding_ready else ["embedding backend unavailable; lexical retrieval may be degraded"]
        return ProviderResult(
            status=status,
            data={
                "ready": True,
                "embedding_ready": embedding_ready,
                "contract_version": CONTRACT_VERSION,
                "capabilities": sorted(self.capabilities),
                "workspace_scope_model": "explicit_workspace_id",
            },
            warnings=warnings,
            metadata=self._metadata(),
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
        allowed = {"decision", "requirement", "constraint", "preference", "milestone", "handoff", "root_cause_fix", "explicit_remember"}
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
            parameters = inspect.signature(method).parameters
            if "workspace_id" not in parameters:
                raise ScopeContractError("core method pre_edit_context does not expose canonical workspace scope")
            raw = method(
                file_path=file_path,
                workspace_id=workspace_id,
                proposed_symbol=proposed_symbol,
            )
            constraints = raw.get("constraints") or []
            has_code_context = bool(raw.get("code_context"))
            has_blast_radius = bool(raw.get("blast_radius"))
            evidence_available = has_code_context or has_blast_radius
            evidence_fresh = raw.get("evidence_fresh", True)
            if constraints:
                status = ProviderStatus.REVIEW_REQUIRED
                evidence_state = "constraints_found"
                can_proceed = False
            elif not evidence_fresh:
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_stale"
                can_proceed = False
            elif not evidence_available:
                status = ProviderStatus.DEGRADED
                evidence_state = "evidence_unavailable"
                can_proceed = False
            else:
                status = ProviderStatus.OK
                evidence_state = "evidence_available"
                can_proceed = True
            data = dict(raw)
            data.update(
                {
                    "status": status.value,
                    "evidence_state": evidence_state,
                    "evidence_fresh": bool(evidence_fresh and evidence_available),
                    "can_proceed": can_proceed,
                }
            )
            return ProviderResult(
                status=status,
                data=data,
                workspace_id=workspace_id,
                metadata=self._metadata(),
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
        record_event = getattr(self.core, "record_event", None)
        if record_event is None:
            raise RuntimeError("core does not provide selective event storage")
        return record_event(
            event_type=event_type,
            content=content,
            workspace_id=workspace_id,
            summary=summary,
            tags=tags or [],
        )

    def _call_scoped(self, method_name: str, value: Any, workspace_id: str, **kwargs: Any) -> Any:
        method = getattr(self.core, method_name)
        parameters = inspect.signature(method).parameters
        scope_name = "workspace_id" if "workspace_id" in parameters else "workspace" if "workspace" in parameters else None
        if scope_name is None:
            raise ScopeContractError(f"core method {method_name} does not expose canonical workspace scope")
        if method_name == "index_status":
            return method(value, **{scope_name: workspace_id})
        if method_name == "forget":
            return method(value, **{scope_name: workspace_id})
        return method(value, **{scope_name: workspace_id}, **kwargs)

    def _scoped(self, operation: str, workspace_id: Optional[str], action: Callable[[], Any]) -> ProviderResult:
        if not workspace_id or not workspace_id.strip():
            return self._scope_error(operation)
        try:
            data = action()
            if isinstance(data, str) and data.startswith("Error"):
                return self._error(
                    ProviderStatus.UNAVAILABLE,
                    ErrorCode.INTERNAL_FAILURE,
                    data,
                    operation=operation,
                )
            return ProviderResult(
                status=ProviderStatus.OK,
                data=data,
                workspace_id=workspace_id,
                metadata=self._metadata(),
            )
        except Exception as exc:
            return self._failure(operation, workspace_id, exc)

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
            metadata=self._metadata(),
        )

    def _error(self, status: ProviderStatus, code: ErrorCode, message: str, **details: Any) -> ProviderResult:
        return ProviderResult(
            status=status,
            errors=[ProviderError(code=code, message=message, details=details)],
            metadata=self._metadata(),
        )

    def _metadata(self) -> dict[str, Any]:
        return {
            "provider_name": "thai-rag",
            "provider_version": self.provider_version,
            "contract_version": CONTRACT_VERSION,
        }
