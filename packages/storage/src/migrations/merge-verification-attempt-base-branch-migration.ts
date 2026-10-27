export const MERGE_VERIFICATION_ATTEMPT_BASE_BRANCH_MIGRATION_SQL = `
ALTER TABLE merge_verification_attempts ADD COLUMN base_branch TEXT;
`;
