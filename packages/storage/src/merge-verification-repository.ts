import type {
  MergeEvidenceSource,
  MergeGateOutcome,
  MergeReviewOutcome,
  MergeVerificationReceipt,
  VerificationMode,
} from '@unified-mpc/domain';
import type { SqliteDatabase } from './database.js';

const MAX_RECEIPT_REF_CHARS = 1_024;
const MAX_REPOSITORY_CHARS = 512;
const MAX_GATE_NAME_CHARS = 512;
const MAX_EVIDENCE_CHARS = 8_192;
const MAX_LIST_LIMIT = 100;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

const VERIFICATION_MODES = new Set<VerificationMode>(['github_ci', 'local_exact_head', 'hybrid']);
const EVIDENCE_SOURCES = new Set<MergeEvidenceSource>(['github_check', 'local_command', 'external_verifier']);
const GATE_OUTCOMES = new Set<MergeGateOutcome>(['passed', 'failed', 'unavailable']);
const REVIEW_OUTCOMES = new Set<MergeReviewOutcome>([
  'github_approved',
  'clean_llm_review',
  'user_override',
  'rejected',
  'missing',
]);

export interface MergeVerificationReceiptRecord {
  readonly sequence: number;
  readonly receiptRef: string;
  readonly receipt: MergeVerificationReceipt;
  readonly recordedAt: string;
}

export interface AppendMergeVerificationReceiptRequest {
  readonly receiptRef: string;
  readonly receipt: MergeVerificationReceipt;
  readonly recordedAt: string;
}

export interface AppendMergeVerificationReceiptResult {
  readonly appended: boolean;
  readonly record: MergeVerificationReceiptRecord;
}

export interface ListMergeVerificationReceiptsForHeadRequest {
  readonly repository: string;
  readonly pullRequest: number;
  readonly headSha: string;
  readonly limit?: number;
}

interface MergeVerificationReceiptRow {
  readonly sequence: number;
  readonly receipt_ref: string;
  readonly repository: string;
  readonly pull_request: number;
  readonly head_sha: string;
  readonly base_sha: string | null;
  readonly verification_mode: string;
  readonly receipt_json: string;
  readonly receipt_created_at: string;
  readonly recorded_at: string;
}

export class MergeVerificationReceiptStoreError extends Error {
  public constructor(
    public readonly reason: 'invalid_receipt' | 'receipt_ref_conflict' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'MergeVerificationReceiptStoreError';
  }
}

export class SqliteMergeVerificationReceiptRepository {
  public constructor(private readonly database: SqliteDatabase) {}

  public async append(
    request: AppendMergeVerificationReceiptRequest,
  ): Promise<AppendMergeVerificationReceiptResult> {
    const receiptRef = requiredBounded(request.receiptRef, 'receiptRef', MAX_RECEIPT_REF_CHARS);
    validateIso(request.recordedAt, 'recordedAt');
    const normalizedReceipt = parseReceipt(request.receipt, 'invalid_receipt');
    const serialized = JSON.stringify(normalizedReceipt);

    const inserted = this.database.connection.prepare(`
      INSERT OR IGNORE INTO merge_verification_receipts (
        receipt_ref,
        repository,
        pull_request,
        head_sha,
        base_sha,
        verification_mode,
        receipt_json,
        receipt_created_at,
        recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      receiptRef,
      normalizedReceipt.repository,
      normalizedReceipt.pullRequest,
      normalizedReceipt.headSha,
      normalizedReceipt.baseSha ?? null,
      normalizedReceipt.verificationMode,
      serialized,
      normalizedReceipt.createdAt,
      request.recordedAt,
    );

    const record = this.requireByRef(receiptRef);
    if (Number(inserted.changes) === 1) {
      return { appended: true, record };
    }

    if (serializeReceipt(record.receipt) !== serialized) {
      throw new MergeVerificationReceiptStoreError(
        'receipt_ref_conflict',
        `Merge verification receipt ref '${receiptRef}' already identifies different evidence`,
      );
    }

    return { appended: false, record };
  }

  public async getByRef(receiptRef: string): Promise<MergeVerificationReceiptRecord | undefined> {
    const normalized = requiredBounded(receiptRef, 'receiptRef', MAX_RECEIPT_REF_CHARS);
    const row = this.database.connection.prepare(
      'SELECT * FROM merge_verification_receipts WHERE receipt_ref = ?',
    ).get(normalized);
    return row === undefined ? undefined : this.toRecord(this.requireRow(row));
  }

  public async listForExactHead(
    request: ListMergeVerificationReceiptsForHeadRequest,
  ): Promise<readonly MergeVerificationReceiptRecord[]> {
    const repository = requiredBounded(request.repository, 'repository', MAX_REPOSITORY_CHARS);
    positiveInteger(request.pullRequest, 'pullRequest');
    validateSha(request.headSha, 'headSha');
    const limit = boundedLimit(request.limit ?? 20);

    const rows = this.database.connection.prepare(`
      SELECT *
      FROM merge_verification_receipts
      WHERE repository = ? AND pull_request = ? AND head_sha = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(repository, request.pullRequest, request.headSha, limit);

    return rows.map((row) => this.toRecord(this.requireRow(row)));
  }

  private requireByRef(receiptRef: string): MergeVerificationReceiptRecord {
    const row = this.database.connection.prepare(
      'SELECT * FROM merge_verification_receipts WHERE receipt_ref = ?',
    ).get(receiptRef);
    if (row === undefined) {
      throw new MergeVerificationReceiptStoreError(
        'corrupt',
        `Inserted merge verification receipt '${receiptRef}' could not be reloaded`,
      );
    }
    return this.toRecord(this.requireRow(row));
  }

  private requireRow(value: unknown): MergeVerificationReceiptRow {
    if (!isRecord(value)) {
      throw new MergeVerificationReceiptStoreError('corrupt', 'Merge verification receipt row is invalid');
    }

    const sequence = value.sequence;
    const receiptRef = value.receipt_ref;
    const repository = value.repository;
    const pullRequest = value.pull_request;
    const headSha = value.head_sha;
    const baseSha = value.base_sha;
    const verificationMode = value.verification_mode;
    const receiptJson = value.receipt_json;
    const receiptCreatedAt = value.receipt_created_at;
    const recordedAt = value.recorded_at;

    if (!Number.isInteger(sequence)
      || typeof receiptRef !== 'string'
      || typeof repository !== 'string'
      || !Number.isInteger(pullRequest)
      || typeof headSha !== 'string'
      || (baseSha !== null && typeof baseSha !== 'string')
      || typeof verificationMode !== 'string'
      || typeof receiptJson !== 'string'
      || typeof receiptCreatedAt !== 'string'
      || typeof recordedAt !== 'string') {
      throw new MergeVerificationReceiptStoreError('corrupt', 'Merge verification receipt row has invalid columns');
    }

    return {
      sequence: sequence as number,
      receipt_ref: receiptRef,
      repository,
      pull_request: pullRequest as number,
      head_sha: headSha,
      base_sha: baseSha as string | null,
      verification_mode: verificationMode,
      receipt_json: receiptJson,
      receipt_created_at: receiptCreatedAt,
      recorded_at: recordedAt,
    };
  }

  private toRecord(row: MergeVerificationReceiptRow): MergeVerificationReceiptRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.receipt_json);
    } catch {
      throw new MergeVerificationReceiptStoreError('corrupt', 'Stored merge verification receipt JSON is invalid');
    }

    const receipt = parseReceipt(parsed, 'corrupt');
    if (receipt.repository !== row.repository
      || receipt.pullRequest !== row.pull_request
      || receipt.headSha !== row.head_sha
      || (receipt.baseSha ?? null) !== row.base_sha
      || receipt.verificationMode !== row.verification_mode
      || receipt.createdAt !== row.receipt_created_at) {
      throw new MergeVerificationReceiptStoreError(
        'corrupt',
        `Stored merge verification receipt '${row.receipt_ref}' columns disagree with its payload`,
      );
    }
    validateIso(row.recorded_at, 'recordedAt', 'corrupt');

    return {
      sequence: row.sequence,
      receiptRef: row.receipt_ref,
      receipt,
      recordedAt: row.recorded_at,
    };
  }
}

function serializeReceipt(receipt: MergeVerificationReceipt): string {
  return JSON.stringify(parseReceipt(receipt, 'invalid_receipt'));
}

function parseReceipt(
  value: unknown,
  reason: MergeVerificationReceiptStoreError['reason'],
): MergeVerificationReceipt {
  if (!isRecord(value)) {
    throw new MergeVerificationReceiptStoreError(reason, 'Merge verification receipt must be an object');
  }

  const repository = requiredBounded(value.repository, 'repository', MAX_REPOSITORY_CHARS, reason);
  const pullRequest = positiveInteger(value.pullRequest, 'pullRequest', reason);
  const headSha = validateSha(value.headSha, 'headSha', reason);
  const baseSha = value.baseSha === undefined
    ? undefined
    : validateSha(value.baseSha, 'baseSha', reason);
  const verificationMode = value.verificationMode;
  if (typeof verificationMode !== 'string' || !VERIFICATION_MODES.has(verificationMode as VerificationMode)) {
    throw new MergeVerificationReceiptStoreError(reason, 'verificationMode is invalid');
  }
  if (!Array.isArray(value.gates)) {
    throw new MergeVerificationReceiptStoreError(reason, 'gates must be an array');
  }

  const gates = value.gates.map((gate, index) => {
    if (!isRecord(gate)) {
      throw new MergeVerificationReceiptStoreError(reason, `gate[${index}] must be an object`);
    }
    const name = requiredBounded(gate.name, `gate[${index}].name`, MAX_GATE_NAME_CHARS, reason);
    const source = gate.source;
    const outcome = gate.outcome;
    if (typeof source !== 'string' || !EVIDENCE_SOURCES.has(source as MergeEvidenceSource)) {
      throw new MergeVerificationReceiptStoreError(reason, `gate[${index}].source is invalid`);
    }
    if (typeof outcome !== 'string' || !GATE_OUTCOMES.has(outcome as MergeGateOutcome)) {
      throw new MergeVerificationReceiptStoreError(reason, `gate[${index}].outcome is invalid`);
    }

    return {
      name,
      source: source as MergeEvidenceSource,
      headSha: validateSha(gate.headSha, `gate[${index}].headSha`, reason),
      outcome: outcome as MergeGateOutcome,
      ...optionalEvidence(gate.evidence, `gate[${index}].evidence`, reason),
    };
  });

  if (!isRecord(value.review)) {
    throw new MergeVerificationReceiptStoreError(reason, 'review must be an object');
  }
  const reviewOutcome = value.review.outcome;
  if (typeof reviewOutcome !== 'string' || !REVIEW_OUTCOMES.has(reviewOutcome as MergeReviewOutcome)) {
    throw new MergeVerificationReceiptStoreError(reason, 'review.outcome is invalid');
  }

  const createdAt = isoString(value.createdAt, 'createdAt', reason);
  return {
    repository,
    pullRequest,
    headSha,
    ...(baseSha === undefined ? {} : { baseSha }),
    verificationMode: verificationMode as VerificationMode,
    gates,
    review: {
      outcome: reviewOutcome as MergeReviewOutcome,
      headSha: validateSha(value.review.headSha, 'review.headSha', reason),
      ...optionalEvidence(value.review.evidence, 'review.evidence', reason),
    },
    createdAt,
  };
}

function optionalEvidence(
  value: unknown,
  label: string,
  reason: MergeVerificationReceiptStoreError['reason'],
): { readonly evidence?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.length > MAX_EVIDENCE_CHARS) {
    throw new MergeVerificationReceiptStoreError(reason, `${label} exceeds ${MAX_EVIDENCE_CHARS} characters`);
  }
  return { evidence: value };
}

function requiredBounded(
  value: unknown,
  label: string,
  max: number,
  reason: MergeVerificationReceiptStoreError['reason'] = 'invalid_receipt',
): string {
  if (typeof value !== 'string') {
    throw new MergeVerificationReceiptStoreError(reason, `${label} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new MergeVerificationReceiptStoreError(reason, `${label} must contain 1-${max} characters`);
  }
  return trimmed;
}

function positiveInteger(
  value: unknown,
  label: string,
  reason: MergeVerificationReceiptStoreError['reason'] = 'invalid_receipt',
): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new MergeVerificationReceiptStoreError(reason, `${label} must be a positive integer`);
  }
  return value as number;
}

function validateSha(
  value: unknown,
  label: string,
  reason: MergeVerificationReceiptStoreError['reason'] = 'invalid_receipt',
): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new MergeVerificationReceiptStoreError(reason, `${label} must be a 40-64 character lowercase hex commit hash`);
  }
  return value;
}

function isoString(
  value: unknown,
  label: string,
  reason: MergeVerificationReceiptStoreError['reason'],
): string {
  if (typeof value !== 'string') {
    throw new MergeVerificationReceiptStoreError(reason, `${label} must be a timestamp string`);
  }
  validateIso(value, label, reason);
  return value;
}

function validateIso(
  value: string,
  label: string,
  reason: MergeVerificationReceiptStoreError['reason'] = 'invalid_receipt',
): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new MergeVerificationReceiptStoreError(reason, `${label} is not a valid timestamp`);
  }
}

function boundedLimit(value: number): number {
  return Math.min(MAX_LIST_LIMIT, positiveInteger(value, 'limit'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
