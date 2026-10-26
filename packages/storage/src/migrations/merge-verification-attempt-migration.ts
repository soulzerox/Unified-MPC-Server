export const MERGE_VERIFICATION_ATTEMPT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS merge_verification_attempts (
  attempt_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pull_request INTEGER NOT NULL CHECK (pull_request > 0),
  head_sha TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  gate_name TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  finished_at TEXT,
  detail TEXT,
  receipt_ref TEXT,
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_merge_verification_attempts_subject_head
  ON merge_verification_attempts(repository, pull_request, head_sha, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_merge_verification_attempts_live
  ON merge_verification_attempts(status, heartbeat_at);

-- One live verification per exact head. Stale rows are reaped before a new attempt begins,
-- so this only rejects a genuinely concurrent duplicate run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_verification_attempts_single_live
  ON merge_verification_attempts(repository, pull_request, head_sha)
  WHERE status = 'running';
`;
