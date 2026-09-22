export const GOAL_WORKSPACE_WRITER_LEASE_MIGRATION_SQL = `
ALTER TABLE workspaces ADD COLUMN writer_lease_id TEXT;
ALTER TABLE workspaces ADD COLUMN writer_lease_owner_id TEXT;
ALTER TABLE workspaces ADD COLUMN writer_lease_generation INTEGER;
ALTER TABLE workspaces ADD COLUMN writer_lease_expires_at TEXT;
`;
