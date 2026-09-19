import os
import re
import hashlib
import time
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
from thai_rag.storage import StorageManager
from thai_rag.ollama_adapter import OllamaEmbeddingAdapter
from thai_rag.code_chunker import CodeChunker, ParentDocument, CodeChunk
from thai_rag.progress import BaseProgressReporter, NullProgressReporter

# Standard directories and files to ignore
DEFAULT_EXCLUDES = {
    ".git", ".svn", ".hg", "node_modules", "venv", ".venv", "env",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "dist", "build", "target", ".idea", ".vscode", "coverage", ".cache",
    "backup", "Backup", "backups", "Backups", "bak", "tmp", "temp",
    "vendor", ".turbo", ".next", ".nuxt", ".output", "output", "out"
}

EXCLUDED_FILES = {
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
    "poetry.lock", "Cargo.lock", "composer.lock", "Gemfile.lock", "flake.lock",
    "LICENSE.txt", "AUTHORS.txt"
}

SENSITIVE_PATTERNS = [
    re.compile(r"^(?:client_secret.*|.*credential.*|.*service_account.*|token|tokens)\.json$", re.IGNORECASE),
    re.compile(r"^.*\.(?:pem|key|pfx|p12|pkcs12|keystore)$", re.IGNORECASE),
    re.compile(r"^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$", re.IGNORECASE),
    re.compile(r"^\.env(?:\..*)?$", re.IGNORECASE),
    re.compile(r"^\.dev\.vars(?:\..*)?$", re.IGNORECASE),
    re.compile(r"^.*(?:secret|token|credential|password|passwd|private_key|enc_key).*\.(?:txt|json|env|vars|key)$", re.IGNORECASE),
]

EXTENSIONLESS_CODE_FILES = {
    "makefile", "dockerfile", "containerfile", "procfile", "gemfile", "vagrantfile", "rakefile"
}

def is_sensitive_file(filename: str) -> bool:
    """Return True if filename matches sensitive credentials/tokens/secrets patterns."""
    return any(p.match(filename) for p in SENSITIVE_PATTERNS)

def is_minified_name(filename: str) -> bool:
    """Return True if filename indicates a minified bundle, source map, or build output."""
    lower = filename.lower()
    return (
        lower.endswith(".min.js") or
        lower.endswith(".min.mjs") or
        lower.endswith(".min.cjs") or
        lower.endswith(".min.css") or
        lower.endswith(".map") or
        lower.endswith(".bundle.js") or
        lower.endswith(".meta.js")
    )

def is_minified_content(content: str) -> bool:
    """Detect minified/bundled code by analyzing line length distributions."""
    total_bytes = len(content.encode("utf-8", errors="ignore"))
    if total_bytes > 20_000:
        lines = content.splitlines()
        if len(lines) > 0:
            avg_line_len = total_bytes / len(lines)
            if avg_line_len > 500:
                return True
            if len(lines) < 15 and total_bytes > 30_000:
                return True
    return False

CODE_EXTENSIONS = {
    ".py", ".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java",
    ".c", ".cpp", ".h", ".hpp", ".cs", ".php", ".rb", ".swift",
    ".sql", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1", ".md", ".json", ".yaml", ".yml", ".toml",
    ".txt", ".prompt",
    ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte"
}

class HybridRetriever:
    """Hybrid Retriever combining SQLite FTS5 (BM25) and ChromaDB (Dense Vector) with RRF."""

    def __init__(
        self,
        storage: StorageManager,
        embedder: OllamaEmbeddingAdapter,
        chunker: CodeChunker
    ):
        self.storage = storage
        self.embedder = embedder
        self.chunker = chunker

    def index_file(self, file_path: str, content: str, workspace: str = ""):
        """Index a single file's parents and child vectors."""
        # BUG-R2: canonicalize to '<ws>/<rel>' so workspace-scoped lookups work
        file_path = self.storage._canonicalize_index_path(file_path, workspace or "")
        # Clean previous entries for this file
        self.storage.delete_file_data(file_path)

        parents = self.chunker.chunk_file(file_path, content)
        if not parents:
            return 0

        # CPG AST & Call Graph Extraction
        try:
            from thai_rag.cpg_extractor import extract_cpg
            ws_name = file_path.split("/")[0] if "/" in file_path else ""
            symbols, edges = extract_cpg(file_path, content, workspace=ws_name)
            self.storage.save_code_graph(file_path, symbols, edges, workspace=ws_name)
        except Exception as exc:
            # BUG-1: previously swallowed silently — parent_docs still saved, but
            # CPG (blast radius) went missing with zero trace. Log for diagnosis.
            logging.getLogger(__name__).warning(
                "CPG extraction failed for %s: %s", file_path, exc
            )

        all_child_ids = []
        all_child_docs = []
        all_child_metas = []

        for p in parents:
            self.storage.save_parent_doc(
                doc_id=p.id,
                file_path=p.file_path,
                start_line=p.start_line,
                end_line=p.end_line,
                content=p.content,
                symbol_name=p.symbol_name
            )

            for c in p.child_chunks:
                all_child_ids.append(c.id)
                all_child_docs.append(c.content)
                ws_name = c.file_path.split("/")[0] if "/" in c.file_path else ""
                all_child_metas.append({
                    "parent_id": c.parent_id,
                    "file_path": c.file_path,
                    "start_line": c.start_line,
                    "end_line": c.end_line,
                    "symbol_name": c.symbol_name,
                    "workspace": ws_name
                })

        if all_child_docs:
            try:
                vectors = self.embedder.embed_documents(all_child_docs)
            except Exception:
                # Resilient fallback: embed sequentially with zero-vector fallback
                vectors = []
                for doc in all_child_docs:
                    try:
                        vectors.append(self.embedder.embed_document(doc))
                    except Exception:
                        vectors.append([0.0] * 768)

            self.storage.save_child_vectors(
                ids=all_child_ids,
                embeddings=vectors,
                documents=all_child_docs,
                metadatas=all_child_metas
            )
        return len(all_child_docs)

    def index_workspace(
        self,
        workspace_path: str = ".",
        force: bool = False,
        progress_reporter: Optional[BaseProgressReporter] = None,
        workspace: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Traverse directory, check SHA256 hashes, and incrementally index code files."""
        root = Path(workspace_path).resolve()
        if not root.is_dir():
            raise ValueError(f"Workspace path {workspace_path} is not a directory.")
        requested_workspace = (workspace or "").strip()
        if requested_workspace and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", requested_workspace):
            raise ValueError("Workspace namespace must be a single identifier without path separators")
        workspace_name = requested_workspace or root.name
        if requested_workspace and workspace_name != root.name:
            # Legacy indexes used root.name, which cannot distinguish same-basename repositories.
            self.storage.delete_workspace_namespace(root.name)

        start_time = time.time()
        indexed_count = 0
        skipped_count = 0

        # Read .gitignore if exists
        gitignore_patterns = set()
        gi_file = root / ".gitignore"
        if gi_file.is_file():
            try:
                for line in gi_file.read_text(encoding="utf-8", errors="ignore").splitlines():
                    l = line.strip()
                    if l and not l.startswith("#"):
                        gitignore_patterns.add(l.rstrip("/"))
            except Exception:
                pass

        target_files = []
        lower_excludes = {x.lower() for x in DEFAULT_EXCLUDES}
        for cur_root, dirs, files in os.walk(root):
            # Prune default excludes and gitignore (case-insensitive)
            dirs[:] = [
                d for d in dirs
                if d not in DEFAULT_EXCLUDES
                and d.lower() not in lower_excludes
                and not d.startswith(".")
                and d not in gitignore_patterns
            ]

            for file in files:
                if file.startswith(".") or file in EXCLUDED_FILES or is_sensitive_file(file) or is_minified_name(file):
                    continue
                ext = Path(file).suffix.lower()
                full_file_path = Path(cur_root) / file
                if ext in CODE_EXTENSIONS:
                    target_files.append(full_file_path)
                elif file.lower() in EXTENSIONLESS_CODE_FILES:
                    target_files.append(full_file_path)
                elif ext == "":
                    # Check if file is executable script starting with shebang
                    try:
                        with open(full_file_path, "rb") as fp:
                            first_bytes = fp.read(32)
                            if first_bytes.startswith(b"#!"):
                                target_files.append(full_file_path)
                    except Exception:
                        pass

        total_files = len(target_files)
        if progress_reporter:
            progress_reporter.notify_start(total_files, str(root))

        self.embedder._fallback_count = 0
        for idx, full_path in enumerate(target_files, 1):
            rel_path = str(full_path.relative_to(root))
            indexed_path = f"{workspace_name}/{rel_path}"

            try:
                stat = full_path.stat()
                mtime = stat.st_mtime

                # Fast path: mtime unchanged → skip without reading/hashing the file
                cached = self.storage.get_file_hash(indexed_path)
                if not force and cached and cached["mtime"] == mtime:
                    skipped_count += 1
                    if progress_reporter:
                        progress_reporter.notify_step(indexed_path, idx, total_files, skipped=True, chunks=0)
                    continue

                # Read content
                content = full_path.read_text(encoding="utf-8", errors="ignore")
                if is_minified_content(content):
                    skipped_count += 1
                    if progress_reporter:
                        progress_reporter.notify_step(indexed_path, idx, total_files, skipped=True, chunks=0)
                    continue
                sha256 = hashlib.sha256(content.encode("utf-8")).hexdigest()

                # Content identical (e.g. restored backup) → refresh cache entry only
                if not force and cached and cached["sha256"] == sha256:
                    self.storage.set_file_hash(indexed_path, mtime, sha256)
                    skipped_count += 1
                    if progress_reporter:
                        progress_reporter.notify_step(indexed_path, idx, total_files, skipped=True, chunks=0)
                    continue

                chunks = self.index_file(indexed_path, content, workspace=workspace_name)
                self.storage.set_file_hash(indexed_path, mtime, sha256)
                indexed_count += 1
                if progress_reporter:
                    progress_reporter.notify_step(indexed_path, idx, total_files, skipped=False, chunks=chunks)
            except Exception as exc:
                # BUG-R5b: don't hide programmer errors as silent 'skipped' —
                # an opaque except here hid a chunker NameError for a long time.
                # Still skip the file (indexing continues), but surface the cause.
                skipped_count += 1
                logging.getLogger(__name__).warning(
                    "index_file failed for %s: %s: %s",
                    indexed_path, type(exc).__name__, exc,
                )
                if progress_reporter:
                    progress_reporter.notify_step(indexed_path, idx, total_files, skipped=True, chunks=0)
                continue

        duration = round(time.time() - start_time, 2)
        if progress_reporter:
            progress_reporter.notify_finish(indexed_count, skipped_count, duration)

        return {
            "indexed": indexed_count,
            "skipped": skipped_count,
            "duration_s": duration,
            "workspace": str(root),
            "embed_fallbacks": getattr(self.embedder, "_fallback_count", 0)
        }

    def search(
        self,
        query: str,
        top_k: int = 5,
        path_filter: Optional[str] = None,
        workspace: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Hybrid Search: SQLite FTS5 (BM25) + ChromaDB (Dense Vector) with RRF."""
        clean_query = query.strip()
        if not clean_query:
            return []

        # 1. Lexical Search (FTS5)
        fts_matches = self.storage.search_code_fts(
            clean_query,
            top_k=top_k * 2,
            path_filter=path_filter,
            workspace=workspace,
        )

        # 2. Vector Search (ChromaDB)
        try:
            q_vec = self.embedder.embed_query(clean_query)
            vec_matches = self.storage.search_code_vector(
                q_vec,
                top_k=top_k * 2,
                path_filter=path_filter,
                workspace=workspace,
            )
        except Exception:
            vec_matches = []

        # 3. Reciprocal Rank Fusion (RRF)
        # parent_id -> {"score": float, "source": str}
        rrf_scores: Dict[str, float] = {}
        parent_map: Dict[str, Dict[str, Any]] = {}

        k = 60.0  # standard RRF constant

        # Rank FTS results (map doc_id to parent)
        for rank, item in enumerate(fts_matches):
            p_id = item["doc_id"]
            rrf_scores[p_id] = rrf_scores.get(p_id, 0.0) + (1.0 / (k + rank + 1))
            if p_id not in parent_map:
                parent_map[p_id] = self.storage.get_parent_doc(p_id, workspace=workspace)

        # Rank Vector results (map child metadata parent_id to parent)
        for rank, item in enumerate(vec_matches):
            meta = item.get("metadata", {})
            p_id = meta.get("parent_id") or item["id"]
            rrf_scores[p_id] = rrf_scores.get(p_id, 0.0) + (1.0 / (k + rank + 1))
            if p_id not in parent_map:
                parent_map[p_id] = self.storage.get_parent_doc(p_id, workspace=workspace)

        # Sort by RRF score descending
        ranked_parents = sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)

        # BUG-10: use normalized path for the final Python-side filter too
        rel_filter = self.storage._normalize_abs_to_rel(path_filter) if path_filter else None
        results = []
        for p_id, score in ranked_parents:
            p_doc = parent_map.get(p_id)
            if not p_doc:
                continue
            if rel_filter and rel_filter.lower() not in p_doc["file_path"].lower():
                continue

            results.append({
                "parent_id": p_id,
                "file_path": p_doc["file_path"],
                "start_line": p_doc["start_line"],
                "end_line": p_doc["end_line"],
                "symbol_name": p_doc.get("symbol_name", ""),
                "score": round(score, 4),
                "content": p_doc["content"]
            })
            if len(results) >= top_k:
                break

        return results

    def get_context(
        self,
        file_path: str,
        line_number: int,
        window_lines: int = 25,
        workspace: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """Retrieve the enclosing parent document or surrounding lines for a file and line number."""
        cur = self.storage.sqlite_conn.cursor()
        # BUG-R6: normalize absolute input to stored '<ws>/<rel>' form so an
        # absolute path (e.g. /home/qwerty/.../webtrans_prepaid/tsconfig.json)
        # still matches the rel parent row (webtrans_prepaid/tsconfig.json).
        candidates = {file_path}
        rel = self.storage._normalize_abs_to_rel(file_path)
        if rel and rel != file_path:
            candidates.add(rel)
        placeholders = " OR ".join("file_path = ?" for _ in candidates)
        scope_clause = " AND file_path LIKE ?" if workspace else ""
        scope_params = (f"{workspace}/%",) if workspace else ()
        # Find exact enclosing parent doc (support exact or suffix match)
        row = cur.execute(f"""
            SELECT * FROM parent_documents
            WHERE ({placeholders} OR file_path LIKE ? OR file_path LIKE ?)
              {scope_clause}
              AND start_line <= ? AND end_line >= ?
            ORDER BY (end_line - start_line) ASC
            LIMIT 1
        """, (*sorted(candidates), f"%/{file_path}", f"%{file_path}%", *scope_params, line_number, line_number)).fetchone()

        if row:
            doc = dict(row)
            return {
                "file_path": doc["file_path"],
                "start_line": doc["start_line"],
                "end_line": doc["end_line"],
                "symbol_name": doc.get("symbol_name", ""),
                "content": doc["content"]
            }

        # If not indexed as a parent doc, look up any parent from this file
        # (BUG-R6: same absolute->rel normalization applied here)
        fallback = cur.execute(f"""
            SELECT * FROM parent_documents
            WHERE ({placeholders} OR file_path LIKE ? OR file_path LIKE ?)
              {scope_clause}
            ORDER BY ABS(start_line - ?) ASC
            LIMIT 1
        """, (*sorted(candidates), f"%/{file_path}", f"%{file_path}%", *scope_params, line_number)).fetchone()

        if fallback:
            doc = dict(fallback)
            return {
                "file_path": doc["file_path"],
                "start_line": doc["start_line"],
                "end_line": doc["end_line"],
                "symbol_name": doc.get("symbol_name", ""),
                "content": doc["content"]
            }

        return None
