# Exercise 03.01: Conversational Memory & JIT Pre-Edit Verification

Learn how turn-by-turn conversational memory and Just-In-Time (JIT) pre-edit verification protect codebases from architectural drift across IDE sessions.

## Key Concepts
- `remember_turn(role, content, workspace, summary, tags)`: Ingests turns immediately into SQLite FTS5 (`porter unicode61`) and vector storage without waiting for session end.
- `pre_edit_context(file_path, workspace, proposed_symbol)`: Enforces pre-edit checks to retrieve past constraints, architectural decisions, and enclosing code scope before any source file modification.

