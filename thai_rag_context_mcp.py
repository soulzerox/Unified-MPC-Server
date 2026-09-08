#!/usr/bin/env python3
"""Entry point for Thai Context & Code RAG MCP Server."""
import sys
from thai_rag.server import mcp

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--help", "-h"):
        print("Usage: thai_rag_context_mcp.py [--index <workspace_path>] [--force]")
        sys.exit(0)
    elif len(sys.argv) > 1 and sys.argv[1] == "--index":
        force = "--force" in sys.argv
        args = [a for a in sys.argv[2:] if a != "--force"]
        path = args[0] if args else "."
        from thai_rag.server import get_server
        res = get_server().code_index(workspace_path=path, force=force)
        print(res)
    else:
        mcp.run(transport="stdio")
