/**
 * Host-owned credential lease ledger for an approved publish (issue #297).
 *
 * A row names one remote, the resolved HTTPS host set, the operator username
 * and a short expiry. The secret never lives here: it stays in the
 * `SecretStore` under `publish-<lease_id>`. `revoked_at` is a tombstone, not a
 * deletion barrier, and expired rows are pruned by the lifecycle sweep.
 */
export const PUBLISH_CREDENTIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS publish_credential_leases (
  lease_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  remote TEXT NOT NULL CHECK(length(remote) BETWEEN 1 AND 128),
  hosts TEXT NOT NULL,
  username TEXT NOT NULL CHECK(length(username) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_publish_credential_lease_expiry
  ON publish_credential_leases(workspace_id, expires_at);
`;
