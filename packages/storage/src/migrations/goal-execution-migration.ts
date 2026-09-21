export const GOAL_EXECUTION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_executions (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK(lease_generation > 0),
  owner_client_id TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','released','superseded','terminal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE RESTRICT,
  UNIQUE(goal_id, lease_generation)
);

INSERT OR IGNORE INTO goal_executions (
  id, goal_id, workspace_id, lease_generation, owner_client_id, owner_session_id,
  state, created_at, updated_at
)
SELECT
  'legacy-' || id || '-' || lease_generation,
  id,
  workspace_id,
  lease_generation,
  COALESCE(lease_owner_client_id, owner_client_id),
  COALESCE(lease_owner_session_id, 'legacy'),
  CASE
    WHEN status <> 'active' THEN 'terminal'
    WHEN lease_owner_session_id IS NULL THEN 'released'
    ELSE 'active'
  END,
  created_at,
  updated_at
FROM goals
WHERE lease_generation > 0;

CREATE INDEX IF NOT EXISTS idx_goal_executions_goal_generation
  ON goal_executions(goal_id, lease_generation DESC);
CREATE INDEX IF NOT EXISTS idx_goal_executions_workspace_state_updated
  ON goal_executions(workspace_id, state, updated_at DESC);
`;
