/**
 * Durable, single-use authority for one approved Git publish (issue #297).
 *
 * A row is a capability, not a queue entry: it is bound to one workspace, one
 * remote, one branch and one exact commit, minted only by `publish_approve`
 * after an explicit `userConfirmed: true`, and spent exactly once by
 * `git_publish` before the Git child runs (`consumed_at` is the replay barrier).
 *
 * `git push` itself stays denied for every caller that could run a credential
 * helper; this table authorizes only the host-built publish path.
 */
export const PUBLISH_APPROVAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS publish_approvals (
  approval_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  remote TEXT NOT NULL CHECK (length(remote) BETWEEN 1 AND 128),
  branch TEXT NOT NULL CHECK (length(branch) BETWEEN 1 AND 256),
  expected_sha TEXT NOT NULL CHECK (length(expected_sha) IN (40, 64)),
  approved_by TEXT NOT NULL CHECK (length(approved_by) BETWEEN 1 AND 256),
  approved_at INTEGER NOT NULL CHECK (approved_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > approved_at),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= approved_at)
);
CREATE INDEX IF NOT EXISTS idx_publish_approval_binding
  ON publish_approvals(workspace_id, remote, branch, expected_sha, consumed_at);
`;
