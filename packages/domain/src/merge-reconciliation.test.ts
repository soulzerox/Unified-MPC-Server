import { describe, expect, it } from 'vitest';
import type { MergeVerificationReceipt, RepositoryMergePolicy } from './merge-verification.js';
import { reconcileMergeEvidence, type MergeObservation } from './merge-reconciliation.js';

const HEAD = '1111111111111111111111111111111111111111';
const STALE_HEAD = '2222222222222222222222222222222222222222';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const policy: RepositoryMergePolicy = {
  repository: 'soulzerox/Unified-MPC-Server',
  defaultBranch: 'main',
  verificationMode: 'local_exact_head',
  requiredGates: [{ name: 'test', source: 'local_command' }],
  reviewPolicy: { required: true, acceptedOutcomes: ['clean_llm_review'] },
};

function receipt(headSha = HEAD): MergeVerificationReceipt {
  return {
    repository: policy.repository,
    pullRequest: 279,
    headSha,
    baseSha: BASE,
    verificationMode: 'local_exact_head',
    gates: [{
      name: 'test',
      source: 'local_command',
      headSha,
      outcome: 'passed',
      evidence: 'task:test',
    }],
    review: {
      outcome: 'clean_llm_review',
      headSha,
      evidence: 'review:commented',
    },
    createdAt: '2026-10-07T01:20:00.000Z',
  };
}

function observation(overrides: Partial<MergeObservation> = {}): MergeObservation {
  return {
    repository: policy.repository,
    pullRequest: 279,
    headSha: HEAD,
    baseBranch: 'main',
    baseSha: BASE,
    merged: true,
    mergeMethod: 'merge',
    mergeSha: MERGE,
    observedAt: '2026-10-07T01:30:22.000Z',
    ...overrides,
  };
}

describe('reconcileMergeEvidence', () => {
  it('reconciles a merged PR only when exact-head evidence and the expected merge method still agree', () => {
    expect(reconcileMergeEvidence(policy, observation(), receipt(), 'merge')).toEqual({
      status: 'RECONCILED',
      action: 'none',
      reason: 'merge_reconciled',
      expectedMergeMethod: 'merge',
      observedMergeMethod: 'merge',
      mergeSha: MERGE,
      blockers: [],
    });
  });

  it('surfaces a policy breach when a merged PR has no verification receipt', () => {
    expect(reconcileMergeEvidence(policy, observation(), undefined, 'merge')).toMatchObject({
      status: 'POLICY_BREACH',
      action: 'surface_policy_breach',
      reason: 'verification_receipt_missing',
      blockers: [{ code: 'receipt_missing' }],
    });
  });

  it('surfaces stale or failed verification evidence as a policy breach', () => {
    expect(reconcileMergeEvidence(policy, observation(), receipt(STALE_HEAD), 'merge')).toMatchObject({
      status: 'POLICY_BREACH',
      action: 'surface_policy_breach',
      reason: 'verification_policy_breach',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'receipt_head_stale', expected: HEAD, observed: STALE_HEAD }),
        expect.objectContaining({ code: 'review_head_stale', expected: HEAD, observed: STALE_HEAD }),
      ]),
    });
  });

  it('surfaces a merge-method mismatch as a policy breach after evidence otherwise passes', () => {
    expect(reconcileMergeEvidence(policy, observation({ mergeMethod: 'squash' }), receipt(), 'merge')).toMatchObject({
      status: 'POLICY_BREACH',
      action: 'surface_policy_breach',
      reason: 'merge_method_mismatch',
      expectedMergeMethod: 'merge',
      observedMergeMethod: 'squash',
      blockers: [],
    });
  });

  it('requires inspection when the merge is not observed or the final merge SHA is unavailable', () => {
    expect(reconcileMergeEvidence(policy, observation({ merged: false, mergeMethod: undefined, mergeSha: undefined }), receipt(), 'merge'))
      .toMatchObject({
        status: 'INSPECT_REQUIRED',
        action: 'inspect_required',
        reason: 'merge_not_observed',
      });

    expect(reconcileMergeEvidence(policy, observation({ mergeSha: undefined }), receipt(), 'merge'))
      .toMatchObject({
        status: 'INSPECT_REQUIRED',
        action: 'inspect_required',
        reason: 'merge_sha_missing',
      });
  });

  it('requires inspection for malformed provider observation metadata instead of claiming reconciliation', () => {
    expect(reconcileMergeEvidence(policy, observation({ mergeSha: 'not-a-sha' }), receipt(), 'merge'))
      .toMatchObject({
        status: 'INSPECT_REQUIRED',
        action: 'inspect_required',
        reason: 'merge_sha_invalid',
      });

    expect(reconcileMergeEvidence(policy, observation({ observedAt: 'not-a-date' }), receipt(), 'merge'))
      .toMatchObject({
        status: 'INSPECT_REQUIRED',
        action: 'inspect_required',
        reason: 'observation_timestamp_invalid',
      });
  });
});
