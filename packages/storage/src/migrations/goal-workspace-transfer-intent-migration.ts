/**
 * A durable *prepared intent*, not write admission or permission to mutate.
 * The initiating first-party service independently verifies the preserved
 * bundle and replacement Git tree before requesting this bounded CAS.
 */
export const GOAL_WORKSPACE_TRANSFER_INTENT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_workspace_transfer_intents (
  operation_id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
  old_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  new_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  expected_goal_revision INTEGER NOT NULL CHECK(expected_goal_revision >= 0),
  expected_admission_generation INTEGER NOT NULL CHECK(expected_admission_generation >= 1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
  retained_manifest_sha256 TEXT NOT NULL CHECK(length(retained_manifest_sha256) = 64),
  request_json TEXT NOT NULL CHECK(length(request_json) <= 8192),
  status TEXT NOT NULL CHECK(status IN ('prepared','completed','cancelled')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_workspace_transfer_active_goal
  ON goal_workspace_transfer_intents(goal_id) WHERE status = 'prepared';
`;
