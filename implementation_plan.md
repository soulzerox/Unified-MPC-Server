# Implementation Plan: Round-2 Bug Audit — Resilience, Path Canonicalization, Workspace Scoping

**STATUS: ✅ COMPLETE** (2026-09-09)

## Overview

Round-2 audit of thai-rag-mcp using ask-matt / diagnosing-bugs / improve-codebase-architecture / performance / tdd / triage / smoke / stress skills, running regression + stress tests against the production DB. Fix three production-grade issues found: (R1) `code_search` hard-gates on Ollama despite a working FTS-only fallback, (R2) parent_documents.file_path mixes bare and workspace-prefixed formats breaking path/workspace lookups, and (R3) `get_file_symbols`/`get_context`/blast-radius workspace scoping mismatches caused by R2. One-off backfill normalizes existing prod bare paths. Regression tests lock in all three.

Baseline: 72 tests pass. Prod DB at `/home/qwerty/.cache/thai-rag-mcp/local_context.db` (4992 code_symbols, 28374 code_edges, 1738 turns, 6159 parent docs) verified with mixed `file_path` formats present.

## Types

No type-system changes. Two data-shape invariants established:

1. **Canonical indexed file_path** (write-side): every row in `parent_documents`, `child vectors metadata`, `code_symbols`, `code_edges`, `file_cache` stores `file_path` as **`<workspace_name>/<rel/path>`** — e.g. `thai-rag-mcp/thai_rag/server.py`. Bare paths (`plan.md`) are legacy/orphaned and get migrated by backfill. New `StorageManager._canonicalize_index_path(path)` helper enforces it:
   - strips leading `/` and `.` segments,
   - if exactly one non-file segment and it's not a known workspace, leaves as-is (guard against mangling),
   - returns `ws_name/rel` when a workspace name is prependable, else the stripped path unchanged (old-format tolerance).

2. **Lookup-side tolerance**: reads (`get_file_symbols`, `get_context`, `search_code_fts`, `search`, `code_blast_radius`) MUST match `file_path` against both stored formats (bare suffix match `%/<rel>` OR exact canonical) so legacy rows stay reachable until backfill.

## Files

### Modify — `thai_rag/server.py`
- `code_search()`: remove `_check_ollama()` gate (lines 268-270). Let `retriever.search()` degrade naturally: vector branch already try/excepts → `vec_matches=[]` → RRF returns FTS-only results. Add a `⚠️ semantic ranking degraded (Ollama unreachable) — FTS5 results only` suffix to the output when `self.embedder.is_alive()` is False.
- `pre_edit_context()`: pass `workspace` through a new tolerant lookup (see storage changes); no behavior change otherwise.

### Modify — `thai_rag/retriever.py`
- `index_file()`: accept optional `workspace: str = ""`. Normalize `file_path` via `storage._canonicalize_index_path()` before chunking/saving so direct `index_file("plan.md", ...)` callers also store canonical form. Derive `ws_name` from the canonical path (first segment), not the raw input.
- `search()` / `get_context()`: delegate path normalization to the new storage tolerance helpers instead of raw substring logic where feasible.

### Modify — `thai_rag/storage.py`
- New `_canonicalize_index_path(file_path)` static helper (see Types).
- `get_file_symbols()`: replace exact `file_path = ? OR file_path LIKE '%/{name}'` with tolerant matching that also matches canonical-vs-bare combinations; when workspace given, match the workspace column OR rows whose `file_path` prefix equals the requested workspace.
- `get_context()` fallback SQL: keep, but make the `LIKE` triple-match consistent with canonical paths (already mostly correct — verify against both formats).
- `_normalize_abs_to_rel()`: extend to return the canonical relative segment robustly for basename-only inputs (currently returns last 2 segments; keep, verify it handles `ws/rel/x`).

### New — `scripts/normalize_bare_paths.py`
One-off migration: scan `parent_documents`, `file_cache`, `code_symbols`, `code_edges`, and Chroma metadata; find rows whose `file_path` lacks a leading workspace prefix; attempt assignment to a workspace by matching the file's relative tail against known `file_cache`/`code_symbols` rows, or by `resolve_file()` from backfill paths; rewrite both SQLite and Chroma `where={"file_path": ...}` entries. Idempotent, prints before/after counts, no re-embedding.

### Modify — `tests/test_bug_audit.py` (append round-2 regression tests)
See Testing.

## Functions

### New
| Function | File | Purpose |
|---|---|---|
| `_canonicalize_index_path(file_path: str) -> str` (staticmethod) | `thai_rag/storage.py` | Enforce `<ws>/<rel>` canonical form; strip junk segments; tolerant to legacy input. |
| `normalize_bare_paths(storage) -> dict` | `scripts/normalize_bare_paths.py` | One-off prod migration of bare `file_path` rows to canonical form; returns `{"migrated": n, "unresolvable": n}`. |

### Modified
| Function | File | Change |
|---|---|---|
| `code_search(query, top_k, path_filter)` | `thai_rag/server.py` | Remove Ollama gate; degrade to FTS-only with ⚠️ suffix. |
| `index_file(file_path, content)` → `index_file(file_path, content, workspace="")` | `thai_rag/retriever.py` | Canonicalize path on write; derive ws from canonical. |
| `get_file_symbols(file_path, workspace)` | `thai_rag/storage.py` | Tolerant path + workspace matching (both formats). |
| `index_workspace(...)` | `thai_rag/retriever.py` | Pass `workspace=ws_name` into `index_file` (already prefixes path at call site — verify no double prefix). |

### Removed
None.

## Classes

No class changes. `StorageManager` gains the static helper; `LocalContextServer`/`HybridRetriever` signatures unchanged externally (new optional params).

## Dependencies

No new dependencies. Existing: sqlite3 (stdlib), chromadb, pythainlp, FastMCP. Backfill uses only storage + existing CPG APIs.

## Testing

New regression tests appended to `tests/test_bug_audit.py` (round-2 section):

1. **R1 — code_search degrades to FTS-only without Ollama** (`test_code_search_fts_only_when_ollama_down`): point `embedder.is_alive()` → False via mock; index a file; `server.code_search("def")` returns matches (not the Ollama error) and output contains the degraded suffix.
2. **R2 — canonical path on write** (`test_index_file_canonicalizes_bare_path`): call `retriever.index_file("plan.md", content, workspace="ws1")`; assert `parent_documents.file_path` == `ws1/plan.md`.
3. **R2 — lookup tolerates legacy bare paths** (`test_get_file_symbols_matches_bare_and_canonical`): seed one bare row + one canonical row for the same file; both resolvable via `get_file_symbols` with matching workspace.
4. **R3 — workspace-scoped blast radius filters cleanly** (`test_blast_radius_workspace_scoping`): two workspaces sharing a symbol name; `get_symbol_blast_radius(sym, workspace="ws1")` returns only ws1 callers.
5. **R2 — bare-path backfill idempotence** (`test_normalize_bare_paths_idempotent`): run migration on a temp DB with mixed rows; second run migrates 0.

Validation pipeline (each step must pass before the next):
1. `venv/bin/python -m pytest tests/ -q` → full suite (baseline 72 + ~5 new) green.
2. `venv/bin/python scripts/smoke_test.py` → smoke green (Ollama up).
3. `scripts/e2e_stress_session_test.py` → stress/smoke green (temp-isolated).
4. Prod backfill: `venv/bin/python scripts/normalize_bare_paths.py` on real prod DB → row counts verified (bare count → 0), no re-embed.
5. Prod spot-check via probe: `code_search` with `path_filter` on a formerly-bare file; `get_file_symbols` on that file; `code_blast_radius` scoped — real output verified.

## Implementation Order

1. Add `_canonicalize_index_path` + tolerant `get_file_symbols` in `storage.py`.
2. `retriever.py`: `index_file` workspace param + canonicalization; keep `index_workspace` path building unchanged (verify no double-prefix with a quick test).
3. `server.py`: remove Ollama gate in `code_search`, add degraded suffix (R1).
4. Write 5 regression tests → run → red for new behavior.
5. Implement fixes → run → green; full suite.
6. Write + run `scripts/normalize_bare_paths.py` against temp fixture DB.
7. Smoke + e2e stress scripts (temp-isolated).
8. Run `normalize_bare_paths.py` on prod DB (backfill), verify counts, spot-check `code_search`/`get_file_symbols`/blast radius on formerly-bare files against prod.
9. Commit + push; update `implementation_plan.md` STATUS to COMPLETE.