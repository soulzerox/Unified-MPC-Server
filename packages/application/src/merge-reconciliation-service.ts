import {
  reconcileMergeEvidence,
  type MergeMethod,
  type MergeObservation,
  type MergeReconciliationReason,
  type MergeReconciliationRecord,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from '@unified-mpc/domain';

export interface MergeReconciliationReceiptRecord {
  readonly receiptRef: string;
  readonly receipt: MergeVerificationReceipt;
}

export interface MergeReconciliationReceiptReader {
  getByRef(receiptRef: string): Promise<MergeReconciliationReceiptRecord | undefined>;
}

export interface MergeReconciliationHistoryWriter {
  append(record: MergeReconciliationRecord): Promise<{
    readonly appended: boolean;
    readonly record: MergeReconciliationRecord;
  }>;
}

export interface MergeReconciliationRequest {
  readonly policy: RepositoryMergePolicy;
  readonly expectedMergeMethod: MergeMethod;
  readonly observation: MergeObservation;
  readonly receiptRef?: string;
}

export type MergeReconciliationInspectReason =
  | 'receipt_store_error'
  | 'receipt_identity_mismatch'
  | 'reconciliation_store_error'
  | MergeReconciliationReason;

export type MergeReconciliationResult =
  | {
      readonly status: 'reconciled' | 'policy_breach';
      readonly record: MergeReconciliationRecord;
    }
  | {
      readonly status: 'inspect_required';
      readonly reason: MergeReconciliationInspectReason;
      readonly receiptRef?: string;
      readonly record?: MergeReconciliationRecord;
    };

export class MergeReconciliationService {
  public constructor(
    private readonly receiptReader: MergeReconciliationReceiptReader,
    private readonly historyWriter: MergeReconciliationHistoryWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async reconcile(request: MergeReconciliationRequest): Promise<MergeReconciliationResult> {
    const receiptRef = request.receiptRef?.trim();
    let receipt: MergeVerificationReceipt | undefined;

    if (receiptRef !== undefined) {
      let stored: MergeReconciliationReceiptRecord | undefined;
      try {
        stored = await this.receiptReader.getByRef(receiptRef);
      } catch {
        return {
          status: 'inspect_required',
          reason: 'receipt_store_error',
          receiptRef,
        };
      }

      if (stored !== undefined && stored.receiptRef !== receiptRef) {
        return {
          status: 'inspect_required',
          reason: 'receipt_identity_mismatch',
          receiptRef,
        };
      }
      receipt = stored?.receipt;
    }

    const decision = reconcileMergeEvidence(
      request.policy,
      request.observation,
      receipt,
      request.expectedMergeMethod,
    );
    const record: MergeReconciliationRecord = {
      reconciliationRef: reconciliationRef(request.observation),
      ...(receiptRef === undefined ? {} : { receiptRef }),
      ...(receipt === undefined ? {} : { receipt }),
      policy: request.policy,
      expectedMergeMethod: request.expectedMergeMethod,
      observation: request.observation,
      decision,
      recordedAt: this.now().toISOString(),
    };

    let persisted: MergeReconciliationRecord;
    try {
      persisted = (await this.historyWriter.append(record)).record;
    } catch {
      return {
        status: 'inspect_required',
        reason: 'reconciliation_store_error',
        ...(receiptRef === undefined ? {} : { receiptRef }),
      };
    }

    if (decision.status === 'RECONCILED') {
      return { status: 'reconciled', record: persisted };
    }
    if (decision.status === 'POLICY_BREACH') {
      return { status: 'policy_breach', record: persisted };
    }
    return {
      status: 'inspect_required',
      reason: decision.reason,
      record: persisted,
    };
  }
}

function reconciliationRef(observation: MergeObservation): string {
  const identity = observation.mergeSha ?? observation.headSha;
  return `merge-reconciliation:${observation.repository}#${observation.pullRequest}@${identity}`;
}
