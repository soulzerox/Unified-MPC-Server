import { randomUUID } from 'node:crypto';
import type {
  HeavyJobClaimResult,
  HeavyJobLiveEntry,
  HeavyJobLiveState,
  HeavyJobQueueEntry,
  HeavyJobQueueStore,
  HeavyJobRecoveryAction,
  HeavyJobSupersedeStoreResult,
} from '@unified-mpc/workspace';
import { isResourceAdmissionClass } from '@unified-mpc/workspace';
import type { SqliteDatabase } from './database.js';

const MAX_IDENTIFIER_CHARS = 128;
const MAX_JOB_KIND_CHARS = 128;
const MAX_DETAIL_CHARS = 4_096;
const MAX_QUEUED_JOBS = 4_096;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

const LIVE_STATES = new Set<HeavyJobLiveState>(['queued', 'running']);

export type HeavyJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'superseded';

/** One stored queue row in any lifecycle state, for recovery and diagnostics. */
export interface HeavyJobStoredEntry extends HeavyJobQueueEntry {
  readonly state: HeavyJobState;
  readonly position: number;
  readonly attempt: number;
  readonly ownerId?: string;
  readonly startedAt?: string;
  readonly heartbeatAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
}

export interface SqliteHeavyJobQueueRepositoryOptions {
  /**
   * Stable identity for this queue owner. Every claim records it so a live
   * owner's queued/running work can never be stolen by another process.
   */
  readonly ownerId?: string;
  readonly now?: () => Date;
  /** Automatic heartbeat interval; `0` disables the timer. */
  readonly heartbeatIntervalMs?: number;
}

interface HeavyJobRow {
  readonly operation_id: string;
  readonly workspace_id: string;
  readonly session_id: string | null;
  readonly job_kind: string;
  readonly resource_class: string;
  readonly cost: number;
  readonly blocking: number;
  readonly state: string;
  readonly position: number;
  readonly attempt: number;
  readonly owner_id: string | null;
  readonly requested_at: string;
  readonly started_at: string | null;
  readonly heartbeat_at: string;
  readonly finished_at: string | null;
  readonly detail: string | null;
}

export class HeavyJobQueueStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_entry' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'HeavyJobQueueStoreError';
  }
}

/**
 * Durable heavy-job queue state (#145 U5).
 *
 * Every transition is a single SQLite transaction. Ownership is fenced by
 * `owner_id`, so a claim can adopt only this owner's queued rows (or rows
 * already orphaned by restart recovery) — a live foreign owner is never
 * silently displaced.
 */
export class SqliteHeavyJobQueueRepository implements HeavyJobQueueStore {
  public readonly ownerId: string;
  private readonly now: () => Date;
  private readonly heartbeatIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(
    private readonly database: SqliteDatabase,
    options: SqliteHeavyJobQueueRepositoryOptions = {},
  ) {
    requireIdentifier(options.ownerId ?? randomUUID(), 'ownerId');
    this.ownerId = options.ownerId ?? randomUUID();
    this.now = options.now ?? ((): Date => new Date());
    const interval = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 0) {
      throw new HeavyJobQueueStoreError('invalid_entry', 'heartbeatIntervalMs must be a non-negative safe integer');
    }
    this.heartbeatIntervalMs = interval;
  }

  /** Start proving this owner is alive; safe to call more than once. */
  public startHeartbeat(): void {
    if (this.timer !== undefined || this.heartbeatIntervalMs === 0) return;
    this.timer = setInterval(() => {
      try {
        this.heartbeat(this.now().toISOString());
      } catch {
        // A missed beat must not crash the owner; recovery fails closed on the
        // next stale sweep instead of inventing liveness.
      }
    }, this.heartbeatIntervalMs);
    this.timer.unref?.();
  }

  public close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Refresh the liveness proof for every live row owned by this repository. */
  public heartbeat(heartbeatAt: string): number {
    validateIso(heartbeatAt, 'heartbeatAt');
    const updated = this.database.connection.prepare(`
      UPDATE heavy_jobs
      SET heartbeat_at = ?
      WHERE owner_id = ? AND state IN ('queued', 'running')
    `).run(heartbeatAt, this.ownerId);
    return Number(updated.changes);
  }

  public claim(entry: HeavyJobQueueEntry, maxQueued: number): HeavyJobClaimResult {
    const normalized = normalizeEntry(entry);
    validateMaxQueued(maxQueued);
    const now = this.now().toISOString();

    return this.transaction((): HeavyJobClaimResult => {
      const existing = this.find(normalized.operationId);
      if (existing !== undefined && LIVE_STATES.has(existing.state as HeavyJobLiveState)) {
        if (existing.state === 'running') {
          return { status: 'running', operationId: normalized.operationId, depth: this.depth() };
        }
        if (existing.owner_id !== null && existing.owner_id !== this.ownerId) {
          return { status: 'coalesced', operationId: normalized.operationId, depth: this.depth() };
        }
        this.database.connection.prepare(`
          UPDATE heavy_jobs
          SET owner_id = ?, heartbeat_at = ?
          WHERE operation_id = ? AND state = 'queued'
        `).run(this.ownerId, now, normalized.operationId);
        return {
          status: 'queued',
          operationId: normalized.operationId,
          position: existing.position,
          depth: this.depth(),
        };
      }

      const depth = this.depth();
      if (depth >= maxQueued) {
        return { status: 'full', operationId: normalized.operationId, depth };
      }
      const position = this.nextPosition();
      if (existing !== undefined) {
        // A terminal exact-input row is re-claimable as a new attempt. Keeping
        // one row per operation identity bounds the table by distinct inputs.
        this.database.connection.prepare(`
          UPDATE heavy_jobs
          SET state = 'queued', position = ?, attempt = attempt + 1, owner_id = ?,
              requested_at = ?, started_at = NULL, heartbeat_at = ?,
              finished_at = NULL, detail = NULL
          WHERE operation_id = ?
        `).run(position, this.ownerId, normalized.requestedAt, now, normalized.operationId);
      } else {
        this.database.connection.prepare(`
          INSERT INTO heavy_jobs (
            operation_id, workspace_id, session_id, job_kind, resource_class, cost,
            blocking, state, position, attempt, owner_id, requested_at,
            started_at, heartbeat_at, finished_at, detail
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 1, ?, ?, NULL, ?, NULL, NULL)
        `).run(
          normalized.operationId,
          normalized.workspaceId,
          normalized.sessionId ?? null,
          normalized.jobKind,
          normalized.resourceClass,
          normalized.cost,
          normalized.blocking ? 1 : 0,
          position,
          this.ownerId,
          normalized.requestedAt,
          now,
        );
      }
      return { status: 'queued', operationId: normalized.operationId, position, depth: this.depth() };
    });
  }

  public promote(operationId: string): number | undefined {
    requireIdentifier(operationId, 'operationId');
    return this.transaction((): number | undefined => {
      const existing = this.find(operationId);
      if (existing === undefined || existing.state !== 'queued') return undefined;
      if (existing.owner_id !== null && existing.owner_id !== this.ownerId) return undefined;
      const row = this.database.connection.prepare(`
        SELECT COALESCE(MIN(position), 0) - 1 AS position
        FROM heavy_jobs
        WHERE state = 'queued' AND operation_id <> ?
      `).get(operationId);
      const position = requireNumber(row, 'position');
      this.database.connection.prepare(`
        UPDATE heavy_jobs SET position = ? WHERE operation_id = ? AND state = 'queued'
      `).run(position, operationId);
      return position;
    });
  }

  public cancel(operationId: string, finishedAt: string): boolean {
    requireIdentifier(operationId, 'operationId');
    validateIso(finishedAt, 'finishedAt');
    const updated = this.database.connection.prepare(`
      UPDATE heavy_jobs
      SET state = 'cancelled', finished_at = ?, detail = NULL
      WHERE operation_id = ? AND state = 'queued'
        AND (owner_id = ? OR owner_id IS NULL)
    `).run(finishedAt, operationId, this.ownerId);
    return Number(updated.changes) === 1;
  }

  public supersede(
    staleOperationId: string,
    entry: HeavyJobQueueEntry,
    maxQueued: number,
  ): HeavyJobSupersedeStoreResult {
    requireIdentifier(staleOperationId, 'staleOperationId');
    const normalized = normalizeEntry(entry);
    validateMaxQueued(maxQueued);
    const now = this.now().toISOString();

    return this.transaction((): HeavyJobSupersedeStoreResult => {
      const replacement = this.find(normalized.operationId);
      if (replacement !== undefined && LIVE_STATES.has(replacement.state as HeavyJobLiveState)) {
        this.retireQueued(staleOperationId, 'superseded', now);
        return { status: 'coalesced', operationId: normalized.operationId, depth: this.depth() };
      }

      const stale = this.find(staleOperationId);
      const staleQueued = stale !== undefined && stale.state === 'queued'
        && (stale.owner_id === null || stale.owner_id === this.ownerId);
      if (!staleQueued) {
        const depth = this.depth();
        if (depth >= maxQueued) {
          return { status: 'full', operationId: normalized.operationId, depth };
        }
        const position = this.nextPosition();
        if (replacement !== undefined) {
          this.database.connection.prepare(`
            UPDATE heavy_jobs
            SET state = 'queued', position = ?, attempt = attempt + 1, owner_id = ?,
                requested_at = ?, started_at = NULL, heartbeat_at = ?,
                finished_at = NULL, detail = NULL
            WHERE operation_id = ?
          `).run(position, this.ownerId, normalized.requestedAt, now, normalized.operationId);
        } else {
          this.insertQueued(normalized, position, now);
        }
        return { status: 'queued', operationId: normalized.operationId, position, depth: this.depth() };
      }

      this.retireQueued(staleOperationId, 'superseded', now);
      const position = stale.position;
      if (replacement !== undefined) {
        this.database.connection.prepare(`
          UPDATE heavy_jobs
          SET state = 'queued', position = ?, attempt = attempt + 1, owner_id = ?,
              requested_at = ?, started_at = NULL, heartbeat_at = ?,
              finished_at = NULL, detail = NULL
          WHERE operation_id = ?
        `).run(position, this.ownerId, normalized.requestedAt, now, normalized.operationId);
      } else {
        this.insertQueued(normalized, position, now);
      }
      return { status: 'superseded', operationId: normalized.operationId, position, depth: this.depth() };
    });
  }

  public start(operationId: string, startedAt: string): boolean {
    requireIdentifier(operationId, 'operationId');
    validateIso(startedAt, 'startedAt');
    const updated = this.database.connection.prepare(`
      UPDATE heavy_jobs
      SET state = 'running', started_at = ?, heartbeat_at = ?
      WHERE operation_id = ? AND state = 'queued' AND owner_id = ?
    `).run(startedAt, startedAt, operationId, this.ownerId);
    return Number(updated.changes) === 1;
  }

  public settle(
    operationId: string,
    outcome: 'completed' | 'failed',
    finishedAt: string,
    detail?: string,
  ): boolean {
    requireIdentifier(operationId, 'operationId');
    validateIso(finishedAt, 'finishedAt');
    const boundedDetail = optionalDetail(detail);
    const updated = this.database.connection.prepare(`
      UPDATE heavy_jobs
      SET state = ?, finished_at = ?, detail = ?
      WHERE operation_id = ? AND state = 'running' AND owner_id = ?
    `).run(outcome, finishedAt, boundedDetail ?? null, operationId, this.ownerId);
    return Number(updated.changes) === 1;
  }

  public recover(
    operationId: string,
    action: HeavyJobRecoveryAction,
    input: { readonly at: string; readonly detail?: string },
  ): boolean {
    requireIdentifier(operationId, 'operationId');
    validateIso(input.at, 'at');
    const detail = optionalDetail(input.detail);
    if (action === 'orphan') {
      const updated = this.database.connection.prepare(`
        UPDATE heavy_jobs
        SET owner_id = NULL, heartbeat_at = ?
        WHERE operation_id = ? AND state = 'queued'
      `).run(input.at, operationId);
      return Number(updated.changes) === 1;
    }
    if (action === 'interrupt') {
      const updated = this.database.connection.prepare(`
        UPDATE heavy_jobs
        SET state = 'interrupted', finished_at = ?, detail = ?
        WHERE operation_id = ? AND state = 'running'
      `).run(input.at, detail ?? null, operationId);
      return Number(updated.changes) === 1;
    }
    if (action === 'expire') {
      const updated = this.database.connection.prepare(`
        UPDATE heavy_jobs
        SET state = 'cancelled', finished_at = ?, detail = ?
        WHERE operation_id = ? AND state = 'queued'
      `).run(input.at, detail ?? null, operationId);
      return Number(updated.changes) === 1;
    }
    throw new HeavyJobQueueStoreError('invalid_entry', `Unknown heavy-job recovery action '${String(action)}'`);
  }

  public depth(): number {
    const row = this.database.connection.prepare(
      "SELECT COUNT(*) AS depth FROM heavy_jobs WHERE state = 'queued'",
    ).get();
    return requireNumber(row, 'depth');
  }

  public listLive(): readonly HeavyJobLiveEntry[] {
    const rows = this.database.connection.prepare(`
      SELECT * FROM heavy_jobs
      WHERE state IN ('queued', 'running')
      ORDER BY CASE state WHEN 'queued' THEN 0 ELSE 1 END, position ASC, operation_id ASC
    `).all();
    return rows.map((row) => toLiveEntry(this.requireRow(row)));
  }

  /** Read one row in any lifecycle state (read-only diagnostics/recovery). */
  public get(operationId: string): HeavyJobStoredEntry | undefined {
    requireIdentifier(operationId, 'operationId');
    const row = this.find(operationId);
    return row === undefined ? undefined : toStoredEntry(row);
  }

  private find(operationId: string): HeavyJobRow | undefined {
    const row = this.database.connection.prepare(
      'SELECT * FROM heavy_jobs WHERE operation_id = ?',
    ).get(operationId);
    return row === undefined ? undefined : this.requireRow(row);
  }

  private retireQueued(operationId: string, state: 'superseded', finishedAt: string): boolean {
    const updated = this.database.connection.prepare(`
      UPDATE heavy_jobs
      SET state = ?, finished_at = ?, detail = NULL
      WHERE operation_id = ? AND state = 'queued'
    `).run(state, finishedAt, operationId);
    return Number(updated.changes) === 1;
  }

  private insertQueued(entry: HeavyJobQueueEntry, position: number, heartbeatAt: string): void {
    this.database.connection.prepare(`
      INSERT INTO heavy_jobs (
        operation_id, workspace_id, session_id, job_kind, resource_class, cost,
        blocking, state, position, attempt, owner_id, requested_at,
        started_at, heartbeat_at, finished_at, detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, 1, ?, ?, NULL, ?, NULL, NULL)
    `).run(
      entry.operationId,
      entry.workspaceId,
      entry.sessionId ?? null,
      entry.jobKind,
      entry.resourceClass,
      entry.cost,
      entry.blocking ? 1 : 0,
      position,
      this.ownerId,
      entry.requestedAt,
      heartbeatAt,
    );
  }

  private nextPosition(): number {
    const row = this.database.connection.prepare(
      'SELECT COALESCE(MAX(position), 0) + 1 AS position FROM heavy_jobs',
    ).get();
    return requireNumber(row, 'position');
  }

  private transaction<T>(operation: () => T): T {
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      connection.exec('COMMIT;');
      return result;
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }
  }

  private requireRow(value: unknown): HeavyJobRow {
    if (!isRecord(value)
      || typeof value.operation_id !== 'string'
      || typeof value.workspace_id !== 'string'
      || (value.session_id !== null && typeof value.session_id !== 'string')
      || typeof value.job_kind !== 'string'
      || typeof value.resource_class !== 'string'
      || typeof value.cost !== 'number'
      || typeof value.blocking !== 'number'
      || typeof value.state !== 'string'
      || typeof value.position !== 'number'
      || typeof value.attempt !== 'number'
      || (value.owner_id !== null && typeof value.owner_id !== 'string')
      || typeof value.requested_at !== 'string'
      || (value.started_at !== null && typeof value.started_at !== 'string')
      || typeof value.heartbeat_at !== 'string'
      || (value.finished_at !== null && typeof value.finished_at !== 'string')
      || (value.detail !== null && typeof value.detail !== 'string')) {
      throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue row has invalid columns');
    }
    return value as unknown as HeavyJobRow;
  }
}

function normalizeEntry(entry: HeavyJobQueueEntry): HeavyJobQueueEntry {
  requireIdentifier(entry.operationId, 'operationId');
  requireIdentifier(entry.workspaceId, 'workspaceId');
  if (entry.sessionId !== undefined) requireIdentifier(entry.sessionId, 'sessionId');
  requireBounded(entry.jobKind, 'jobKind', MAX_JOB_KIND_CHARS);
  if (!isResourceAdmissionClass(entry.resourceClass)) {
    throw new HeavyJobQueueStoreError('invalid_entry', 'resourceClass is invalid');
  }
  requirePositiveInteger(entry.cost, 'cost');
  validateIso(entry.requestedAt, 'requestedAt');
  if (typeof entry.blocking !== 'boolean') {
    throw new HeavyJobQueueStoreError('invalid_entry', 'blocking must be a boolean');
  }
  return entry;
}

function toLiveEntry(row: HeavyJobRow): HeavyJobLiveEntry {
  if (!LIVE_STATES.has(row.state as HeavyJobLiveState)) {
    throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue row is not live');
  }
  const entry = toBaseEntry(row);
  if (row.state === 'running' && row.started_at === null) {
    throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue running row has no start time');
  }
  return {
    ...entry,
    state: row.state as HeavyJobLiveState,
    position: row.position,
    attempt: row.attempt,
    ...(row.owner_id === null ? {} : { ownerId: row.owner_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    heartbeatAt: row.heartbeat_at,
  };
}

function toStoredEntry(row: HeavyJobRow): HeavyJobStoredEntry {
  if (!isHeavyJobState(row.state)) {
    throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue state is invalid');
  }
  return {
    ...toBaseEntry(row),
    state: row.state,
    position: row.position,
    attempt: row.attempt,
    ...(row.owner_id === null ? {} : { ownerId: row.owner_id }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    heartbeatAt: row.heartbeat_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.detail === null ? {} : { detail: row.detail }),
  };
}

function toBaseEntry(row: HeavyJobRow): HeavyJobQueueEntry {
  if (!isResourceAdmissionClass(row.resource_class)) {
    throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue resourceClass is invalid');
  }
  if (!Number.isSafeInteger(row.position) || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
    throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue row counters are invalid');
  }
  if (row.blocking !== 0 && row.blocking !== 1) {
    throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue blocking flag is invalid');
  }
  if (!Number.isSafeInteger(row.cost) || row.cost < 1) {
    throw new HeavyJobQueueStoreError('corrupt', 'Heavy-job queue cost is invalid');
  }
  return {
    operationId: row.operation_id,
    workspaceId: row.workspace_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    jobKind: row.job_kind,
    resourceClass: row.resource_class,
    cost: row.cost,
    blocking: row.blocking === 1,
    requestedAt: row.requested_at,
  };
}

function isHeavyJobState(value: string): value is HeavyJobState {
  return value === 'queued'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'interrupted'
    || value === 'superseded';
}


function requireIdentifier(value: unknown, label: string): asserts value is string {
  requireBounded(value, label, MAX_IDENTIFIER_CHARS);
}

function requireBounded(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new HeavyJobQueueStoreError('invalid_entry', `${label} is invalid`);
  }
}

function requirePositiveInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new HeavyJobQueueStoreError('invalid_entry', `${label} is invalid`);
  }
}

function validateMaxQueued(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_QUEUED_JOBS) {
    throw new HeavyJobQueueStoreError('invalid_entry', `maxQueued must be between 1 and ${MAX_QUEUED_JOBS}`);
  }
}

function validateIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new HeavyJobQueueStoreError('invalid_entry', `${label} is invalid`);
  }
}

function optionalDetail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HeavyJobQueueStoreError('invalid_entry', 'detail is invalid');
  return value.length <= MAX_DETAIL_CHARS ? value : value.slice(0, MAX_DETAIL_CHARS);
}

function requireNumber(value: unknown, key: string): number {
  if (!isRecord(value) || typeof value[key] !== 'number') {
    throw new HeavyJobQueueStoreError('corrupt', `Heavy-job queue ${key} is invalid`);
  }
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
