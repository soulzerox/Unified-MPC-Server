export const GOAL_WORKSPACE_METADATA_MIGRATION_SQL = `
ALTER TABLE workspaces ADD COLUMN goal_id TEXT;
ALTER TABLE workspaces ADD COLUMN parent_workspace_id TEXT;
ALTER TABLE workspaces ADD COLUMN goal_workspace_kind TEXT;
ALTER TABLE workspaces ADD COLUMN parent_source TEXT;
ALTER TABLE workspaces ADD COLUMN base_revision TEXT;
ALTER TABLE workspaces ADD COLUMN branch_name TEXT;
ALTER TABLE workspaces ADD COLUMN checkpoint_id TEXT;
ALTER TABLE workspaces ADD COLUMN integration_state TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_goal_id
  ON workspaces(goal_id)
  WHERE goal_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workspaces_parent_workspace_id
  ON workspaces(parent_workspace_id)
  WHERE parent_workspace_id IS NOT NULL;
`;
