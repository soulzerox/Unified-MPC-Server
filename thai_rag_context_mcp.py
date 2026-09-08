#!/usr/bin/env python3
"""Entry point for Thai Context & Code RAG MCP Server."""
import sys
from thai_rag.server import mcp

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--index":
        path = sys.argv[2] if len(sys.argv) > 2 else "."
        from thai_rag.server import get_server
        res = get_server().code_index(workspace_path=path)
        print(res)
    else:
        mcp.run(transport="stdio")
