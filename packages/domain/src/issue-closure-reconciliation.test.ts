import { describe, expect, it } from 'vitest';
import type { IssueClosureReceipt } from './issue-closure-evidence.js';
import { reconcileIssueClosureState } from './issue-closure-reconciliation.js';

const ISSUE = 'soulzerox/Unified-MPC-Server#99';

function receipt(
  overrides: Partial<IssueClosureReceipt> = {},
): IssueClosureReceipt {
  return {
    issue: ISSUE,
    implementationPRs: ['soulzerox/Unified-MPC-Server#232'],
    satisfiedCriteria: [],
    successorScope: [],
    removedScope: [],
    unresolvedCriteria: [],
    mergeVerificationRefs: [
      {
        implementationPR: 'soulzerox/Unified-MPC-Server#232',
        receiptRef: 'merge-verification:pr232@8689c1a6',
      },
    ],
    closeAllowed: true,
    reason: 'closure_evidence_complete',
    blockers: [],
    ...overrides,
  };
}

describe('reconcileIssueClosureState', () => {
  it('requires reopening when an issue is closed despite a receipt that forbids closure', () => {
    const closureReceipt = receipt({
      closeAllowed: false,
      reason: 'anti_close_fence',
      blockers: [
        {
          code: 'anti_close_fence',
          evidence: 'Parent #99 remains open',
        },
      ],
    });

    expect(reconcileIssueClosureState(closureReceipt, {
      issue: ISSUE,
      state: 'closed',
    })).toEqual({
      status: 'UNEXPECTED_CLOSURE',
      action: 'reopen_required',
      issue: ISSUE,
      expectedState: 'open',
      observedState: 'closed',
      reason: 'closure_forbidden_but_issue_closed',
      closureBlockers: closureReceipt.blockers,
    });
  });

  it('treats an open issue as consistent when closure evidence forbids closure', () => {
    expect(reconcileIssueClosureState(receipt({
      closeAllowed: false,
      reason: 'unresolved_criterion',
      blockers: [
        {
          code: 'unresolved_criterion',
          criterion: 'post-merge reconciliation',
          sourceRef: 'issue#99',
        },
      ],
    }), {
      issue: ISSUE,
      state: 'open',
    })).toMatchObject({
      status: 'CONSISTENT_OPEN',
      action: 'none',
      expectedState: 'open',
      observedState: 'open',
      reason: 'closure_forbidden_issue_open',
    });
  });

  it('treats a closed issue as consistent when a valid receipt allows closure', () => {
    expect(reconcileIssueClosureState(receipt(), {
      issue: ISSUE,
      state: 'closed',
    })).toEqual({
      status: 'CONSISTENT_CLOSED',
      action: 'none',
      issue: ISSUE,
      expectedState: 'closed',
      observedState: 'closed',
      reason: 'allowed_closure_observed',
      closureBlockers: [],
    });
  });

  it('surfaces an allowed closure that was not observed without mutating issue state', () => {
    expect(reconcileIssueClosureState(receipt(), {
      issue: ISSUE,
      state: 'open',
    })).toEqual({
      status: 'CLOSE_NOT_OBSERVED',
      action: 'close_if_policy_allows',
      issue: ISSUE,
      expectedState: 'closed',
      observedState: 'open',
      reason: 'allowed_closure_not_observed',
      closureBlockers: [],
    });
  });

  it('requires inspection when the observed issue state is unknown', () => {
    expect(reconcileIssueClosureState(receipt(), {
      issue: ISSUE,
      state: 'unknown',
    })).toEqual({
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      issue: ISSUE,
      expectedState: 'closed',
      observedState: 'unknown',
      reason: 'issue_state_unknown',
      closureBlockers: [],
    });
  });

  it('requires inspection when the observation belongs to a different issue', () => {
    expect(reconcileIssueClosureState(receipt(), {
      issue: 'soulzerox/Unified-MPC-Server#80',
      state: 'closed',
    })).toEqual({
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      issue: ISSUE,
      expectedState: 'closed',
      observedState: 'closed',
      reason: 'issue_identity_mismatch',
      observedIssue: 'soulzerox/Unified-MPC-Server#80',
      closureBlockers: [],
    });
  });

  it('fails closed when a receipt claims closure is allowed while blockers remain', () => {
    const malformed = receipt({
      closeAllowed: true,
      blockers: [
        {
          code: 'unresolved_criterion',
          criterion: 'still open',
          sourceRef: 'issue#99',
        },
      ],
    });

    expect(reconcileIssueClosureState(malformed, {
      issue: ISSUE,
      state: 'closed',
    })).toMatchObject({
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      reason: 'closure_receipt_inconsistent',
      closureBlockers: malformed.blockers,
    });
  });

  it('fails closed when the receipt reason contradicts the closure decision', () => {
    expect(reconcileIssueClosureState(receipt({
      closeAllowed: true,
      reason: 'unexpected_reason',
      blockers: [],
    }), {
      issue: ISSUE,
      state: 'closed',
    })).toMatchObject({
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      reason: 'closure_receipt_inconsistent',
    });

    expect(reconcileIssueClosureState(receipt({
      closeAllowed: false,
      reason: 'anti_close_fence',
      blockers: [
        {
          code: 'unresolved_criterion',
          criterion: 'still open',
          sourceRef: 'issue#99',
        },
      ],
    }), {
      issue: ISSUE,
      state: 'open',
    })).toMatchObject({
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      reason: 'closure_receipt_inconsistent',
    });
  });

  it('fails closed when a receipt forbids closure without explaining why', () => {
    expect(reconcileIssueClosureState(receipt({
      closeAllowed: false,
      reason: 'unknown',
      blockers: [],
    }), {
      issue: ISSUE,
      state: 'open',
    })).toMatchObject({
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      reason: 'closure_receipt_inconsistent',
    });
  });
});
