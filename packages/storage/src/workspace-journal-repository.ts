import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './database.js';

/**
 * Per-field bounds, each mirroring the DDL. A value the schema would reject must
 * be refused here as a typed store error first, so a caller sees
 * `WorkspaceJournalStoreError` instead of a raw `SQLITE_CONSTRAINT`.
 */
const MAX_WORKSPACE_ID_CHARS = 512;
const MAX_OPERATION_CHARS = 64;
const MAX_TOOL_CHARS = 128;
const MAX_CALL_ID_CHARS = 256;
const MAX_RESULT_CODE_CHARS = 128;
const MAX_SUMMARY_CHARS = 500;
const MAX_SESSION_CHARS = 512;
const MAX_TRACE_CHARS = 512;
const MAX_RECORDED_AT_CHARS = 64;
const MAX_EVENT_ID_CHARS = 512;
const DEFAULT_MAX_EVENTS_PER_WORKSPACE = 5_000;
const MAX_LIST_LIMIT = 200;

/**
 * Operations whose call ends the request, not the work: the handler returns a
 * handle — a process id, a task id, a parked shell, a spawned worktree — as soon
 * as the work starts, so the `completed` row that call writes proves nothing
 * about the work itself. Every `project_*` launcher, `benchmark_run`,
 * `run_affected_tests` and `verify_incremental` belong here for the same reason:
 * they all spawn and return, and the verifier hands back a live process when its
 * deadline passes.
 *
 * `run_goal` is deliberately absent: the goal runtime already tracks a goal's
 * liveness, so a journal pin would outlive the goal it describes.
 *
 * `agent_swarm_run` is present even though it carries read-only sub-actions
 * (`status`/`result`/`cancel`/`list`): its `start` hands back a swarm id while the
 * swarm keeps running, and a per-tool-name rule cannot split the sub-actions. Not
 * pinning one after a start is the fail-open this set exists to close, so the set
 * errs closed; the journal row of a read is closed by the call itself under
 * `swarm_read_settled`, so the name-level pin does not outlive the read.
 *
 * A deferred call stays `present` until a freshness probe writes `closure_code`
 * on it (`closeDeferredCalls`): the probe is the only thing that may claim the
 * handle is gone, because this store cannot see a running process. A goal whose
 * workspace journaled one of these kinds and whose probe cannot answer therefore
 * stays `present`, which is the safe direction.
 */
export const DEFERRED_CLOSURE_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'process_start', 'task_create', 'shell', 'wsl_exec',
  'codex_run', 'delegate', 'parallel_delegate', 'merge_verification_run',
  'project_dev', 'project_test', 'project_lint', 'project_typecheck', 'project_build',
  'benchmark_run', 'run_affected_tests', 'verify_incremental',
  'git_worktree_spawn', 'agent_swarm_run',
]);

/**
 * Kinds whose open row is a reference to work that outlives the call, and whose newest
 * open row can be closed by a later call of the same kind.
 *
 * Two open rows of such a kind are two different references, not two reports of the
 * same in-flight work: a `git_worktree_spawn` row stands for a worktree that may still
 * hold work, an `agent_swarm_run start` row for a swarm that still runs, and a
 * `merge_verification_run` row for an attempt that is still queued. Retention's
 * per-kind collapse treats open rows as interchangeable and keeps the newest, which is
 * how each of them can lose its pin: the evicted row is the only evidence of that work,
 * and the survivor then settles itself under `worktree_preview_settled`,
 * `swarm_read_settled` or `verification_settled`, leaving the kind with nothing open
 * while the work still runs. These kinds are therefore never collapsed — losing a
 * reference is the fail-open direction, and each of them is rare next to a launcher.
 *
 * Adding a settlement rule for another kind means adding it here too. The journal
 * cannot derive the list: the rules live in the MCP server, one layer up.
 */
export const DURABLE_REFERENCE_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'git_worktree_spawn', 'agent_swarm_run', 'merge_verification_run',
]);

export type WorkspaceJournalPhase = 'started' | 'completed';
export type WorkspaceJournalStatus = 'started' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
/** The same vocabulary `WorkspaceDurableReferenceState` uses, minus the fail-closed `unknown`. */
export type WorkspaceJournalReferenceState = 'clear' | 'present';

export interface WorkspaceJournalAppendRequest {
  readonly workspaceId: string;
  readonly operationKind: string;
  /** Required: the `(workspace, callId, phase)` triple is what pairs an open row
   * with its completion, and SQL would neither dedupe nor match a NULL. */
  readonly callId: string;
  readonly phase: WorkspaceJournalPhase;
  readonly status: WorkspaceJournalStatus;
  readonly sessionId?: string;
  readonly toolName?: string;
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
  readonly callId: string;
  readonly phase: WorkspaceJournalPhase;
  readonly status: WorkspaceJournalStatus;
  readonly resultCode?: string;
  readonly summary?: string;
  readonly traceId?: string;
  readonly recordedAt: string;
  /** Set once a freshness probe proved no durable handle of this call is live. */
  readonly closureCode?: string;
  readonly closedAt?: string;
}

export interface WorkspaceJournalClosureRequest {
  readonly workspaceId: string;
  /** Only the kinds the caller can actually probe. A kind left out keeps pinning. */
  readonly operationKinds: readonly string[];
  /**
   * Rows recorded before this instant are out of scope: a runtime can only prove
   * that no handle is live for work it could have observed, so an older call
   * from a previous host stays open instead of reading as closed.
   */
  readonly recordedAtOrAfter?: string;
  readonly closureCode: string;
  readonly closedAt?: string;
  /**
   * The calls this probe speaks for. Required: the journal is shared between
   * hosts while a probe only sees the handles it created, so an unscoped close
   * would answer for another host's work. An empty list closes nothing.
   */
  readonly callIds: readonly string[];
}

export interface OpenDeferredCallsRequest {
  readonly workspaceId: string;
  /** The calls to check. An empty list asks nothing. */
  readonly callIds: readonly string[];
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
  readonly call_id: string;
  readonly phase: string;
  readonly status: string;
  readonly result_code: string | null;
  readonly summary: string | null;
  readonly trace_id: string | null;
  readonly recorded_at: string;
  readonly closure_code: string | null;
  readonly closed_at: string | null;
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
  // Closed list, not "anything but started": the DDL accepts five statuses and a
  // stray string must not reach it as a raw SQLITE_CONSTRAINT.
  const phaseMatchesStatus = request.status === 'started'
    ? request.phase === 'started'
    : (request.phase === 'completed'
      && (request.status === 'completed' || request.status === 'failed'
        || request.status === 'cancelled' || request.status === 'interrupted'));
  return required(request.workspaceId, MAX_WORKSPACE_ID_CHARS)
    && required(request.operationKind, MAX_OPERATION_CHARS)
    && required(request.callId, MAX_CALL_ID_CHARS)
    && phaseMatchesStatus
    && bounded(request.sessionId, MAX_SESSION_CHARS)
    && bounded(request.toolName, MAX_TOOL_CHARS)
    && bounded(request.resultCode, MAX_RESULT_CODE_CHARS)
    && bounded(request.summary, MAX_SUMMARY_CHARS)
    && bounded(request.traceId, MAX_TRACE_CHARS)
    && bounded(request.recordedAt, MAX_RECORDED_AT_CHARS)
    && bounded(request.eventId, MAX_EVENT_ID_CHARS);
}

function toEntry(row: JournalRow): WorkspaceJournalEntry {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    operationKind: row.operation_kind,
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    callId: row.call_id,
    phase: row.phase === 'started' ? 'started' : 'completed',
    status: row.status as WorkspaceJournalStatus,
    ...(row.result_code === null ? {} : { resultCode: row.result_code }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
    recordedAt: row.recorded_at,
    ...(row.closure_code === null ? {} : { closureCode: row.closure_code }),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
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
  private readonly deferredClosureKinds: ReadonlySet<string>;

  public constructor(
    private readonly database: SqliteDatabase,
    options: {
      readonly maxEventsPerWorkspace?: number;
      readonly deferredClosureKinds?: ReadonlySet<string>;
    } = {},
  ) {
    this.maxEventsPerWorkspace = options.maxEventsPerWorkspace ?? DEFAULT_MAX_EVENTS_PER_WORKSPACE;
    this.deferredClosureKinds = options.deferredClosureKinds ?? DEFERRED_CLOSURE_OPERATION_KINDS;
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
      request.callId,
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
    if (!required(request.workspaceId, MAX_WORKSPACE_ID_CHARS)) {
      throw new WorkspaceJournalStoreError('invalid_entry', 'Journal reads require a bounded workspaceId');
    }
    const limit = Math.min(Math.max(request.limit ?? MAX_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const after = Number.isSafeInteger(request.afterSequence) && (request.afterSequence ?? 0) > 0 ? request.afterSequence as number : 0;
    const rows = this.database.connection.prepare(`
      SELECT sequence, event_id, workspace_id, session_id, operation_kind, tool_name, call_id, phase, status, result_code, summary, trace_id, recorded_at, closure_code, closed_at
      FROM workspace_journal_events
      WHERE workspace_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(request.workspaceId, after, limit) as unknown as JournalRow[];
    return rows.map(toEntry);
  }

  /**
   * Close the deferred calls a freshness probe proved finished.
   *
   * The probe owns the verdict: this store only records it. A deferred call keeps
   * its `completed` row (the request ended there) and gains `closure_code`, which
   * is what the projection reads as "the work ended too". Rows already closed are
   * left alone, so a repeated probe is a no-op and the first verdict survives.
   *
   * `recordedAtOrAfter` is the honesty boundary: a runtime's process/task stores
   * only know the handles they created, so closing a call it never could have
   * observed would turn "unknown" into "clear".
   *
   * Only `DEFERRED_CLOSURE_OPERATION_KINDS` can be closed here. An ordinary open
   * call is a different question — the owner died mid-call — and letting a probe
   * answer it would be the fail-open this store exists to prevent.
   */
  public closeDeferredCalls(request: WorkspaceJournalClosureRequest): number {
    if (!required(request.workspaceId, MAX_WORKSPACE_ID_CHARS)
      || !required(request.closureCode, MAX_RESULT_CODE_CHARS)
      || (request.recordedAtOrAfter !== undefined && !required(request.recordedAtOrAfter, MAX_RECORDED_AT_CHARS))
      || (request.closedAt !== undefined && !required(request.closedAt, MAX_RECORDED_AT_CHARS))) {
      throw new WorkspaceJournalStoreError('invalid_entry', 'Journal closure requires bounded identifiers');
    }
    const kinds = [...new Set(request.operationKinds.filter((kind) => required(kind, MAX_OPERATION_CHARS)
      && this.deferredClosureKinds.has(kind)))];
    if (kinds.length === 0) return 0;
    const calls = [...new Set(request.callIds.filter((callId) => required(callId, MAX_CALL_ID_CHARS)))];
    if (calls.length === 0) return 0;
    const floor = request.recordedAtOrAfter;
    const result = this.database.connection.prepare(`
      UPDATE workspace_journal_events
      SET closure_code = ?, closed_at = ?
      WHERE workspace_id = ? AND phase = 'started' AND closure_code IS NULL
        AND operation_kind IN (${kinds.map(() => '?').join(', ')})
        ${floor === undefined ? '' : 'AND recorded_at >= ?'}
        AND call_id IN (${calls.map(() => '?').join(', ')})
    `).run(
      request.closureCode,
      request.closedAt ?? new Date().toISOString(),
      request.workspaceId,
      ...kinds,
      ...(floor === undefined ? [] : [floor]),
      ...calls,
    );
    return Number(result.changes);
  }

  /**
   * The operation kind that owns each of these still-open calls.
   *
   * A call with no recorded handle can only be judged by something coarser, and
   * which coarser question is honest depends on the kind: a managed process is
   * listed by the process store, while a durable task never appears there at all.
   * The journal already knows the kind, so the caller asks it instead of guessing
   * from the tool name it no longer has.
   */
  public openDeferredCallKinds(request: OpenDeferredCallsRequest): ReadonlyMap<string, string> {
    if (!required(request.workspaceId, MAX_WORKSPACE_ID_CHARS)) {
      throw new WorkspaceJournalStoreError('invalid_entry', 'Journal reads require a bounded workspaceId');
    }
    const kinds = new Map<string, string>();
    const calls = [...new Set(request.callIds.filter((callId) => required(callId, MAX_CALL_ID_CHARS)))];
    if (calls.length === 0) return kinds;
    const rows = this.database.connection.prepare(`
      SELECT DISTINCT call_id, operation_kind
      FROM workspace_journal_events
      WHERE workspace_id = ? AND phase = 'started' AND closure_code IS NULL
        AND call_id IN (${calls.map(() => '?').join(', ')})
    `).all(request.workspaceId, ...calls) as unknown as { readonly call_id: string; readonly operation_kind: string }[];
    for (const row of rows) kinds.set(row.call_id, row.operation_kind);
    return kinds;
  }

  /**
   * Which of these calls the journal still holds open.
   *
   * `closeDeferredCalls` reports the rows it changed, and a zero is ambiguous: the
   * row may carry a closure code from an earlier sweep — a no-op, not a refusal —
   * or it may be out of reach for this runtime. A caller that kept asking about an
   * already-closed call would never finish; one that stopped asking about an open
   * call would strand its pin. So the difference is read back, not guessed.
   */
  public openDeferredCallIds(request: OpenDeferredCallsRequest): readonly string[] {
    if (!required(request.workspaceId, MAX_WORKSPACE_ID_CHARS)) {
      throw new WorkspaceJournalStoreError('invalid_entry', 'Journal reads require a bounded workspaceId');
    }
    const calls = [...new Set(request.callIds.filter((callId) => required(callId, MAX_CALL_ID_CHARS)))];
    if (calls.length === 0) return [];
    const rows = this.database.connection.prepare(`
      SELECT DISTINCT call_id
      FROM workspace_journal_events
      WHERE workspace_id = ? AND phase = 'started' AND closure_code IS NULL
        AND call_id IN (${calls.map(() => '?').join(', ')})
    `).all(request.workspaceId, ...calls) as unknown as { readonly call_id: string }[];
    return rows.map((row) => row.call_id);
  }

  /**
   * Durable references per goal, in the vocabulary `WorkspaceService` uses.
   *
   * A goal is `present` while one of its live workspaces owns an operation that
   * started and never reported a terminal outcome: discarding the worktree would
   * discard the only remaining handle to that work. A goal with no such row is
   * `clear`, because a goal that never journaled anything has nothing this store
   * pins. Archived registrations are excluded — their worktree is already gone,
   * so a row left behind by them must not pin the goal's current workspace.
   *
   * A handle-returning operation is `present` even after its own call returns:
   * `DEFERRED_CLOSURE_OPERATION_KINDS` hands back a process or task id, so its
   * `completed` phase ends the request and says nothing about the work. Reading
   * that phase as closure would report `clear` for a workspace with a running
   * process in it, which is exactly the fail-closed answer this projection is
   * supposed to protect.
   *
   * `closure_code` is what ends that deferral: only a freshness probe that asked
   * the durable task/process stores writes it, and a row carrying one stops
   * pinning. A call nobody closed — including one whose owner died mid-flight —
   * keeps reading `present`, because this store still cannot tell "running" from
   * "died" on its own.
   *
   * Callers still decide fail-closed on their own; absence here is evidence, not
   * a blanket permission.
   */
  public goalDurableReferenceStates(goalIds: readonly string[]): ReadonlyMap<string, WorkspaceJournalReferenceState> {
    const states = new Map<string, WorkspaceJournalReferenceState>();
    const ids = [...new Set(goalIds.filter((goalId) => required(goalId, MAX_WORKSPACE_ID_CHARS)))];
    for (const goalId of ids) states.set(goalId, 'clear');
    if (ids.length === 0) return states;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database.connection.prepare(`
      SELECT DISTINCT w.goal_id AS goal_id
      FROM workspace_journal_events j
      JOIN workspaces w ON w.id = j.workspace_id
      WHERE w.goal_id IN (${placeholders})
        AND w.archived_at IS NULL
        AND j.phase = 'started'
        AND j.status = 'started'
        AND j.closure_code IS NULL
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
    const kinds = [...this.deferredClosureKinds];
    if (kinds.length > 0) {
      const deferred = this.database.connection.prepare(`
        SELECT DISTINCT w.goal_id AS goal_id
        FROM workspace_journal_events j
        JOIN workspaces w ON w.id = j.workspace_id
        WHERE w.goal_id IN (${placeholders})
          AND w.archived_at IS NULL
          AND j.phase = 'started'
          AND j.operation_kind IN (${kinds.map(() => '?').join(', ')})
          AND j.closure_code IS NULL
      `).all(...ids, ...kinds) as unknown as { readonly goal_id: string | null }[];
      for (const row of deferred) {
        if (row.goal_id !== null) states.set(row.goal_id, 'present');
      }
    }
    return states;
  }

  private trim(workspaceId: string, db: SqliteDatabase['connection']): void {
    const overflow = db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_journal_events WHERE workspace_id = ?
    `).get(workspaceId) as unknown as { readonly count: number };
    const excess = Number(overflow.count) - this.maxEventsPerWorkspace;
    if (excess <= 0) return;
    const kinds = [...this.deferredClosureKinds];
    const kindPlaceholders = kinds.map(() => '?').join(', ');
    // The projection asks whether a workspace still holds an *open* deferred call
    // of a kind, not which call it was, so older open calls of the same kind are
    // redundant once a newer one exists. Collapsing only those keeps the store
    // bounded: an open deferred `started` row can never be collected as a whole
    // call, so without this a workspace that keeps launching processes would grow
    // past `maxEventsPerWorkspace` forever. Closed ones are ordinary evidence and
    // the whole-call deletion below collects them. A durable reference kind is the
    // exception: its open rows are distinct references, not repeated reports of one
    // in-flight call, so collapsing them would let a self-settling newer row evict
    // the older reference that still pins.
    const collapseKinds = kinds.filter((kind) => !DURABLE_REFERENCE_OPERATION_KINDS.has(kind));
    if (collapseKinds.length > 0) {
      const collapsePlaceholders = collapseKinds.map(() => '?').join(', ');
      db.prepare(`
        DELETE FROM workspace_journal_events
        WHERE workspace_id = ? AND phase = 'started' AND closure_code IS NULL
          AND operation_kind IN (${collapsePlaceholders})
          AND EXISTS (
            SELECT 1 FROM workspace_journal_events n
            WHERE n.workspace_id = workspace_journal_events.workspace_id
              AND n.operation_kind = workspace_journal_events.operation_kind
              AND n.phase = 'started'
              AND n.closure_code IS NULL
              AND n.sequence > workspace_journal_events.sequence
          )
      `).run(workspaceId, ...collapseKinds);
    }
    const deferredCalls = kinds.length === 0
      ? '0'
      : `EXISTS (
          SELECT 1 FROM workspace_journal_events k
          WHERE k.workspace_id = c.workspace_id
            AND k.call_id = c.call_id
            AND k.operation_kind IN (${kindPlaceholders})
            AND k.phase = 'started'
            AND k.closure_code IS NULL
        )`;
    // An open row is what pins a worktree, so retention must never be the reason
    // it disappears — and a completion may not go without its own `started` row
    // either, or the leftover row would look open forever and block cleanup
    // permanently. Retention therefore deletes whole closed calls, oldest first,
    // and picks enough calls to cover the overflow.
    //
    // An unclosed deferred call is excluded: its own completion is not evidence
    // the work ended, so collecting the pair would turn the projection back into
    // the fail-open this store exists to prevent. Once a freshness probe wrote
    // `closure_code` that objection is gone, and the pair is collectable.
    db.prepare(`
      DELETE FROM workspace_journal_events
      WHERE workspace_id = ? AND call_id IN (
        SELECT c.call_id FROM workspace_journal_events c
        WHERE c.workspace_id = ? AND c.phase = 'completed'
          AND EXISTS (
            SELECT 1 FROM workspace_journal_events s
            WHERE s.workspace_id = c.workspace_id
              AND s.call_id = c.call_id
              AND s.phase = 'started'
          )
          AND NOT ${deferredCalls}
        GROUP BY c.call_id
        ORDER BY MIN(c.sequence) ASC
        LIMIT ?
      )
    `).run(workspaceId, workspaceId, ...kinds, Math.ceil(excess / 2));
    // A terminal row whose call never started pins nothing, so it is collectable
    // on its own. The shipped caller cannot write one; this keeps the store from
    // leaking rows if another caller does.
    db.prepare(`
      DELETE FROM workspace_journal_events
      WHERE sequence IN (
        SELECT j.sequence FROM workspace_journal_events j
        WHERE j.workspace_id = ? AND j.status <> 'started'
          AND NOT EXISTS (
            SELECT 1 FROM workspace_journal_events s
            WHERE s.workspace_id = j.workspace_id
              AND s.call_id = j.call_id
              AND s.phase = 'started'
          )
        ORDER BY j.sequence ASC
        LIMIT ?
      )
    `).run(workspaceId, excess);
  }
}
