export const GOAL_RUNTIME_SNAPSHOT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_runtime_snapshots (
  goal_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  lifecycle_state TEXT NOT NULL,
  runtime_state TEXT NOT NULL,
  desired_runtime_state TEXT NOT NULL,
  integration_state TEXT NOT NULL,
  workspace_state TEXT NOT NULL,
  active_execution_id TEXT,
  execution_generation INTEGER,
  phase TEXT,
  progress_json TEXT,
  last_activity_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  blocker_kind TEXT,
  blocker_detail TEXT,
  blocker_observed_at TEXT,
  last_event_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  CHECK (contract_version > 0),
  CHECK (last_event_sequence >= 0),
  CHECK (execution_generation IS NULL OR execution_generation > 0),
  CHECK (active_execution_id IS NULL OR execution_generation IS NOT NULL),
  CHECK (
    blocker_kind IS NOT NULL
    OR (blocker_detail IS NULL AND blocker_observed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_goal_runtime_snapshots_workspace_state
  ON goal_runtime_snapshots(workspace_id, lifecycle_state, runtime_state);
CREATE INDEX IF NOT EXISTS idx_goal_runtime_snapshots_workspace_updated
  ON goal_runtime_snapshots(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goal_runtime_snapshots_active_execution
  ON goal_runtime_snapshots(active_execution_id)
  WHERE active_execution_id IS NOT NULL;
`;