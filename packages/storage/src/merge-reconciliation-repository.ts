import {
  reconcileMergeEvidence,
  type MergeMethod,
  type MergeObservation,
  type MergeReconciliationDecision,
  type MergeReconciliationRecord,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from '@unified-mpc/domain';
import type { SqliteDatabase } from './database.js';

const MAX_REF_CHARS = 1_024;
const MAX_REPOSITORY_CHARS = 512;
const MAX_LIST_LIMIT = 100;
const MERGE_METHODS = new Set<MergeMethod>(['merge', 'squash', 'rebase']);

export interface MergeReconciliationHistoryRecord extends MergeReconciliationRecord {
  readonly sequence: number;
}

export interface AppendMergeReconciliationResult {
  readonly appended: boolean;
  readonly record: MergeReconciliationHistoryRecord;
}

export interface ListMergeReconciliationsForPullRequestRequest {
  readonly repository: string;
  readonly pullRequest: number;
  readonly limit?: number;
}

interface MergeReconciliationRow {
  readonly sequence: number;
  readonly reconciliation_ref: string;
  readonly repository: string;
  readonly pull_request: number;
  readonly head_sha: string;
  readonly merge_sha: string | null;
  readonly receipt_ref: string | null;
  readonly expected_merge_method: string;
  readonly status: string;
  readonly reason: string;
  readonly record_json: string;
  readonly observed_at: string;
  readonly recorded_at: string;
}

export class MergeReconciliationStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_record' | 'reconciliation_ref_conflict' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'MergeReconciliationStoreError';
  }
}

export class SqliteMergeReconciliationRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async append(record: MergeReconciliationRecord): Promise<AppendMergeReconciliationResult> {
    const incomingRef = requiredBounded(record.reconciliationRef, 'reconciliationRef', MAX_REF_CHARS);
    const existingRow = this.database.connection.prepare(
      'SELECT * FROM merge_reconciliation_records WHERE reconciliation_ref = ?',
    ).get(incomingRef);
    if (existingRow !== undefined) {
      const persisted = this.toRecord(this.requireRow(existingRow));
      let normalizedIncoming: MergeReconciliationRecord;
      try {
        normalizedIncoming = parseRecord(record, 'invalid_record');
      } catch {
        throw new MergeReconciliationStoreError(
          'reconciliation_ref_conflict',
          `Merge reconciliation ref '${incomingRef}' already identifies different evidence`,
        );
      }
      if (!hasSameReconciliationEvidence(persisted, normalizedIncoming)) {
        throw new MergeReconciliationStoreError(
          'reconciliation_ref_conflict',
          `Merge reconciliation ref '${incomingRef}' already identifies different evidence`,
        );
      }
      return { appended: false, record: persisted };
    }

    const normalized = parseRecord(record, 'invalid_record');
    const serialized = JSON.stringify(normalized);

    const inserted = this.database.connection.prepare(`
      INSERT OR IGNORE INTO merge_reconciliation_records (
        reconciliation_ref,
        repository,
        pull_request,
        head_sha,
        merge_sha,
        receipt_ref,
        expected_merge_method,
        status,
        reason,
        record_json,
        observed_at,
        recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.reconciliationRef,
      normalized.observation.repository,
      normalized.observation.pullRequest,
      normalized.observation.headSha,
      normalized.observation.mergeSha ?? null,
      normalized.receiptRef ?? null,
      normalized.expectedMergeMethod,
      normalized.decision.status,
      normalized.decision.reason,
      serialized,
      normalized.observation.observedAt,
      normalized.recordedAt,
    );

    const persisted = this.requireByRef(normalized.reconciliationRef);
    if (Number(inserted.changes) === 1) {
      return { appended: true, record: persisted };
    }

    if (!hasSameReconciliationEvidence(persisted, normalized)) {
      throw new MergeReconciliationStoreError(
        'reconciliation_ref_conflict',
        `Merge reconciliation ref '${normalized.reconciliationRef}' already identifies different evidence`,
      );
    }

    return { appended: false, record: persisted };
  }

  public async getByRef(reconciliationRef: string): Promise<MergeReconciliationHistoryRecord | undefined> {
    const normalized = requiredBounded(reconciliationRef, 'reconciliationRef', MAX_REF_CHARS);
    const row = this.database.connection.prepare(
      'SELECT * FROM merge_reconciliation_records WHERE reconciliation_ref = ?',
    ).get(normalized);
    return row === undefined ? undefined : this.toRecord(this.requireRow(row));
  }

  public async listForPullRequest(
    request: ListMergeReconciliationsForPullRequestRequest,
  ): Promise<readonly MergeReconciliationHistoryRecord[]> {
    const repository = requiredBounded(request.repository, 'repository', MAX_REPOSITORY_CHARS);
    const pullRequest = positiveInteger(request.pullRequest, 'pullRequest');
    const limit = boundedLimit(request.limit ?? 20);

    const rows = this.database.connection.prepare(`
      SELECT *
      FROM merge_reconciliation_records
      WHERE repository = ? AND pull_request = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(repository, pullRequest, limit);

    return rows.map((row) => this.toRecord(this.requireRow(row)));
  }

  private requireByRef(reconciliationRef: string): MergeReconciliationHistoryRecord {
    const row = this.database.connection.prepare(
      'SELECT * FROM merge_reconciliation_records WHERE reconciliation_ref = ?',
    ).get(reconciliationRef);
    if (row === undefined) {
      throw new MergeReconciliationStoreError(
        'corrupt',
        `Inserted merge reconciliation '${reconciliationRef}' could not be reloaded`,
      );
    }
    return this.toRecord(this.requireRow(row));
  }

  private requireRow(value: unknown): MergeReconciliationRow {
    if (!isRecord(value)) {
      throw new MergeReconciliationStoreError('corrupt', 'Merge reconciliation row is invalid');
    }

    const sequence = value.sequence;
    const reconciliationRef = value.reconciliation_ref;
    const repository = value.repository;
    const pullRequest = value.pull_request;
    const headSha = value.head_sha;
    const mergeSha = value.merge_sha;
    const receiptRef = value.receipt_ref;
    const expectedMergeMethod = value.expected_merge_method;
    const status = value.status;
    const reason = value.reason;
    const recordJson = value.record_json;
    const observedAt = value.observed_at;
    const recordedAt = value.recorded_at;

    if (!Number.isInteger(sequence)
      || typeof reconciliationRef !== 'string'
      || typeof repository !== 'string'
      || !Number.isInteger(pullRequest)
      || typeof headSha !== 'string'
      || (mergeSha !== null && typeof mergeSha !== 'string')
      || (receiptRef !== null && typeof receiptRef !== 'string')
      || typeof expectedMergeMethod !== 'string'
      || typeof status !== 'string'
      || typeof reason !== 'string'
      || typeof recordJson !== 'string'
      || typeof observedAt !== 'string'
      || typeof recordedAt !== 'string') {
      throw new MergeReconciliationStoreError('corrupt', 'Merge reconciliation row has invalid columns');
    }

    return {
      sequence: sequence as number,
      reconciliation_ref: reconciliationRef,
      repository,
      pull_request: pullRequest as number,
      head_sha: headSha,
      merge_sha: mergeSha as string | null,
      receipt_ref: receiptRef as string | null,
      expected_merge_method: expectedMergeMethod,
      status,
      reason,
      record_json: recordJson,
      observed_at: observedAt,
      recorded_at: recordedAt,
    };
  }

  private toRecord(row: MergeReconciliationRow): MergeReconciliationHistoryRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.record_json);
    } catch {
      throw new MergeReconciliationStoreError('corrupt', 'Stored merge reconciliation JSON is invalid');
    }

    const record = parseRecord(parsed, 'corrupt');
    const recomputed = reconcileSafely(
      record.policy,
      record.observation,
      record.receipt,
      record.expectedMergeMethod,
      'corrupt',
    );

    if (canonicalStringify(recomputed) !== canonicalStringify(record.decision)) {
      throw new MergeReconciliationStoreError(
        'corrupt',
        `Stored merge reconciliation '${row.reconciliation_ref}' decision disagrees with current evidence`,
      );
    }

    if (record.reconciliationRef !== row.reconciliation_ref
      || record.observation.repository !== row.repository
      || record.observation.pullRequest !== row.pull_request
      || record.observation.headSha !== row.head_sha
      || (record.observation.mergeSha ?? null) !== row.merge_sha
      || (record.receiptRef ?? null) !== row.receipt_ref
      || record.expectedMergeMethod !== row.expected_merge_method
      || record.decision.status !== row.status
      || record.decision.reason !== row.reason
      || record.observation.observedAt !== row.observed_at
      || record.recordedAt !== row.recorded_at) {
      throw new MergeReconciliationStoreError(
        'corrupt',
        `Stored merge reconciliation '${row.reconciliation_ref}' columns disagree with its payload`,
      );
    }

    return { sequence: row.sequence, ...record };
  }
}

function hasSameReconciliationEvidence(
  persisted: MergeReconciliationHistoryRecord,
  incoming: MergeReconciliationRecord,
): boolean {
  const {
    sequence,
    recordedAt: persistedRecordedAt,
    ...persistedEvidence
  } = persisted;
  const {
    recordedAt: incomingRecordedAt,
    ...incomingEvidence
  } = incoming;
  void sequence;
  void persistedRecordedAt;
  void incomingRecordedAt;
  return canonicalStringify(persistedEvidence) === canonicalStringify(incomingEvidence);
}

function parseRecord(
  value: unknown,
  reason: MergeReconciliationStoreError['reason'],
): MergeReconciliationRecord {
  if (!isRecord(value)) {
    throw new MergeReconciliationStoreError(reason, 'Merge reconciliation record must be an object');
  }

  const reconciliationRef = requiredBounded(value.reconciliationRef, 'reconciliationRef', MAX_REF_CHARS, reason);
  const receiptRef = value.receiptRef === undefined
    ? undefined
    : requiredBounded(value.receiptRef, 'receiptRef', MAX_REF_CHARS, reason);
  const expectedMergeMethod = value.expectedMergeMethod;
  if (typeof expectedMergeMethod !== 'string' || !MERGE_METHODS.has(expectedMergeMethod as MergeMethod)) {
    throw new MergeReconciliationStoreError(reason, 'expectedMergeMethod is invalid');
  }

  if (!isRecord(value.policy) || !isRecord(value.observation) || !isRecord(value.decision)) {
    throw new MergeReconciliationStoreError(reason, 'policy, observation, and decision must be objects');
  }

  const policy = value.policy as unknown as RepositoryMergePolicy;
  const observation = parseObservation(value.observation, reason);
  const receipt = value.receipt === undefined
    ? undefined
    : value.receipt as unknown as MergeVerificationReceipt;
  const recordedAt = requiredTimestamp(value.recordedAt, 'recordedAt', reason);
  const decision = value.decision as unknown as MergeReconciliationDecision;

  const recomputed = reconcileSafely(
    policy,
    observation,
    receipt,
    expectedMergeMethod as MergeMethod,
    reason,
  );
  if (canonicalStringify(recomputed) !== canonicalStringify(decision)) {
    throw new MergeReconciliationStoreError(reason, 'Merge reconciliation decision does not match its evidence');
  }

  return {
    reconciliationRef,
    ...(receiptRef === undefined ? {} : { receiptRef }),
    ...(receipt === undefined ? {} : { receipt }),
    policy,
    expectedMergeMethod: expectedMergeMethod as MergeMethod,
    observation,
    decision: recomputed,
    recordedAt,
  };
}

function parseObservation(
  value: Record<string, unknown>,
  reason: MergeReconciliationStoreError['reason'],
): MergeObservation {
  const repository = requiredBounded(value.repository, 'observation.repository', MAX_REPOSITORY_CHARS, reason);
  const pullRequest = positiveInteger(value.pullRequest, 'observation.pullRequest', reason);
  const headSha = requiredBounded(value.headSha, 'observation.headSha', 128, reason);
  const baseBranch = requiredBounded(value.baseBranch, 'observation.baseBranch', 512, reason);
  const baseSha = value.baseSha === undefined
    ? undefined
    : requiredBounded(value.baseSha, 'observation.baseSha', 128, reason);
  if (typeof value.merged !== 'boolean') {
    throw new MergeReconciliationStoreError(reason, 'observation.merged must be boolean');
  }

  let mergeMethod: MergeMethod | undefined;
  if (value.mergeMethod !== undefined) {
    if (typeof value.mergeMethod !== 'string' || !MERGE_METHODS.has(value.mergeMethod as MergeMethod)) {
      throw new MergeReconciliationStoreError(reason, 'observation.mergeMethod is invalid');
    }
    mergeMethod = value.mergeMethod as MergeMethod;
  }

  const mergeSha = value.mergeSha === undefined
    ? undefined
    : requiredBounded(value.mergeSha, 'observation.mergeSha', 128, reason);
  if (typeof value.observedAt !== 'string') {
    throw new MergeReconciliationStoreError(reason, 'observation.observedAt must be a string');
  }

  return {
    repository,
    pullRequest,
    headSha,
    baseBranch,
    ...(baseSha === undefined ? {} : { baseSha }),
    merged: value.merged,
    ...(mergeMethod === undefined ? {} : { mergeMethod }),
    ...(mergeSha === undefined ? {} : { mergeSha }),
    observedAt: value.observedAt,
  };
}

function reconcileSafely(
  policy: RepositoryMergePolicy,
  observation: MergeObservation,
  receipt: MergeVerificationReceipt | undefined,
  expectedMergeMethod: MergeMethod,
  reason: MergeReconciliationStoreError['reason'],
): MergeReconciliationDecision {
  try {
    return reconcileMergeEvidence(policy, observation, receipt, expectedMergeMethod);
  } catch {
    throw new MergeReconciliationStoreError(reason, 'Merge reconciliation evidence cannot be evaluated');
  }
}

function requiredBounded(
  value: unknown,
  label: string,
  max: number,
  reason: MergeReconciliationStoreError['reason'] = 'invalid_record',
): string {
  if (typeof value !== 'string') {
    throw new MergeReconciliationStoreError(reason, `${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new MergeReconciliationStoreError(reason, `${label} must contain 1-${max} characters`);
  }
  return trimmed;
}

function requiredTimestamp(
  value: unknown,
  label: string,
  reason: MergeReconciliationStoreError['reason'],
): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new MergeReconciliationStoreError(reason, `${label} is not a valid timestamp`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  reason: MergeReconciliationStoreError['reason'] = 'invalid_record',
): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new MergeReconciliationStoreError(reason, `${label} must be a positive integer`);
  }
  return value as number;
}

function boundedLimit(value: number): number {
  return Math.min(MAX_LIST_LIMIT, positiveInteger(value, 'limit'));
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
