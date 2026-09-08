import sqlite3
import datetime
import threading
from pathlib import Path
from typing import Dict, Any, List, Optional
import chromadb
from chromadb.config import Settings
from thai_rag.config import SQLITE_PATH, CHROMA_PATH

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
        where = None
        if path_filter:
            where = {"file_path": {"$contains": path_filter}}
        
        results = self.code_collection.query(
            query_embeddings=[query_vector],
            n_results=top_k,
            where=where
        )
        items = []
        if results and results["ids"] and len(results["ids"][0]) > 0:
            for i in range(len(results["ids"][0])):
                items.append({
                    "id": results["ids"][0][i],
                    "document": results["documents"][0][i] if results["documents"] else "",
                    "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                    "distance": results["distances"][0][i] if results.get("distances") else 0.0
                })
        return items

    def search_code_fts(self, query: str, top_k: int = 10) -> List[Dict[str, Any]]:
        clean_query = "".join(c for c in query if c.isalnum() or c in (" ", "_")).strip()
        if not clean_query:
            return []
        
        words = [w for w in clean_query.split() if len(w) > 1]
        if not words:
            words = [clean_query]
        fts_expr = " OR ".join(f"{w}*" for w in words)

        with self._lock:
            cur = self.sqlite_conn.cursor()
            try:
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
        where = None
        if category:
            where = {"category": category}
        
        results = self.memory_collection.query(
            query_embeddings=[query_vector],
            n_results=limit,
            where=where
        )
        items = []
        if results and results["ids"] and len(results["ids"][0]) > 0:
            for i in range(len(results["ids"][0])):
                items.append({
                    "id": results["ids"][0][i],
                    "content": results["documents"][0][i] if results["documents"] else "",
                    "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                    "distance": results["distances"][0][i] if results.get("distances") else 0.0
                })
        return items

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
        try:
            self.code_collection.delete(where={"file_path": file_path})
        except Exception:
            pass

    def close(self):
        with self._lock:
            try:
                self.sqlite_conn.close()
            except Exception:
                pass
