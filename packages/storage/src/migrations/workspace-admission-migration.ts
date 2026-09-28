export const WORKSPACE_ADMISSION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspace_admission_receipts (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  admission_generation INTEGER NOT NULL CHECK (admission_generation > 0),
  write_lease_generation INTEGER NOT NULL CHECK (write_lease_generation > 0),
  receipt_json TEXT NOT NULL CHECK (length(receipt_json) <= 16384),
  updated_at TEXT NOT NULL
);
`;
