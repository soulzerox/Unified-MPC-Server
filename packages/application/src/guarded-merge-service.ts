import {
  evaluateMergeEvidence,
  type MergeEvidenceDecision,
  type MergeEvidenceSubject,
  type MergeMethod,
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

/** The pull request identity the host provider holds right now. */
export interface GuardedMergeAuthoritativeSubject {
  readonly headSha: string;
  readonly baseBranch: string;
  readonly baseSha: string;
}

/**
 * Authoritative subject source. The caller names the pull request it wants
 * merged; this port proves that identity is still the one the provider holds,
 * so the shared rule — evidence must name this exact repository, pull request,
 * head and base — is evaluated against the provider instead of against the
 * caller's claim. A source that cannot answer throws, and the merge is refused
 * rather than guessed.
 */
export interface GuardedMergeSubjectSource {
  read(request: {
    readonly repository: string;
    readonly pullRequest: number;
  }): Promise<GuardedMergeAuthoritativeSubject>;
}

export interface GuardedMergeDispatchRequest {
  readonly receiptRef: string;
  readonly subject: MergeEvidenceSubject;
  readonly mergeMethod: MergeMethod;
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
  | 'subject_unavailable'
  | 'subject_mismatch'
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
    private readonly subjectSource: GuardedMergeSubjectSource,
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

    // Resolve the subject before the evidence is read: a receipt can only
    // authorize the pull request the provider holds, not the one the caller
    // described. Without this, a caller could name the default branch for a PR
    // that targets another one and still satisfy the policy's base check.
    let authoritative: GuardedMergeAuthoritativeSubject;
    try {
      authoritative = await this.subjectSource.read({
        repository: request.subject.repository,
        pullRequest: request.subject.pullRequest,
      });
    } catch {
      return {
        status: 'inspect_required',
        reason: 'subject_unavailable',
        receiptRef,
      };
    }

    const mismatch = subjectMismatch(request.subject, authoritative);
    if (mismatch !== undefined) {
      return {
        status: 'inspect_required',
        reason: 'subject_mismatch',
        receiptRef,
        detail: mismatch,
      };
    }

    // The caller's head, base branch and any base commit it named are now
    // proven equal to the provider's. `baseSha` is still optional on the
    // caller's subject, so evaluating the caller's object would let an omitted
    // base silently disable the receipt's base check. The provider base is the
    // only one a receipt can be valid against.
    const authorized: MergeEvidenceSubject = {
      ...request.subject,
      baseSha: authoritative.baseSha,
    };

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

    const decision = evaluateMergeEvidence(request.policy, authorized, record?.receipt);
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
        subject: authorized,
        mergeMethod: request.policy.mergeMethod ?? 'merge',
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
      subject: authorized,
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

/**
 * The caller's subject is the request; the provider's is the proof. A
 * disagreement is never resolved in the caller's favour — the caller re-reads
 * the pull request and asks again. Fixed messages keep the detail bounded and
 * free of provider text.
 *
 * The optional `baseSha` is compared only when the caller names one. An absent
 * base keeps the evidence rule unchanged: `evaluateMergeEvidence` skips the
 * base-commit check unless both sides carry it.
 */
function subjectMismatch(
  subject: MergeEvidenceSubject,
  authoritative: GuardedMergeAuthoritativeSubject,
): string | undefined {
  if (!sameSha(subject.headSha, authoritative.headSha)) {
    return 'the pull request head is no longer the head the caller named';
  }
  if (subject.baseBranch !== authoritative.baseBranch) {
    return 'the pull request targets a different base branch than the caller named';
  }
  if (subject.baseSha !== undefined && !sameSha(subject.baseSha, authoritative.baseSha)) {
    return 'the pull request base commit is no longer the base the caller named';
  }
  return undefined;
}

/** Hex SHAs name one commit in either case; the evidence check stays byte-exact. */
function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
