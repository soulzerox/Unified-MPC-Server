export const GOAL_RUNTIME_INTEGRATION_OBSERVATION_MIGRATION_SQL = `
ALTER TABLE goal_runtime_events
  ADD COLUMN integration_state TEXT
  CHECK (
    integration_state IS NULL
    OR integration_state IN ('pending','integrated','conflict','unknown')
  );
`;
