import { describe, expect, it } from 'vitest';
import type {
  MergeEvidenceSubject,
  MergeVerificationReceipt,
  RepositoryMergePolicy,
} from '@unified-mpc/domain';
import {
  GuardedMergeService,
  type GuardedMergeDispatchPort,
  type GuardedMergeReceiptReader,
} from './guarded-merge-service.js';

const HEAD = '1111111111111111111111111111111111111111';
const STALE_HEAD = '2222222222222222222222222222222222222222';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RECEIPT_REF = 'merge-verification:pr276@1111111';

const policy: RepositoryMergePolicy = {
  repository: 'soulzerox/Unified-MPC-Server',
  defaultBranch: 'main',
  verificationMode: 'local_exact_head',
  requiredGates: [
    { name: 'test', source: 'local_command' },
    { name: 'typecheck', source: 'local_command' },
  ],
  reviewPolicy: {
    required: true,
    acceptedOutcomes: ['clean_llm_review'],
  },
};

const subject: MergeEvidenceSubject = {
  repository: 'soulzerox/Unified-MPC-Server',
  pullRequest: 276,
  headSha: HEAD,
  baseBranch: 'main',
  baseSha: BASE,
};

function receipt(headSha = HEAD): MergeVerificationReceipt {
  return {
    repository: subject.repository,
    pullRequest: subject.pullRequest,
    headSha,
    baseSha: BASE,
    verificationMode: 'local_exact_head',
    gates: [
      {
        name: 'test',
        source: 'local_command',
        headSha,
        outcome: 'passed',
        evidence: 'task:test',
      },
      {
        name: 'typecheck',
        source: 'local_command',
        headSha,
        outcome: 'passed',
        evidence: 'task:typecheck',
      },
    ],
    review: {
      outcome: 'clean_llm_review',
      headSha,
      evidence: 'review:commented',
    },
    createdAt: '2026-10-06T13:45:00.000Z',
  };
}

function reader(
  value: { readonly receiptRef: string; readonly receipt: MergeVerificationReceipt } | undefined,
): GuardedMergeReceiptReader {
  return {
    async getByRef(): Promise<typeof value> {
      return value;
    },
  };
}

function dispatchPort(
  calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }>,
): GuardedMergeDispatchPort {
  return {
    async dispatchMerge(request): Promise<void> {
      calls.push(request);
    },
  };
}

describe('GuardedMergeService', () => {
  it('fails closed without a durable verification receipt and never dispatches', async () => {
    const calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }> = [];
    const service = new GuardedMergeService(reader(undefined), dispatchPort(calls));

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toMatchObject({
      status: 'blocked',
      receiptRef: RECEIPT_REF,
      decision: {
        status: 'MERGE_BLOCKED',
        blockers: [{ code: 'receipt_missing' }],
      },
    });
    expect(calls).toEqual([]);
  });

  it('rejects stale exact-head evidence before the merge adapter sees it', async () => {
    const calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }> = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt(STALE_HEAD) }),
      dispatchPort(calls),
    );

    const result = await service.dispatch({ policy, subject, receiptRef: RECEIPT_REF });

    expect(result).toMatchObject({
      status: 'blocked',
      decision: {
        status: 'MERGE_BLOCKED',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'receipt_head_stale', expected: HEAD, observed: STALE_HEAD }),
          expect.objectContaining({ code: 'review_head_stale', expected: HEAD, observed: STALE_HEAD }),
        ]),
      },
    });
    expect(calls).toEqual([]);
  });

  it('never dispatches when required gates or review do not satisfy policy', async () => {
    const calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }> = [];
    const invalidReceipt = receipt();
    const service = new GuardedMergeService(
      reader({
        receiptRef: RECEIPT_REF,
        receipt: {
          ...invalidReceipt,
          gates: [
            {
              ...invalidReceipt.gates[0]!,
              outcome: 'failed',
            },
          ],
          review: {
            ...invalidReceipt.review,
            outcome: 'rejected',
          },
        },
      }),
      dispatchPort(calls),
    );

    const result = await service.dispatch({ policy, subject, receiptRef: RECEIPT_REF });

    expect(result).toMatchObject({
      status: 'blocked',
      decision: {
        status: 'MERGE_BLOCKED',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'required_gate_not_passed', gate: 'test', observed: 'failed' }),
          expect.objectContaining({ code: 'required_gate_missing', gate: 'typecheck' }),
          expect.objectContaining({ code: 'review_rejected', observed: 'rejected' }),
        ]),
      },
    });
    expect(calls).toEqual([]);
  });

  it('dispatches once only after the referenced receipt satisfies the exact-head policy', async () => {
    const calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }> = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      dispatchPort(calls),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'dispatched',
      receiptRef: RECEIPT_REF,
      subject,
    });
    expect(calls).toEqual([{ receiptRef: RECEIPT_REF, subject }]);
  });

  it('fails closed when receipt storage cannot be inspected', async () => {
    const calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }> = [];
    const failingReader: GuardedMergeReceiptReader = {
      async getByRef(): Promise<never> {
        throw new Error('storage unavailable');
      },
    };
    const service = new GuardedMergeService(failingReader, dispatchPort(calls));

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'receipt_store_error',
      receiptRef: RECEIPT_REF,
    });
    expect(calls).toEqual([]);
  });

  it('fails closed when the receipt reader returns a different receipt identity', async () => {
    const calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }> = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: 'merge-verification:other', receipt: receipt() }),
      dispatchPort(calls),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'receipt_identity_mismatch',
      receiptRef: RECEIPT_REF,
    });
    expect(calls).toEqual([]);
  });

  it('does not claim a merge when the abstract dispatch adapter fails', async () => {
    const failingPort: GuardedMergeDispatchPort = {
      async dispatchMerge(): Promise<never> {
        throw new Error('provider failure');
      },
    };
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      failingPort,
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'merge_dispatch_error',
      receiptRef: RECEIPT_REF,
    });
  });

  it('rejects an empty receipt ref before reading storage or dispatching', async () => {
    let reads = 0;
    const calls: Array<{ readonly receiptRef: string; readonly subject: MergeEvidenceSubject }> = [];
    const service = new GuardedMergeService({
      async getByRef(): Promise<undefined> {
        reads += 1;
        return undefined;
      },
    }, dispatchPort(calls));

    await expect(service.dispatch({ policy, subject, receiptRef: '   ' })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'invalid_receipt_ref',
      receiptRef: '',
    });
    expect(reads).toBe(0);
    expect(calls).toEqual([]);
  });
});
