/**
 * Where a deferred call's handle lives (issue #170, freshness step).
 *
 * `workspace_journal_events` records that a call happened; it deliberately does
 * not record what the call produced. A handle id is a fact about another
 * authority — the process store, the MCP task store, the swarm store, the
 * worktree ledger — and it must be forgotten the moment that authority settles
 * it, so storing it on an append-only event row would leave rows nobody owns.
 *
 * `provider` is the closed set of authorities a freshness probe can ask, spelled
 * out in the DDL as well as in `DEFERRED_HANDLE_PROVIDERS`: the app-side check
 * guards the writer, and the CHECK guards the database against a writer that
 * skipped it. A row whose provider no adapter answers keeps the call pinned,
 * which is the safe direction — the journal cannot see a running task on its own.
 *
 * No index on `call_id` alone: every lookup filters `workspace_id` too, so the
 * primary key's prefix already serves it.
 */
export const DEFERRED_HANDLE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS deferred_handles (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 256),
  provider TEXT NOT NULL CHECK (provider IN ('process', 'task', 'swarm', 'worktree', 'verification')),
  handle_id TEXT NOT NULL CHECK (length(handle_id) BETWEEN 1 AND 256),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 1 AND 64),
  PRIMARY KEY (workspace_id, call_id)
);
`;
