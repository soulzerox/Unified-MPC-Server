# Implementation Plan

[Overview]
Test the real-world usability of thai-rag-mcp by embedding the current live Antigravity session transcript into an isolated RAG instance and probing recall/search/pre_edit for remaining bugs.
The transcript (3494 lines, Thai/English mixed coding dialogue) is an ideal stress case for FTS5 Thai tokenization, vector recall, and CPG indexing. Approach: extract USER_INPUT + PLANNER_RESPONSE turns, ingest via `LocalContextServer.remember_turn` on temp SQLite+Chroma storage (never touching real `~/.cache/thai-rag-mcp`), then run recall, code_search, code_index + blast_radius, and pre_edit_context probes; record every failure as a bug with file/line evidence before fixing anything.

[Types]
No production type changes in this phase (test-only). Test harness data shapes:
- `SessionTurn { role, content (max 2000 chars), summary (first 150 chars), step_index, created_at }` — from transcript JSONL fields.
- `EmbedReport { total_turns, ingested_ok, ingest_failures, recall_cases, search_cases, pre_edit_case, bugs_found }` — printed as JSON + summary, not persisted.

[Files]
New files (under `/home/qwerty/thai-rag-mcp/`):
- `scripts/embed_session_audit.py` (new, ~180 lines) — standalone audit harness; extract transcript to temp `LocalContextServer`, run ingest + probes, print JSON report. Extends `scripts/e2e_stress_session_test.py::extract_session_dialogue` with bug-hunting probes (category recall, absolute path_filter, empty-query guards, FTS duplicate check).
- `tests/test_embed_session_audit.py` (new, ~120 lines) — pytest wrapper; vector parts skip if Ollama down, FTS parts always run.
Existing files: read-only in plan phase (`server.py`, `storage.py`, `retriever.py`, `ollama_adapter.py`, `config.py`, existing e2e scripts). No edits, no deletions, no config changes (temp dirs via `tempfile.TemporaryDirectory`).

[Functions]
New functions in `scripts/embed_session_audit.py`:
- `extract_turns(transcript_path, max_chars=2000) -> list` — parse JSONL, keep USER_INPUT + PLANNER_RESPONSE (len>30), truncate, skip malformed lines.
- `ingest_turns(server, turns, workspace="thai-rag-mcp") -> (ok_count, failures)` — loop `server.remember_turn(...)` with tags `["session-audit","embed-test"]`; measure turns/sec.
- `probe_recall(server, cases) -> list[dict]` — `server.recall(query, category, limit=5)` for Thai, English, category-filtered (`decision`), and empty query; record hits + expected-keyword presence.
- `probe_code_search(server, cases) -> list[dict]` — after `index_workspace("thai_rag")`: no filter vs relative (`thai_rag`) vs absolute path; record hits (BUG-10 parity check).
- `probe_pre_edit(server) -> dict` — `server.pre_edit_context(file_path=<abs storage.py>, workspace="thai-rag-mcp", proposed_symbol="save_conversation_turn")`; record can_proceed, constraints, callers.
- `main() -> int` — wire everything on temp storage, print JSON report, nonzero on failure.
Modified/removed functions: none in plan phase (fix candidates noted only: `StorageManager.search_memories_vector`, `server.py::recall`, `retriever.py::search`).

[Classes]
New/modified/removed classes: none (harness uses functions + existing `LocalContextServer`).
Classes under test (read-only): `LocalContextServer` (`server.py:18`), `StorageManager` (`storage.py:22`), `HybridRetriever` (`retriever.py:78`), `OllamaEmbeddingAdapter` (`ollama_adapter.py:7`), `CodeChunker` (`code_chunker.py:29`).

[Dependencies]
No new packages, no version changes (chromadb 1.5.9, mcp 2.2.0, pythainlp 5.3.7, requests, pytest — all in `venv`). Requires `ollama serve` + model `nomic-embed-text-v2-moe:latest` for vector probes; harness must call `embedder.is_alive()` first and skip vector asserts gracefully (earlier `curl /api/tags` timed out in this shell — never hang). No network beyond localhost:11434.

[Testing]
New: `tests/test_embed_session_audit.py` — 4 tests (`test_ingest_all_turns_succeed`, `test_recall_thai_and_category`, `test_code_search_abs_vs_relative_parity`, `test_pre_edit_returns_constraints_and_callers`) asserting on the temp-server report, never on real cache.
Existing tests: untouched (`test_conversational_memory.py`, `test_retriever.py`, `test_session_e2e_stress.py`).
Validation: (1) `venv/bin/python scripts/embed_session_audit.py` → inspect JSON; (2) `pytest tests/test_embed_session_audit.py -q`; (3) gate `pytest tests/ -q` stays green; (4) optional MCP stdio smoke (`initialize` + `tools/list` → 9 tools). Every probe failure logged as BUG-<n> with repro + file:line — fixes out of scope until user approves.

[Implementation Order]
1. Inspect transcript sample (first 5 + random 5 lines) to confirm USER_INPUT/PLANNER_RESPONSE schema and Thai ratio.
2. Create `scripts/embed_session_audit.py` (`extract_turns` + `ingest_turns` only); dry-run ingest on temp storage, verify counts.
3. Add `probe_recall` (Thai/English/category/empty); run; record recall bugs.
4. Add `index_workspace("thai_rag")` + `probe_code_search` (none vs relative vs absolute); run; record search bugs.
5. Add `probe_pre_edit` + blast_radius check; run; record pre-edit/CPG bugs.
6. Wrap in `tests/test_embed_session_audit.py`; run pytest file.
7. Run full gate `pytest tests/ -q`; compile EmbedReport with all BUG findings.
8. Present report to user; ask approval before any production fix (STOP — no commits in this phase).
