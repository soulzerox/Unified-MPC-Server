import { describe, expect, it } from 'vitest';
import type {
  MergeEvidenceSubject,
  MergeVerificationReceipt,
  RepositoryMergePolicy,
} from '@unified-mpc/domain';
import {
  GuardedMergeService,
  type GuardedMergeAuthoritativeSubject,
  type GuardedMergeDispatchPort,
  type GuardedMergeDispatchRequest,
  type GuardedMergeReceiptReader,
  type GuardedMergeSubjectSource,
} from './guarded-merge-service.js';

const HEAD = '1111111111111111111111111111111111111111';
const LETTERED_HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
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
  calls: GuardedMergeDispatchRequest[],
): GuardedMergeDispatchPort {
  return {
    async dispatchMerge(request): Promise<void> {
      calls.push(request);
    },
  };
}

function subjectSource(
  overrides: Partial<GuardedMergeAuthoritativeSubject> = {},
  reads?: { count: number },
): GuardedMergeSubjectSource {
  return {
    async read(): Promise<GuardedMergeAuthoritativeSubject> {
      if (reads !== undefined) reads.count += 1;
      return { headSha: HEAD, baseBranch: 'main', baseSha: BASE, ...overrides };
    },
  };
}

describe('GuardedMergeService', () => {
  it('fails closed without a durable verification receipt and never dispatches', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(reader(undefined), dispatchPort(calls), subjectSource());

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
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt(STALE_HEAD) }),
      dispatchPort(calls),
      subjectSource(),
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
    const calls: GuardedMergeDispatchRequest[] = [];
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
      subjectSource(),
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
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      dispatchPort(calls),
      subjectSource(),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'dispatched',
      receiptRef: RECEIPT_REF,
      subject,
    });
    expect(calls).toEqual([{ receiptRef: RECEIPT_REF, subject, mergeMethod: 'merge' }]);
  });

  it('dispatches the merge method the policy declares', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      dispatchPort(calls),
      subjectSource(),
    );

    await expect(service.dispatch({
      policy: { ...policy, mergeMethod: 'squash' },
      subject,
      receiptRef: RECEIPT_REF,
    })).resolves.toMatchObject({ status: 'dispatched' });
    expect(calls).toEqual([{ receiptRef: RECEIPT_REF, subject, mergeMethod: 'squash' }]);
  });

  it('fails closed when receipt storage cannot be inspected', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const failingReader: GuardedMergeReceiptReader = {
      async getByRef(): Promise<never> {
        throw new Error('storage unavailable');
      },
    };
    const service = new GuardedMergeService(failingReader, dispatchPort(calls), subjectSource());

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'receipt_store_error',
      receiptRef: RECEIPT_REF,
    });
    expect(calls).toEqual([]);
  });

  it('fails closed when the receipt reader returns a different receipt identity', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: 'merge-verification:other', receipt: receipt() }),
      dispatchPort(calls),
      subjectSource(),
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
      subjectSource(),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'merge_dispatch_error',
      receiptRef: RECEIPT_REF,
      detail: 'provider failure',
    });
  });

  it('reports a bounded single-line dispatch detail and redacts credential-shaped text', async () => {
    const failingPort: GuardedMergeDispatchPort = {
      async dispatchMerge(): Promise<never> {
        throw new Error(
          `Unknown MCP server: github\n\tghp_abcdefghijklmnopqrstuvwxyz0123456789 ${'x'.repeat(600)}`,
        );
      },
    };
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      failingPort,
      subjectSource(),
    );

    const result = await service.dispatch({ policy, subject, receiptRef: RECEIPT_REF });
    expect(result).toMatchObject({
      status: 'inspect_required',
      reason: 'merge_dispatch_error',
      receiptRef: RECEIPT_REF,
    });
    if (result.status !== 'inspect_required') throw new Error('expected inspect_required');
    expect(result.detail).toContain('Unknown MCP server: github');
    expect(result.detail).not.toContain('\n');
    expect(result.detail).not.toContain('\t');
    expect(result.detail).not.toContain('ghp_');
    expect(result.detail).toContain('[redacted-token]');
    expect((result.detail ?? '').length).toBeLessThanOrEqual(400);
  });

  it('omits dispatch detail when the failure carries no message', async () => {
    const failingPort: GuardedMergeDispatchPort = {
      async dispatchMerge(): Promise<never> {
        throw undefined;
      },
    };
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      failingPort,
      subjectSource(),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'merge_dispatch_error',
      receiptRef: RECEIPT_REF,
    });
  });

  it('rejects an empty receipt ref before reading storage or dispatching', async () => {
    let reads = 0;
    const subjectReads = { count: 0 };
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService({
      async getByRef(): Promise<undefined> {
        reads += 1;
        return undefined;
      },
    }, dispatchPort(calls), subjectSource({}, subjectReads));

    await expect(service.dispatch({ policy, subject, receiptRef: '   ' })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'invalid_receipt_ref',
      receiptRef: '',
    });
    expect(reads).toBe(0);
    expect(subjectReads.count).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a head the provider no longer holds, before reading the receipt', async () => {
    let reads = 0;
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      {
        async getByRef(): Promise<undefined> {
          reads += 1;
          return undefined;
        },
      },
      dispatchPort(calls),
      subjectSource({ headSha: STALE_HEAD }),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'subject_mismatch',
      receiptRef: RECEIPT_REF,
      detail: 'the pull request head is no longer the head the caller named',
    });
    expect(reads).toBe(0);
    expect(calls).toEqual([]);
  });

  it('refuses a base branch the provider does not hold', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      dispatchPort(calls),
      subjectSource({ baseBranch: 'release' }),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toMatchObject({
      status: 'inspect_required',
      reason: 'subject_mismatch',
      detail: 'the pull request targets a different base branch than the caller named',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a base commit the provider does not hold', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      dispatchPort(calls),
      subjectSource({ baseSha: STALE_HEAD }),
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toMatchObject({
      status: 'inspect_required',
      reason: 'subject_mismatch',
      detail: 'the pull request base commit is no longer the base the caller named',
    });
    expect(calls).toEqual([]);
  });

  it('fails closed when the provider cannot confirm the subject', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      dispatchPort(calls),
      {
        async read(): Promise<never> {
          throw new Error('provider unavailable');
        },
      },
    );

    await expect(service.dispatch({ policy, subject, receiptRef: RECEIPT_REF })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'subject_unavailable',
      receiptRef: RECEIPT_REF,
    });
    expect(calls).toEqual([]);
  });

  it('compares hex SHAs case-insensitively in the preflight', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const upper = { ...subject, headSha: LETTERED_HEAD.toUpperCase() };
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt(upper.headSha) }),
      dispatchPort(calls),
      subjectSource({ headSha: LETTERED_HEAD, baseSha: BASE }),
    );

    await expect(service.dispatch({ policy, subject: upper, receiptRef: RECEIPT_REF }))
      .resolves.toMatchObject({ status: 'dispatched' });
    expect(calls).toHaveLength(1);
  });

  it('keeps the receipt head comparison byte-exact', async () => {
    // The preflight leniency above must not leak into the evidence rule: a
    // receipt written for the same commit in another case is still a different
    // string, and `evaluateMergeEvidence` refuses it.
    const calls: GuardedMergeDispatchRequest[] = [];
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt(LETTERED_HEAD.toUpperCase()) }),
      dispatchPort(calls),
      subjectSource({ headSha: LETTERED_HEAD, baseSha: BASE }),
    );

    const result = await service.dispatch({
      policy,
      subject: { ...subject, headSha: LETTERED_HEAD },
      receiptRef: RECEIPT_REF,
    });
    expect(result.status).toBe('blocked');
    const codes = result.status === 'blocked'
      ? result.decision.blockers.map((blocker) => blocker.code)
      : [];
    expect(codes).toContain('receipt_head_stale');
    expect(calls).toEqual([]);
  });

  it('enforces the provider base when the caller omits baseSha', async () => {
    // Omitting baseSha used to skip the receipt's base check entirely, because
    // the evaluator only compares a base both sides carry. The provider read
    // makes the base known, so it is no longer the caller's to omit.
    const calls: GuardedMergeDispatchRequest[] = [];
    const { baseSha: _omitted, ...withoutBase } = subject;
    const staleBase = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: { ...receipt(), baseSha: staleBase } }),
      dispatchPort(calls),
      subjectSource({ baseSha: BASE }),
    );

    await expect(service.dispatch({ policy, subject: withoutBase, receiptRef: RECEIPT_REF }))
      .resolves.toMatchObject({
        status: 'blocked',
        decision: {
          status: 'MERGE_BLOCKED',
          blockers: [{ code: 'receipt_base_stale', expected: BASE, observed: staleBase }],
        },
      });
    expect(calls).toEqual([]);
  });

  it('dispatches the subject the provider confirmed, not the object the caller sent', async () => {
    const calls: GuardedMergeDispatchRequest[] = [];
    const { baseSha: _omitted, ...withoutBase } = subject;
    const service = new GuardedMergeService(
      reader({ receiptRef: RECEIPT_REF, receipt: receipt() }),
      dispatchPort(calls),
      subjectSource({ baseSha: BASE }),
    );

    const result = await service.dispatch({ policy, subject: withoutBase, receiptRef: RECEIPT_REF });
    expect(result).toMatchObject({ status: 'dispatched' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject.baseSha).toBe(BASE);
  });
});
