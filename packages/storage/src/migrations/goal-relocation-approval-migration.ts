/**
 * A single-use, owner-bound Host Approval capability for Goal Workspace
 * relocation. Written ONLY after the trusted host fence confirmed the exact
 * Goal owner identity, operation, and source/destination workspace pair.
 *
 * This is NOT writer admission and NOT permission to mutate files. The Goal
 * Workspace transfer CAS must revalidate live owner/lease/admission state and
 * consume the capability exactly once; a replay, an expired capability, or a
 * capability bound to a stale admission generation/lease fails closed.
 */
export const GOAL_RELOCATION_APPROVAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS goal_relocation_approvals (
  approval_id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('attest_custody','relocate_goal')),
  from_workspace_id TEXT NOT NULL,
  to_workspace_id TEXT NOT NULL,
  owner_client_id TEXT NOT NULL,
  owner_session_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  admission_generation INTEGER,
  lease_generation INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goal_relocation_approval_goal
  ON goal_relocation_approvals(goal_id, operation_id, action);
`;