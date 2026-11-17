import type { SqliteDatabase } from './database.js';

const MAX_ID_CHARS = 256;
const MAX_RECORDED_AT_CHARS = 64;

/**
 * The authorities a deferred call's handle can belong to.
 *
 * Closed on purpose: an unlisted provider has no adapter, so a probe cannot
 * answer for it and the call keeps pinning. Adding one here is the whole change
 * needed to make that authority answerable.
 */
export const DEFERRED_HANDLE_PROVIDERS = ['process', 'task', 'swarm', 'worktree', 'verification', 'codex'] as const;
export type DeferredHandleProvider = typeof DEFERRED_HANDLE_PROVIDERS[number];

export interface DeferredHandleAppendRequest {
  readonly workspaceId: string;
  readonly callId: string;
  readonly provider: DeferredHandleProvider;
  readonly handleId: string;
  readonly recordedAt?: string;
}

export interface DeferredHandle {
  readonly workspaceId: string;
  readonly callId: string;
  readonly provider: DeferredHandleProvider;
  readonly handleId: string;
  readonly recordedAt: string;
}

interface DeferredHandleRow {
  readonly workspace_id: string;
  readonly call_id: string;
  readonly provider: string;
  readonly handle_id: string;
  readonly recorded_at: string;
}

export class DeferredHandleStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_entry',
    message: string,
  ) {
    super(message);
    this.name = 'DeferredHandleStoreError';
  }
}

function required(value: string | undefined, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * SQLITE_CONSTRAINT_FOREIGNKEY, in the numeric and message-only shapes
 * `node:sqlite` exposes.
 *
 * `deferred_handles` has exactly one foreign key — `workspace_id` into
 * `workspaces(id)` — so a violation can only mean the handle names a workspace this
 * host does not have, which is a caller bug rather than a driver failure. A second
 * foreign key would make this classifier wrong, and the answer is then to inspect
 * which constraint fired or to stop translating at all, not to widen the name.
 */
function isForeignKeyViolation(error: unknown): boolean {
  if ((error as { errcode?: unknown } | null)?.errcode === 787) return true;
  return error instanceof Error && error.message.includes('FOREIGN KEY');
}

/**
 * Which handle a journaled call returned, and which authority can answer for it.
 *
 * The ledger is a correlation table, not a verdict: it never says a handle is
 * finished. A freshness probe asks the provider named here, and only that
 * provider may settle the call. `forget` is the caller's acknowledgement that
 * the verdict landed, so a settled call stops costing a lookup.
 *
 * `record` keeps the first handle for a call. A retried tool completion writes
 * the same handle, and a call that somehow returned two would be a bug to see in
 * the journal rather than something to silently overwrite.
 */
export class SqliteDeferredHandleRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public record(request: DeferredHandleAppendRequest): void {
    if (!required(request.workspaceId, MAX_ID_CHARS)
      || !required(request.callId, MAX_ID_CHARS)
      || !required(request.handleId, MAX_ID_CHARS)
      || !DEFERRED_HANDLE_PROVIDERS.includes(request.provider)
      || (request.recordedAt !== undefined && !required(request.recordedAt, MAX_RECORDED_AT_CHARS))) {
      throw new DeferredHandleStoreError('invalid_entry', 'Deferred handle requires bounded identifiers');
    }
    try {
      this.database.connection.prepare(`
        INSERT INTO deferred_handles (workspace_id, call_id, provider, handle_id, recorded_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, call_id) DO NOTHING
      `).run(
        request.workspaceId,
        request.callId,
        request.provider,
        request.handleId,
        request.recordedAt ?? new Date().toISOString(),
      );
    } catch (error) {
      // The one failure this method can explain: the workspace does not exist, so
      // the row would name an owner nothing can ask. Anything else (disk, schema)
      // is not the caller's fault and must keep its own shape.
      if (!isForeignKeyViolation(error)) throw error;
      throw new DeferredHandleStoreError(
        'invalid_entry',
        `Deferred handle names a workspace this host does not have: ${request.workspaceId}`,
      );
    }
  }

  /** The handles this workspace recorded for the given calls, in no fixed order. */
  public take(workspaceId: string, callIds: readonly string[]): readonly DeferredHandle[] {
    if (!required(workspaceId, MAX_ID_CHARS)) {
      throw new DeferredHandleStoreError('invalid_entry', 'Deferred handle lookup requires a workspace');
    }
    const ids = [...new Set(callIds.filter((callId) => required(callId, MAX_ID_CHARS)))];
    if (ids.length === 0) return [];
    const rows = this.database.connection.prepare(`
      SELECT workspace_id, call_id, provider, handle_id, recorded_at
      FROM deferred_handles
      WHERE workspace_id = ? AND call_id IN (${ids.map(() => '?').join(', ')})
    `).all(workspaceId, ...ids) as unknown as DeferredHandleRow[];
    return rows.map(toHandle);
  }

  /** Drop settled calls' handles. Returns how many rows went away. */
  public forget(workspaceId: string, callIds: readonly string[]): number {
    if (!required(workspaceId, MAX_ID_CHARS)) {
      throw new DeferredHandleStoreError('invalid_entry', 'Deferred handle forget requires a workspace');
    }
    const ids = [...new Set(callIds.filter((callId) => required(callId, MAX_ID_CHARS)))];
    if (ids.length === 0) return 0;
    const result = this.database.connection.prepare(`
      DELETE FROM deferred_handles
      WHERE workspace_id = ? AND call_id IN (${ids.map(() => '?').join(', ')})
    `).run(workspaceId, ...ids);
    return Number(result.changes);
  }
}

function toHandle(row: DeferredHandleRow): DeferredHandle {
  return {
    workspaceId: row.workspace_id,
    callId: row.call_id,
    provider: row.provider as DeferredHandleProvider,
    handleId: row.handle_id,
    recordedAt: row.recorded_at,
  };
}
