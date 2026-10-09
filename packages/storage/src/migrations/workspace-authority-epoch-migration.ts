/**
 * Transactional registry generation, intentionally numbered 035 to avoid
 * the independent Issue #298's in-flight 032-034 migrations.
 *
 * The row and triggers are in the same SQLite transaction as each workspace
 * write. External SQL writers and separate SQLite connections are covered;
 * rollback never publishes a new generation. This is durable invalidation,
 * NOT a distributed lock or retroactive cancellation of Python side effects.
 */
export const WORKSPACE_AUTHORITY_EPOCH_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS workspace_authority_epoch (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 1 AND generation <= 9007199254740991)
);
INSERT OR IGNORE INTO workspace_authority_epoch (id, generation) VALUES (1, 1);

CREATE TRIGGER IF NOT EXISTS workspace_authority_insert
AFTER INSERT ON workspaces BEGIN
  UPDATE workspace_authority_epoch SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS workspace_authority_update
AFTER UPDATE ON workspaces BEGIN
  UPDATE workspace_authority_epoch SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER IF NOT EXISTS workspace_authority_delete
AFTER DELETE ON workspaces BEGIN
  UPDATE workspace_authority_epoch SET generation = generation + 1 WHERE id = 1;
END;
`;
