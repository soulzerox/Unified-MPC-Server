import type { IssueClosureReconciliationDecision } from '@unified-mpc/domain';

export type IssueClosureLifecycleTargetState = 'open' | 'closed';

export interface AuthorizeIssueClosureLifecycleMutationRequest {
  readonly decision: IssueClosureReconciliationDecision;
  readonly issue: string;
  readonly targetState: IssueClosureLifecycleTargetState;
}

export type IssueClosureLifecycleMutationPolicyResult =
  | {
    readonly status: 'authorized';
    readonly evidence: string;
  }
  | {
    readonly status: 'denied';
  }
  | {
    readonly status: 'inspect_required';
  };

export interface IssueClosureLifecycleMutationPolicyPort {
  authorizeIssueLifecycleMutation(
    request: AuthorizeIssueClosureLifecycleMutationRequest,
  ): Promise<IssueClosureLifecycleMutationPolicyResult>;
}

export interface SetIssueClosureLifecycleStateRequest {
  readonly issue: string;
  readonly targetState: IssueClosureLifecycleTargetState;
}

export type IssueClosureLifecycleMutationPortResult =
  | {
    readonly status: 'confirmed';
    readonly issue: string;
    readonly state: IssueClosureLifecycleTargetState;
    readonly evidence: string;
  }
  | {
    readonly status: 'ambiguous';
    readonly issue: string;
  };

export interface IssueClosureLifecycleMutationPort {
  setIssueState(
    request: SetIssueClosureLifecycleStateRequest,
  ): Promise<IssueClosureLifecycleMutationPortResult>;
}

export type IssueClosureLifecycleMutationFailureReason =
  | 'reconciliation_inspect_required'
  | 'mutation_not_authorized'
  | 'policy_state_ambiguous'
  | 'policy_provider_error'
  | 'mutation_state_ambiguous'
  | 'mutation_contract_violation'
  | 'mutation_provider_error';

export type IssueClosureLifecycleMutationResult =
  | {
    readonly status: 'not_mutated';
    readonly disposition: 'no_action';
    readonly issue: string;
    readonly action: 'none';
    readonly observedState: IssueClosureReconciliationDecision['observedState'];
    readonly expectedState: IssueClosureReconciliationDecision['expectedState'];
  }
  | {
    readonly status: 'mutated';
    readonly action: 'reopened' | 'closed';
    readonly issue: string;
    readonly state: IssueClosureLifecycleTargetState;
    readonly evidence: readonly string[];
  }
  | {
    readonly status: 'inspect_required';
    readonly reason: IssueClosureLifecycleMutationFailureReason;
    readonly issue: string;
    readonly action: IssueClosureReconciliationDecision['action'];
    readonly targetState: IssueClosureLifecycleTargetState;
    readonly evidence: readonly string[];
    readonly detail?: string;
  };

export class IssueClosureLifecycleMutationService {
  public constructor(
    private readonly policy: IssueClosureLifecycleMutationPolicyPort,
    private readonly mutation: IssueClosureLifecycleMutationPort,
  ) {}

  public async execute(
    decision: IssueClosureReconciliationDecision,
  ): Promise<IssueClosureLifecycleMutationResult> {
    if (decision.action === 'none') {
      return {
        status: 'not_mutated',
        disposition: 'no_action',
        issue: decision.issue,
        action: 'none',
        observedState: decision.observedState,
        expectedState: decision.expectedState,
      };
    }

    const targetState = targetStateFor(decision);

    if (decision.action === 'inspect_required') {
      return inspectRequired(
        'reconciliation_inspect_required',
        decision,
        targetState,
        [],
      );
    }

    let authorization: IssueClosureLifecycleMutationPolicyResult;
    try {
      authorization = await this.policy.authorizeIssueLifecycleMutation({
        decision,
        issue: decision.issue,
        targetState,
      });
    } catch {
      return inspectRequired(
        'policy_provider_error',
        decision,
        targetState,
        [],
        'issue lifecycle policy authorization failed',
      );
    }

    if (authorization.status === 'denied') {
      return inspectRequired(
        'mutation_not_authorized',
        decision,
        targetState,
        [],
      );
    }

    if (authorization.status === 'inspect_required') {
      return inspectRequired(
        'policy_state_ambiguous',
        decision,
        targetState,
        [],
      );
    }

    const policyEvidence = authorization.evidence.trim();
    if (policyEvidence.length === 0) {
      return inspectRequired(
        'policy_state_ambiguous',
        decision,
        targetState,
        [],
      );
    }

    let mutationResult: IssueClosureLifecycleMutationPortResult;
    try {
      mutationResult = await this.mutation.setIssueState({
        issue: decision.issue,
        targetState,
      });
    } catch {
      return inspectRequired(
        'mutation_provider_error',
        decision,
        targetState,
        [policyEvidence],
        'issue lifecycle mutation failed',
      );
    }

    if (mutationResult.status === 'ambiguous') {
      return inspectRequired(
        'mutation_state_ambiguous',
        decision,
        targetState,
        [policyEvidence],
      );
    }

    const mutationEvidence = mutationResult.evidence.trim();
    if (
      mutationResult.issue !== decision.issue
      || mutationResult.state !== targetState
      || mutationEvidence.length === 0
    ) {
      return inspectRequired(
        'mutation_contract_violation',
        decision,
        targetState,
        [policyEvidence],
      );
    }

    return {
      status: 'mutated',
      action: targetState === 'open' ? 'reopened' : 'closed',
      issue: decision.issue,
      state: targetState,
      evidence: [policyEvidence, mutationEvidence],
    };
  }
}

function targetStateFor(
  decision: IssueClosureReconciliationDecision,
): IssueClosureLifecycleTargetState {
  if (decision.action === 'reopen_required') return 'open';
  if (decision.action === 'close_if_policy_allows') return 'closed';
  return decision.expectedState;
}

function inspectRequired(
  reason: IssueClosureLifecycleMutationFailureReason,
  decision: IssueClosureReconciliationDecision,
  targetState: IssueClosureLifecycleTargetState,
  evidence: readonly string[],
  detail?: string,
): Extract<IssueClosureLifecycleMutationResult, { readonly status: 'inspect_required' }> {
  return {
    status: 'inspect_required',
    reason,
    issue: decision.issue,
    action: decision.action,
    targetState,
    evidence,
    ...(detail === undefined ? {} : { detail }),
  };
}
