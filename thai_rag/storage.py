import sqlite3
import datetime
import threading
import re
from pathlib import Path
from typing import Dict, Any, List, Optional
import chromadb
from chromadb.config import Settings
from thai_rag.config import SQLITE_PATH, CHROMA_PATH

KNOWN_CATEGORIES = frozenset({"decision", "constraint", "preference", "rule", "general"})


def derive_category_from_tags(tags) -> str:
    """Derive a memory category from a tag list (case-insensitive).

    Returns the first tag matching a known category (decision/constraint/
    preference/rule); falls back to "general" when no tag matches so that
    untagged turns stay discoverable via the relaxed recall filter.
    """
    for t in (tags or []):
        norm = str(t).strip().lower()
        if norm in KNOWN_CATEGORIES and norm != "general":
            return norm
    return "general"

def tokenize_text_for_fts(text: str) -> str:
    """Tokenize Thai and multilingual text with word boundaries for SQLite FTS5."""
    if not text:
        return ""
    try:
        import pythainlp
        tokens = pythainlp.tokenize.word_tokenize(text, engine="newmm")
        return " ".join(t.strip() for t in tokens if t.strip())
    except Exception:
        return text

class StorageManager:
    """Persistent storage coordinator: SQLite (FTS5 + Docs + Cache) + ChromaDB (Vectors)."""

    def __init__(
        self,
        sqlite_path: Path = SQLITE_PATH,
        chroma_path: str = CHROMA_PATH
    ):
        self._lock = threading.Lock()
        self.sqlite_path = Path(sqlite_path)
        self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        
        self.sqlite_conn = sqlite3.connect(
            str(self.sqlite_path),
            check_same_thread=False
        )
        self.sqlite_conn.row_factory = sqlite3.Row
        self._init_sqlite()

        self.chroma_path = str(chroma_path)
        Path(self.chroma_path).mkdir(parents=True, exist_ok=True)
        self.chroma_client = chromadb.PersistentClient(
            path=self.chroma_path,
            settings=Settings(anonymized_telemetry=False)
        )
        self.code_collection = self.chroma_client.get_or_create_collection(
            name="code_vectors",
            metadata={"hnsw:space": "cosine"}
        )
        self.memory_collection = self.chroma_client.get_or_create_collection(
            name="memory_vectors",
            metadata={"hnsw:space": "cosine"}
        )

    def _init_sqlite(self):
        with self._lock:
            cur = self.sqlite_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL;")
            cur.execute("PRAGMA synchronous=NORMAL;")

            # Parent code chunks store
            cur.execute("""
                CREATE TABLE IF NOT EXISTS parent_documents (
                    id TEXT PRIMARY KEY,
                    file_path TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    symbol_name TEXT,
                    created_at TEXT NOT NULL
                );
            """)

            # FTS5 full-text index for code symbols and keywords
            cur.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_code_symbols USING fts5(
                    doc_id UNINDEXED,
                    symbol_name,
                    file_path,
                    content,
                    tokenize = 'porter unicode61'
                );
            """)

            # Agent long-term memory store (replaces OpenViking)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    content TEXT NOT NULL,
                    category TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
            """)

            # File cache table for incremental indexing
            cur.execute("""
                CREATE TABLE IF NOT EXISTS file_cache (
                    file_path TEXT PRIMARY KEY,
                    mtime REAL NOT NULL,
                    sha256 TEXT NOT NULL,
                    last_indexed TEXT NOT NULL
                );
            """)

            # Realtime conversation turns
            cur.execute("""
                CREATE TABLE IF NOT EXISTS conversation_turns (
                    turn_id TEXT PRIMARY KEY,
                    workspace TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    summary TEXT,
                    tags TEXT,
                    created_at TEXT NOT NULL
                );
            """)

            cur.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_conversation USING fts5(
                    turn_id UNINDEXED,
                    workspace,
                    content,
                    summary,
                    tags,
                    tokenize = 'porter unicode61'
                );
            """)

            # Code Property Graph (CPG-Lite) tables
            cur.execute("""
                CREATE TABLE IF NOT EXISTS code_symbols (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT NOT NULL,
                    symbol_name TEXT NOT NULL,
                    symbol_type TEXT NOT NULL,
                    line_start INTEGER NOT NULL,
                    line_end INTEGER NOT NULL,
                    workspace TEXT NOT NULL,
                    UNIQUE(file_path, symbol_name, line_start)
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_code_symbols_ws_name ON code_symbols(workspace, symbol_name);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path);")

            cur.execute("""
                CREATE TABLE IF NOT EXISTS code_edges (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_symbol TEXT NOT NULL,
                    source_file TEXT NOT NULL,
                    target_symbol TEXT NOT NULL,
                    target_file TEXT,
                    edge_type TEXT NOT NULL,
                    workspace TEXT NOT NULL,
                    UNIQUE(source_symbol, source_file, target_symbol, edge_type, workspace)
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_code_edges_target ON code_edges(workspace, target_symbol);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_code_edges_source ON code_edges(workspace, source_symbol);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_code_edges_source_file ON code_edges(source_file);")
            self.sqlite_conn.commit()

    # --- Parent Documents CRUD ---

    def save_parent_doc(
        self,
        doc_id: str,
        file_path: str,
        start_line: int,
        end_line: int,
        content: str,
        symbol_name: Optional[str] = None
    ):
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self._lock:
            with self.sqlite_conn:
                self.sqlite_conn.execute("""
                    INSERT OR REPLACE INTO parent_documents (id, file_path, start_line, end_line, content, symbol_name, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (doc_id, file_path, start_line, end_line, content, symbol_name or "", now))

                # Update FTS5
                self.sqlite_conn.execute("DELETE FROM fts_code_symbols WHERE doc_id = ?", (doc_id,))
                self.sqlite_conn.execute("""
                    INSERT INTO fts_code_symbols (doc_id, symbol_name, file_path, content)
                    VALUES (?, ?, ?, ?)
                """, (doc_id, symbol_name or "", file_path, content))

    def get_parent_doc(self, doc_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cur = self.sqlite_conn.cursor()
            row = cur.execute("SELECT * FROM parent_documents WHERE id = ?", (doc_id,)).fetchone()
            if not row:
                return None
            return dict(row)

    # --- Child Vectors CRUD ---

    def save_child_vectors(
        self,
        ids: List[str],
        embeddings: List[List[float]],
        documents: List[str],
        metadatas: List[Dict[str, Any]]
    ):
        if not ids:
            return
        self.code_collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=metadatas
        )

    def search_code_vector(
        self,
        query_vector: List[float],
        top_k: int = 5,
        path_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        col_count = self.code_collection.count()
        if col_count == 0:
            return []

        where_filter = None
        rel_filter = self._normalize_abs_to_rel(path_filter) if path_filter else None
        if path_filter:
            ws_candidate = (rel_filter or path_filter).strip().rstrip("/").split("/")[0]
            try:
                test_match = self.code_collection.get(where={"workspace": ws_candidate}, limit=1)
                if test_match and test_match["ids"]:
                    where_filter = {"workspace": ws_candidate}
            except Exception:
                where_filter = None

        # BUG-R5: fetch a generous candidate pool whenever path_filter is set.
        # With a workspace where_filter the old code fetched only top_k rows,
        # then the python-side path filter depleted that pool — an exact-file
        # filter returned zero hits even for indexed files. Always fetch up to
        # max(top_k*40, 200) so the path filter has candidates to narrow.
        fetch_k = min(col_count, max(top_k * 40, 200) if path_filter else top_k)

        results = self.code_collection.query(
            query_embeddings=[query_vector],
            n_results=fetch_k,
            where=where_filter
        )
        items = []
        if results and results["ids"] and len(results["ids"][0]) > 0:
            for i in range(len(results["ids"][0])):
                meta = results["metadatas"][0][i] if results["metadatas"] else {}
                file_path = meta.get("file_path", "")
                # BUG-10: normalized path filter check here too
                if rel_filter and rel_filter.lower() not in file_path.lower():
                    continue

                items.append({
                    "id": results["ids"][0][i],
                    "document": results["documents"][0][i] if results["documents"] else "",
                    "metadata": meta,
                    "distance": results["distances"][0][i] if results.get("distances") else 0.0
                })
                if len(items) >= top_k:
                    break
        return items

    def search_code_fts(self, query: str, top_k: int = 10, path_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        clean_query = "".join(c for c in query if c.isalnum() or c in (" ", "_")).strip()
        if not clean_query:
            return []

        words = [w for w in clean_query.split() if len(w) > 1]
        if not words:
            words = [clean_query]
        fts_expr = " OR ".join(f'"{w}"*' for w in words)

        # BUG-10: normalized path_filter — match relative stored paths from absolute inputs
        rel_filter = self._normalize_abs_to_rel(path_filter) if path_filter else None

        with self._lock:
            cur = self.sqlite_conn.cursor()
            try:
                if rel_filter:
                    rows = cur.execute("""
                        SELECT doc_id, symbol_name, file_path, rank
                        FROM fts_code_symbols
                        WHERE fts_code_symbols MATCH ? AND file_path LIKE ?
                        ORDER BY rank
                        LIMIT ?
                    """, (fts_expr, f"%{rel_filter}%", top_k)).fetchall()
                else:
                    rows = cur.execute("""
                        SELECT doc_id, symbol_name, file_path, rank
                        FROM fts_code_symbols
                        WHERE fts_code_symbols MATCH ?
                        ORDER BY rank
                        LIMIT ?
                    """, (fts_expr, top_k)).fetchall()
                return [dict(r) for r in rows]
            except Exception:
                return []

    @staticmethod
    def _normalize_abs_to_rel(path_filter: Optional[str]) -> Optional[str]:
        """Best-effort normalize an absolute path_filter to the relative form stored in DB.

        Indexed file_paths look like "<ws_name>/<rel_path>" (e.g. "thai_rag/storage.py").
        An absolute path from the user (e.g. "/mnt/.../thai_rag/storage.py") won't match a
        LIKE '%<abs>%'. We fall back to the last 2 segments (ws/rel) or the basename.
        """
        if not path_filter:
            return None
        s = path_filter.replace("\\", "/")
        parts = [x for x in s.split("/") if x]
        if len(parts) >= 2:
            return "/".join(parts[-2:])
        return parts[-1] if parts else None

    # --- Agent Memory CRUD (Replacing OpenViking) ---

    def save_memory(
        self,
        memory_id: str,
        content: str,
        category: str,
        vector: List[float]
    ):
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self._lock:
            with self.sqlite_conn:
                self.sqlite_conn.execute("""
                    INSERT OR REPLACE INTO memories (id, content, category, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                """, (memory_id, content, category, now, now))

        self.memory_collection.upsert(
            ids=[memory_id],
            embeddings=[vector],
            documents=[content],
            metadatas=[{"category": category, "created_at": now}]
        )

    def get_memory(self, memory_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cur = self.sqlite_conn.cursor()
            row = cur.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
            if not row:
                return None
            return dict(row)

    def delete_memory(self, memory_id: str) -> bool:
        with self._lock:
            with self.sqlite_conn:
                cur = self.sqlite_conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
                deleted = cur.rowcount > 0
        try:
            self.memory_collection.delete(ids=[memory_id])
        except Exception:
            pass
        return deleted

    def search_memories_vector(
        self,
        query_vector: List[float],
        limit: int = 5,
        category: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        if self.memory_collection.count() == 0:
            return []

        # BUG-8: vector `where` on category only matches remember() metadata, silently
        # dropping turns. Query without the where filter, then filter in Python so both
        # remember() (metadata["category"]) and remember_turn() (now unified) are matched.
        results = self.memory_collection.query(
            query_embeddings=[query_vector],
            n_results=limit * 8
        )
        items = []
        if results and results["ids"] and len(results["ids"][0]) > 0:
            for i in range(len(results["ids"][0])):
                meta = results["metadatas"][0][i] if results["metadatas"] else {}
                raw_cat = (meta.get("category") or "").strip().lower()
                row_category = raw_cat if raw_cat else derive_category_from_tags(
                    (meta.get("tags", "") or "").split(",")
                )
                if category:
                    want = category.strip().lower()
                    # Relaxed match: rows with a concrete but different category are
                    # still filtered out, while untagged ("general") rows pass any
                    # category query so derived-category turns stay discoverable.
                    if row_category != "general" and row_category != want:
                        continue
                items.append({
                    "id": results["ids"][0][i],
                    "content": results["documents"][0][i] if results["documents"] else "",
                    "metadata": meta,
                    "distance": results["distances"][0][i] if results.get("distances") else 0.0
                })
                if len(items) >= limit:
                    break
        return items

    # --- Realtime Conversational Memory CRUD ---

    def save_conversation_turn(
        self,
        turn_id: str,
        workspace: str,
        role: str,
        content: str,
        summary: Optional[str] = None,
        tags: Optional[List[str]] = None,
        embedding: Optional[List[float]] = None
    ):
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        # BUG-9: guard — accept str or list; never join a string per-character
        if isinstance(tags, str):
            tags = [tags]
        tags = [t for t in (tags or []) if str(t).strip()]
        tags_str = ",".join(tags)
        fts_content = tokenize_text_for_fts(content)
        fts_summary = tokenize_text_for_fts(summary or "")
        fts_tags = tokenize_text_for_fts(tags_str)

        with self._lock:
            with self.sqlite_conn:
                self.sqlite_conn.execute("""
                    INSERT OR REPLACE INTO conversation_turns (turn_id, workspace, role, content, summary, tags, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (turn_id, workspace, role, content, summary or "", tags_str, now))
                self.sqlite_conn.execute("DELETE FROM fts_conversation WHERE turn_id = ?", (turn_id,))
                self.sqlite_conn.execute("""
                    INSERT INTO fts_conversation (turn_id, workspace, content, summary, tags)
                    VALUES (?, ?, ?, ?, ?)
                """, (turn_id, workspace, fts_content, fts_summary, fts_tags))

        if embedding:
            doc_text = f"[{workspace}] {role}: {summary or content}"
            # BUG-8b: unify metadata — include category + created_at so recall can
            # display/filter turns consistently with remember() memories.
            category = derive_category_from_tags(tags)
            self.memory_collection.upsert(
                ids=[turn_id],
                embeddings=[embedding],
                documents=[doc_text],
                metadatas=[{
                    "workspace": workspace,
                    "role": role,
                    "tags": tags_str,
                    "type": "turn",
                    "category": category,
                    "created_at": now,
                }]
            )

    def search_conversation_turns(
        self,
        query: str,
        workspace: Optional[str] = None,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        clean_query = re.sub(r'[^\w\s]', ' ', query).strip()
        if not clean_query:
            return []

        try:
            import pythainlp
            tokens = [t.strip() for t in pythainlp.tokenize.word_tokenize(clean_query, engine="newmm") if t.strip()]
        except Exception:
            tokens = clean_query.split()

        words = [w for w in tokens if len(w) > 0]
        if not words:
            words = [clean_query]

        fts_expr = " OR ".join(f'"{w}"*' for w in words)
        with self._lock:
            cur = self.sqlite_conn.cursor()
            try:
                if workspace:
                    rows = cur.execute("""
                        SELECT t.turn_id, t.workspace, t.role, t.content, t.summary, t.tags, t.created_at, f.rank
                        FROM fts_conversation f
                        JOIN conversation_turns t ON f.turn_id = t.turn_id
                        WHERE fts_conversation MATCH ? AND t.workspace = ?
                        ORDER BY f.rank
                        LIMIT ?
                    """, (fts_expr, workspace, limit)).fetchall()
                else:
                    rows = cur.execute("""
                        SELECT t.turn_id, t.workspace, t.role, t.content, t.summary, t.tags, t.created_at, f.rank
                        FROM fts_conversation f
                        JOIN conversation_turns t ON f.turn_id = t.turn_id
                        WHERE fts_conversation MATCH ?
                        ORDER BY f.rank
                        LIMIT ?
                    """, (fts_expr, limit)).fetchall()
                return [dict(r) for r in rows]
            except Exception:
                return []

    def get_file_constraints(
        self,
        file_path: str,
        workspace: Optional[str] = None,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        p = Path(file_path)
        candidates = self.search_conversation_turns(p.stem, workspace=workspace, limit=limit)
        if not candidates and p.name != p.stem:
            candidates = self.search_conversation_turns(p.name, workspace=workspace, limit=limit)
        return candidates

    # --- Incremental Cache & Cleanup ---

    def get_file_hash(self, file_path: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            cur = self.sqlite_conn.cursor()
            row = cur.execute("SELECT * FROM file_cache WHERE file_path = ?", (file_path,)).fetchone()
            if not row:
                return None
            return dict(row)

    def set_file_hash(self, file_path: str, mtime: float, sha256: str):
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self._lock:
            with self.sqlite_conn:
                self.sqlite_conn.execute("""
                    INSERT OR REPLACE INTO file_cache (file_path, mtime, sha256, last_indexed)
                    VALUES (?, ?, ?, ?)
                """, (file_path, mtime, sha256, now))

    def delete_file_data(self, file_path: str):
        with self._lock:
            with self.sqlite_conn:
                self.sqlite_conn.execute("DELETE FROM parent_documents WHERE file_path = ?", (file_path,))
                self.sqlite_conn.execute("DELETE FROM fts_code_symbols WHERE file_path = ?", (file_path,))
                self.sqlite_conn.execute("DELETE FROM file_cache WHERE file_path = ?", (file_path,))
                self.sqlite_conn.execute("DELETE FROM code_symbols WHERE file_path = ?", (file_path,))
                self.sqlite_conn.execute("DELETE FROM code_edges WHERE source_file = ?", (file_path,))
        try:
            self.code_collection.delete(where={"file_path": file_path})
        except Exception:
            pass

    def delete_workspace_namespace(self, workspace: str):
        """Remove all indexed code records under one logical workspace namespace."""
        prefix = f"{workspace.rstrip('/')}/%"
        with self._lock:
            rows = self.sqlite_conn.execute("""
                SELECT file_path FROM parent_documents WHERE file_path LIKE ?
                UNION SELECT file_path FROM file_cache WHERE file_path LIKE ?
                UNION SELECT file_path FROM code_symbols WHERE file_path LIKE ?
                UNION SELECT source_file FROM code_edges WHERE source_file LIKE ?
                UNION SELECT target_file FROM code_edges WHERE target_file LIKE ? AND target_file IS NOT NULL
            """, (prefix, prefix, prefix, prefix, prefix)).fetchall()
        for row in {row[0] for row in rows if row[0]}:
            self.delete_file_data(row)

    # --- Code Property Graph (CPG-Lite) CRUD ---

    def save_code_graph(
        self,
        file_path: str,
        symbols: List[Dict[str, Any]],
        edges: List[Dict[str, Any]],
        workspace: str = ""
    ):
        with self._lock:
            with self.sqlite_conn:
                self.sqlite_conn.execute(
                    "DELETE FROM code_symbols WHERE file_path = ? AND workspace = ?",
                    (file_path, workspace)
                )
                self.sqlite_conn.execute(
                    "DELETE FROM code_edges WHERE source_file = ? AND workspace = ?",
                    (file_path, workspace)
                )
                if symbols:
                    self.sqlite_conn.executemany("""
                        INSERT OR IGNORE INTO code_symbols (file_path, symbol_name, symbol_type, line_start, line_end, workspace)
                        VALUES (:file_path, :symbol_name, :symbol_type, :line_start, :line_end, :workspace)
                    """, symbols)
                if edges:
                    self.sqlite_conn.executemany("""
                        INSERT OR IGNORE INTO code_edges (source_symbol, source_file, target_symbol, target_file, edge_type, workspace)
                        VALUES (:source_symbol, :source_file, :target_symbol, :target_file, :edge_type, :workspace)
                    """, edges)

    def find_callers(
        self,
        symbol_name: str,
        workspace: Optional[str] = None,
        max_depth: int = 2
    ) -> List[Dict[str, Any]]:
        """Find functions, methods, and files that call the specified symbol directly or transitively."""
        ws = workspace.strip().lower().replace("-", "_").replace(" ", "_") if workspace else None
        query = """
        WITH RECURSIVE caller_graph(source_symbol, source_file, target_symbol, target_file, edge_type, depth) AS (
            SELECT source_symbol, source_file, target_symbol, target_file, edge_type, 1
            FROM code_edges
            WHERE (target_symbol = ? OR target_symbol LIKE ?)
              AND (? IS NULL
                   OR instr(REPLACE(REPLACE(lower(workspace), '-', '_'), ' ', '_'), ?) > 0
                   OR instr(?, REPLACE(REPLACE(lower(workspace), '-', '_'), ' ', '_')) > 0)
            UNION
            SELECT e.source_symbol, e.source_file, e.target_symbol, e.target_file, e.edge_type, cg.depth + 1
            FROM code_edges e
            JOIN caller_graph cg ON (
                e.target_symbol = cg.source_symbol
                OR e.target_symbol LIKE '%.' || cg.source_symbol
                OR cg.source_symbol LIKE '%.' || e.target_symbol
                OR (instr(cg.source_symbol, '.') > 0 AND e.target_symbol = substr(cg.source_symbol, instr(cg.source_symbol, '.') + 1))
            )
            WHERE cg.depth < ?
              AND (? IS NULL
                   OR instr(REPLACE(REPLACE(lower(e.workspace), '-', '_'), ' ', '_'), ?) > 0
                   OR instr(?, REPLACE(REPLACE(lower(e.workspace), '-', '_'), ' ', '_')) > 0)
        )
        SELECT DISTINCT source_symbol, source_file, target_symbol, target_file, edge_type, depth
        FROM caller_graph
        ORDER BY depth ASC
        LIMIT 100;
        """
        exact = symbol_name
        like_suffix = f"%.{symbol_name}"
        with self._lock:
            cur = self.sqlite_conn.cursor()
            rows = cur.execute(
                query,
                (exact, like_suffix, ws, ws, ws, max_depth, ws, ws, ws)
            ).fetchall()
            return [dict(r) for r in rows]

    def find_callees(
        self,
        symbol_name: str,
        workspace: Optional[str] = None,
        max_depth: int = 2
    ) -> List[Dict[str, Any]]:
        """Find functions, methods, and modules that the specified symbol calls directly or transitively."""
        ws = workspace.strip().lower().replace("-", "_").replace(" ", "_") if workspace else None
        query = """
        WITH RECURSIVE callee_graph(source_symbol, source_file, target_symbol, target_file, edge_type, depth) AS (
            SELECT source_symbol, source_file, target_symbol, target_file, edge_type, 1
            FROM code_edges
            WHERE (source_symbol = ? OR source_symbol LIKE ? OR source_symbol LIKE ?)
              AND (? IS NULL
                   OR instr(REPLACE(REPLACE(lower(workspace), '-', '_'), ' ', '_'), ?) > 0
                   OR instr(?, REPLACE(REPLACE(lower(workspace), '-', '_'), ' ', '_')) > 0)
            UNION
            SELECT e.source_symbol, e.source_file, e.target_symbol, e.target_file, e.edge_type, cg.depth + 1
            FROM code_edges e
            JOIN callee_graph cg ON (
                e.source_symbol = cg.target_symbol
                OR e.source_symbol LIKE '%.' || cg.target_symbol
                OR cg.target_symbol LIKE '%.' || e.source_symbol
                OR (instr(cg.target_symbol, '.') > 0 AND e.source_symbol = substr(cg.target_symbol, instr(cg.target_symbol, '.') + 1))
            )
            WHERE cg.depth < ?
              AND (? IS NULL
                   OR instr(REPLACE(REPLACE(lower(e.workspace), '-', '_'), ' ', '_'), ?) > 0
                   OR instr(?, REPLACE(REPLACE(lower(e.workspace), '-', '_'), ' ', '_')) > 0)
        )
        SELECT DISTINCT source_symbol, source_file, target_symbol, target_file, edge_type, depth
        FROM callee_graph
        ORDER BY depth ASC
        LIMIT 100;
        """
        exact = symbol_name
        like_prefix = f"{symbol_name}.%"
        like_suffix = f"%.{symbol_name}"
        with self._lock:
            cur = self.sqlite_conn.cursor()
            rows = cur.execute(
                query,
                (exact, like_prefix, like_suffix, ws, ws, ws, max_depth, ws, ws, ws)
            ).fetchall()
            return [dict(r) for r in rows]

    @staticmethod
    def _canonicalize_index_path(file_path: str, workspace: str = "") -> str:
        """Enforce canonical '<ws>/<rel>' form for stored index paths.

        Legacy rows may have bare relative paths ('plan.md') — normalizing on
        write keeps parent_documents / code_symbols / code_edges / file_cache
        consistent so workspace-scoped lookups work. Tolerant to already-canonical
        input (never double-prefixes) and to absolute paths (keeps last 2 segments).
        """
        if not file_path:
            return file_path
        s = file_path.replace("\\", "/")
        # strip leading slashes and '.' segments
        parts = [x for x in s.split("/") if x not in ("", ".")]
        if not parts:
            return file_path
        # already has a workspace prefix (>=2 segments) -> leave as-is
        if len(parts) >= 2:
            return "/".join(parts)
        # absolute-ish path with a real directory? keep last 2 segments
        if "/" in s and len(parts) == 1:
            return parts[-1]
        # bare single segment: prepend workspace when provided
        if workspace and workspace.strip():
            return f"{workspace.strip().strip('/')}/{parts[0]}"
        return parts[0]

    def get_file_symbols(self, file_path: str, workspace: Optional[str] = None) -> List[Dict[str, Any]]:
        ws = workspace.strip().lower().replace("-", "_").replace(" ", "_") if workspace else None
        with self._lock:
            cur = self.sqlite_conn.cursor()
            # BUG-R3: match both canonical ('ws/rel') and legacy bare ('rel') rows.
            canonical = self._canonicalize_index_path(file_path, workspace or "")
            rel_suffix = f"%/{Path(canonical).name}"
            orig = file_path.replace("\\", "/")
            if ws:
                rows = cur.execute(
                    """SELECT file_path, symbol_name, symbol_type, line_start, line_end, workspace
                       FROM code_symbols
                       WHERE (file_path = ? OR file_path = ? OR file_path LIKE ? OR file_path LIKE ?)
                         AND (workspace = ? OR workspace = '' OR workspace IS NULL
                              OR instr(REPLACE(REPLACE(lower(workspace), '-', '_'), ' ', '_'), ?) > 0
                              OR instr(?, REPLACE(REPLACE(lower(workspace), '-', '_'), ' ', '_')) > 0)
                       ORDER BY line_start ASC""",
                    (canonical, orig, f"%/{canonical}", rel_suffix, ws, ws, ws)
                ).fetchall()
            else:
                rows = cur.execute(
                    """SELECT file_path, symbol_name, symbol_type, line_start, line_end, workspace
                       FROM code_symbols
                       WHERE file_path = ? OR file_path = ? OR file_path LIKE ? OR file_path LIKE ?
                       ORDER BY line_start ASC""",
                    (canonical, orig, f"%/{canonical}", rel_suffix)
                ).fetchall()
            return [dict(r) for r in rows]

    def get_symbol_blast_radius(
        self,
        symbol_name: str,
        file_path: Optional[str] = None,
        workspace: Optional[str] = None,
        max_depth: int = 2
    ) -> Dict[str, Any]:
        callers = self.find_callers(symbol_name, workspace=workspace, max_depth=max_depth)
        callees = self.find_callees(symbol_name, workspace=workspace, max_depth=max_depth)

        impacted_files = set()
        for c in callers:
            src_f = c.get("source_file")
            if src_f and (not file_path or src_f != file_path):
                impacted_files.add(src_f)

        return {
            "symbol": symbol_name,
            "file_path": file_path,
            "workspace": workspace or "",
            "callers": callers,
            "callees": callees,
            "impacted_files": sorted(list(impacted_files))
        }

    def close(self):
        with self._lock:
            try:
                self.sqlite_conn.close()
            except Exception:
                pass
