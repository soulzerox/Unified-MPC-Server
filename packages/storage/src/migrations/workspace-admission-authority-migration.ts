/**
 * Admission receipt authorization changes must fence strict FD3 sessions even
 * when workspace registration/root identity is unchanged. The existing durable
 * registry epoch is incremented in the SAME SQLite transaction; rollbacks
 * cannot publish revocation. Direct SQL writers and independent WebUI/STDIO
 * processes are covered. No claim of retroactive Python side-effect rollback.
 */
export const WORKSPACE_ADMISSION_AUTHORITY_MIGRATION_SQL = `
CREATE TRIGGER IF NOT EXISTS workspace_admission_authority_insert
AFTER INSERT ON workspace_admission_receipts BEGIN
  UPDATE workspace_authority_epoch SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS workspace_admission_authority_update
AFTER UPDATE ON workspace_admission_receipts BEGIN
  UPDATE workspace_authority_epoch SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS workspace_admission_authority_delete
AFTER DELETE ON workspace_admission_receipts BEGIN
  UPDATE workspace_authority_epoch SET generation = generation + 1 WHERE id = 1;
END;
`;
