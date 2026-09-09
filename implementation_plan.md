# Implementation Plan

[Overview]
Fix two follow-ups from the session-embed audit: (A) category filter exact-match hides untagged turns, (B) code_index blocks ~60s on Ollama embeds for large workspaces.


[Types]
(A) Category mapping: no schema change. Chroma metadata gains derived `category` on every turn via `derive_category_from_tags(tags) -> str`; `search_memories_vector` keeps Python-side filter but treats `general` as wildcard-pass. New type: `KNOWN_CATEGORIES = {"decision","constraint","preference","rule","general"}` (frozenset in `storage.py`).
(B) Background jobs: new `IndexJob { job_id: str, status: Literal["running","done","error"], workspace, total_files, indexed_files, skipped_files, started_at, finished_at, result: dict|None, error: str|None }` held in module-level `_INDEX_JOBS: dict[str, IndexJob]` in `server.py` (in-memory only, single MCP process). New tool return shapes: `code_index(background: bool) -> str` returns `job_id` immediately when background; `index_status(job_id) -> str` renders progress/result.

[Files]
- `/home/qwerty/thai-rag-mcp/thai_rag/storage.py` (modify) — add `KNOWN_CATEGORIES` + `derive_category_from_tags()`; use in `save_conversation_turn` (replace inline loop at lines 429-433); relax `search_memories_vector` filter (lines 379-380) so `general` rows pass any category query.
- `/home/qwerty/thai-rag-mcp/thai_rag/server.py` (modify) — add `threading`-based `_INDEX_JOBS` registry + `code_index(..., background: bool=False)` branch + `index_status(job_id)` method + `@mcp.tool() index_status`; keep sync path byte-identical.
- `/home/qwerty/thai-rag-mcp/tests/test_conversational_memory.py` (modify) — add 2 tests for (A).
- `/home/qwerty/thai-rag-mcp/tests/test_server_e2e.py` (modify, or new `tests/test_background_index.py`) — add 2-3 tests for (B).
- `/home/qwerty/thai-rag-mcp/README.md` (modify) — document derived-category rule + `code_index background` / `index_status` usage.

[Functions]
(A) `derive_category_from_tags(tags: list[str]) -> str` (new, `storage.py`) — normalize each tag (strip+lower); return first hit in `KNOWN_CATEGORIES` minus `general`; else `"general"`. `StorageManager.save_conversation_turn` — replace inline loop with helper. `StorageManager.search_memories_vector` — change filter to `if category and category != "general" and row_category != "general" and row_category != category: continue` (general rows pass; explicit non-general mismatch still excluded).
(B) `LocalContextServer.code_index(workspace_path, force, background=False)` (modify, `server.py`) — background=True: create job_id `idx_<hex8>`, spawn `threading.Thread(daemon=True)` running `retriever.index_workspace` with `ProgressReporter`, return `🚀 Indexing started in background [Job: ...]`; sync path unchanged. `LocalContextServer.index_status(job_id)` (new) — return `⏳ running (indexed_files/skipped_files so far)` or final result/error string; unknown id → `Warning`. `@mcp.tool() index_status` (new) — thin wrapper. `HybridRetriever.index_file/index_workspace`, `OllamaEmbeddingAdapter` — untouched.

[Classes]
No new/modified/removed classes. Touched: `StorageManager` (`storage.py:22` — 2 methods), `LocalContextServer` (`server.py:18` — 1 modified + 1 new method). `HybridRetriever`, `OllamaEmbeddingAdapter`, `CodeChunker` untouched. `_INDEX_JOBS` is a plain module-level dict of dicts (not a class) guarded by a `threading.Lock`.

[Dependencies]
None — stdlib `threading`+`uuid` only. No new packages, no Ollama/embedding changes (batch `/api/embed` path stays as-is). Thread-safety: `StorageManager` already serializes SQLite via `self._lock`; Chroma writes from the single worker thread; SQLite `check_same_thread=False` already set (`storage.py:36`).

[Testing]
- (A) `tests/test_conversational_memory.py`: `test_untagged_turn_passes_category_filter` (remember_turn tags=["session-audit"] → recall(category="decision") must include it); `test_explicit_mismatch_still_excluded` (tags=["preference"] must NOT appear under category="decision").
- (B) new `tests/test_background_index.py` (or extend `test_server_e2e.py`): `test_background_returns_job_id_immediately` (<2s, contains `Job:`); `test_index_status_transitions_to_done` (poll ≤60s → done + counts); `test_index_status_unknown_job` (warning string).
- Gate: full `pytest tests/ -q` green (baseline 62); MCP stdio smoke lists 10 tools (9 + `index_status`); rerun `scripts/embed_session_audit.py --quick` for regression.

[Implementation Order]
1. Inspect transcript sample (first 5 + random 5 lines) to confirm USER_INPUT/PLANNER_RESPONSE schema and Thai ratio.
2. Create `scripts/embed_session_audit.py` (`extract_turns` + `ingest_turns` only); dry-run ingest on temp storage, verify counts.
3. Add `probe_recall` (Thai/English/category/empty); run; record recall bugs.
4. Add `index_workspace("thai_rag")` + `probe_code_search` (none vs relative vs absolute); run; record search bugs.
5. Add `probe_pre_edit` + blast_radius check; run; record pre-edit/CPG bugs.
6. Wrap in `tests/test_embed_session_audit.py`; run pytest file.
7. Run full gate `pytest tests/ -q`; compile EmbedReport with all BUG findings.
8. Present report to user; ask approval before any production fix (STOP — no commits in this phase).
