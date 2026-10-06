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
    } catch {
      return {
        status: 'inspect_required',
        reason: 'merge_dispatch_error',
        receiptRef,
      };
    }

    return {
      status: 'dispatched',
      receiptRef,
      subject: request.subject,
    };
  }
}
