import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

const MAX_ID_CHARS = 512;
const MAX_OPERATION_CHARS = 64;
const MAX_SUMMARY_CHARS = 500;
const DEFAULT_MAX_EVENTS_PER_WORKSPACE = 5_000;
const MAX_LIST_LIMIT = 200;

export type WorkspaceJournalPhase = 'started' | 'completed';
export type WorkspaceJournalStatus = 'started' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
/** The same vocabulary `WorkspaceDurableReferenceState` uses, minus the fail-closed `unknown`. */
export type WorkspaceJournalReferenceState = 'clear' | 'present';

export interface WorkspaceJournalAppendRequest {
  readonly workspaceId: string;
  readonly operationKind: string;
  readonly phase: WorkspaceJournalPhase;
  readonly status: WorkspaceJournalStatus;
  readonly sessionId?: string;
  readonly toolName?: string;
  readonly callId?: string;
  readonly resultCode?: string;
  readonly summary?: string;
  readonly traceId?: string;
  readonly recordedAt?: string;
  readonly eventId?: string;
}

export interface WorkspaceJournalEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly operationKind: string;
  readonly toolName?: string;
  readonly callId?: string;
  readonly phase: WorkspaceJournalPhase;
  readonly status: WorkspaceJournalStatus;
  readonly resultCode?: string;
  readonly summary?: string;
  readonly traceId?: string;
  readonly recordedAt: string;
}

export interface ListWorkspaceJournalRequest {
  readonly workspaceId: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

interface JournalRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly workspace_id: string;
  readonly session_id: string | null;
  readonly operation_kind: string;
  readonly tool_name: string | null;
  readonly call_id: string | null;
  readonly phase: string;
  readonly status: string;
  readonly result_code: string | null;
  readonly summary: string | null;
  readonly trace_id: string | null;
  readonly recorded_at: string;
}

export class WorkspaceJournalStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_entry',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceJournalStoreError';
  }
}

function bounded(value: string | undefined, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max);
}

function required(value: string | undefined, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validRequest(request: WorkspaceJournalAppendRequest): boolean {
  const phaseMatchesStatus = (request.phase === 'started' && request.status === 'started')
    || (request.phase === 'completed' && request.status !== 'started');
  return required(request.workspaceId, MAX_ID_CHARS)
    && required(request.operationKind, MAX_OPERATION_CHARS)
    && phaseMatchesStatus
    && bounded(request.sessionId, MAX_ID_CHARS)
    && bounded(request.toolName, MAX_ID_CHARS)
    && bounded(request.callId, MAX_ID_CHARS)
    && bounded(request.resultCode, MAX_ID_CHARS)
    && bounded(request.summary, MAX_SUMMARY_CHARS)
    && bounded(request.traceId, MAX_ID_CHARS)
    && bounded(request.recordedAt, 64)
    && bounded(request.eventId, MAX_ID_CHARS);
}

function toEntry(row: JournalRow): WorkspaceJournalEntry {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    operationKind: row.operation_kind,
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(row.call_id === null ? {} : { callId: row.call_id }),
    phase: row.phase === 'started' ? 'started' : 'completed',
    status: row.status as WorkspaceJournalStatus,
    ...(row.result_code === null ? {} : { resultCode: row.result_code }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
    recordedAt: row.recorded_at,
  };
}

/**
 * Append-oriented store for recovery-relevant workspace operations.
 *
 * Writes are best-effort by contract: the caller records them beside the audit
 * log, and a rejected or duplicate entry must never fail the tool call it
 * describes. Reads are bounded so a journal cannot be used to pull an unbounded
 * history into one response.
 */
export class SqliteWorkspaceJournalRepository {
  private readonly maxEventsPerWorkspace: number;

  public constructor(
    private readonly database: SqliteDatabase,
    options: { readonly maxEventsPerWorkspace?: number } = {},
  ) {
    this.maxEventsPerWorkspace = options.maxEventsPerWorkspace ?? DEFAULT_MAX_EVENTS_PER_WORKSPACE;
  }

  /**
   * Record one operation. Returns the assigned sequence, or `null` when the
   * `(workspace, callId, phase)` row already exists: a retried write is not an
   * error and must not create a second row.
   */
  public append(request: WorkspaceJournalAppendRequest): number | null {
    if (!validRequest(request)) {
      throw new WorkspaceJournalStoreError('invalid_entry', 'Journal entry is not bounded or is missing a required field');
    }
    const db = this.database.connection;
    const insert = db.prepare(`
      INSERT INTO workspace_journal_events
        (event_id, workspace_id, session_id, operation_kind, tool_name, call_id, phase, status, result_code, summary, trace_id, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, call_id, phase) DO NOTHING
    `);
    const result = insert.run(
      request.eventId ?? randomUUID(),
      request.workspaceId,
      request.sessionId ?? null,
      request.operationKind,
      request.toolName ?? null,
      request.callId ?? null,
      request.phase,
      request.status,
      request.resultCode ?? null,
      request.summary ?? null,
      request.traceId ?? null,
      request.recordedAt ?? new Date().toISOString(),
    );
    if (Number(result.changes) === 0) return null;
    this.trim(request.workspaceId, db);
    return Number(result.lastInsertRowid);
  }

  public list(request: ListWorkspaceJournalRequest): readonly WorkspaceJournalEntry[] {
    if (!required(request.workspaceId, MAX_ID_CHARS)) {
      throw new WorkspaceJournalStoreError('invalid_entry', 'Journal reads require a bounded workspaceId');
    }
    const limit = Math.min(Math.max(request.limit ?? MAX_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const after = Number.isSafeInteger(request.afterSequence) && (request.afterSequence ?? 0) > 0 ? request.afterSequence as number : 0;
    const rows = this.database.connection.prepare(`
      SELECT sequence, event_id, workspace_id, session_id, operation_kind, tool_name, call_id, phase, status, result_code, summary, trace_id, recorded_at
      FROM workspace_journal_events
      WHERE workspace_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(request.workspaceId, after, limit) as unknown as JournalRow[];
    return rows.map(toEntry);
  }

  /**
   * Durable references per goal, in the vocabulary `WorkspaceService` uses.
   *
   * A goal is `present` while it owns an operation that started and never
   * reported a terminal outcome: discarding the worktree would discard the only
   * remaining handle to that work. A goal with no such row is `clear`, because
   * a goal that never journaled anything has nothing this store pins. Callers
   * still decide fail-closed on their own; absence here is evidence, not a
   * blanket permission.
   */
  public goalDurableReferenceStates(goalIds: readonly string[]): ReadonlyMap<string, WorkspaceJournalReferenceState> {
    const states = new Map<string, WorkspaceJournalReferenceState>();
    const ids = [...new Set(goalIds.filter((goalId) => required(goalId, MAX_ID_CHARS)))];
    for (const goalId of ids) states.set(goalId, 'clear');
    if (ids.length === 0) return states;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database.connection.prepare(`
      SELECT DISTINCT w.goal_id AS goal_id
      FROM workspace_journal_events j
      JOIN workspaces w ON w.id = j.workspace_id
      WHERE w.goal_id IN (${placeholders})
        AND j.status = 'started'
        AND NOT EXISTS (
          SELECT 1 FROM workspace_journal_events c
          WHERE c.workspace_id = j.workspace_id
            AND c.call_id = j.call_id
            AND c.phase = 'completed'
        )
    `).all(...ids) as unknown as { readonly goal_id: string | null }[];
    for (const row of rows) {
      if (row.goal_id !== null) states.set(row.goal_id, 'present');
    }
    return states;
  }

  private trim(workspaceId: string, db: SqliteDatabase['connection']): void {
    const overflow = db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_journal_events WHERE workspace_id = ?
    `).get(workspaceId) as unknown as { readonly count: number };
    const excess = Number(overflow.count) - this.maxEventsPerWorkspace;
    if (excess <= 0) return;
    // Only terminal rows are collectable: an open row is what pins a worktree,
    // so retention must never be the reason it disappears.
    db.prepare(`
      DELETE FROM workspace_journal_events
      WHERE sequence IN (
        SELECT sequence FROM workspace_journal_events
        WHERE workspace_id = ? AND status <> 'started'
        ORDER BY sequence ASC
        LIMIT ?
      )
    `).run(workspaceId, excess);
  }
}
