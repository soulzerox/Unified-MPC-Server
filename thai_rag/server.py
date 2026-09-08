import uuid
import datetime
from pathlib import Path
from typing import Optional

try:
    from mcp.server.mcpserver import MCPServer as FastMCP
except ImportError:
    from mcp.server.fastmcp import FastMCP

from thai_rag.config import SQLITE_PATH, CHROMA_PATH, OLLAMA_BASE_URL, EMBEDDING_MODEL
from thai_rag.storage import StorageManager
from thai_rag.ollama_adapter import OllamaEmbeddingAdapter
from thai_rag.code_chunker import CodeChunker
from thai_rag.retriever import HybridRetriever

class LocalContextServer:
    """Core server logic for Local Context & Code RAG."""

    def __init__(
        self,
        sqlite_path: Path = SQLITE_PATH,
        chroma_path: str = CHROMA_PATH,
        ollama_url: str = OLLAMA_BASE_URL,
        model_name: str = EMBEDDING_MODEL
    ):
        self.storage = StorageManager(sqlite_path=sqlite_path, chroma_path=chroma_path)
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

    def remember(self, content: str, category: str = "general") -> str:
        """Record a persistent long-term memory or project rule/decision."""
        if not content.strip():
            return "Error: Memory content cannot be empty."

        err = self._check_ollama()
        if err:
            return err

        mem_id = f"mem_{uuid.uuid4().hex[:12]}"
        try:
            vec = self.embedder.embed_document(content)
            self.storage.save_memory(mem_id, content.strip(), category.strip(), vec)
            return f"✅ Remembered [ID: {mem_id}] (Category: {category}):\n{content.strip()}"
        except Exception as e:
            return f"Error remembering content: {str(e)}"

    def recall(self, query: str, category: Optional[str] = None, limit: int = 5) -> str:
        """Retrieve memories and past context matching a semantic query."""
        if not query.strip():
            return "Error: Query cannot be empty."

        err = self._check_ollama()
        if err:
            return err

        try:
            q_vec = self.embedder.embed_query(query)
            matches = self.storage.search_memories_vector(q_vec, limit=limit, category=category)
            if not matches:
                return f"No memories found matching '{query}'."

            out = [f"### 🧠 Retrieved Memories for '{query}':"]
            for m in matches:
                meta = m.get("metadata", {})
                cat = meta.get("category", "general")
                date = meta.get("created_at", "")[:19]
                dist = round(m.get("distance", 0.0), 3)
                out.append(f"- **[ID: {m['id']}]** (Category: `{cat}`, Date: `{date}`, Dist: `{dist}`):\n  {m['content']}")

            return "\n\n".join(out)
        except Exception as e:
            return f"Error recalling memories: {str(e)}"

    def forget(self, memory_id: str) -> str:
        """Delete an obsolete memory entry by its ID."""
        if not memory_id.strip():
            return "Error: Memory ID cannot be empty."

        deleted = self.storage.delete_memory(memory_id.strip())
        if deleted:
            return f"🗑️ Deleted memory ID: {memory_id}"
        return f"Warning: Memory ID {memory_id} not found."

    # --- Domain B: Code RAG ---

    def code_index(self, workspace_path: str = ".", force: bool = False) -> str:
        """Index all source code files in a workspace with SHA256 incremental caching."""
        err = self._check_ollama()
        if err:
            return err

        try:
            res = self.retriever.index_workspace(workspace_path, force=force)
            return (
                f"📁 **Code Indexing Completed:**\n"
                f"- Indexed: `{res['indexed']} files`\n"
                f"- Skipped (unchanged): `{res['skipped']} files`\n"
                f"- Duration: `{res['duration_s']}s`\n"
                f"- Workspace: `{res['workspace']}`"
            )
        except Exception as e:
            return f"Error indexing workspace: {str(e)}"

    def code_search(self, query: str, top_k: int = 5, path_filter: Optional[str] = None) -> str:
        """Search code symbols and semantic logic across the indexed codebase."""
        if not query.strip():
            return "Error: Search query cannot be empty."

        err = self._check_ollama()
        if err:
            return err

        try:
            results = self.retriever.search(query, top_k=top_k, path_filter=path_filter)
            if not results:
                return f"No code snippets found matching '{query}'."

            out = [f"### 🔎 Code Matches for '{query}':"]
            for idx, r in enumerate(results, 1):
                symbol = f" (`{r['symbol_name']}`)" if r.get('symbol_name') else ""
                out.append(
                    f"#### {idx}. [{r['file_path']}:{r['start_line']}-{r['end_line']}]{symbol} (RRF Score: {r['score']})\n"
                    f"```{Path(r['file_path']).suffix.lstrip('.') or 'text'}\n"
                    f"{r['content']}\n"
                    f"```"
                )
            return "\n\n".join(out)
        except Exception as e:
            return f"Error searching code: {str(e)}"

    def code_context(self, file_path: str, line_number: int, window: int = 25) -> str:
        """Retrieve the enclosing function/class context or surrounding lines for a file."""
        try:
            ctx = self.retriever.get_context(file_path, line_number, window_lines=window)
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
def remember(content: str, category: str = "general") -> str:
    """Record a persistent long-term memory or project rule/decision."""
    return get_server().remember(content, category)

@mcp.tool()
def recall(query: str, category: str = None, limit: int = 5) -> str:
    """Retrieve memories and past context matching a semantic query."""
    return get_server().recall(query, category=category, limit=limit)

@mcp.tool()
def forget(memory_id: str) -> str:
    """Delete an obsolete memory entry by its ID."""
    return get_server().forget(memory_id)

@mcp.tool()
def code_index(workspace_path: str = ".", force: bool = False) -> str:
    """Index all source code files in a workspace with SHA256 incremental caching."""
    return get_server().code_index(workspace_path, force=force)

@mcp.tool()
def code_search(query: str, top_k: int = 5, path_filter: str = None) -> str:
    """Search code symbols and semantic logic across the indexed codebase."""
    return get_server().code_search(query, top_k=top_k, path_filter=path_filter)

@mcp.tool()
def code_context(file_path: str, line_number: int, window: int = 25) -> str:
    """Retrieve the enclosing function/class context or surrounding lines for a file."""
    return get_server().code_context(file_path, line_number, window=window)

if __name__ == "__main__":
    mcp.run(transport="stdio")
