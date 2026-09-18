#!/usr/bin/env python3
"""Compatibility wrapper for the installed `thai-rag-mcp` command."""
from thai_rag.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
