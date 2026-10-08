/**
 * Retention manifest digest + source/destination owner identity, pinned OUTSIDE
 * the retained filesystem copy. Write only through an authenticated first-party
 * sealing flow; merely recording a SHA is not attestation of on-disk bytes.
 */
export const GOAL_WORKSPACE_RETENTION_EVIDENCE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_workspace_retention_evidence (
  operation_id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
  source_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  destination_workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  expected_admission_generation INTEGER NOT NULL CHECK(expected_admission_generation >= 1),
  lease_generation INTEGER NOT NULL CHECK(lease_generation >= 1),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
  evidence_json TEXT NOT NULL CHECK(length(evidence_json) <= 8192),
  status TEXT NOT NULL CHECK(status IN ('sealed','consumed','revoked')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_goal_retention_active_evidence
  ON goal_workspace_retention_evidence(goal_id) WHERE status = 'sealed';
`;
