import {
  evaluateMergeEvidence,
  type MergeEvidenceDecision,
  type MergeEvidenceSubject,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from '@unified-mpc/domain';

export interface GuardedMergeReceiptRecord {
  readonly receiptRef: string;
  readonly receipt: MergeVerificationReceipt;
}

export interface GuardedMergeReceiptReader {
  getByRef(receiptRef: string): Promise<GuardedMergeReceiptRecord | undefined>;
}

export interface GuardedMergeDispatchRequest {
  readonly receiptRef: string;
  readonly subject: MergeEvidenceSubject;
}

export interface GuardedMergeDispatchPort {
  dispatchMerge(request: GuardedMergeDispatchRequest): Promise<void>;
}

export interface GuardedMergeRequest {
  readonly policy: RepositoryMergePolicy;
  readonly subject: MergeEvidenceSubject;
  readonly receiptRef: string;
}

export type GuardedMergeInspectReason =
  | 'invalid_receipt_ref'
  | 'receipt_store_error'
  | 'receipt_identity_mismatch'
  | 'merge_dispatch_error';

export type GuardedMergeResult =
  | {
      readonly status: 'blocked';
      readonly receiptRef: string;
      readonly decision: MergeEvidenceDecision;
    }
  | {
      readonly status: 'dispatched';
      readonly receiptRef: string;
      readonly subject: MergeEvidenceSubject;
    }
  | {
      readonly status: 'inspect_required';
      readonly reason: GuardedMergeInspectReason;
      readonly receiptRef: string;
      readonly detail?: string;
    };

export class GuardedMergeService {
  public constructor(
    private readonly receiptReader: GuardedMergeReceiptReader,
    private readonly dispatchPort: GuardedMergeDispatchPort,
  ) {}

  public async dispatch(request: GuardedMergeRequest): Promise<GuardedMergeResult> {
    const receiptRef = request.receiptRef.trim();
    if (receiptRef.length === 0) {
      return {
        status: 'inspect_required',
        reason: 'invalid_receipt_ref',
        receiptRef,
      };
    }

    let record: GuardedMergeReceiptRecord | undefined;
    try {
      record = await this.receiptReader.getByRef(receiptRef);
    } catch {
      return {
        status: 'inspect_required',
        reason: 'receipt_store_error',
        receiptRef,
      };
    }

    if (record !== undefined && record.receiptRef !== receiptRef) {
      return {
        status: 'inspect_required',
        reason: 'receipt_identity_mismatch',
        receiptRef,
      };
    }

    const decision = evaluateMergeEvidence(request.policy, request.subject, record?.receipt);
    if (decision.status === 'MERGE_BLOCKED') {
      return {
        status: 'blocked',
        receiptRef,
        decision,
      };
    }

    try {
      await this.dispatchPort.dispatchMerge({
        receiptRef,
        subject: request.subject,
      });
    } catch (error: unknown) {
      const detail = dispatchFailureDetail(error);
      return {
        status: 'inspect_required',
        reason: 'merge_dispatch_error',
        receiptRef,
        ...(detail === undefined ? {} : { detail }),
      };
    }

    return {
      status: 'dispatched',
      receiptRef,
      subject: request.subject,
    };
  }
}

const MAX_DISPATCH_DETAIL_CHARS = 400;
const REDACTED_TOKEN = '[redacted-token]';
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
];

/**
 * Keep the provider failure visible to the caller without leaking secrets or
 * multi-line error payloads into the tool response. The guarded merge still
 * fails closed; this detail is diagnostic only.
 */
function dispatchFailureDetail(error: unknown): string | undefined {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : undefined;
  if (raw === undefined) return undefined;

  let sanitized = Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim();
  for (const shape of CREDENTIAL_SHAPES) {
    sanitized = sanitized.replace(shape, REDACTED_TOKEN);
  }
  if (sanitized.length === 0) return undefined;
  if (sanitized.length <= MAX_DISPATCH_DETAIL_CHARS) return sanitized;
  return `${sanitized.slice(0, MAX_DISPATCH_DETAIL_CHARS - 1)}…`;
}
