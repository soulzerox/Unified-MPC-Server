/**
 * Pinned verified retention receipts live in the SQLite custody ledger,
 * never in the retained bundle itself. Only a first-party verifier may
 * submit an independently rehashed manifest to this storage boundary.
 * A receipt is not Host Approval or writer admission.
 */
export const GOAL_WORKSPACE_RETENTION_CUSTODY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_workspace_retention_custody (
  operation_id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
  old_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  new_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 0),
  admission_generation INTEGER NOT NULL CHECK(admission_generation >= 1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
  pin_json TEXT NOT NULL CHECK(length(pin_json) <= 8192),
  pinned_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pinned' CHECK(status IN ('pinned','consumed','revoked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_workspace_custody_active_goal
  ON goal_workspace_retention_custody(goal_id) WHERE status = 'pinned';
`;
