import { describe, expect, it } from 'vitest';
import {
  evaluateMergeEvidence,
  type MergeVerificationReceipt,
  type RepositoryMergePolicy,
} from './merge-verification.js';

const HEAD = '1111111111111111111111111111111111111111';
const NEXT_HEAD = '2222222222222222222222222222222222222222';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const localPolicy: RepositoryMergePolicy = {
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

const subject = {
  repository: localPolicy.repository,
  pullRequest: 230,
  headSha: HEAD,
  baseBranch: 'main',
  baseSha: BASE,
} as const;

function localReceipt(overrides: Partial<MergeVerificationReceipt> = {}): MergeVerificationReceipt {
  return {
    repository: subject.repository,
    pullRequest: subject.pullRequest,
    headSha: subject.headSha,
    baseSha: subject.baseSha,
    verificationMode: 'local_exact_head',
    gates: [
      {
        name: 'test',
        source: 'local_command',
        headSha: HEAD,
        outcome: 'passed',
        evidence: 'task:test-1',
      },
      {
        name: 'typecheck',
        source: 'local_command',
        headSha: HEAD,
        outcome: 'passed',
        evidence: 'task:typecheck-1',
      },
    ],
    review: {
      outcome: 'clean_llm_review',
      headSha: HEAD,
      evidence: 'review:42',
    },
    createdAt: '2026-10-04T08:00:00.000Z',
    ...overrides,
  };
}

describe('evaluateMergeEvidence', () => {
  it('fails closed when no merge verification receipt exists', () => {
    expect(evaluateMergeEvidence(localPolicy, subject, undefined)).toEqual({
      status: 'MERGE_BLOCKED',
      blockers: [{ code: 'receipt_missing' }],
    });
  });

  it('allows local exact-head verification without inventing GitHub CI evidence', () => {
    expect(evaluateMergeEvidence(localPolicy, subject, localReceipt())).toEqual({
      status: 'MERGE_ALLOWED',
      blockers: [],
    });
  });

  it('invalidates receipt, gates, and review when the PR head moves', () => {
    const moved = { ...subject, headSha: NEXT_HEAD };

    expect(evaluateMergeEvidence(localPolicy, moved, localReceipt())).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([
        { code: 'receipt_head_stale', expected: NEXT_HEAD, observed: HEAD },
        { code: 'required_gate_head_stale', gate: 'test', expected: NEXT_HEAD, observed: HEAD },
        { code: 'required_gate_head_stale', gate: 'typecheck', expected: NEXT_HEAD, observed: HEAD },
        { code: 'review_head_stale', expected: NEXT_HEAD, observed: HEAD },
      ]),
    });
  });

  it('fails closed when required gate evidence is missing, failed, unavailable, or from the wrong source', () => {
    const cases: readonly [string, MergeVerificationReceipt['gates'], string][] = [
      [
        'missing',
        localReceipt().gates.filter((gate) => gate.name !== 'typecheck'),
        'required_gate_missing',
      ],
      [
        'failed',
        localReceipt().gates.map((gate) => gate.name === 'test' ? { ...gate, outcome: 'failed' as const } : gate),
        'required_gate_not_passed',
      ],
      [
        'unavailable',
        localReceipt().gates.map((gate) => gate.name === 'test' ? { ...gate, outcome: 'unavailable' as const } : gate),
        'required_gate_not_passed',
      ],
      [
        'wrong source',
        localReceipt().gates.map((gate) => gate.name === 'test' ? { ...gate, source: 'github_check' as const } : gate),
        'required_gate_source_mismatch',
      ],
    ];

    for (const [, gates, blocker] of cases) {
      expect(evaluateMergeEvidence(localPolicy, subject, localReceipt({ gates }))).toMatchObject({
        status: 'MERGE_BLOCKED',
        blockers: expect.arrayContaining([expect.objectContaining({ code: blocker })]),
      });
    }
  });

  it('keeps review evidence truthful and policy-scoped', () => {
    expect(evaluateMergeEvidence(
      localPolicy,
      subject,
      localReceipt({ review: { outcome: 'github_approved', headSha: HEAD, evidence: 'github-review:1' } }),
    )).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'review_outcome_not_allowed', observed: 'github_approved' })]),
    });

    expect(evaluateMergeEvidence(
      localPolicy,
      subject,
      localReceipt({ review: { outcome: 'missing', headSha: HEAD } }),
    )).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'review_missing' })]),
    });

    expect(evaluateMergeEvidence(
      localPolicy,
      subject,
      localReceipt({ review: { outcome: 'rejected', headSha: HEAD, evidence: 'review:rejected' } }),
    )).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'review_rejected' })]),
    });
  });

  it('does not let optional review metadata become an accidental merge gate', () => {
    const noReviewPolicy: RepositoryMergePolicy = {
      ...localPolicy,
      reviewPolicy: { required: false, acceptedOutcomes: [] },
    };

    expect(evaluateMergeEvidence(
      noReviewPolicy,
      subject,
      localReceipt({ review: { outcome: 'missing', headSha: NEXT_HEAD } }),
    )).toEqual({
      status: 'MERGE_ALLOWED',
      blockers: [],
    });
  });

  it('rejects ambiguous duplicate receipts for one required gate', () => {
    const receipt = localReceipt();
    const duplicateTestGate = receipt.gates.find((gate) => gate.name === 'test');
    expect(duplicateTestGate).toBeDefined();
    if (duplicateTestGate === undefined) return;

    expect(evaluateMergeEvidence(
      localPolicy,
      subject,
      { ...receipt, gates: [...receipt.gates, duplicateTestGate] },
    )).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'required_gate_ambiguous', gate: 'test' }),
      ]),
    });
  });

  it('requires the receipt to match repository, PR, target branch/base and configured verification mode', () => {
    const githubPolicy: RepositoryMergePolicy = {
      ...localPolicy,
      verificationMode: 'github_ci',
      requiredGates: [{ name: 'test', source: 'github_check' }],
      reviewPolicy: { required: false, acceptedOutcomes: [] },
    };

    expect(evaluateMergeEvidence(localPolicy, { ...subject, repository: 'other/repo' }, localReceipt())).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'repository_mismatch' })]),
    });
    expect(evaluateMergeEvidence(localPolicy, { ...subject, pullRequest: 231 }, localReceipt())).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'pull_request_mismatch' })]),
    });
    expect(evaluateMergeEvidence(localPolicy, { ...subject, baseBranch: 'release' }, localReceipt())).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'base_branch_mismatch' })]),
    });
    expect(evaluateMergeEvidence(localPolicy, { ...subject, baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, localReceipt())).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'receipt_base_stale' })]),
    });
    expect(evaluateMergeEvidence(githubPolicy, subject, localReceipt())).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'verification_mode_mismatch' })]),
    });
  });

  it('rejects gate-source policy that contradicts the configured verification mode', () => {
    const invalidPolicy: RepositoryMergePolicy = {
      ...localPolicy,
      requiredGates: [{ name: 'test', source: 'github_check' }],
    };

    expect(evaluateMergeEvidence(
      invalidPolicy,
      subject,
      localReceipt({
        gates: [{ name: 'test', source: 'github_check', headSha: HEAD, outcome: 'passed' }],
      }),
    )).toMatchObject({
      status: 'MERGE_BLOCKED',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'policy_gate_source_incompatible', gate: 'test' }),
      ]),
    });
  });

  it('supports hybrid verification with explicitly sourced exact-head gates', () => {
    const hybridPolicy: RepositoryMergePolicy = {
      repository: subject.repository,
      defaultBranch: 'main',
      verificationMode: 'hybrid',
      requiredGates: [
        { name: 'test', source: 'local_command' },
        { name: 'provenance', source: 'github_check' },
      ],
      reviewPolicy: {
        required: true,
        acceptedOutcomes: ['github_approved', 'clean_llm_review'],
      },
    };
    const receipt: MergeVerificationReceipt = {
      repository: subject.repository,
      pullRequest: subject.pullRequest,
      headSha: HEAD,
      baseSha: BASE,
      verificationMode: 'hybrid',
      gates: [
        { name: 'test', source: 'local_command', headSha: HEAD, outcome: 'passed' },
        { name: 'provenance', source: 'github_check', headSha: HEAD, outcome: 'passed' },
      ],
      review: { outcome: 'github_approved', headSha: HEAD, evidence: 'github-review:2' },
      createdAt: '2026-10-04T08:00:00.000Z',
    };

    expect(evaluateMergeEvidence(hybridPolicy, subject, receipt)).toEqual({
      status: 'MERGE_ALLOWED',
      blockers: [],
    });
  });
});
