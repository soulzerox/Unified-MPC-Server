/**
 * Durable heavy-job queue state (#145 U5).
 *
 * The #13 admission controller remains the final admission authority; this
 * table only persists the bounded waiter queue that survives an owner process
 * restart. One row per exact operation identity keeps the queue bounded by
 * distinct inputs rather than by retry count.
 */
export const HEAVY_JOB_QUEUE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS heavy_jobs (
  operation_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT,
  job_kind TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost > 0),
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'superseded')),
  position INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  owner_id TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT NOT NULL,
  finished_at TEXT,
  detail TEXT,
  CHECK (
    (state IN ('queued', 'running') AND finished_at IS NULL)
    OR (state NOT IN ('queued', 'running') AND finished_at IS NOT NULL)
  ),
  CHECK (state <> 'running' OR started_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_heavy_jobs_queued_order
  ON heavy_jobs(position)
  WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS idx_heavy_jobs_live_owner
  ON heavy_jobs(owner_id, heartbeat_at)
  WHERE state IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_heavy_jobs_queued_age
  ON heavy_jobs(requested_at)
  WHERE state = 'queued';
`;
