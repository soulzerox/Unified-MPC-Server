export const MERGE_RECONCILIATION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS merge_reconciliation_records (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_ref TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  pull_request INTEGER NOT NULL CHECK (pull_request > 0),
  head_sha TEXT NOT NULL,
  merge_sha TEXT,
  receipt_ref TEXT,
  expected_merge_method TEXT NOT NULL CHECK (
    expected_merge_method IN ('merge', 'squash', 'rebase')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('RECONCILED', 'POLICY_BREACH', 'INSPECT_REQUIRED')
  ),
  reason TEXT NOT NULL,
  record_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merge_reconciliation_subject_sequence
  ON merge_reconciliation_records(repository, pull_request, sequence DESC);

CREATE INDEX IF NOT EXISTS idx_merge_reconciliation_merge_sha
  ON merge_reconciliation_records(repository, merge_sha)
  WHERE merge_sha IS NOT NULL;
`;
