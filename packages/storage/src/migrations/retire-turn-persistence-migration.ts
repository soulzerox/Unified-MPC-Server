/**
 * Retire the pre-#2 turn-compliance tables (issue #4).
 *
 * `record_turn`, its transcript sources and the mandatory `memory` /
 * `thai-rag-mcp` child topology were removed from the runtime, so nothing reads
 * or writes these tables any more. Installations that applied the released
 * `018_turn_persistence` migration still carry the rows, and leaving them in
 * place keeps a dead architecture visible in every storage diagnostic.
 *
 * The retirement drops the tables outright rather than quarantining them: the
 * database layer creates a pre-migration backup before the first pending
 * migration, so an operator can recover the rows there, and keeping a parallel
 * legacy table would only move the stale state one name over.
 *
 * Properties required by the issue:
 * - idempotent: `IF EXISTS` makes a partially retired or hand-cleaned database a
 *   no-op instead of a startup failure;
 * - transactional: both drops commit or roll back together with the version row;
 * - clean-install parity: a fresh install replays 018 for history fidelity and
 *   this migration drops the fresh, empty tables in the same open, so both paths
 *   converge on the same schema;
 * - safe across repeated starts: `schema_migrations` records the id, so this runs
 *   once per database.
 */
export const RETIRE_TURN_PERSISTENCE_MIGRATION_SQL = `
DROP INDEX IF EXISTS idx_turn_persistence_completed_at;
DROP INDEX IF EXISTS idx_turn_persistence_active_updated_at;
DROP TABLE IF EXISTS turn_persistence_completed;
DROP TABLE IF EXISTS turn_persistence_active;
`;
