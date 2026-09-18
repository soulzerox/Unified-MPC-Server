"""Installed command-line entry point for Thai RAG MCP.

Keep argument parsing free of server imports so --help/--version do not create
the default cache directory or require optional runtime services.
"""
from __future__ import annotations

import argparse
from importlib import metadata
from typing import Sequence


def _version() -> str:
    try:
        return metadata.version("thai-rag-mcp")
    except metadata.PackageNotFoundError:
        return "0.1.0"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="thai-rag-mcp",
        description="Run the standalone Thai RAG MCP server or index a workspace.",
    )
    parser.add_argument(
        "--index",
        metavar="WORKSPACE_PATH",
        help="Index one workspace and exit instead of starting the stdio MCP server.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-indexing; valid only together with --index.",
    )
    parser.add_argument(
        "--stdio",
        action="store_true",
        help="Explicitly select the standalone stdio MCP transport (the default mode).",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {_version()}")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.force and not args.index:
        parser.error("--force requires --index")
    if args.index and args.stdio:
        parser.error("--index and --stdio are mutually exclusive")

    if args.index:
        from thai_rag.server import get_server

        result = get_server().code_index(workspace_path=args.index, force=args.force)
        print(result)
        return 0

    from thai_rag.server import mcp

    mcp.run(transport="stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
