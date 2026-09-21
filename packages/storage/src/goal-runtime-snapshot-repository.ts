import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  isGoalBlockerKind,
  isGoalDesiredRuntimeState,
  isGoalIntegrationState,
  isGoalLifecycleState,
  isGoalRuntimeState,
  isGoalWorkspaceState,
  type GoalRuntimeBlocker,
  type GoalRuntimeProgress,
  type GoalRuntimeProgressStep,
  type GoalRuntimeProjection,
  type GoalRuntimeSnapshotRecord,
  type GoalRuntimeSnapshotRepository,
  type ListWorkspaceGoalRuntimeSnapshotsRequest,
  type StoreGoalRuntimeSnapshotRequest,
} from '@unified-mpc/domain';
import type { DatabaseSync } from 'node:sqlite';
import type { SqliteDatabase } from './database.js';

const MAX_LIST_LIMIT = 500;
const MAX_ID_CHARS = 512;
const MAX_TEXT_CHARS = 4_000;
const MAX_PROGRESS_STEPS = 256;

interface GoalRuntimeSnapshotRow {
  readonly goal_id: string;
  readonly workspace_id: string;
  readonly contract_version: number;
  readonly lifecycle_state: string;
  readonly runtime_state: string;
  readonly desired_runtime_state: string;
  readonly integration_state: string;
  readonly workspace_state: string;
  readonly active_execution_id: string | null;
  readonly execution_generation: number | null;
  readonly phase: string | null;
  readonly progress_json: string | null;
  readonly last_activity_at: string;
  readonly last_heartbeat_at: string | null;
  readonly blocker_kind: string | null;
  readonly blocker_detail: string | null;
  readonly blocker_observed_at: string | null;
  readonly last_event_sequence: number;
  readonly updated_at: string;
}

export class GoalRuntimeSnapshotStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_projection' | 'stale_sequence' | 'sequence_conflict' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'GoalRuntimeSnapshotStoreError';
  }
}

export class SqliteGoalRuntimeSnapshotRepository implements GoalRuntimeSnapshotRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async getGoalRuntimeSnapshot(goalId: string): Promise<GoalRuntimeSnapshotRecord | null> {
    requireIdentifier(goalId, 'goalId');
    const row = this.database.connection.prepare(
      'SELECT * FROM goal_runtime_snapshots WHERE goal_id = ?',
    ).get(goalId);
    return row === undefined ? null : this.toRecord(this.requireRow(row));
  }

  public async listWorkspaceGoalRuntimeSnapshots(
    request: ListWorkspaceGoalRuntimeSnapshotsRequest,
  ): Promise<readonly GoalRuntimeSnapshotRecord[]> {
    requireIdentifier(request.workspaceId, 'workspaceId');
    const rows = this.database.connection.prepare(`
      SELECT * FROM goal_runtime_snapshots
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, goal_id ASC
      LIMIT ?
    `).all(request.workspaceId, boundedLimit(request.limit));
    return rows.map((row) => this.toRecord(this.requireRow(row)));
  }

  public async storeGoalRuntimeSnapshot(
    request: StoreGoalRuntimeSnapshotRequest,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const projection = normalizeProjection(request.projection, 'invalid_projection');
    const lastEventSequence = nonNegativeInteger(request.lastEventSequence, 'lastEventSequence', 'invalid_projection');
    validateIso(request.updatedAt, 'updatedAt', 'invalid_projection');
    this.validateStoredScope(projection, lastEventSequence);

    return this.transaction(() => {
      const existingRow = this.database.connection.prepare(
        'SELECT * FROM goal_runtime_snapshots WHERE goal_id = ?',
      ).get(projection.goalId);
      if (existingRow !== undefined) {
        const existing = this.toRecord(this.requireRow(existingRow));
        if (lastEventSequence < existing.lastEventSequence) {
          throw new GoalRuntimeSnapshotStoreError(
            'stale_sequence',
            `Goal runtime snapshot cursor cannot move backwards from ${existing.lastEventSequence} to ${lastEventSequence}`,
          );
        }
        if (lastEventSequence === existing.lastEventSequence) {
          if (sameProjection(existing.projection, projection)) return existing;
          throw new GoalRuntimeSnapshotStoreError(
            'sequence_conflict',
            `Goal runtime snapshot sequence ${lastEventSequence} already identifies different projected state`,
          );
        }

        this.database.connection.prepare(`
          UPDATE goal_runtime_snapshots
          SET workspace_id = ?,
              contract_version = ?,
              lifecycle_state = ?,
              runtime_state = ?,
              desired_runtime_state = ?,
              integration_state = ?,
              workspace_state = ?,
              active_execution_id = ?,
              execution_generation = ?,
              phase = ?,
              progress_json = ?,
              last_activity_at = ?,
              last_heartbeat_at = ?,
              blocker_kind = ?,
              blocker_detail = ?,
              blocker_observed_at = ?,
              last_event_sequence = ?,
              updated_at = ?
          WHERE goal_id = ?
        `).run(...rowValues(projection, lastEventSequence, request.updatedAt), projection.goalId);
      } else {
        this.database.connection.prepare(`
          INSERT INTO goal_runtime_snapshots (
            goal_id, workspace_id, contract_version, lifecycle_state, runtime_state,
            desired_runtime_state, integration_state, workspace_state,
            active_execution_id, execution_generation, phase, progress_json,
            last_activity_at, last_heartbeat_at,
            blocker_kind, blocker_detail, blocker_observed_at,
            last_event_sequence, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          projection.goalId,
          ...rowValues(projection, lastEventSequence, request.updatedAt),
        );
      }

      const stored = this.database.connection.prepare(
        'SELECT * FROM goal_runtime_snapshots WHERE goal_id = ?',
      ).get(projection.goalId);
      if (stored === undefined) {
        throw new GoalRuntimeSnapshotStoreError('corrupt', 'Goal runtime snapshot disappeared after write');
      }
      return this.toRecord(this.requireRow(stored));
    });
  }

  private validateStoredScope(projection: GoalRuntimeProjection, lastEventSequence: number): void {
    const goal = this.database.connection.prepare(
      'SELECT workspace_id FROM goals WHERE id = ?',
    ).get(projection.goalId) as { workspace_id?: string } | undefined;
    if (goal === undefined || typeof goal.workspace_id !== 'string') {
      throw new GoalRuntimeSnapshotStoreError('invalid_projection', `Goal '${projection.goalId}' does not exist`);
    }
    if (goal.workspace_id !== projection.workspaceId) {
      throw new GoalRuntimeSnapshotStoreError(
        'invalid_projection',
        'Goal runtime snapshot workspace does not match its Goal',
      );
    }

    if (lastEventSequence > 0) {
      const event = this.database.connection.prepare(`
        SELECT sequence FROM goal_runtime_events
        WHERE sequence = ? AND workspace_id = ? AND goal_id = ?
      `).get(lastEventSequence, projection.workspaceId, projection.goalId);
      if (!isRecord(event) || typeof event.sequence !== 'number') {
        throw new GoalRuntimeSnapshotStoreError(
          'invalid_projection',
          'Goal runtime snapshot cursor does not identify a durable event for this Goal',
        );
      }
    }

    if (projection.executionGeneration === undefined) return;

    const execution = projection.activeExecutionId === undefined
      ? this.database.connection.prepare(`
          SELECT id FROM goal_executions
          WHERE goal_id = ? AND workspace_id = ? AND lease_generation = ?
          ORDER BY created_at DESC
          LIMIT 1
        `).get(projection.goalId, projection.workspaceId, projection.executionGeneration)
      : this.database.connection.prepare(`
          SELECT id FROM goal_executions
          WHERE id = ? AND goal_id = ? AND workspace_id = ? AND lease_generation = ?
        `).get(
          projection.activeExecutionId,
          projection.goalId,
          projection.workspaceId,
          projection.executionGeneration,
        );
    if (!isRecord(execution) || typeof execution.id !== 'string') {
      throw new GoalRuntimeSnapshotStoreError(
        'invalid_projection',
        'Goal runtime snapshot execution identity/generation has no matching durable receipt',
      );
    }
  }

  private toRecord(row: GoalRuntimeSnapshotRow): GoalRuntimeSnapshotRecord {
    if (row.contract_version !== GOAL_RUNTIME_CONTRACT_VERSION) {
      throw new GoalRuntimeSnapshotStoreError(
        'corrupt',
        `Unsupported Goal runtime snapshot contract version '${row.contract_version}'`,
      );
    }
    const projection = normalizeProjection({
      contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
      goalId: row.goal_id,
      workspaceId: row.workspace_id,
      lifecycleState: row.lifecycle_state,
      runtimeState: row.runtime_state,
      desiredRuntimeState: row.desired_runtime_state,
      integrationState: row.integration_state,
      workspaceState: row.workspace_state,
      ...(row.active_execution_id === null ? {} : { activeExecutionId: row.active_execution_id }),
      ...(row.execution_generation === null ? {} : { executionGeneration: row.execution_generation }),
      ...(row.phase === null ? {} : { phase: row.phase }),
      ...(row.progress_json === null ? {} : { progress: parseProgress(row.progress_json, 'corrupt') }),
      lastActivityAt: row.last_activity_at,
      ...(row.last_heartbeat_at === null ? {} : { lastHeartbeatAt: row.last_heartbeat_at }),
      ...(row.blocker_kind === null
        ? {}
        : {
            blocker: {
              kind: row.blocker_kind,
              ...(row.blocker_detail === null ? {} : { detail: row.blocker_detail }),
              ...(row.blocker_observed_at === null ? {} : { observedAt: row.blocker_observed_at }),
            },
          }),
    }, 'corrupt');
    const lastEventSequence = nonNegativeInteger(row.last_event_sequence, 'last_event_sequence', 'corrupt');
    validateIso(row.updated_at, 'updated_at', 'corrupt');
    return { projection, lastEventSequence, updatedAt: row.updated_at };
  }

  private requireRow(value: unknown): GoalRuntimeSnapshotRow {
    if (!isRecord(value)) throw new GoalRuntimeSnapshotStoreError('corrupt', 'Goal runtime snapshot row is invalid');
    const requiredStrings = [
      'goal_id',
      'workspace_id',
      'lifecycle_state',
      'runtime_state',
      'desired_runtime_state',
      'integration_state',
      'workspace_state',
      'last_activity_at',
      'updated_at',
    ];
    if (!requiredStrings.every((key) => typeof value[key] === 'string')) {
      throw new GoalRuntimeSnapshotStoreError('corrupt', 'Goal runtime snapshot required fields are invalid');
    }
    const nullableStrings = [
      'active_execution_id',
      'phase',
      'progress_json',
      'last_heartbeat_at',
      'blocker_kind',
      'blocker_detail',
      'blocker_observed_at',
    ];
    if (!nullableStrings.every((key) => value[key] === null || typeof value[key] === 'string')) {
      throw new GoalRuntimeSnapshotStoreError('corrupt', 'Goal runtime snapshot optional fields are invalid');
    }
    if (typeof value.contract_version !== 'number'
      || typeof value.last_event_sequence !== 'number'
      || (value.execution_generation !== null && typeof value.execution_generation !== 'number')) {
      throw new GoalRuntimeSnapshotStoreError('corrupt', 'Goal runtime snapshot numeric fields are invalid');
    }
    return value as unknown as GoalRuntimeSnapshotRow;
  }

  private transaction<T>(operation: () => T): T {
    const connection: DatabaseSync = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      const value = operation();
      connection.exec('COMMIT;');
      return value;
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
  }
}

function rowValues(
  projection: GoalRuntimeProjection,
  lastEventSequence: number,
  updatedAt: string,
): Array<string | number | null> {
  return [
    projection.workspaceId,
    projection.contractVersion,
    projection.lifecycleState,
    projection.runtimeState,
    projection.desiredRuntimeState,
    projection.integrationState,
    projection.workspaceState,
    projection.activeExecutionId ?? null,
    projection.executionGeneration ?? null,
    projection.phase ?? null,
    projection.progress === undefined ? null : JSON.stringify(projection.progress),
    projection.lastActivityAt,
    projection.lastHeartbeatAt ?? null,
    projection.blocker?.kind ?? null,
    projection.blocker?.detail ?? null,
    projection.blocker?.observedAt ?? null,
    lastEventSequence,
    updatedAt,
  ];
}

function normalizeProjection(
  value: GoalRuntimeProjection | Record<string, unknown>,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): GoalRuntimeProjection {
  if (!isRecord(value)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime projection is invalid');
  if (value.contractVersion !== GOAL_RUNTIME_CONTRACT_VERSION) {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime projection contract version is invalid');
  }
  const goalId = requiredIdentifier(value.goalId, 'goalId', reason);
  const workspaceId = requiredIdentifier(value.workspaceId, 'workspaceId', reason);
  if (!isGoalLifecycleState(value.lifecycleState)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal lifecycle state is invalid');
  if (!isGoalRuntimeState(value.runtimeState)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime state is invalid');
  if (!isGoalDesiredRuntimeState(value.desiredRuntimeState)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal desired runtime state is invalid');
  if (!isGoalIntegrationState(value.integrationState)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal integration state is invalid');
  if (!isGoalWorkspaceState(value.workspaceState)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal workspace state is invalid');

  const activeExecutionId = value.activeExecutionId === undefined
    ? undefined
    : requiredIdentifier(value.activeExecutionId, 'activeExecutionId', reason);
  const executionGeneration = value.executionGeneration === undefined
    ? undefined
    : positiveInteger(value.executionGeneration, 'executionGeneration', reason);
  if (activeExecutionId !== undefined && executionGeneration === undefined) {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Active execution requires an execution generation');
  }

  const requiresExecution = runtimeRequiresActiveExecution(value.runtimeState);
  if (requiresExecution && activeExecutionId === undefined) {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Active Goal runtime state requires an active execution');
  }
  if (value.lifecycleState !== 'open' && requiresExecution) {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Closed Goal lifecycle cannot retain active runtime state');
  }
  if (activeExecutionId !== undefined
    && (value.runtimeState === 'idle' || value.runtimeState === 'failed' || value.runtimeState === 'cancelled')) {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Terminal/idle runtime state cannot retain an active execution');
  }

  const phase = optionalText(value.phase, 'phase', reason);
  const progress = value.progress === undefined
    ? undefined
    : normalizeProgress(value.progress, reason);
  const lastActivityAt = requiredIso(value.lastActivityAt, 'lastActivityAt', reason);
  const lastHeartbeatAt = value.lastHeartbeatAt === undefined
    ? undefined
    : requiredIso(value.lastHeartbeatAt, 'lastHeartbeatAt', reason);
  const blocker = value.blocker === undefined
    ? undefined
    : normalizeBlocker(value.blocker, reason);

  return {
    contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
    goalId,
    workspaceId,
    lifecycleState: value.lifecycleState,
    runtimeState: value.runtimeState,
    desiredRuntimeState: value.desiredRuntimeState,
    integrationState: value.integrationState,
    workspaceState: value.workspaceState,
    ...(activeExecutionId === undefined ? {} : { activeExecutionId }),
    ...(executionGeneration === undefined ? {} : { executionGeneration }),
    ...(phase === undefined ? {} : { phase }),
    ...(progress === undefined ? {} : { progress }),
    lastActivityAt,
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    ...(blocker === undefined ? {} : { blocker }),
  };
}

function normalizeProgress(
  value: unknown,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): GoalRuntimeProgress {
  if (!isRecord(value)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime progress is invalid');
  const phase = optionalText(value.phase, 'progress.phase', reason);
  const detail = optionalText(value.detail, 'progress.detail', reason);
  const completedUnits = value.completedUnits === undefined
    ? undefined
    : nonNegativeNumber(value.completedUnits, 'progress.completedUnits', reason);
  const totalUnits = value.totalUnits === undefined
    ? undefined
    : nonNegativeNumber(value.totalUnits, 'progress.totalUnits', reason);
  if (completedUnits !== undefined && totalUnits !== undefined && completedUnits > totalUnits) {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime completed units exceed total units');
  }

  let steps: readonly GoalRuntimeProgressStep[] | undefined;
  if (value.steps !== undefined) {
    if (!Array.isArray(value.steps) || value.steps.length > MAX_PROGRESS_STEPS) {
      throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime progress steps are invalid');
    }
    steps = value.steps.map((step) => normalizeProgressStep(step, reason));
  }

  return {
    ...(phase === undefined ? {} : { phase }),
    ...(steps === undefined ? {} : { steps }),
    ...(completedUnits === undefined ? {} : { completedUnits }),
    ...(totalUnits === undefined ? {} : { totalUnits }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function normalizeProgressStep(
  value: unknown,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): GoalRuntimeProgressStep {
  if (!isRecord(value)) throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime progress step is invalid');
  const id = requiredIdentifier(value.id, 'progress step id', reason);
  const title = requiredText(value.title, 'progress step title', reason);
  if (value.state !== 'pending'
    && value.state !== 'running'
    && value.state !== 'completed'
    && value.state !== 'failed'
    && value.state !== 'blocked') {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime progress step state is invalid');
  }
  const summary = optionalText(value.summary, 'progress step summary', reason);
  return {
    id,
    title,
    state: value.state,
    ...(summary === undefined ? {} : { summary }),
  };
}

function normalizeBlocker(
  value: unknown,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): GoalRuntimeBlocker {
  if (!isRecord(value) || !isGoalBlockerKind(value.kind)) {
    throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime blocker is invalid');
  }
  const detail = optionalText(value.detail, 'blocker.detail', reason);
  const observedAt = value.observedAt === undefined
    ? undefined
    : requiredIso(value.observedAt, 'blocker.observedAt', reason);
  return {
    kind: value.kind,
    ...(detail === undefined ? {} : { detail }),
    ...(observedAt === undefined ? {} : { observedAt }),
  };
}

function parseProgress(
  serialized: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): GoalRuntimeProgress {
  try {
    return normalizeProgress(JSON.parse(serialized) as unknown, reason);
  } catch (error) {
    if (error instanceof GoalRuntimeSnapshotStoreError) throw error;
    throw new GoalRuntimeSnapshotStoreError(reason, 'Goal runtime progress JSON is corrupt');
  }
}

function sameProjection(left: GoalRuntimeProjection, right: GoalRuntimeProjection): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function runtimeRequiresActiveExecution(state: GoalRuntimeProjection['runtimeState']): boolean {
  return state === 'queued'
    || state === 'starting'
    || state === 'running'
    || state === 'paused'
    || state === 'waiting_approval'
    || state === 'waiting_input'
    || state === 'blocked'
    || state === 'recovering'
    || state === 'recovery_required';
}

function requireIdentifier(value: unknown, label: string): void {
  requiredIdentifier(value, label, 'invalid_projection');
}

function requiredIdentifier(
  value: unknown,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_ID_CHARS) {
    throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  }
  return value;
}

function requiredText(
  value: unknown,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEXT_CHARS) {
    throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS) {
    throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(
  value: unknown,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  }
  return value;
}

function nonNegativeNumber(
  value: unknown,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  }
  return value;
}

function requiredIso(
  value: unknown,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): string {
  if (typeof value !== 'string') throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  validateIso(value, label, reason);
  return value;
}

function validateIso(
  value: string,
  label: string,
  reason: GoalRuntimeSnapshotStoreError['reason'],
): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new GoalRuntimeSnapshotStoreError(reason, `${label} is invalid`);
  }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GoalRuntimeSnapshotStoreError('invalid_projection', 'limit is invalid');
  }
  return Math.min(value, MAX_LIST_LIMIT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
