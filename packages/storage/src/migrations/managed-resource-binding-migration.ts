export const MANAGED_RESOURCE_BINDING_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS managed_resource_bindings (
  operation_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  resource_class TEXT NOT NULL CHECK(resource_class IN ('goal_process', 'delegated_agent')),
  cost INTEGER NOT NULL CHECK(cost > 0),
  logical_handle TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('linux', 'darwin')),
  pid INTEGER NOT NULL CHECK(pid > 0),
  process_started_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active', 'termination_unverified', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_managed_resource_bindings_state
  ON managed_resource_bindings(state, updated_at);

CREATE INDEX IF NOT EXISTS idx_managed_resource_bindings_workspace
  ON managed_resource_bindings(workspace_id, state, updated_at);
`;
