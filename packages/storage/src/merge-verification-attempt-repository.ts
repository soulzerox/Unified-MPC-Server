import type { SqliteDatabase } from './database.js';

const MAX_ATTEMPT_ID_CHARS = 256;
const MAX_REPOSITORY_CHARS = 512;
const MAX_WORKSPACE_ID_CHARS = 128;
const MAX_GATE_NAME_CHARS = 512;
const MAX_BRANCH_CHARS = 256;
const MAX_DETAIL_CHARS = 4_096;
const MAX_RECEIPT_REF_CHARS = 1_024;
const MAX_LIST_LIMIT = 100;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

const TERMINAL_STATUSES = new Set<MergeVerificationAttemptStatus>(['completed', 'failed', 'interrupted']);
const LIVE_STATUSES = new Set<MergeVerificationAttemptStatus>(['queued', 'running']);

/**
 * `queued` means the exact-head request was accepted but heavy admission was denied.
 * The row is durable and truthful: no gate ran, no receipt exists, and the next
 * `merge_verification_run` for the same head claims this row instead of duplicating it.
 */
export type MergeVerificationAttemptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';

export interface MergeVerificationAttemptRecord {
  readonly attemptId: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseBranch?: string;
  readonly workspaceId?: string;
  readonly status: MergeVerificationAttemptStatus;
  readonly gateName?: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly finishedAt?: string;
  readonly detail?: string;
  readonly receiptRef?: string;
}

/** A row that is still live (`queued` or `running`); never a terminal verdict. */
export type LiveMergeVerificationAttemptRecord = MergeVerificationAttemptRecord & {
  readonly status: 'queued' | 'running';
};

export interface BeginMergeVerificationAttemptRequest {
  readonly attemptId: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseBranch?: string;
  readonly workspaceId?: string;
  readonly startedAt: string;
}

export interface HeartbeatMergeVerificationAttemptRequest {
  readonly heartbeatAt: string;
  readonly gateName?: string;
}

/** Persist a durable `queued` attempt for a denied heavy admission (#305). */
export interface QueueMergeVerificationAttemptRequest {
  readonly attemptId: string;
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly baseBranch?: string;
  readonly workspaceId?: string;
  readonly requestedAt: string;
}

/** Atomically promote one `queued` attempt to `running`. */
export interface ClaimQueuedMergeVerificationAttemptRequest {
  readonly claimedAt: string;
  /** The workspace the promoted run will actually use; keeps the row truthful. */
  readonly workspaceId?: string;
}

export interface FinishMergeVerificationAttemptRequest {
  readonly status: 'completed' | 'failed';
  readonly finishedAt: string;
  readonly detail?: string;
  readonly receiptRef?: string;
}

export interface ReapStaleMergeVerificationAttemptsRequest {
  readonly now: string;
  readonly staleAfterMs: number;
}

export interface ListMergeVerificationAttemptsRequest {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha?: string;
  readonly limit?: number;
}

export interface FindLiveMergeVerificationAttemptRequest {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly now: string;
  readonly staleAfterMs: number;
}

interface MergeVerificationAttemptRow {
  readonly attempt_id: string;
  readonly repository: string;
  readonly pull_request: number;
  readonly head_sha: string;
  readonly base_branch: string | null;
  readonly workspace_id: string | null;
  readonly status: string;
  readonly gate_name: string | null;
  readonly started_at: string;
  readonly heartbeat_at: string;
  readonly finished_at: string | null;
  readonly detail: string | null;
  readonly receipt_ref: string | null;
}

export class MergeVerificationAttemptStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_attempt' | 'attempt_conflict' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'MergeVerificationAttemptStoreError';
  }
}

export class SqliteMergeVerificationAttemptRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async begin(
    request: BeginMergeVerificationAttemptRequest,
  ): Promise<MergeVerificationAttemptRecord> {
    const attemptId = requiredBounded(request.attemptId, 'attemptId', MAX_ATTEMPT_ID_CHARS);
    const repository = requiredBounded(request.repository, 'repository', MAX_REPOSITORY_CHARS);
    positiveInteger(request.pullRequest, 'pullRequest');
    validateSha(request.headSha, 'headSha');
    const baseBranch = request.baseBranch === undefined
      ? undefined
      : requiredBounded(request.baseBranch, 'baseBranch', MAX_BRANCH_CHARS);
    const workspaceId = request.workspaceId === undefined
      ? undefined
      : requiredBounded(request.workspaceId, 'workspaceId', MAX_WORKSPACE_ID_CHARS);
    validateIso(request.startedAt, 'startedAt');

    const inserted = this.database.connection.prepare(`
      INSERT OR IGNORE INTO merge_verification_attempts (
        attempt_id,
        repository,
        pull_request,
        head_sha,
        base_branch,
        workspace_id,
        status,
        started_at,
        heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      attemptId,
      repository,
      request.pullRequest,
      request.headSha,
      baseBranch ?? null,
      workspaceId ?? null,
      request.startedAt,
      request.startedAt,
    );

    if (Number(inserted.changes) !== 1) {
      throw new MergeVerificationAttemptStoreError(
        'attempt_conflict',
        `Merge verification attempt '${attemptId}' already exists`,
      );
    }

    return this.requireById(attemptId);
  }

  /**
   * Persist a `queued` attempt for an exact head whose heavy admission was denied.
   *
   * Nothing ran and no receipt exists; the row is the durable record of the request.
   * The single-live partial unique index also covers `queued`, so a second enqueue for
   * the same head conflicts instead of creating a duplicate queue entry.
   */
  public async enqueue(
    request: QueueMergeVerificationAttemptRequest,
  ): Promise<MergeVerificationAttemptRecord> {
    const attemptId = requiredBounded(request.attemptId, 'attemptId', MAX_ATTEMPT_ID_CHARS);
    const repository = requiredBounded(request.repository, 'repository', MAX_REPOSITORY_CHARS);
    positiveInteger(request.pullRequest, 'pullRequest');
    validateSha(request.headSha, 'headSha');
    const baseBranch = request.baseBranch === undefined
      ? undefined
      : requiredBounded(request.baseBranch, 'baseBranch', MAX_BRANCH_CHARS);
    const workspaceId = request.workspaceId === undefined
      ? undefined
      : requiredBounded(request.workspaceId, 'workspaceId', MAX_WORKSPACE_ID_CHARS);
    validateIso(request.requestedAt, 'requestedAt');

    const inserted = this.database.connection.prepare(`
      INSERT OR IGNORE INTO merge_verification_attempts (
        attempt_id,
        repository,
        pull_request,
        head_sha,
        base_branch,
        workspace_id,
        status,
        started_at,
        heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      attemptId,
      repository,
      request.pullRequest,
      request.headSha,
      baseBranch ?? null,
      workspaceId ?? null,
      request.requestedAt,
      request.requestedAt,
    );

    if (Number(inserted.changes) !== 1) {
      throw new MergeVerificationAttemptStoreError(
        'attempt_conflict',
        `A queued or running merge verification already exists for ${repository}#${request.pullRequest}@${request.headSha}`,
      );
    }

    return this.requireById(attemptId);
  }

  /**
   * Promote one queued attempt to running. Exactly one caller wins the transition;
   * a losing caller must re-read durable state instead of running the gates twice.
   */
  public async claimQueued(
    attemptId: string,
    request: ClaimQueuedMergeVerificationAttemptRequest,
  ): Promise<MergeVerificationAttemptRecord> {
    const normalizedAttemptId = requiredBounded(attemptId, 'attemptId', MAX_ATTEMPT_ID_CHARS);
    validateIso(request.claimedAt, 'claimedAt');
    const workspaceId = request.workspaceId === undefined
      ? undefined
      : requiredBounded(request.workspaceId, 'workspaceId', MAX_WORKSPACE_ID_CHARS);

    const updated = this.database.connection.prepare(`
      UPDATE merge_verification_attempts
      SET status = 'running', heartbeat_at = ?, workspace_id = COALESCE(?, workspace_id)
      WHERE attempt_id = ? AND status = 'queued'
    `).run(request.claimedAt, workspaceId ?? null, normalizedAttemptId);

    if (Number(updated.changes) !== 1) {
      throw new MergeVerificationAttemptStoreError(
        'attempt_conflict',
        `Merge verification attempt '${normalizedAttemptId}' is not queued`,
      );
    }

    return this.requireById(normalizedAttemptId);
  }

  public async heartbeat(
    attemptId: string,
    request: HeartbeatMergeVerificationAttemptRequest,
  ): Promise<boolean> {
    const normalizedAttemptId = requiredBounded(attemptId, 'attemptId', MAX_ATTEMPT_ID_CHARS);
    validateIso(request.heartbeatAt, 'heartbeatAt');
    const gateName = request.gateName === undefined
      ? undefined
      : requiredBounded(request.gateName, 'gateName', MAX_GATE_NAME_CHARS);

    const updated = this.database.connection.prepare(`
      UPDATE merge_verification_attempts
      SET heartbeat_at = ?, gate_name = COALESCE(?, gate_name)
      WHERE attempt_id = ? AND status = 'running'
    `).run(request.heartbeatAt, gateName ?? null, normalizedAttemptId);

    return Number(updated.changes) === 1;
  }

  public async finish(
    attemptId: string,
    request: FinishMergeVerificationAttemptRequest,
  ): Promise<MergeVerificationAttemptRecord> {
    const normalizedAttemptId = requiredBounded(attemptId, 'attemptId', MAX_ATTEMPT_ID_CHARS);
    if (request.status !== 'completed' && request.status !== 'failed') {
      throw new MergeVerificationAttemptStoreError('invalid_attempt', 'status must be completed or failed');
    }
    validateIso(request.finishedAt, 'finishedAt');
    const detail = optionalBounded(request.detail, 'detail', MAX_DETAIL_CHARS);
    const receiptRef = optionalBounded(request.receiptRef, 'receiptRef', MAX_RECEIPT_REF_CHARS);

    const updated = this.database.connection.prepare(`
      UPDATE merge_verification_attempts
      SET status = ?, finished_at = ?, detail = ?, receipt_ref = ?
      WHERE attempt_id = ? AND status = 'running'
    `).run(request.status, request.finishedAt, detail ?? null, receiptRef ?? null, normalizedAttemptId);

    if (Number(updated.changes) !== 1) {
      throw new MergeVerificationAttemptStoreError(
        'attempt_conflict',
        `Merge verification attempt '${normalizedAttemptId}' is not running`,
      );
    }

    return this.requireById(normalizedAttemptId);
  }

  public async markInterrupted(
    attemptId: string,
    request: { readonly finishedAt: string; readonly detail: string },
  ): Promise<MergeVerificationAttemptRecord> {
    const normalizedAttemptId = requiredBounded(attemptId, 'attemptId', MAX_ATTEMPT_ID_CHARS);
    validateIso(request.finishedAt, 'finishedAt');
    const detail = requiredBounded(request.detail, 'detail', MAX_DETAIL_CHARS);

    const updated = this.database.connection.prepare(`
      UPDATE merge_verification_attempts
      SET status = 'interrupted', finished_at = ?, detail = ?
      WHERE attempt_id = ? AND status = 'running'
    `).run(request.finishedAt, detail, normalizedAttemptId);

    if (Number(updated.changes) !== 1) {
      throw new MergeVerificationAttemptStoreError(
        'attempt_conflict',
        `Merge verification attempt '${normalizedAttemptId}' is not running`,
      );
    }

    return this.requireById(normalizedAttemptId);
  }

  /**
   * Marks every `running` attempt whose heartbeat fell behind the bounded grace window as
   * `interrupted`. This is the truthful recovery path after the host process died mid-gate:
   * the attempt row survives, but no verdict and no receipt were ever produced.
   */
  public async reapStale(
    request: ReapStaleMergeVerificationAttemptsRequest,
  ): Promise<readonly string[]> {
    validateIso(request.now, 'now');
    if (!Number.isInteger(request.staleAfterMs) || request.staleAfterMs <= 0) {
      throw new MergeVerificationAttemptStoreError('invalid_attempt', 'staleAfterMs must be a positive integer');
    }
    const cutoff = new Date(Date.parse(request.now) - request.staleAfterMs).toISOString();

    const rows = this.database.connection.prepare(`
      SELECT attempt_id
      FROM merge_verification_attempts
      WHERE status = 'running' AND heartbeat_at <= ?
      ORDER BY heartbeat_at ASC
    `).all(cutoff);

    const reaped: string[] = [];
    const update = this.database.connection.prepare(`
      UPDATE merge_verification_attempts
      SET status = 'interrupted', finished_at = ?, detail = ?
      WHERE attempt_id = ? AND status = 'running' AND heartbeat_at <= ?
    `);
    const detail = `Verification did not report a verdict before its heartbeat expired (${request.staleAfterMs}ms grace)`;

    for (const row of rows) {
      const attemptId = this.requireAttemptId(row);
      const result = update.run(request.now, detail, attemptId, cutoff);
      if (Number(result.changes) === 1) reaped.push(attemptId);
    }

    return reaped;
  }

  public async getById(attemptId: string): Promise<MergeVerificationAttemptRecord | undefined> {
    const normalized = requiredBounded(attemptId, 'attemptId', MAX_ATTEMPT_ID_CHARS);
    const row = this.database.connection.prepare(
      'SELECT * FROM merge_verification_attempts WHERE attempt_id = ?',
    ).get(normalized);
    return row === undefined ? undefined : this.toRecord(this.requireRow(row));
  }

  public async list(
    request: ListMergeVerificationAttemptsRequest,
  ): Promise<readonly MergeVerificationAttemptRecord[]> {
    const repository = requiredBounded(request.repository, 'repository', MAX_REPOSITORY_CHARS);
    positiveInteger(request.pullRequest, 'pullRequest');
    const limit = boundedLimit(request.limit ?? 20);

    if (request.headSha !== undefined) {
      validateSha(request.headSha, 'headSha');
      const rows = this.database.connection.prepare(`
        SELECT *
        FROM merge_verification_attempts
        WHERE repository = ? AND pull_request = ? AND head_sha = ?
        ORDER BY started_at DESC, attempt_id DESC
        LIMIT ?
      `).all(repository, request.pullRequest, request.headSha, limit);
      return rows.map((row) => this.toRecord(this.requireRow(row)));
    }

    const rows = this.database.connection.prepare(`
      SELECT *
      FROM merge_verification_attempts
      WHERE repository = ? AND pull_request = ?
      ORDER BY started_at DESC, attempt_id DESC
      LIMIT ?
    `).all(repository, request.pullRequest, limit);
    return rows.map((row) => this.toRecord(this.requireRow(row)));
  }

  /**
   * Live-or-queued lookup for one exact head. A `running` row only counts while its
   * heartbeat is fresh; a `queued` row never expires because no work has started.
   * Running rows are preferred so a real run always wins over a stale queue marker.
   */
  public async findActive(
    request: FindLiveMergeVerificationAttemptRequest,
  ): Promise<LiveMergeVerificationAttemptRecord | undefined> {
    const repository = requiredBounded(request.repository, 'repository', MAX_REPOSITORY_CHARS);
    positiveInteger(request.pullRequest, 'pullRequest');
    validateSha(request.headSha, 'headSha');
    validateIso(request.now, 'now');
    if (!Number.isInteger(request.staleAfterMs) || request.staleAfterMs <= 0) {
      throw new MergeVerificationAttemptStoreError('invalid_attempt', 'staleAfterMs must be a positive integer');
    }
    const cutoff = new Date(Date.parse(request.now) - request.staleAfterMs).toISOString();

    const row = this.database.connection.prepare(`
      SELECT *
      FROM merge_verification_attempts
      WHERE repository = ? AND pull_request = ? AND head_sha = ?
        AND (
          status = 'queued'
          OR (status = 'running' AND heartbeat_at > ?)
        )
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, started_at DESC, attempt_id DESC
      LIMIT 1
    `).get(repository, request.pullRequest, request.headSha, cutoff);

    if (row === undefined) return undefined;
    const record = this.toRecord(this.requireRow(row));
    const status = record.status;
    if (status !== 'queued' && status !== 'running') {
      throw new MergeVerificationAttemptStoreError('corrupt', 'Active attempt row has a non-live status');
    }
    return { ...record, status };
  }

  public async findLive(
    request: FindLiveMergeVerificationAttemptRequest,
  ): Promise<MergeVerificationAttemptRecord | undefined> {
    const repository = requiredBounded(request.repository, 'repository', MAX_REPOSITORY_CHARS);
    positiveInteger(request.pullRequest, 'pullRequest');
    validateSha(request.headSha, 'headSha');
    validateIso(request.now, 'now');
    if (!Number.isInteger(request.staleAfterMs) || request.staleAfterMs <= 0) {
      throw new MergeVerificationAttemptStoreError('invalid_attempt', 'staleAfterMs must be a positive integer');
    }
    const cutoff = new Date(Date.parse(request.now) - request.staleAfterMs).toISOString();

    const row = this.database.connection.prepare(`
      SELECT *
      FROM merge_verification_attempts
      WHERE repository = ? AND pull_request = ? AND head_sha = ?
        AND status = 'running' AND heartbeat_at > ?
      ORDER BY heartbeat_at DESC, attempt_id DESC
      LIMIT 1
    `).get(repository, request.pullRequest, request.headSha, cutoff);

    return row === undefined ? undefined : this.toRecord(this.requireRow(row));
  }

  private requireById(attemptId: string): MergeVerificationAttemptRecord {
    const row = this.database.connection.prepare(
      'SELECT * FROM merge_verification_attempts WHERE attempt_id = ?',
    ).get(attemptId);
    if (row === undefined) {
      throw new MergeVerificationAttemptStoreError(
        'corrupt',
        `Merge verification attempt '${attemptId}' could not be reloaded`,
      );
    }
    return this.toRecord(this.requireRow(row));
  }

  private requireAttemptId(value: unknown): string {
    if (!isRecord(value) || typeof value.attempt_id !== 'string') {
      throw new MergeVerificationAttemptStoreError('corrupt', 'Merge verification attempt row is invalid');
    }
    return value.attempt_id;
  }

  private requireRow(value: unknown): MergeVerificationAttemptRow {
    if (!isRecord(value)) {
      throw new MergeVerificationAttemptStoreError('corrupt', 'Merge verification attempt row is invalid');
    }

    const attemptId = value.attempt_id;
    const repository = value.repository;
    const pullRequest = value.pull_request;
    const headSha = value.head_sha;
    const baseBranch = value.base_branch;
    const workspaceId = value.workspace_id;
    const status = value.status;
    const gateName = value.gate_name;
    const startedAt = value.started_at;
    const heartbeatAt = value.heartbeat_at;
    const finishedAt = value.finished_at;
    const detail = value.detail;
    const receiptRef = value.receipt_ref;

    if (typeof attemptId !== 'string'
      || typeof repository !== 'string'
      || !Number.isInteger(pullRequest)
      || typeof headSha !== 'string'
      || (baseBranch !== null && typeof baseBranch !== 'string')
      || (workspaceId !== null && typeof workspaceId !== 'string')
      || typeof status !== 'string'
      || (!TERMINAL_STATUSES.has(status as MergeVerificationAttemptStatus) && !LIVE_STATUSES.has(status as MergeVerificationAttemptStatus))
      || (gateName !== null && typeof gateName !== 'string')
      || typeof startedAt !== 'string'
      || typeof heartbeatAt !== 'string'
      || (finishedAt !== null && typeof finishedAt !== 'string')
      || (detail !== null && typeof detail !== 'string')
      || (receiptRef !== null && typeof receiptRef !== 'string')) {
      throw new MergeVerificationAttemptStoreError('corrupt', 'Merge verification attempt row has invalid columns');
    }

    return {
      attempt_id: attemptId,
      repository,
      pull_request: pullRequest as number,
      head_sha: headSha,
      base_branch: baseBranch as string | null,
      workspace_id: workspaceId as string | null,
      status,
      gate_name: gateName as string | null,
      started_at: startedAt,
      heartbeat_at: heartbeatAt,
      finished_at: finishedAt as string | null,
      detail: detail as string | null,
      receipt_ref: receiptRef as string | null,
    };
  }

  private toRecord(row: MergeVerificationAttemptRow): MergeVerificationAttemptRecord {
    validateIso(row.started_at, 'startedAt', 'corrupt');
    validateIso(row.heartbeat_at, 'heartbeatAt', 'corrupt');
    if (row.finished_at !== null) validateIso(row.finished_at, 'finishedAt', 'corrupt');
    if (LIVE_STATUSES.has(row.status as MergeVerificationAttemptStatus) && row.finished_at !== null) {
      throw new MergeVerificationAttemptStoreError('corrupt', 'Live attempt must not have a finish timestamp');
    }
    if (TERMINAL_STATUSES.has(row.status as MergeVerificationAttemptStatus) && row.finished_at === null) {
      throw new MergeVerificationAttemptStoreError('corrupt', 'Terminal attempt must have a finish timestamp');
    }

    return {
      attemptId: row.attempt_id,
      repository: row.repository,
      pullRequest: row.pull_request,
      headSha: row.head_sha,
      ...(row.base_branch === null ? {} : { baseBranch: row.base_branch }),
      ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
      status: row.status as MergeVerificationAttemptStatus,
      ...(row.gate_name === null ? {} : { gateName: row.gate_name }),
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
      ...(row.detail === null ? {} : { detail: row.detail }),
      ...(row.receipt_ref === null ? {} : { receiptRef: row.receipt_ref }),
    };
  }
}

function optionalBounded(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredBounded(value, label, max);
}

function requiredBounded(
  value: unknown,
  label: string,
  max: number,
  reason: MergeVerificationAttemptStoreError['reason'] = 'invalid_attempt',
): string {
  if (typeof value !== 'string') {
    throw new MergeVerificationAttemptStoreError(reason, `${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new MergeVerificationAttemptStoreError(reason, `${label} must contain 1-${max} characters`);
  }
  return trimmed;
}

function positiveInteger(
  value: unknown,
  label: string,
  reason: MergeVerificationAttemptStoreError['reason'] = 'invalid_attempt',
): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new MergeVerificationAttemptStoreError(reason, `${label} must be a positive integer`);
  }
  return value as number;
}

function validateSha(
  value: unknown,
  label: string,
  reason: MergeVerificationAttemptStoreError['reason'] = 'invalid_attempt',
): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new MergeVerificationAttemptStoreError(reason, `${label} must be a 40-64 character lowercase hex commit hash`);
  }
  return value;
}

function validateIso(
  value: string,
  label: string,
  reason: MergeVerificationAttemptStoreError['reason'] = 'invalid_attempt',
): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new MergeVerificationAttemptStoreError(reason, `${label} is not a valid timestamp`);
  }
}

function boundedLimit(value: number): number {
  return Math.min(MAX_LIST_LIMIT, positiveInteger(value, 'limit'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
