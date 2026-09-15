import type { SqliteDatabase } from './database.js';

export type StoredTurnPersistenceRole = 'user' | 'assistant';
export type StoredTurnPersistenceMode = 'required' | 'best_effort';

export interface StoredTurnPersistenceActiveState {
  readonly turnId: string;
  readonly mode: StoredTurnPersistenceMode;
  readonly violations: number;
}

interface ActiveRow {
  readonly turn_id: string;
  readonly mode: string;
  readonly violations: number;
}

export class SqliteTurnPersistenceRepository {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public isCompleted(scope: string, turnId: string, role: StoredTurnPersistenceRole): boolean {
    const row = this.database.connection.prepare(
      'SELECT 1 AS present FROM turn_persistence_completed WHERE scope = ? AND turn_id = ? AND role = ? LIMIT 1',
    ).get(scope, turnId, role);
    return row !== undefined;
  }

  public markCompleted(scope: string, turnId: string, role: StoredTurnPersistenceRole): void {
    this.database.connection.prepare(`
      INSERT INTO turn_persistence_completed (scope, turn_id, role, completed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, turn_id, role) DO UPDATE SET completed_at = excluded.completed_at
    `).run(scope, turnId, role, this.now());
  }

  public pruneCompleted(maxEntries: number): void {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) return;
    this.database.connection.prepare(`
      DELETE FROM turn_persistence_completed
      WHERE rowid NOT IN (
        SELECT rowid
        FROM turn_persistence_completed
        ORDER BY completed_at DESC, rowid DESC
        LIMIT ?
      )
    `).run(maxEntries);
  }

  public getActive(scope: string): StoredTurnPersistenceActiveState | undefined {
    const row = this.database.connection.prepare(
      'SELECT turn_id, mode, violations FROM turn_persistence_active WHERE scope = ?',
    ).get(scope) as ActiveRow | undefined;
    if (row === undefined || !isStoredMode(row.mode) || !Number.isInteger(row.violations) || row.violations < 0) return undefined;
    return { turnId: row.turn_id, mode: row.mode, violations: row.violations };
  }

  public setActive(scope: string, state: StoredTurnPersistenceActiveState): void {
    this.database.connection.prepare(`
      INSERT INTO turn_persistence_active (scope, turn_id, mode, violations, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        turn_id = excluded.turn_id,
        mode = excluded.mode,
        violations = excluded.violations,
        updated_at = excluded.updated_at
    `).run(scope, state.turnId, state.mode, state.violations, this.now());
  }

  public clearActive(scope: string, turnId: string): void {
    this.database.connection.prepare(
      'DELETE FROM turn_persistence_active WHERE scope = ? AND turn_id = ?',
    ).run(scope, turnId);
  }

  public pruneActive(maxEntries: number): void {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) return;
    this.database.connection.prepare(`
      DELETE FROM turn_persistence_active
      WHERE rowid NOT IN (
        SELECT rowid
        FROM turn_persistence_active
        ORDER BY updated_at DESC, rowid DESC
        LIMIT ?
      )
    `).run(maxEntries);
  }
}

function isStoredMode(value: string): value is StoredTurnPersistenceMode {
  return value === 'required' || value === 'best_effort';
}
