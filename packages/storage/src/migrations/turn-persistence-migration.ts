/**
 * Turn-compliance persistence from the pre-#2 `record_turn` pipeline.
 *
 * The runtime that wrote these tables is gone, but the migration id was released
 * and some installations recorded it, so the chain keeps replaying the original
 * shape for history fidelity. A fresh install creates the tables here and
 * `045_retire_turn_persistence` drops them in the same open; an upgraded install
 * that already recorded 018 skips this SQL and only runs the retirement.
 *
 * Do not rewrite this file. See `retire-turn-persistence-migration.ts`.
 */
export const TURN_PERSISTENCE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS turn_persistence_completed (
  scope TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  completed_at TEXT NOT NULL,
  PRIMARY KEY(scope, turn_id, role)
);

CREATE INDEX IF NOT EXISTS idx_turn_persistence_completed_at
  ON turn_persistence_completed(completed_at DESC);

CREATE TABLE IF NOT EXISTS turn_persistence_active (
  scope TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('required','best_effort')),
  violations INTEGER NOT NULL DEFAULT 0 CHECK(violations >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_persistence_active_updated_at
  ON turn_persistence_active(updated_at DESC);
`;
