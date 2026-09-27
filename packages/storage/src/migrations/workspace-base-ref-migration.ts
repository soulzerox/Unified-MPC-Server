export const WORKSPACE_BASE_REF_MIGRATION_SQL = `
ALTER TABLE workspaces ADD COLUMN base_ref TEXT;
`;
