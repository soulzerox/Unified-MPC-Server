/**
 * Deferred-closure evidence for the workspace journal (issue #170, freshness step).
 *
 * A handle-returning call is journaled opened and its own `completed` row proves
 * nothing about the work, so `(call_id, phase)` alone cannot express "this work
 * ended". These columns let a freshness probe record that it asked the durable
 * task/process stores and found no live handle, without deleting the row that
 * says the work once happened.
 *
 * `closure_code` is the reason and doubles as the idempotency key: the update
 * only touches rows whose `closure_code IS NULL`, so a repeated probe is a no-op
 * and a later one cannot overwrite the first verdict.
 */
export const WORKSPACE_JOURNAL_CLOSURE_MIGRATION_SQL = `
ALTER TABLE workspace_journal_events
  ADD COLUMN closure_code TEXT CHECK (closure_code IS NULL OR length(closure_code) BETWEEN 1 AND 128);
ALTER TABLE workspace_journal_events
  ADD COLUMN closed_at TEXT CHECK (closed_at IS NULL OR length(closed_at) BETWEEN 1 AND 64);
CREATE INDEX IF NOT EXISTS idx_workspace_journal_open_deferred
  ON workspace_journal_events(workspace_id, operation_kind, closure_code);
`;
