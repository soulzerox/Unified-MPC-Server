/**
 * Durable, workspace-scoped operational journal (issue #170, first slice).
 *
 * This table is an index of recovery-relevant operations, not a second truth
 * system: the authoritative state stays in the task runtime, the goal runtime
 * and the audit log. A row records that an operation touched a workspace, in a
 * durable sequence, so a later session can find it without replaying chat.
 *
 * `status = 'started'` is the only status that pins a Goal Workspace: an open
 * operation that never reported a terminal outcome still owns work inside that
 * worktree. Terminal rows are references, not custody, so they do not block
 * cleanup. `call_id`/`phase` are unique so a retried write cannot duplicate a
 * row, and `(call_id, phase)` is what pairs an open row with its completion.
 */
export const WORKSPACE_JOURNAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspace_journal_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT,
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 64),
  tool_name TEXT CHECK (tool_name IS NULL OR length(tool_name) BETWEEN 1 AND 128),
  call_id TEXT CHECK (call_id IS NULL OR length(call_id) BETWEEN 1 AND 256),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'completed')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'cancelled', 'interrupted')),
  result_code TEXT CHECK (result_code IS NULL OR length(result_code) BETWEEN 1 AND 128),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
  trace_id TEXT CHECK (trace_id IS NULL OR length(trace_id) BETWEEN 1 AND 512),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 1 AND 64),
  UNIQUE (workspace_id, call_id, phase)
);
CREATE INDEX IF NOT EXISTS idx_workspace_journal_workspace
  ON workspace_journal_events(workspace_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_journal_open
  ON workspace_journal_events(workspace_id, status, sequence DESC);
`;
