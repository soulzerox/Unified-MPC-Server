/**
 * Durable queued verification attempts (#305).
 *
 * A denied heavy admission must not evaporate: the request is persisted as a
 * `queued` attempt bound to the exact head, and the next `merge_verification_run`
 * for that head claims the same row instead of spawning a duplicate. SQLite
 * cannot widen a CHECK constraint in place, so the table is rebuilt once.
 *
 * The single-live partial unique index now covers `queued` as well as `running`:
 * one live-or-queued verification per exact head, still any number of terminal rows.
 */
export const MERGE_VERIFICATION_ATTEMPT_QUEUE_MIGRATION_SQL = `
CREATE TABLE merge_verification_attempts_next (
  attempt_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pull_request INTEGER NOT NULL CHECK (pull_request > 0),
  head_sha TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
  gate_name TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  finished_at TEXT,
  detail TEXT,
  receipt_ref TEXT,
  base_branch TEXT,
  CHECK (
    (status IN ('queued', 'running') AND finished_at IS NULL)
    OR (status NOT IN ('queued', 'running') AND finished_at IS NOT NULL)
  )
);

INSERT INTO merge_verification_attempts_next (
  attempt_id,
  repository,
  pull_request,
  head_sha,
  workspace_id,
  status,
  gate_name,
  started_at,
  heartbeat_at,
  finished_at,
  detail,
  receipt_ref,
  base_branch
)
SELECT
  attempt_id,
  repository,
  pull_request,
  head_sha,
  workspace_id,
  status,
  gate_name,
  started_at,
  heartbeat_at,
  finished_at,
  detail,
  receipt_ref,
  base_branch
FROM merge_verification_attempts;

DROP TABLE merge_verification_attempts;

ALTER TABLE merge_verification_attempts_next RENAME TO merge_verification_attempts;

CREATE INDEX IF NOT EXISTS idx_merge_verification_attempts_subject_head
  ON merge_verification_attempts(repository, pull_request, head_sha, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_merge_verification_attempts_live
  ON merge_verification_attempts(status, heartbeat_at);

-- One live-or-queued verification per exact head. Stale running rows are reaped
-- before a new attempt begins, so this only rejects a genuinely concurrent run or
-- an already-queued request for the same head.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merge_verification_attempts_single_live
  ON merge_verification_attempts(repository, pull_request, head_sha)
  WHERE status IN ('queued', 'running');
`;
