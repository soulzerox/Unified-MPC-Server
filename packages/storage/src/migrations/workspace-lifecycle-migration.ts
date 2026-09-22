export const WORKSPACE_LIFECYCLE_MIGRATION_SQL = `
ALTER TABLE workspaces ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'project';
ALTER TABLE workspaces ADD COLUMN owner_session_id TEXT;
ALTER TABLE workspaces ADD COLUMN owner_job_id TEXT;
ALTER TABLE workspaces ADD COLUMN auto_cleanup INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN expires_at TEXT;
ALTER TABLE workspaces ADD COLUMN unavailable_since TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_lifecycle_kind ON workspaces(workspace_kind, archived_at);
CREATE INDEX IF NOT EXISTS idx_workspaces_lifecycle_expiry ON workspaces(expires_at) WHERE archived_at IS NULL;
`;
