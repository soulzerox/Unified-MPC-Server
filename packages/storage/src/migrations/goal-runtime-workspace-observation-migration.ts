export const GOAL_RUNTIME_WORKSPACE_OBSERVATION_MIGRATION_SQL = `
ALTER TABLE goal_runtime_events
  ADD COLUMN workspace_state TEXT
  CHECK (
    workspace_state IS NULL
    OR workspace_state IN ('clean','dirty','missing','unavailable','conflict','unknown')
  );
`;
