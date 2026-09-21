import {
  isExecutionScopedRuntimeEventType,
  isGoalBlockerKind,
  isGoalScopedRuntimeEvent,
  isGoalScopedRuntimeEventType,
  type AppendGoalRuntimeEventRequest,
  type AppendGoalRuntimeEventResult,
  type AppendGoalRuntimeReconciliationEventRequest,
  type AppendGoalRuntimeReconciliationEventResult,
  type ExecutionScopedRuntimeEvent,
  type GoalRuntimeEvent,
  type GoalRuntimeEventRecord,
  type GoalRuntimeEventReplayPage,
  type GoalRuntimeEventRepository,
  type GoalRuntimeReconciliationEventRepository,
  type ListGoalRuntimeEventsRequest,
  type ReplayWorkspaceGoalRuntimeEventsRequest,
} from '@unified-mpc/domain';
import type { SqliteDatabase } from './database.js';

const DEFAULT_MAX_EVENTS_PER_WORKSPACE = 5_000;
const DEFAULT_RETENTION_SLACK = 128;
const MAX_REPLAY_LIMIT = 500;
const MAX_ID_CHARS = 512;
const MAX_DETAIL_CHARS = 2_000;

export interface SqliteGoalRuntimeEventRepositoryOptions {
  readonly maxEventsPerWorkspace?: number;
  /**
   * Avoid a DELETE on every append. Retention remains hard-bounded by
   * maxEventsPerWorkspace + retentionSlack and compacts back to the max.
   */
  readonly retentionSlack?: number;
}

interface GoalRuntimeEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly workspace_id: string;
  readonly goal_id: string;
  readonly event_type: string;
  readonly execution_id: string | null;
  readonly execution_generation: number | null;
  readonly occurred_at: string;
  readonly detail: string | null;
  readonly phase: string | null;
  readonly task_id: string | null;
  readonly checkpoint_id: string | null;
  readonly blocker_kind: string | null;
  readonly recorded_at: string;
}

export class GoalRuntimeEventStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_event' | 'event_id_conflict' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'GoalRuntimeEventStoreError';
  }
}

export class SqliteGoalRuntimeEventRepository implements GoalRuntimeEventRepository, GoalRuntimeReconciliationEventRepository {
  private readonly maxEventsPerWorkspace: number;
  private readonly retentionSlack: number;

  public constructor(
    private readonly database: SqliteDatabase,
    options: SqliteGoalRuntimeEventRepositoryOptions = {},
  ) {
    this.maxEventsPerWorkspace = positiveInteger(
      options.maxEventsPerWorkspace ?? DEFAULT_MAX_EVENTS_PER_WORKSPACE,
      'maxEventsPerWorkspace',
    );
    this.retentionSlack = nonNegativeInteger(
      options.retentionSlack ?? DEFAULT_RETENTION_SLACK,
      'retentionSlack',
    );
  }

  public async appendGoalRuntimeEvent(
    request: AppendGoalRuntimeEventRequest,
  ): Promise<AppendGoalRuntimeEventResult> {
    validateEvent(request.event);
    validateIso(request.recordedAt, 'recordedAt');
    this.validateStoredScope(request.event);

    const event = request.event;
    const execution = isGoalScopedRuntimeEvent(event) ? undefined : event;
    const inserted = this.database.connection.prepare(`
      INSERT OR IGNORE INTO goal_runtime_events (
        event_id, workspace_id, goal_id, event_type,
        execution_id, execution_generation,
        occurred_at, detail, phase, task_id, checkpoint_id, blocker_kind, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.workspaceId,
      event.goalId,
      event.type,
      execution?.executionId ?? null,
      execution?.executionGeneration ?? null,
      event.occurredAt,
      event.detail ?? null,
      execution?.phase ?? null,
      execution?.taskId ?? null,
      execution?.checkpointId ?? null,
      execution?.blockerKind ?? null,
      request.recordedAt,
    );

    if (Number(inserted.changes) === 1) {
      const row = this.requireEventById(event.eventId);
      this.enforceWorkspaceRetention(event.workspaceId);
      return { appended: true, record: this.toRecord(row) };
    }

    const existing = this.requireEventById(event.eventId);
    const record = this.toRecord(existing);
    if (!sameEvent(record.event, event)) {
      throw new GoalRuntimeEventStoreError(
        'event_id_conflict',
        `Goal runtime event ID '${event.eventId}' already identifies different content`,
      );
    }
    return { appended: false, record };
  }

  public async appendGoalRuntimeReconciliationEvent(
    request: AppendGoalRuntimeReconciliationEventRequest,
  ): Promise<AppendGoalRuntimeReconciliationEventResult> {
    validateEvent(request.event);
    validateIso(request.recordedAt, 'recordedAt');
    nonNegativeInteger(request.expectedSnapshotSequence, 'expectedSnapshotSequence');
    positiveInteger(request.expectedLeaseGeneration, 'expectedLeaseGeneration');
    nonNegativeInteger(request.expectedLeaseActivitySeq, 'expectedLeaseActivitySeq');
    if (request.event.type !== 'worker_lost') {
      throw new GoalRuntimeEventStoreError('invalid_event', 'Only worker_lost may use the reconciliation commit fence');
    }
    if (request.event.executionGeneration !== request.expectedLeaseGeneration) {
      throw new GoalRuntimeEventStoreError(
        'invalid_event',
        'Reconciliation event generation must match the probed lease generation',
      );
    }

    return this.transaction(() => {
      const duplicateRow = this.database.connection.prepare(
        'SELECT * FROM goal_runtime_events WHERE event_id = ?',
      ).get(request.event.eventId);
      const duplicateRecord = duplicateRow === undefined
        ? undefined
        : this.toRecord(this.requireRow(duplicateRow));
      if (duplicateRecord !== undefined && !sameEvent(duplicateRecord.event, request.event)) {
        throw new GoalRuntimeEventStoreError(
          'event_id_conflict',
          `Goal runtime event ID '${request.event.eventId}' already identifies different content`,
        );
      }

      this.validateStoredScope(request.event);

      const goal = this.database.connection.prepare(`
        SELECT workspace_id, status, lease_generation, lease_activity_seq
        FROM goals
        WHERE id = ?
      `).get(request.event.goalId) as {
        workspace_id?: string;
        status?: string;
        lease_generation?: number;
        lease_activity_seq?: number;
      } | undefined;
      if (goal === undefined || goal.status !== 'active') {
        return { disposition: 'concurrent_change' as const, reason: 'goal_not_active' as const };
      }
      if (goal.workspace_id !== request.event.workspaceId) {
        throw new GoalRuntimeEventStoreError('invalid_event', 'Goal runtime event workspace does not match its Goal');
      }
      if (goal.lease_generation !== request.expectedLeaseGeneration
        || goal.lease_activity_seq !== request.expectedLeaseActivitySeq) {
        return { disposition: 'concurrent_change' as const, reason: 'lease_changed' as const };
      }

      const snapshot = this.database.connection.prepare(`
        SELECT last_event_sequence, active_execution_id, execution_generation
        FROM goal_runtime_snapshots
        WHERE goal_id = ?
      `).get(request.event.goalId) as {
        last_event_sequence?: number;
        active_execution_id?: string | null;
        execution_generation?: number | null;
      } | undefined;
      if (snapshot === undefined
        || snapshot.last_event_sequence !== request.expectedSnapshotSequence
        || snapshot.active_execution_id !== request.event.executionId
        || snapshot.execution_generation !== request.event.executionGeneration) {
        return { disposition: 'concurrent_change' as const, reason: 'snapshot_changed' as const };
      }

      const newerEvent = duplicateRecord === undefined
        ? this.database.connection.prepare(`
            SELECT sequence
            FROM goal_runtime_events
            WHERE goal_id = ? AND sequence > ?
            ORDER BY sequence ASC
            LIMIT 1
          `).get(request.event.goalId, request.expectedSnapshotSequence)
        : this.database.connection.prepare(`
            SELECT sequence
            FROM goal_runtime_events
            WHERE goal_id = ? AND sequence > ? AND event_id <> ?
            ORDER BY sequence ASC
            LIMIT 1
          `).get(
            request.event.goalId,
            request.expectedSnapshotSequence,
            duplicateRecord.event.eventId,
          );
      if (newerEvent !== undefined) {
        return { disposition: 'concurrent_change' as const, reason: 'event_stream_advanced' as const };
      }

      const execution = this.database.connection.prepare(`
        SELECT id, state
        FROM goal_executions
        WHERE goal_id = ? AND workspace_id = ? AND lease_generation = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(
        request.event.goalId,
        request.event.workspaceId,
        request.expectedLeaseGeneration,
      ) as { id?: string; state?: string } | undefined;
      if (execution === undefined
        || execution.id !== request.event.executionId
        || execution.state !== 'active') {
        return { disposition: 'concurrent_change' as const, reason: 'execution_changed' as const };
      }

      const continuation = this.database.connection.prepare(`
        SELECT id, version
        FROM goal_scheduled_continuations
        WHERE goal_id = ?
          AND status IN (
            'prepared','scheduled','create_uncertain',
            'reschedule_required','reschedule_failed','reschedule_uncertain',
            'cancel_required','cancel_failed','cancel_uncertain'
          )
        ORDER BY generation DESC
        LIMIT 1
      `).get(request.event.goalId) as { id?: string; version?: number } | undefined;
      const expectedContinuation = request.expectedLiveScheduledContinuation;
      const continuationMatches = expectedContinuation === null
        ? continuation === undefined
        : continuation !== undefined
          && continuation.id === expectedContinuation.continuationId
          && continuation.version === expectedContinuation.version;
      if (!continuationMatches) {
        return { disposition: 'concurrent_change' as const, reason: 'scheduled_continuation_changed' as const };
      }
      if (duplicateRecord !== undefined) {
        return { disposition: 'duplicate' as const, record: duplicateRecord };
      }

      const event = request.event;
      const inserted = this.database.connection.prepare(`
        INSERT INTO goal_runtime_events (
          event_id, workspace_id, goal_id, event_type,
          execution_id, execution_generation,
          occurred_at, detail, phase, task_id, checkpoint_id, blocker_kind, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.workspaceId,
        event.goalId,
        event.type,
        event.executionId,
        event.executionGeneration,
        event.occurredAt,
        event.detail ?? null,
        event.phase ?? null,
        event.taskId ?? null,
        event.checkpointId ?? null,
        event.blockerKind ?? null,
        request.recordedAt,
      );
      if (Number(inserted.changes) !== 1) {
        throw new GoalRuntimeEventStoreError('corrupt', 'Reconciliation event insert did not create exactly one row');
      }
      const record = this.toRecord(this.requireEventById(event.eventId));
      this.enforceWorkspaceRetention(event.workspaceId);
      return { disposition: 'appended' as const, record };
    });
  }

  public async replayWorkspaceGoalRuntimeEvents(
    request: ReplayWorkspaceGoalRuntimeEventsRequest,
  ): Promise<GoalRuntimeEventReplayPage> {
    requireIdentifier(request.workspaceId, 'workspaceId');
    const limit = boundedLimit(request.limit);
    const afterSequence = request.afterSequence === undefined
      ? undefined
      : nonNegativeInteger(request.afterSequence, 'afterSequence');

    const bounds = this.database.connection.prepare(`
      SELECT MIN(sequence) AS oldest, MAX(sequence) AS latest
      FROM goal_runtime_events
      WHERE workspace_id = ?
    `).get(request.workspaceId) as { oldest?: number | null; latest?: number | null } | undefined;
    const oldestAvailableSequence = numericOrUndefined(bounds?.oldest);
    const latestSequence = numericOrUndefined(bounds?.latest);
    const replayWindowMissed = afterSequence !== undefined
      && oldestAvailableSequence !== undefined
      && afterSequence < oldestAvailableSequence - 1;

    const rows = afterSequence === undefined
      ? this.database.connection.prepare(`
          SELECT * FROM goal_runtime_events
          WHERE workspace_id = ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(request.workspaceId, limit)
      : this.database.connection.prepare(`
          SELECT * FROM goal_runtime_events
          WHERE workspace_id = ? AND sequence > ?
          ORDER BY sequence ASC
          LIMIT ?
        `).all(request.workspaceId, afterSequence, limit);

    return {
      events: rows.map((row) => this.toRecord(this.requireRow(row))),
      ...(oldestAvailableSequence === undefined ? {} : { oldestAvailableSequence }),
      ...(latestSequence === undefined ? {} : { latestSequence }),
      replayWindowMissed,
    };
  }

  public async listGoalRuntimeEvents(
    request: ListGoalRuntimeEventsRequest,
  ): Promise<readonly GoalRuntimeEventRecord[]> {
    requireIdentifier(request.goalId, 'goalId');
    const rows = this.database.connection.prepare(`
      SELECT * FROM goal_runtime_events
      WHERE goal_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(request.goalId, boundedLimit(request.limit));
    return rows.map((row) => this.toRecord(this.requireRow(row)));
  }

  private validateStoredScope(event: GoalRuntimeEvent): void {
    const goal = this.database.connection.prepare(
      'SELECT workspace_id FROM goals WHERE id = ?',
    ).get(event.goalId) as { workspace_id?: string } | undefined;
    if (goal === undefined || typeof goal.workspace_id !== 'string') {
      throw new GoalRuntimeEventStoreError('invalid_event', `Goal '${event.goalId}' does not exist`);
    }
    if (goal.workspace_id !== event.workspaceId) {
      throw new GoalRuntimeEventStoreError('invalid_event', 'Goal runtime event workspace does not match its Goal');
    }

    if (isGoalScopedRuntimeEvent(event)) return;

    const execution = this.database.connection.prepare(`
      SELECT goal_id, workspace_id, lease_generation
      FROM goal_executions
      WHERE id = ?
    `).get(event.executionId) as {
      goal_id?: string;
      workspace_id?: string;
      lease_generation?: number;
    } | undefined;
    if (execution === undefined
      || typeof execution.goal_id !== 'string'
      || typeof execution.workspace_id !== 'string'
      || typeof execution.lease_generation !== 'number') {
      throw new GoalRuntimeEventStoreError('invalid_event', `Execution '${event.executionId}' does not exist`);
    }
    if (execution.goal_id !== event.goalId || execution.workspace_id !== event.workspaceId) {
      throw new GoalRuntimeEventStoreError('invalid_event', 'Goal runtime event execution scope does not match its Goal');
    }
    if (execution.lease_generation !== event.executionGeneration) {
      throw new GoalRuntimeEventStoreError('invalid_event', 'Goal runtime event execution generation does not match its durable receipt');
    }
  }

  private requireEventById(eventId: string): GoalRuntimeEventRow {
    const row = this.database.connection.prepare(
      'SELECT * FROM goal_runtime_events WHERE event_id = ?',
    ).get(eventId);
    if (row === undefined) {
      throw new GoalRuntimeEventStoreError('corrupt', `Goal runtime event '${eventId}' disappeared after insert`);
    }
    return this.requireRow(row);
  }

  private enforceWorkspaceRetention(workspaceId: string): void {
    const countRow = this.database.connection.prepare(
      'SELECT COUNT(*) AS count FROM goal_runtime_events WHERE workspace_id = ?',
    ).get(workspaceId) as { count?: number | bigint } | undefined;
    const count = Number(countRow?.count ?? 0);
    if (count <= this.maxEventsPerWorkspace + this.retentionSlack) return;

    this.database.connection.prepare(`
      DELETE FROM goal_runtime_events
      WHERE workspace_id = ?
        AND sequence < (
          SELECT sequence
          FROM goal_runtime_events
          WHERE workspace_id = ?
          ORDER BY sequence DESC
          LIMIT 1 OFFSET ?
        )
    `).run(workspaceId, workspaceId, this.maxEventsPerWorkspace - 1);
  }

  private transaction<T>(operation: () => T): T {
    this.database.connection.exec('BEGIN IMMEDIATE;');
    try {
      const value = operation();
      this.database.connection.exec('COMMIT;');
      return value;
    } catch (error) {
      this.database.connection.exec('ROLLBACK;');
      throw error;
    }
  }

  private toRecord(row: GoalRuntimeEventRow): GoalRuntimeEventRecord {
    const common = {
      eventId: row.event_id,
      workspaceId: row.workspace_id,
      goalId: row.goal_id,
      occurredAt: row.occurred_at,
      ...(row.detail === null ? {} : { detail: row.detail }),
    };

    let event: GoalRuntimeEvent;
    if (isGoalScopedRuntimeEventType(row.event_type)) {
      if (row.execution_id !== null || row.execution_generation !== null
        || row.phase !== null || row.task_id !== null || row.checkpoint_id !== null || row.blocker_kind !== null) {
        throw new GoalRuntimeEventStoreError('corrupt', 'Goal-scoped runtime event contains execution-only fields');
      }
      event = { ...common, type: row.event_type };
    } else if (isExecutionScopedRuntimeEventType(row.event_type)) {
      if (row.execution_id === null || row.execution_generation === null) {
        throw new GoalRuntimeEventStoreError('corrupt', 'Execution-scoped runtime event is missing execution identity');
      }
      if (!Number.isInteger(row.execution_generation) || row.execution_generation <= 0) {
        throw new GoalRuntimeEventStoreError('corrupt', 'Execution-scoped runtime event generation is invalid');
      }
      if (row.blocker_kind !== null && !isGoalBlockerKind(row.blocker_kind)) {
        throw new GoalRuntimeEventStoreError('corrupt', 'Goal runtime event blocker kind is invalid');
      }
      const scoped: ExecutionScopedRuntimeEvent = {
        ...common,
        type: row.event_type,
        executionId: row.execution_id,
        executionGeneration: row.execution_generation,
        ...(row.phase === null ? {} : { phase: row.phase }),
        ...(row.task_id === null ? {} : { taskId: row.task_id }),
        ...(row.checkpoint_id === null ? {} : { checkpointId: row.checkpoint_id }),
        ...(row.blocker_kind === null ? {} : { blockerKind: row.blocker_kind }),
      };
      event = scoped;
    } else {
      throw new GoalRuntimeEventStoreError('corrupt', `Unknown Goal runtime event type '${row.event_type}'`);
    }

    return {
      sequence: row.sequence,
      event,
      recordedAt: row.recorded_at,
    };
  }

  private requireRow(value: unknown): GoalRuntimeEventRow {
    if (!isRecord(value)) throw new GoalRuntimeEventStoreError('corrupt', 'Goal runtime event row is invalid');
    const requiredStrings = ['event_id', 'workspace_id', 'goal_id', 'event_type', 'occurred_at', 'recorded_at'];
    if (!requiredStrings.every((key) => typeof value[key] === 'string')) {
      throw new GoalRuntimeEventStoreError('corrupt', 'Goal runtime event required fields are invalid');
    }
    const nullableStrings = ['execution_id', 'detail', 'phase', 'task_id', 'checkpoint_id', 'blocker_kind'];
    if (!nullableStrings.every((key) => value[key] === null || typeof value[key] === 'string')) {
      throw new GoalRuntimeEventStoreError('corrupt', 'Goal runtime event optional fields are invalid');
    }
    if (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence) || value.sequence <= 0) {
      throw new GoalRuntimeEventStoreError('corrupt', 'Goal runtime event sequence is invalid');
    }
    if (value.execution_generation !== null
      && (typeof value.execution_generation !== 'number'
        || !Number.isInteger(value.execution_generation)
        || value.execution_generation <= 0)) {
      throw new GoalRuntimeEventStoreError('corrupt', 'Goal runtime event execution generation is invalid');
    }
    validateIso(value.occurred_at as string, 'occurred_at', 'corrupt');
    validateIso(value.recorded_at as string, 'recorded_at', 'corrupt');
    return value as unknown as GoalRuntimeEventRow;
  }
}

function validateEvent(event: GoalRuntimeEvent): void {
  requireIdentifier(event.eventId, 'eventId');
  requireIdentifier(event.workspaceId, 'workspaceId');
  requireIdentifier(event.goalId, 'goalId');
  validateIso(event.occurredAt, 'occurredAt');
  optionalBounded(event.detail, 'detail', MAX_DETAIL_CHARS);

  if (isGoalScopedRuntimeEvent(event)) return;

  requireIdentifier(event.executionId, 'executionId');
  positiveInteger(event.executionGeneration, 'executionGeneration');
  optionalBounded(event.phase, 'phase', MAX_ID_CHARS);
  optionalBounded(event.taskId, 'taskId', MAX_ID_CHARS);
  optionalBounded(event.checkpointId, 'checkpointId', MAX_ID_CHARS);
  if (event.blockerKind !== undefined && !isGoalBlockerKind(event.blockerKind)) {
    throw new GoalRuntimeEventStoreError('invalid_event', 'blockerKind is invalid');
  }
}

function sameEvent(left: GoalRuntimeEvent, right: GoalRuntimeEvent): boolean {
  if (left.eventId !== right.eventId
    || left.type !== right.type
    || left.workspaceId !== right.workspaceId
    || left.goalId !== right.goalId
    || left.occurredAt !== right.occurredAt
    || left.detail !== right.detail) return false;

  if (isGoalScopedRuntimeEvent(left) || isGoalScopedRuntimeEvent(right)) {
    return isGoalScopedRuntimeEvent(left) && isGoalScopedRuntimeEvent(right);
  }

  return left.executionId === right.executionId
    && left.executionGeneration === right.executionGeneration
    && left.phase === right.phase
    && left.taskId === right.taskId
    && left.checkpointId === right.checkpointId
    && left.blockerKind === right.blockerKind;
}

function boundedLimit(value: number): number {
  return Math.min(MAX_REPLAY_LIMIT, positiveInteger(value, 'limit'));
}

function requireIdentifier(value: string, label: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_CHARS) {
    throw new GoalRuntimeEventStoreError('invalid_event', `${label} must contain 1-${MAX_ID_CHARS} characters`);
  }
}

function optionalBounded(value: string | undefined, label: string, max: number): void {
  if (value !== undefined && value.length > max) {
    throw new GoalRuntimeEventStoreError('invalid_event', `${label} exceeds ${max} characters`);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GoalRuntimeEventStoreError('invalid_event', `${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new GoalRuntimeEventStoreError('invalid_event', `${label} must be a non-negative integer`);
  }
  return value;
}

function validateIso(
  value: string,
  label: string,
  reason: GoalRuntimeEventStoreError['reason'] = 'invalid_event',
): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new GoalRuntimeEventStoreError(reason, `${label} is not a valid timestamp`);
  }
}

function numericOrUndefined(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
