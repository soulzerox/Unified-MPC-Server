import type {
  IssueClosureBlocker,
  IssueClosureReceipt,
} from './issue-closure-evidence.js';

export type ObservedIssueLifecycleState = 'open' | 'closed' | 'unknown';

export interface IssueClosureStateObservation {
  readonly issue: string;
  readonly state: ObservedIssueLifecycleState;
}

export type IssueClosureReconciliationStatus =
  | 'CONSISTENT_OPEN'
  | 'CONSISTENT_CLOSED'
  | 'UNEXPECTED_CLOSURE'
  | 'CLOSE_NOT_OBSERVED'
  | 'INSPECT_REQUIRED';

export type IssueClosureReconciliationAction =
  | 'none'
  | 'reopen_required'
  | 'close_if_policy_allows'
  | 'inspect_required';

export interface IssueClosureReconciliationDecision {
  readonly status: IssueClosureReconciliationStatus;
  readonly action: IssueClosureReconciliationAction;
  readonly issue: string;
  readonly expectedState: 'open' | 'closed';
  readonly observedState: ObservedIssueLifecycleState;
  readonly reason:
    | 'closure_forbidden_issue_open'
    | 'closure_forbidden_but_issue_closed'
    | 'allowed_closure_observed'
    | 'allowed_closure_not_observed'
    | 'issue_state_unknown'
    | 'issue_identity_mismatch'
    | 'closure_receipt_inconsistent';
  readonly observedIssue?: string;
  readonly closureBlockers: readonly IssueClosureBlocker[];
}

export function reconcileIssueClosureState(
  receipt: IssueClosureReceipt,
  observation: IssueClosureStateObservation,
): IssueClosureReconciliationDecision {
  const expectedState = receipt.closeAllowed ? 'closed' : 'open';

  if (!isReceiptConsistent(receipt)) {
    return {
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      issue: receipt.issue,
      expectedState,
      observedState: observation.state,
      reason: 'closure_receipt_inconsistent',
      closureBlockers: receipt.blockers,
    };
  }

  if (observation.issue !== receipt.issue) {
    return {
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      issue: receipt.issue,
      expectedState,
      observedState: observation.state,
      reason: 'issue_identity_mismatch',
      observedIssue: observation.issue,
      closureBlockers: receipt.blockers,
    };
  }

  if (observation.state === 'unknown') {
    return {
      status: 'INSPECT_REQUIRED',
      action: 'inspect_required',
      issue: receipt.issue,
      expectedState,
      observedState: observation.state,
      reason: 'issue_state_unknown',
      closureBlockers: receipt.blockers,
    };
  }

  if (!receipt.closeAllowed) {
    if (observation.state === 'closed') {
      return {
        status: 'UNEXPECTED_CLOSURE',
        action: 'reopen_required',
        issue: receipt.issue,
        expectedState: 'open',
        observedState: 'closed',
        reason: 'closure_forbidden_but_issue_closed',
        closureBlockers: receipt.blockers,
      };
    }

    return {
      status: 'CONSISTENT_OPEN',
      action: 'none',
      issue: receipt.issue,
      expectedState: 'open',
      observedState: 'open',
      reason: 'closure_forbidden_issue_open',
      closureBlockers: receipt.blockers,
    };
  }

  if (observation.state === 'closed') {
    return {
      status: 'CONSISTENT_CLOSED',
      action: 'none',
      issue: receipt.issue,
      expectedState: 'closed',
      observedState: 'closed',
      reason: 'allowed_closure_observed',
      closureBlockers: receipt.blockers,
    };
  }

  return {
    status: 'CLOSE_NOT_OBSERVED',
    action: 'close_if_policy_allows',
    issue: receipt.issue,
    expectedState: 'closed',
    observedState: 'open',
    reason: 'allowed_closure_not_observed',
    closureBlockers: receipt.blockers,
  };
}

function isReceiptConsistent(receipt: IssueClosureReceipt): boolean {
  if (receipt.closeAllowed) {
    return receipt.blockers.length === 0
      && receipt.reason === 'closure_evidence_complete';
  }

  return receipt.blockers.length > 0
    && receipt.reason === receipt.blockers[0]!.code;
}
