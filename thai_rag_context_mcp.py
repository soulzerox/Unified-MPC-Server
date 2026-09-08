#!/usr/bin/env python3
"""Entry point for Thai Context & Code RAG MCP Server."""
import sys
from thai_rag.server import mcp

if __name__ == "__main__":
    mcp.run(transport="stdio")
