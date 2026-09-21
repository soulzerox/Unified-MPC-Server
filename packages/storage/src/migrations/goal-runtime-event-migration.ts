export const GOAL_RUNTIME_EVENT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_runtime_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  execution_id TEXT,
  execution_generation INTEGER,
  occurred_at TEXT NOT NULL,
  detail TEXT,
  phase TEXT,
  task_id TEXT,
  checkpoint_id TEXT,
  blocker_kind TEXT,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  CHECK (
    (execution_id IS NULL AND execution_generation IS NULL)
    OR
    (execution_id IS NOT NULL AND execution_generation IS NOT NULL AND execution_generation > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_goal_runtime_events_workspace_sequence
  ON goal_runtime_events(workspace_id, sequence);
CREATE INDEX IF NOT EXISTS idx_goal_runtime_events_goal_sequence
  ON goal_runtime_events(goal_id, sequence);
CREATE INDEX IF NOT EXISTS idx_goal_runtime_events_execution_sequence
  ON goal_runtime_events(execution_id, sequence)
  WHERE execution_id IS NOT NULL;
`;
