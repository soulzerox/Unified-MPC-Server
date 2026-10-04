import { describe, expect, it } from 'vitest';
import type { MergeEvidenceDecision } from './merge-verification.js';
import {
  evaluateIssueClosureEvidence,
  type IssueClosureEvidenceInput,
} from './issue-closure-evidence.js';

const IMPLEMENTATION_PR = 'soulzerox/Unified-MPC-Server#231';
const SECOND_PR = 'soulzerox/Unified-MPC-Server#232';

const mergeAllowed: MergeEvidenceDecision = {
  status: 'MERGE_ALLOWED',
  blockers: [],
};

const mergeBlocked: MergeEvidenceDecision = {
  status: 'MERGE_BLOCKED',
  blockers: [{ code: 'receipt_missing' }],
};

function closureInput(
  overrides: Partial<IssueClosureEvidenceInput> = {},
): IssueClosureEvidenceInput {
  return {
    issue: 'soulzerox/Unified-MPC-Server#99',
    implementationPRs: [IMPLEMENTATION_PR],
    closeIntent: 'explicit_close',
    antiCloseMarkers: [],
    criteria: [
      {
        criterion: 'closing-keyword parser safety',
        source: { kind: 'issue_body', ref: 'issue#99' },
        disposition: {
          kind: 'satisfied',
          evidence: ['pr#230'],
        },
      },
      {
        criterion: 'closure evidence consumes merge verification',
        source: { kind: 'issue_comment', ref: 'issuecomment-5761159647' },
        disposition: {
          kind: 'satisfied',
          evidence: ['pr#231'],
        },
      },
    ],
    mergeVerifications: [
      {
        implementationPR: IMPLEMENTATION_PR,
        decision: mergeAllowed,
        receiptRef: 'merge-verification:pr231@461d7e41',
      },
    ],
    ...overrides,
  };
}

describe('evaluateIssueClosureEvidence', () => {
  it('does not treat references or conventional issue mentions as close intent', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      closeIntent: 'reference_only',
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'explicit_close_intent_missing' }),
      ]),
    });

    expect(evaluateIssueClosureEvidence(closureInput({
      closeIntent: 'none',
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'explicit_close_intent_missing' }),
      ]),
    });
  });

  it('treats normalized anti-close or remaining-scope markers as a hard fence', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      antiCloseMarkers: [
        'Parent #99 remains open',
        'remaining #99 scope',
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'anti_close_fence',
          evidence: 'Parent #99 remains open',
        }),
        expect.objectContaining({
          code: 'anti_close_fence',
          evidence: 'remaining #99 scope',
        }),
      ]),
    });
  });

  it('includes unresolved scope added in issue comments and reports the exact criterion', () => {
    const receipt = evaluateIssueClosureEvidence(closureInput({
      criteria: [
        {
          criterion: 'original body criterion',
          source: { kind: 'issue_body', ref: 'issue#99' },
          disposition: { kind: 'satisfied', evidence: ['pr#230'] },
        },
        {
          criterion: 'comment-added cross-repo reconciliation',
          source: { kind: 'issue_comment', ref: 'issuecomment-5761159647' },
          disposition: { kind: 'unresolved' },
        },
      ],
    }));

    expect(receipt).toMatchObject({
      closeAllowed: false,
      unresolvedCriteria: [
        {
          criterion: 'comment-added cross-repo reconciliation',
          source: { kind: 'issue_comment', ref: 'issuecomment-5761159647' },
        },
      ],
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'unresolved_criterion',
          criterion: 'comment-added cross-repo reconciliation',
          sourceRef: 'issuecomment-5761159647',
        }),
      ]),
    });
  });

  it('allows unresolved-looking scope only when it has durable successor ownership or approved removal evidence', () => {
    const receipt = evaluateIssueClosureEvidence(closureInput({
      criteria: [
        {
          criterion: 'parser safety',
          source: { kind: 'issue_body', ref: 'issue#99' },
          disposition: { kind: 'satisfied', evidence: ['pr#230'] },
        },
        {
          criterion: 'durable workflow receipt persistence',
          source: { kind: 'issue_comment', ref: 'issuecomment-5761159647' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/Unified-MPC-Server#142',
            ownerState: 'open',
            linkEvidence: ['issue#99->#142', 'issue#142->#99'],
          },
        },
        {
          criterion: 'obsolete historical wording',
          source: { kind: 'scope_change', ref: 'scope-change-2026-10-04' },
          disposition: {
            kind: 'removed',
            approvalEvidence: ['scope-change-approved:user'],
          },
        },
      ],
    }));

    expect(receipt).toMatchObject({
      closeAllowed: true,
      reason: 'closure_evidence_complete',
      satisfiedCriteria: [
        {
          criterion: 'parser safety',
          evidence: ['pr#230'],
        },
      ],
      successorScope: [
        {
          scope: 'durable workflow receipt persistence',
          ownerIssue: 'soulzerox/Unified-MPC-Server#142',
          evidence: ['issue#99->#142', 'issue#142->#99'],
        },
      ],
      removedScope: [
        {
          scope: 'obsolete historical wording',
          approvalEvidence: ['scope-change-approved:user'],
        },
      ],
      unresolvedCriteria: [],
      mergeVerificationRefs: [
        {
          implementationPR: IMPLEMENTATION_PR,
          receiptRef: 'merge-verification:pr231@461d7e41',
        },
      ],
      blockers: [],
    });
  });

  it('does not accept a satisfied criterion without concrete evidence', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      criteria: [
        {
          criterion: 'claimed complete without proof',
          source: { kind: 'issue_body', ref: 'issue#99' },
          disposition: {
            kind: 'satisfied',
            evidence: [],
          },
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      unresolvedCriteria: [
        {
          criterion: 'claimed complete without proof',
          source: { kind: 'issue_body', ref: 'issue#99' },
        },
      ],
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'satisfied_criterion_evidence_missing',
          criterion: 'claimed complete without proof',
        }),
      ]),
    });
  });

  it('fails closed when successor ownership is not backed by a durable link', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      criteria: [
        {
          criterion: 'cross-repo owner',
          source: { kind: 'issue_comment', ref: 'issuecomment-owner' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#18',
            ownerState: 'open',
            linkEvidence: [],
          },
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'successor_link_evidence_missing',
          criterion: 'cross-repo owner',
        }),
      ]),
    });
  });

  it('does not treat a closed or unknown successor as durable remaining-scope ownership', () => {
    for (const ownerState of ['closed', 'unknown'] as const) {
      expect(evaluateIssueClosureEvidence(closureInput({
        criteria: [
          {
            criterion: 'remaining lifecycle work',
            source: { kind: 'issue_comment', ref: 'issuecomment-owner-state' },
            disposition: {
              kind: 'successor',
              ownerIssue: 'soulzerox/Unified-MPC-Server#80',
              ownerState,
              linkEvidence: ['#99->#80'],
            },
          },
        ],
      }))).toMatchObject({
        closeAllowed: false,
        unresolvedCriteria: [
          {
            criterion: 'remaining lifecycle work',
            source: { kind: 'issue_comment', ref: 'issuecomment-owner-state' },
          },
        ],
        blockers: expect.arrayContaining([
          expect.objectContaining({
            code: 'successor_owner_not_open',
            criterion: 'remaining lifecycle work',
          }),
        ]),
      });
    }
  });

  it('fails closed when a scope removal is not explicitly approved', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      criteria: [
        {
          criterion: 'removed without approval',
          source: { kind: 'scope_change', ref: 'scope-change-missing-approval' },
          disposition: {
            kind: 'removed',
            approvalEvidence: [],
          },
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'scope_removal_approval_missing',
          criterion: 'removed without approval',
        }),
      ]),
    });
  });

  it('allows a standalone audited issue with no implementation PR to close without merge evidence', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      implementationPRs: [],
      mergeVerifications: [],
      criteria: [
        {
          criterion: 'remaining work transferred to open owners',
          source: { kind: 'issue_comment', ref: 'audit-transfer' },
          disposition: {
            kind: 'successor',
            ownerIssue: 'soulzerox/thai-rag-mcp#8',
            ownerState: 'open',
            linkEvidence: ['audit-transfer->#8'],
          },
        },
      ],
    }))).toMatchObject({
      closeAllowed: true,
      mergeVerificationRefs: [],
      blockers: [],
    });
  });

  it('requires exact merge verification for every implementation PR', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      implementationPRs: [IMPLEMENTATION_PR, SECOND_PR],
      mergeVerifications: [
        {
          implementationPR: IMPLEMENTATION_PR,
          decision: mergeAllowed,
          receiptRef: 'merge-verification:pr231@461d7e41',
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'merge_verification_missing',
          implementationPR: SECOND_PR,
        }),
      ]),
    });
  });

  it('rejects duplicate implementation PR identities instead of double-counting one receipt', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      implementationPRs: [IMPLEMENTATION_PR, IMPLEMENTATION_PR],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'implementation_pr_duplicate',
          implementationPR: IMPLEMENTATION_PR,
        }),
      ]),
    });
  });

  it('accepts multiple implementation PRs only when each has one exact allowed receipt', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      implementationPRs: [IMPLEMENTATION_PR, SECOND_PR],
      mergeVerifications: [
        {
          implementationPR: IMPLEMENTATION_PR,
          decision: mergeAllowed,
          receiptRef: 'merge-verification:pr231@461d7e41',
        },
        {
          implementationPR: SECOND_PR,
          decision: mergeAllowed,
          receiptRef: 'merge-verification:pr232@abcdef12',
        },
      ],
    }))).toMatchObject({
      closeAllowed: true,
      mergeVerificationRefs: [
        {
          implementationPR: IMPLEMENTATION_PR,
          receiptRef: 'merge-verification:pr231@461d7e41',
        },
        {
          implementationPR: SECOND_PR,
          receiptRef: 'merge-verification:pr232@abcdef12',
        },
      ],
      blockers: [],
    });
  });

  it('rejects ambiguous or unrelated merge evidence instead of selecting it arbitrarily', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      mergeVerifications: [
        {
          implementationPR: IMPLEMENTATION_PR,
          decision: mergeAllowed,
          receiptRef: 'merge-verification:first',
        },
        {
          implementationPR: IMPLEMENTATION_PR,
          decision: mergeAllowed,
          receiptRef: 'merge-verification:second',
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'merge_verification_ambiguous',
          implementationPR: IMPLEMENTATION_PR,
        }),
      ]),
    });

    expect(evaluateIssueClosureEvidence(closureInput({
      mergeVerifications: [
        {
          implementationPR: IMPLEMENTATION_PR,
          decision: mergeAllowed,
          receiptRef: 'merge-verification:pr231@461d7e41',
        },
        {
          implementationPR: SECOND_PR,
          decision: mergeAllowed,
          receiptRef: 'merge-verification:unrelated',
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'merge_verification_unexpected',
          implementationPR: SECOND_PR,
        }),
      ]),
    });
  });

  it('cannot issue a valid closure receipt from blocked or unreferenced merge verification', () => {
    expect(evaluateIssueClosureEvidence(closureInput({
      mergeVerifications: [
        {
          implementationPR: IMPLEMENTATION_PR,
          decision: mergeBlocked,
          receiptRef: 'merge-verification:blocked',
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'merge_verification_blocked',
          implementationPR: IMPLEMENTATION_PR,
          mergeBlockers: [{ code: 'receipt_missing' }],
        }),
      ]),
    });

    expect(evaluateIssueClosureEvidence(closureInput({
      mergeVerifications: [
        {
          implementationPR: IMPLEMENTATION_PR,
          decision: mergeAllowed,
          receiptRef: '',
        },
      ],
    }))).toMatchObject({
      closeAllowed: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'merge_verification_reference_missing',
          implementationPR: IMPLEMENTATION_PR,
        }),
      ]),
    });
  });
});
