/**
 * Widen the deferred-handle provider set to include `codex` (#170, freshness step).
 *
 * `codex_run` returns a `codexTaskId` whose authority is `CodexService`, not the
 * process store: a codex process lives in a different `ProcessManager` instance, so
 * the process listing can never see it. Recording the id under `process` would read
 * "absent from the listing" as gone for a task that is still running, which is the
 * one direction the closure design forbids, so the provider has to be its own name
 * — and SQLite cannot widen a CHECK constraint in place, so the table is rebuilt
 * once. The rows are copied verbatim: nothing about an existing handle changes.
 *
 * The DDL keeps the same closed set as `DEFERRED_HANDLE_PROVIDERS`; the app-side
 * check and the CHECK are the same list in two places, and a row written by a
 * writer that skipped the repository still cannot name a provider no adapter asks.
 */
export const DEFERRED_HANDLE_PROVIDER_MIGRATION_SQL = `
CREATE TABLE deferred_handles_next (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL CHECK (length(call_id) BETWEEN 1 AND 256),
  provider TEXT NOT NULL CHECK (provider IN ('process', 'task', 'swarm', 'worktree', 'verification', 'codex')),
  handle_id TEXT NOT NULL CHECK (length(handle_id) BETWEEN 1 AND 256),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 1 AND 64),
  PRIMARY KEY (workspace_id, call_id)
);

INSERT INTO deferred_handles_next (workspace_id, call_id, provider, handle_id, recorded_at)
SELECT workspace_id, call_id, provider, handle_id, recorded_at
FROM deferred_handles;

DROP TABLE deferred_handles;

ALTER TABLE deferred_handles_next RENAME TO deferred_handles;
`;
