export const MERGE_VERIFICATION_RECEIPT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS merge_verification_receipts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_ref TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  pull_request INTEGER NOT NULL CHECK (pull_request > 0),
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  verification_mode TEXT NOT NULL CHECK (
    verification_mode IN ('github_ci', 'local_exact_head', 'hybrid')
  ),
  receipt_json TEXT NOT NULL,
  receipt_created_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_verification_receipts_subject_head_sequence
  ON merge_verification_receipts(repository, pull_request, head_sha, sequence DESC);
`;
