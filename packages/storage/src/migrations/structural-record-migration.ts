export const STRUCTURAL_RECORD_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS structural_record_generations (
  generation_id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree_oid TEXT NOT NULL,
  ref TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  written_at TEXT NOT NULL,
  file_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS structural_records (
  generation_id TEXT NOT NULL REFERENCES structural_record_generations(generation_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  language TEXT NOT NULL,
  parse_error TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (generation_id, path)
);

CREATE INDEX IF NOT EXISTS idx_structural_records_path ON structural_records(path, generation_id);
`;
