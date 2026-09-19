import threading
import time
import uuid
import datetime
from pathlib import Path
from typing import Optional, Dict, Any

try:
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:
    from mcp.server.fastmcp import FastMCP

from thai_rag.config import SQLITE_PATH, CHROMA_PATH, OLLAMA_BASE_URL, EMBEDDING_MODEL
from thai_rag.storage import StorageManager
from thai_rag.ollama_adapter import OllamaEmbeddingAdapter
from thai_rag.code_chunker import CodeChunker
from thai_rag.retriever import HybridRetriever
from thai_rag.progress import BaseProgressReporter, ProgressReporter, NullProgressReporter

# In-memory background index job registry (single MCP process).
# Jobs do not survive a server restart — re-run code_index (incremental cache makes it cheap).
_INDEX_JOBS: Dict[str, Dict[str, Any]] = {}
_INDEX_JOBS_LOCK = threading.Lock()


def _new_index_job(workspace_path: str, force: bool, workspace: Optional[str] = None) -> Dict[str, Any]:
    job_id = f"idx_{uuid.uuid4().hex[:8]}"
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    job: Dict[str, Any] = {
        "job_id": job_id,
        "status": "running",
        "workspace": workspace_path,
        "workspace_id": workspace,
        "force": force,
        "indexed_files": 0,
        "skipped_files": 0,
        "total_files": 0,
        "started_at": now,
        "finished_at": None,
        "result": None,
        "error": None,
    }
    with _INDEX_JOBS_LOCK:
        _INDEX_JOBS[job_id] = job
    return job


class JobProgressReporter(NullProgressReporter):
    """Bridge progress callbacks into an in-memory index job record.

    Forwards events to an optional HUD reporter so the floating progress
    window keeps working during background indexing.
    """

    def __init__(self, job: Dict[str, Any], hud: Optional[BaseProgressReporter] = None):
        self._job = job
        self._hud = hud

    def notify_start(self, total_files: int, workspace: str) -> None:
        with _INDEX_JOBS_LOCK:
            self._job["total_files"] = total_files
        if self._hud:
            self._hud.notify_start(total_files, workspace)

    def notify_step(self, file_name: str, index: int, total: int,
                    skipped: bool = False, chunks: int = 0) -> None:
        with _INDEX_JOBS_LOCK:
            if skipped:
                self._job["skipped_files"] += 1
            else:
                self._job["indexed_files"] += 1
            if total:
                self._job["total_files"] = total
        if self._hud:
            self._hud.notify_step(file_name, index, total, skipped=skipped, chunks=chunks)

    def notify_finish(self, indexed: int, skipped: int, duration_s: float) -> None:
        if self._hud:
            try:
                self._hud.notify_finish(indexed, skipped, duration_s)
            except Exception:
                pass

    def notify_error(self, message: str) -> None:
        if self._hud:
            try:
                self._hud.notify_error(message)
            except Exception:
                pass


class LocalContextServer:
    """Core server logic for Local Context & Code RAG."""

    supports_canonical_workspace_scope = True
    supports_canonical_code_scope = True

    def __init__(
        self,
        sqlite_path: Path = SQLITE_PATH,
        chroma_path: str = CHROMA_PATH,
        ollama_url: str = OLLAMA_BASE_URL,
        model_name: str = EMBEDDING_MODEL,
        storage: Optional[StorageManager] = None
    ):
        self.storage = storage if storage is not None else StorageManager(sqlite_path=sqlite_path, chroma_path=chroma_path)
        self.embedder = OllamaEmbeddingAdapter(base_url=ollama_url, model=model_name)
        self.chunker = CodeChunker()
        self.retriever = HybridRetriever(
            storage=self.storage,
            embedder=self.embedder,
            chunker=self.chunker
        )

    def _check_ollama(self) -> Optional[str]:
        if not self.embedder.is_alive():
            return f"❌ Error: Local Ollama server is unreachable at {self.embedder.base_url}. Please ensure 'ollama serve' is running."
        return None

    # --- Domain A: Agent Memory (Replacing OpenViking) ---

    def remember(self, content: str, workspace_id: Optional[str] = None, category: str = "general") -> str:
        """Record a persistent long-term memory or project rule/decision."""
        if not content.strip():
            return "Error: Memory content cannot be empty."

        err = self._check_ollama()
        if err:
            return err

        mem_id = f"mem_{uuid.uuid4().hex[:12]}"
        try:
            vec = self.embedder.embed_document(content)
            self.storage.save_memory(mem_id, content.strip(), category.strip(), vec, workspace_id=workspace_id)
            return f"✅ Remembered [ID: {mem_id}] (Category: {category}):\n{content.strip()}"
        except Exception as e:
            return f"Error remembering content: {str(e)}"

    def recall(
        self,
        query: str,
        workspace_id: Optional[str] = None,
        category: Optional[str] = None,
        limit: int = 5,
    ) -> str:
        """Retrieve memories and past context matching a semantic query."""
        if not query.strip():
            return "Error: Query cannot be empty."

        # BUG-R8: clamp limit — Chroma rejects n_results=0/negative outright,
        # which leaked a raw library error to the caller. Cap the top end too:
        # fetch limit*8 candidates, so huge limits balloon the query.
        if not isinstance(limit, int) or limit < 1:
            limit = 5
        limit = min(limit, 50)

        err = self._check_ollama()
        if err:
            return err

        try:
            q_vec = self.embedder.embed_query(query)
            search_kwargs = {"limit": limit, "category": category}
            if workspace_id:
                search_kwargs["workspace_id"] = workspace_id
            matches = self.storage.search_memories_vector(q_vec, **search_kwargs)
            if not matches:
                return f"No memories found matching '{query}'."

            out = [f"### 🧠 Retrieved Memories for '{query}':"]
            for m in matches:
                meta = m.get("metadata", {})
                cat = meta.get("category") or "general"
                date_raw = meta.get("created_at") or meta.get("date") or ""
                date = str(date_raw)[:19]
                dist = round(m.get("distance", 0.0), 3)
                out.append(f"- **[ID: {m['id']}]** (Category: `{cat}`, Date: `{date}`, Dist: `{dist}`):\n  {m['content']}")

            return "\n\n".join(out)
        except Exception as e:
            return f"Error recalling memories: {str(e)}"

    def forget(self, memory_id: str, workspace_id: Optional[str] = None, category: Optional[str] = None) -> str:
        """Delete an obsolete memory entry by its ID."""
        if not memory_id.strip():
            return "Error: Memory ID cannot be empty."

        scoped_category = category.strip() if category is not None and category.strip() else None
        deleted = self.storage.delete_memory(
            memory_id.strip(),
            category=scoped_category,
            workspace_id=workspace_id,
        )
        if deleted:
            return f"🗑️ Deleted memory ID: {memory_id}"
        if workspace_id:
            return f"Error: Memory ID {memory_id} is outside workspace scope."
        return f"Warning: Memory ID {memory_id} not found."

    # --- Domain B: Code RAG ---

    def code_index(
        self,
        workspace_path: str = ".",
        force: bool = False,
        background: bool = False,
        workspace_id: Optional[str] = None,
        workspace: Optional[str] = None,
        structured: bool = False,
    ) -> str | dict:
        """Index all source code files in a workspace with SHA256 incremental caching.

        background=True returns a job_id immediately; poll with index_status().
        """
        workspace = workspace_id if workspace_id is not None else workspace
        workspace = workspace or Path(workspace_path).resolve().name
        err = self._check_ollama()
        if err:
            return {"status": "error", "workspace_id": workspace, "error": err} if structured else err

        if background:
            job = _new_index_job(workspace_path, force, workspace=workspace)
            job_id = job["job_id"]

            def _run() -> None:
                try:
                    hud = ProgressReporter()
                    bridge = JobProgressReporter(job, hud)
                    res = self.retriever.index_workspace(
                        workspace_path, force=force, progress_reporter=bridge, workspace=workspace
                    )
                    with _INDEX_JOBS_LOCK:
                        job["indexed_files"] = res.get("indexed", 0)
                        job["skipped_files"] = res.get("skipped", 0)
                        job["result"] = res
                        job["status"] = "done"
                except Exception as e:
                    with _INDEX_JOBS_LOCK:
                        job["status"] = "error"
                        job["error"] = str(e)
                    try:
                        bridge = JobProgressReporter(job, None)
                        bridge.notify_error(str(e))
                    except Exception:
                        pass
                finally:
                    with _INDEX_JOBS_LOCK:
                        job["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

            t = threading.Thread(target=_run, daemon=True)
            t.start()
            if structured:
                return {
                    "status": "running",
                    "job_id": job_id,
                    "workspace_id": workspace,
                    "workspace_path": workspace_path,
                }
            return (
                f"🚀 Indexing started in background [Job: {job_id}]\n"
                f"- Workspace: `{workspace_path}`\n"
                f"- Poll with `index_status(\"{job_id}\")`."
            )

        try:
            reporter = ProgressReporter()
            res = self.retriever.index_workspace(
                workspace_path, force=force, progress_reporter=reporter, workspace=workspace
            )
            if structured:
                return {"status": "done", "workspace_id": workspace, **res}
            out = (
                f"📁 **Code Indexing Completed:**\n"
                f"- Indexed: `{res['indexed']} files`\n"
                f"- Skipped (unchanged): `{res['skipped']} files`\n"
                f"- Duration: `{res['duration_s']}s`\n"
                f"- Workspace: `{res['workspace']}`"
            )
            if res.get("embed_fallbacks"):
                out += f"\n- ⚠️ Embed fallbacks (zero-vector): `{res['embed_fallbacks']}` chunks — check Ollama health"
            return out
        except Exception as e:
            if structured:
                return {"status": "error", "workspace_id": workspace, "error": str(e)}
            return f"Error indexing workspace: {str(e)}"

    def index_status(self, job_id: str, workspace_id: Optional[str] = None, workspace: Optional[str] = None, structured: bool = False):
        """Poll a background code_index job by its job_id."""
        workspace = workspace_id if workspace_id is not None else workspace
        with _INDEX_JOBS_LOCK:
            job = _INDEX_JOBS.get(job_id)
        if not job:
            if structured:
                return {"status": "unknown", "job_id": job_id}
            return f"⚠️ Warning: Unknown job_id `{job_id}`. Jobs do not survive server restarts — re-run code_index."
        if workspace is not None and job.get("workspace_id") != workspace:
            if structured:
                return {"status": "scope_denied", "job_id": job_id, "workspace_id": workspace}
            return f"Error: Index job `{job_id}` is outside workspace scope."

        if structured:
            return {
                "status": job["status"],
                "job_id": job["job_id"],
                "workspace_id": job.get("workspace_id"),
                "indexed_files": job["indexed_files"],
                "skipped_files": job["skipped_files"],
                "total_files": job["total_files"],
                "result": job.get("result"),
                "error": job.get("error"),
            }

        if job["status"] == "running":
            return (
                f"⏳ Indexing in progress [{job['job_id']}]\n"
                f"- Indexed: {job['indexed_files']}/{job['total_files']}\n"
                f"- Skipped: {job['skipped_files']}\n"
                f"- Workspace: `{job['workspace']}`"
            )
        if job["status"] == "error":
            return f"❌ Indexing failed [{job['job_id']}]: {job['error']}"

        res = job["result"] or {}
        return (
            f"✅ Indexing complete [{job['job_id']}]\n"
            f"- Indexed: `{res.get('indexed', job['indexed_files'])} files`\n"
            f"- Skipped: `{res.get('skipped', job['skipped_files'])} files`\n"
            f"- Duration: `{res.get('duration_s', '?')}s`\n"
            f"- Workspace: `{job['workspace']}`"
        )

    def code_search(
        self,
        query: str,
        top_k: int = 5,
        path_filter: Optional[str] = None,
        workspace_id: Optional[str] = None,
        workspace: Optional[str] = None,
        structured: bool = False,
    ):
        """Search code symbols and semantic logic across the indexed codebase."""
        if not query.strip():
            return "Error: Search query cannot be empty."
        workspace = workspace_id if workspace_id is not None else workspace

        # BUG-R1: no hard Ollama gate — retriever.search() already degrades to
        # FTS-only when embeddings are unavailable. Surface a warning suffix.
        degraded = not self.embedder.is_alive()

        try:
            results = self.retriever.search(
                query,
                top_k=top_k,
                path_filter=path_filter,
                workspace=workspace,
            )
            if structured:
                return {
                    "query": query,
                    "workspace_id": workspace,
                    "items": results,
                    "warnings": ["semantic ranking degraded"] if degraded else [],
                }
            if not results:
                base = f"No code snippets found matching '{query}'."
                return base + ("  ⚠️ semantic ranking degraded (Ollama unreachable) — FTS5 results only" if degraded else "")

            out = [f"### 🔎 Code Matches for '{query}':"]
            for idx, r in enumerate(results, 1):
                symbol = f" (`{r['symbol_name']}`)" if r.get('symbol_name') else ""
                out.append(
                    f"#### {idx}. [{r['file_path']}:{r['start_line']}-{r['end_line']}]{symbol} (RRF Score: {r['score']})\n"
                    f"```{Path(r['file_path']).suffix.lstrip('.') or 'text'}\n"
                    f"{r['content']}\n"
                    f"```"
                )
            if degraded:
                out.append("⚠️ semantic ranking degraded (Ollama unreachable) — FTS5 results only")
            return "\n\n".join(out)
        except Exception as e:
            return f"Error searching code: {str(e)}"

    def code_context(
        self,
        file_path: str,
        line_number: int,
        window: int = 25,
        workspace_id: Optional[str] = None,
        workspace: Optional[str] = None,
        structured: bool = False,
    ):
        """Retrieve the enclosing function/class context or surrounding lines for a file."""
        workspace = workspace_id if workspace_id is not None else workspace
        try:
            ctx = self.retriever.get_context(
                file_path,
                line_number,
                window_lines=window,
                workspace=workspace,
            )
            if structured:
                return {
                    "file_path": file_path,
                    "line_number": line_number,
                    "workspace_id": workspace,
                    "context": ctx,
                }
            if not ctx:
                return f"No context found for {file_path}:{line_number}."

            symbol = f" (Scope: `{ctx['symbol_name']}`)" if ctx.get('symbol_name') else ""
            return (
                f"### 📍 Context around [{ctx['file_path']}:{ctx['start_line']}-{ctx['end_line']}]{symbol}:\n"
                f"```{Path(file_path).suffix.lstrip('.') or 'text'}\n"
                f"{ctx['content']}\n"
                f"```"
            )
        except Exception as e:
            return f"Error retrieving context: {str(e)}"

    def record_event(
        self,
        event_type: str,
        content: str,
        workspace_id: str,
        summary: Optional[str] = None,
        tags: Optional[list] = None,
    ) -> dict:
        if not event_type.strip() or not content.strip():
            raise ValueError("event_type and content cannot be empty")
        event_tags = list(tags or [])
        event_tags.append(event_type)
        turn_id = f"event_{uuid.uuid4().hex[:12]}"
        vector = None
        if self.embedder.is_alive():
            try:
                vector = self.embedder.embed_document(f"[{workspace_id}] event: {summary or content}")
            except Exception:
                pass
        self.storage.save_conversation_turn(
            turn_id=turn_id,
            workspace=workspace_id,
            role="event",
            content=content,
            summary=summary,
            tags=event_tags,
            embedding=vector,
        )
        return {
            "event_type": event_type,
            "workspace_id": workspace_id,
            "content": content,
            "summary": summary,
            "tags": event_tags,
        }

    def remember_turn(
        self,
        role: str,
        content: str,
        workspace_id: Optional[str] = None,
        workspace: Optional[str] = None,
        summary: Optional[str] = None,
        tags: Optional[list] = None,
        turn_id: Optional[str] = None,
    ) -> str:
        """Record an interaction turn or decision immediately during chat into persistent memory.

        A caller may provide a stable ``turn_id`` so an ambiguous retry upserts the
        same turn instead of creating a duplicate. Missing/blank IDs preserve the
        historical behavior and generate a fresh local ID.
        """
        if not content.strip():
            return "Error: Content cannot be empty."

        workspace_id = workspace_id or workspace or "general"
        turn_id = (turn_id or "").strip() or f"turn_{uuid.uuid4().hex[:12]}"
        vector = None
        embed_failed = False
        if self.embedder.is_alive():
            try:
                vector = self.embedder.embed_document(f"[{workspace_id}] {role}: {summary or content}")
            except Exception:
                # BUG-4: turn still saved to SQLite (FTS search works), but Chroma
                # vector is skipped — surface a warning so silent data loss is visible.
                embed_failed = True

        self.storage.save_conversation_turn(
            turn_id=turn_id,
            workspace=workspace_id,
            role=role,
            content=content,
            summary=summary,
            tags=tags or [],
            embedding=vector
        )
        if embed_failed:
            return f"✅ Conversation turn recorded [ID: {turn_id}] ⚠️ (embedded without vector — embedding failed; FTS search still works)"
        return f"✅ Conversation turn recorded [ID: {turn_id}]"

    def pre_edit_context(
        self,
        file_path: str,
        workspace_id: Optional[str] = None,
        proposed_symbol: Optional[str] = None,
        workspace: Optional[str] = None,
    ) -> dict:
        """Verify constraints, blast radius, and enclosing context before editing a file."""
        scoped_workspace = workspace_id if workspace_id is not None else workspace
        if not scoped_workspace:
            return {
                "file_path": file_path,
                "workspace": "",
                "evidence": {"storage": "unavailable", "code_index": "unavailable", "cpg": "unavailable"},
                "can_proceed": False,
                "constraints": [],
                "code_context": None,
                "blast_radius": None,
                "message": "canonical workspace_id is required",
            }
        workspace_id = scoped_workspace
        workspace = workspace_id
        constraints = self.storage.get_file_constraints(file_path, workspace=workspace_id)

        file_symbols = self.storage.get_file_symbols(file_path, workspace=workspace)

        blast_radius = None
        if proposed_symbol:
            blast_radius = self.storage.get_symbol_blast_radius(proposed_symbol, file_path=file_path, workspace=workspace)
        elif file_symbols:
            top_sym = file_symbols[0]["symbol_name"]
            blast_radius = self.storage.get_symbol_blast_radius(top_sym, file_path=file_path, workspace=workspace)

        code_ctx = None
        try:
            # Only fetch code context when the file truly exists on disk.
            # Indexed paths look like "<workspace>/<rel/path>" and may need base resolution.
            if self._resolve_real_path(file_path) is not None:
                target_line = 1
                if proposed_symbol:
                    match = next(
                        (s for s in file_symbols
                         if s["symbol_name"] == proposed_symbol
                         or s["symbol_name"].endswith("." + proposed_symbol)),
                        None,
                    )
                    if match:
                        target_line = max(1, (match["line_start"] + match["line_end"]) // 2)
                elif file_symbols:
                    target_line = max(1, (file_symbols[0]["line_start"] + file_symbols[0]["line_end"]) // 2)
                code_ctx = self.retriever.get_context(file_path, target_line, window_lines=30, workspace=workspace_id)
        except Exception:
            pass

        can_proceed = bool(file_symbols and code_ctx and blast_radius)
        return {
            "file_path": file_path,
            "workspace": workspace_id,
            "evidence": {
                "storage": "ready",
                "code_index": "available" if file_symbols else "missing",
                "code_context": "available" if code_ctx else "missing",
                "cpg": "available" if blast_radius else "missing",
            },
            "can_proceed": can_proceed,
            "constraints": constraints,
            "code_context": code_ctx,
            "blast_radius": blast_radius,
            "message": f"Found {len(constraints)} past constraints for {file_path}." if constraints else ("Evidence complete; safe to proceed." if can_proceed else "Evidence incomplete; review required before proceeding.")
        }

    @staticmethod
    def _resolve_real_path(file_path: str) -> Optional[Path]:
        """Resolve an indexed path ("ws/rel/file") to an existing on-disk file, if possible."""
        p = Path(file_path)
        if p.is_file():
            return p
        parts = p.parts
        if len(parts) < 2:
            return None
        candidates = [Path.cwd() / p, Path.home() / p, Path.cwd().parent / p]
        # cwd itself may be the workspace root → drop the workspace name segment
        candidates.append(Path.cwd().joinpath(*parts[1:]))
        for cand in candidates:
            try:
                if cand.is_file():
                    return cand
            except Exception:
                continue
        return None

    def code_blast_radius(
        self,
        symbol_name: str,
        workspace_id: Optional[str] = None,
        max_depth: int = 2,
        workspace: str = "",
        structured: bool = False,
    ):
        """Analyze Code Property Graph (CPG-Lite) blast radius: find all direct/transitive callers and impacted files."""
        workspace = workspace_id if workspace_id is not None else workspace
        blast = self.storage.get_symbol_blast_radius(symbol_name, workspace=workspace or None, max_depth=max_depth)

        callers = blast.get("callers", [])
        callees = blast.get("callees", [])
        impacted = blast.get("impacted_files", [])
        if structured:
            return {
                "symbol_name": symbol_name,
                "workspace_id": workspace,
                "callers": callers,
                "callees": callees,
                "impacted_files": impacted,
            }

        out = [f"### 💥 Blast Radius Analysis for `{symbol_name}`:"]
        out.append(f"- **Direct & Transitive Callers**: {len(callers)}")
        out.append(f"- **Callees / Dependencies**: {len(callees)}")
        out.append(f"- **Impacted Files**: {len(impacted)}")

        if callers:
            out.append("\n#### 📞 Inbound Callers (Who will be affected):")
            for c in callers[:10]:
                out.append(f"- `depth {c.get('depth', 1)}`: `{c.get('source_symbol')}` in `{c.get('source_file')}` ({c.get('edge_type')})")

        if callees:
            out.append("\n#### 🎯 Outbound Callees (What this depends on):")
            for c in callees[:10]:
                out.append(f"- `depth {c.get('depth', 1)}`: calls `{c.get('target_symbol')}` ({c.get('edge_type')})")

        if impacted:
            out.append("\n#### 📁 Impacted External Files:")
            for f in impacted:
                out.append(f"- `{f}`")

        return "\n".join(out)

    def provider(self):
        """Return transport-independent provider contract for this core."""
        from thai_rag.provider import ThaiRagProvider

        return ThaiRagProvider(core=self)

    def close(self):
        self.storage.close()

# FastMCP / MCPServer App Instance
mcp = FastMCP("thai-context-aware-rag")

# Shared server instance for MCP lifecycle
_server = None

def get_server() -> LocalContextServer:
    global _server
    if _server is None:
        _server = LocalContextServer()
    return _server

@mcp.tool()
def health(workspace_id: Optional[str] = None):
    """Report provider readiness and dependency health."""
    return get_server().provider().health(workspace_id=workspace_id).to_dict()


@mcp.tool()
def version(workspace_id: Optional[str] = None):
    """Report provider contract and compatibility metadata."""
    return get_server().provider().version(workspace_id=workspace_id).to_dict()


@mcp.tool()
def remember(content: str, category: str = "general", workspace_id: Optional[str] = None):
    """Record a persistent long-term memory or project rule/decision."""
    return get_server().provider().remember(
        content=content,
        workspace_id=workspace_id,
        category=category,
    ).to_dict()

@mcp.tool()
def recall(query: str, category: str = None, limit: int = 5, workspace_id: Optional[str] = None):
    """Retrieve memories and past context matching a semantic query."""
    return get_server().provider().recall(
        query=query,
        workspace_id=workspace_id,
        category=category,
        limit=limit,
    ).to_dict()

@mcp.tool()
def remember_turn(
    role: str,
    content: str,
    workspace: str = "",
    summary: str = "",
    tags: str = "",
    turn_id: str = "",
    workspace_id: Optional[str] = None,
):
    """Record an interaction turn through the provider contract."""
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    scoped_workspace = workspace_id if workspace_id is not None else (workspace or None)
    return get_server().provider().remember_turn(
        role=role,
        content=content,
        workspace_id=scoped_workspace,
        summary=summary or None,
        tags=tag_list,
        turn_id=turn_id or None,
    ).to_dict()

@mcp.tool()
def record_event(
    event_type: str,
    content: str,
    workspace_id: Optional[str] = None,
    summary: str = "",
    tags: str = "",
):
    """Record a selective workspace event through the provider contract."""
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
    return get_server().provider().record_event(
        event_type=event_type,
        content=content,
        workspace_id=workspace_id,
        summary=summary or None,
        tags=tag_list,
    ).to_dict()

@mcp.tool()
def pre_edit_context(
    file_path: str,
    workspace: str = "",
    proposed_symbol: str = "",
    workspace_id: Optional[str] = None,
):
    """MANDATORY pre-edit check: Retrieve prior architectural constraints, decisions, enclosing code scope, and CPG blast radius before editing a file."""
    scoped_workspace = workspace_id if workspace_id is not None else (workspace or None)
    return get_server().provider().pre_edit_context(
        file_path=file_path,
        workspace_id=scoped_workspace,
        proposed_symbol=proposed_symbol or None,
    ).to_dict()
def _format_code_search(data: dict) -> str:
    query = data.get("query", "")
    items = data.get("items", [])
    warnings = data.get("warnings", [])
    if not items:
        return f"No code snippets found matching '{query}'."
    out = [f"### 🔎 Code Matches for '{query}':"]
    for idx, item in enumerate(items, 1):
        symbol = f" (`{item['symbol_name']}`)" if item.get("symbol_name") else ""
        out.append(
            f"#### {idx}. [{item['file_path']}:{item['start_line']}-{item['end_line']}]{symbol} (RRF Score: {item['score']})\n"
            f"```{Path(item['file_path']).suffix.lstrip('.') or 'text'}\n"
            f"{item['content']}\n"
            f"```"
        )
    out.extend(warnings)
    return "\n\n".join(out)


def _format_code_context(data: dict) -> str:
    file_path = data.get("file_path", "")
    line_number = data.get("line_number", 0)
    context = data.get("context")
    if not context:
        return f"No context found for {file_path}:{line_number}."
    symbol = f" (Scope: `{context['symbol_name']}`)" if context.get("symbol_name") else ""
    return (
        f"### 📍 Context around [{context['file_path']}:{context['start_line']}-{context['end_line']}]{symbol}:\n"
        f"```{Path(file_path).suffix.lstrip('.') or 'text'}\n"
        f"{context['content']}\n"
        f"```"
    )


def _format_code_blast(data: dict) -> str:
    symbol_name = data.get("symbol_name", "")
    callers = data.get("callers", [])
    callees = data.get("callees", [])
    impacted = data.get("impacted_files", [])
    out = [f"### 💥 Blast Radius Analysis for `{symbol_name}`:"]
    out.append(f"- **Direct & Transitive Callers**: {len(callers)}")
    out.append(f"- **Callees / Dependencies**: {len(callees)}")
    out.append(f"- **Impacted Files**: {len(impacted)}")
    if callers:
        out.append("\n#### 📞 Inbound Callers (Who will be affected):")
        out.extend(f"- `depth {item.get('depth', 1)}`: `{item.get('source_symbol')}` in `{item.get('source_file')}` ({item.get('edge_type')})" for item in callers[:10])
    if callees:
        out.append("\n#### 🎯 Outbound Callees (What this depends on):")
        out.extend(f"- `depth {item.get('depth', 1)}`: calls `{item.get('target_symbol')}` ({item.get('edge_type')})" for item in callees[:10])
    if impacted:
        out.append("\n#### 📁 Impacted External Files:")
        out.extend(f"- `{file_path}`" for file_path in impacted[:10])
    return "\n".join(out)


@mcp.tool()
def code_blast_radius(
    symbol_name: str,
    workspace: str = "",
    max_depth: int = 2,
    workspace_id: Optional[str] = None,
):
    """Analyze Code Property Graph (CPG) blast radius: find all direct/transitive callers and impacted files before modifying a symbol."""
    scoped_workspace = workspace_id if workspace_id is not None else (workspace or None)
    result = get_server().provider().code_blast_radius(
        symbol_name=symbol_name,
        workspace_id=scoped_workspace,
        max_depth=max_depth,
    ).to_dict()
    return _format_code_blast(result["data"]) if result["status"] == "ok" else result

@mcp.tool()
def forget(memory_id: str, category: str = None, workspace_id: Optional[str] = None):
    """Delete an obsolete memory entry by ID, optionally requiring its category."""
    return get_server().provider().forget(memory_id=memory_id, workspace_id=workspace_id).to_dict()

@mcp.tool()
def code_index(
    workspace_path: str = ".",
    force: bool = False,
    background: bool = False,
    workspace: str = "",
    workspace_id: Optional[str] = None,
):
    """Index all source code files in a workspace with SHA256 incremental caching.

    background=True returns a job_id immediately; poll with index_status().
    """
    scoped_workspace = workspace_id if workspace_id is not None else (workspace or None)
    result = get_server().provider().code_index(
        workspace_path=workspace_path,
        workspace_id=scoped_workspace,
        force=force,
        background=background,
    ).to_dict()
    if result.get("status") != "ok" or not isinstance(result.get("data"), dict):
        return result
    data = result["data"]
    if data.get("status") == "running":
        return (
            f"🚀 Indexing started in background [Job: {data['job_id']}]\n"
            f"- Workspace: `{data['workspace_path']}`\n"
            f"- Poll with `index_status(\"{data['job_id']}\")`."
        )
    return (
        f"📁 **Code Indexing Completed:**\n"
        f"- Indexed: `{data['indexed']} files`\n"
        f"- Skipped (unchanged): `{data['skipped']} files`\n"
        f"- Duration: `{data['duration_s']}s`\n"
        f"- Workspace: `{data['workspace']}`"
    )


@mcp.tool()
def index_status(
    job_id: str,
    workspace: str = "",
    workspace_id: Optional[str] = None,
):
    """Poll a background code_index job by its job_id."""
    scoped_workspace = workspace_id if workspace_id is not None else (workspace or None)
    result = get_server().provider().index_status(job_id=job_id, workspace_id=scoped_workspace).to_dict()
    if result.get("status") != "ok" or not isinstance(result.get("data"), dict):
        return result
    data = result["data"]
    if data["status"] == "running":
        return (
            f"⏳ Indexing in progress [{data['job_id']}]\n"
            f"- Indexed: {data['indexed_files']}/{data['total_files']}\n"
            f"- Skipped: {data['skipped_files']}\n"
            f"- Workspace: `{data['workspace_id']}`"
        )
    if data["status"] == "error":
        return f"❌ Indexing failed [{data['job_id']}]: {data['error']}"
    return (
        f"✅ Indexing complete [{data['job_id']}]\n"
        f"- Indexed: `{data.get('result', {}).get('indexed', data['indexed_files'])} files`\n"
        f"- Skipped: `{data.get('result', {}).get('skipped', data['skipped_files'])} files`\n"
        f"- Duration: `{data.get('result', {}).get('duration_s', '?')}s`\n"
        f"- Workspace: `{data['workspace_id']}`"
    )

@mcp.tool()
def code_search(
    query: str,
    top_k: int = 5,
    path_filter: str = None,
    workspace: str = "",
    workspace_id: Optional[str] = None,
):
    """Search code symbols and semantic logic across the indexed codebase."""
    scoped_workspace = workspace_id if workspace_id is not None else (workspace or None)
    result = get_server().provider().code_search(
        query=query,
        workspace_id=scoped_workspace,
        top_k=top_k,
        path_filter=path_filter,
    ).to_dict()
    return _format_code_search(result["data"]) if result["status"] == "ok" else result

@mcp.tool()
def code_context(
    file_path: str,
    line_number: int,
    window: int = 25,
    workspace: str = "",
    workspace_id: Optional[str] = None,
):
    """Retrieve the enclosing function/class context or surrounding lines for a file."""
    scoped_workspace = workspace_id if workspace_id is not None else (workspace or None)
    result = get_server().provider().code_context(
        file_path=file_path,
        line_number=line_number,
        workspace_id=scoped_workspace,
        window=window,
    ).to_dict()
    return _format_code_context(result["data"]) if result["status"] == "ok" else result

if __name__ == "__main__":
    mcp.run(transport="stdio")
