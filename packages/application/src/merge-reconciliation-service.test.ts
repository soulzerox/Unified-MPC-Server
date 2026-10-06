import { describe, expect, it, vi } from 'vitest';
import {
  type MergeObservation,
  type MergeReconciliationRecord,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from '@unified-mpc/domain';
import {
  MergeReconciliationService,
  type MergeReconciliationHistoryWriter,
  type MergeReconciliationReceiptReader,
} from './merge-reconciliation-service.js';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RECEIPT_REF = 'merge-verification:279@1111111';

const policy: RepositoryMergePolicy = {
  repository: 'soulzerox/Unified-MPC-Server',
  defaultBranch: 'main',
  verificationMode: 'local_exact_head',
  requiredGates: [{ name: 'test', source: 'local_command' }],
  reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
};

const receipt: MergeVerificationReceipt = {
  repository: policy.repository,
  pullRequest: 279,
  headSha: HEAD,
  baseSha: BASE,
  verificationMode: 'local_exact_head',
  gates: [{ name: 'test', source: 'local_command', headSha: HEAD, outcome: 'passed' }],
  review: { outcome: 'clean_llm_review', headSha: HEAD },
  createdAt: '2026-10-07T01:20:00.000Z',
};

const observation: MergeObservation = {
  repository: policy.repository,
  pullRequest: 279,
  headSha: HEAD,
  baseBranch: 'main',
  baseSha: BASE,
  merged: true,
  mergeMethod: 'merge',
  mergeSha: MERGE,
  observedAt: '2026-10-07T01:30:22.000Z',
};

function writer(records: MergeReconciliationRecord[]): MergeReconciliationHistoryWriter {
  return {
    async append(record): Promise<{ readonly appended: boolean; readonly record: MergeReconciliationRecord }> {
      records.push(record);
      return { appended: true, record };
    },
  };
}

function reader(
  value: { readonly receiptRef: string; readonly receipt: MergeVerificationReceipt } | undefined,
): MergeReconciliationReceiptReader {
  return {
    async getByRef(): Promise<typeof value> {
      return value;
    },
  };
}

describe('MergeReconciliationService', () => {
  it('persists a reconciled immutable record for matching exact-head evidence', async () => {
    const records: MergeReconciliationRecord[] = [];
    const service = new MergeReconciliationService(
      reader({ receiptRef: RECEIPT_REF, receipt }),
      writer(records),
      () => new Date('2026-10-07T01:31:00.000Z'),
    );

    const result = await service.reconcile({
      policy,
      expectedMergeMethod: 'merge',
      observation,
      receiptRef: RECEIPT_REF,
    });

    expect(result).toMatchObject({
      status: 'reconciled',
      record: {
        reconciliationRef: expect.stringContaining('merge-reconciliation:'),
        receiptRef: RECEIPT_REF,
        decision: { status: 'RECONCILED', reason: 'merge_reconciled' },
        recordedAt: '2026-10-07T01:31:00.000Z',
      },
    });
    expect(records).toHaveLength(1);
  });

  it('persists and surfaces a policy breach when a merged PR has no receipt reference', async () => {
    const records: MergeReconciliationRecord[] = [];
    const receiptReader = { getByRef: vi.fn() };
    const service = new MergeReconciliationService(
      receiptReader,
      writer(records),
      () => new Date('2026-10-07T01:31:00.000Z'),
    );

    const result = await service.reconcile({
      policy,
      expectedMergeMethod: 'merge',
      observation,
    });

    expect(receiptReader.getByRef).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'policy_breach',
      record: {
        decision: {
          status: 'POLICY_BREACH',
          reason: 'verification_receipt_missing',
        },
      },
    });
    expect(records).toHaveLength(1);
  });

  it('persists failed or stale verification as a policy breach instead of terminal success', async () => {
    const records: MergeReconciliationRecord[] = [];
    const failedReceipt: MergeVerificationReceipt = {
      ...receipt,
      gates: [{ ...receipt.gates[0]!, outcome: 'failed' }],
    };
    const service = new MergeReconciliationService(
      reader({ receiptRef: RECEIPT_REF, receipt: failedReceipt }),
      writer(records),
      () => new Date('2026-10-07T01:31:00.000Z'),
    );

    await expect(service.reconcile({
      policy,
      expectedMergeMethod: 'merge',
      observation,
      receiptRef: RECEIPT_REF,
    })).resolves.toMatchObject({
      status: 'policy_breach',
      record: {
        decision: {
          status: 'POLICY_BREACH',
          reason: 'verification_policy_breach',
        },
      },
    });
  });

  it('fails closed when receipt storage cannot be inspected or returns the wrong receipt identity', async () => {
    const history = { append: vi.fn() };
    const failingReader: MergeReconciliationReceiptReader = {
      async getByRef(): Promise<never> {
        throw new Error('storage unavailable');
      },
    };
    const unavailable = new MergeReconciliationService(
      failingReader,
      history,
      () => new Date('2026-10-07T01:31:00.000Z'),
    );

    await expect(unavailable.reconcile({
      policy,
      expectedMergeMethod: 'merge',
      observation,
      receiptRef: RECEIPT_REF,
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'receipt_store_error',
      receiptRef: RECEIPT_REF,
    });
    expect(history.append).not.toHaveBeenCalled();

    const mismatch = new MergeReconciliationService(
      reader({ receiptRef: 'merge-verification:other', receipt }),
      history,
      () => new Date('2026-10-07T01:31:00.000Z'),
    );
    await expect(mismatch.reconcile({
      policy,
      expectedMergeMethod: 'merge',
      observation,
      receiptRef: RECEIPT_REF,
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'receipt_identity_mismatch',
      receiptRef: RECEIPT_REF,
    });
  });

  it('persists inspect-required domain decisions instead of rewriting them as storage errors', async () => {
    const records: MergeReconciliationRecord[] = [];
    const service = new MergeReconciliationService(
      reader({ receiptRef: RECEIPT_REF, receipt }),
      writer(records),
      () => new Date('2026-10-07T01:31:00.000Z'),
    );

    await expect(service.reconcile({
      policy,
      expectedMergeMethod: 'merge',
      observation: { ...observation, mergeSha: undefined },
      receiptRef: RECEIPT_REF,
    })).resolves.toMatchObject({
      status: 'inspect_required',
      reason: 'merge_sha_missing',
      record: {
        decision: {
          status: 'INSPECT_REQUIRED',
          reason: 'merge_sha_missing',
        },
      },
    });
    expect(records).toHaveLength(1);
  });

  it('never claims reconciliation when durable history persistence fails', async () => {
    const failingWriter: MergeReconciliationHistoryWriter = {
      async append(): Promise<never> {
        throw new Error('disk full');
      },
    };
    const service = new MergeReconciliationService(
      reader({ receiptRef: RECEIPT_REF, receipt }),
      failingWriter,
      () => new Date('2026-10-07T01:31:00.000Z'),
    );

    await expect(service.reconcile({
      policy,
      expectedMergeMethod: 'merge',
      observation,
      receiptRef: RECEIPT_REF,
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'reconciliation_store_error',
      receiptRef: RECEIPT_REF,
    });
  });
});
