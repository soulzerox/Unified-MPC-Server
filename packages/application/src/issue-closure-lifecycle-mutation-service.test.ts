import { describe, expect, it } from 'vitest';
import type { IssueClosureReconciliationDecision } from '@unified-mpc/domain';
import {
  IssueClosureLifecycleMutationService,
  type IssueClosureLifecycleMutationPolicyPort,
  type IssueClosureLifecycleMutationPolicyResult,
  type IssueClosureLifecycleMutationPort,
  type IssueClosureLifecycleMutationPortResult,
} from './issue-closure-lifecycle-mutation-service.js';

const ISSUE = 'soulzerox/Unified-MPC-Server#99';

function decision(
  action: IssueClosureReconciliationDecision['action'],
): IssueClosureReconciliationDecision {
  if (action === 'reopen_required') {
    return {
      status: 'UNEXPECTED_CLOSURE',
      action,
      issue: ISSUE,
      expectedState: 'open',
      observedState: 'closed',
      reason: 'closure_forbidden_but_issue_closed',
      closureBlockers: [{ code: 'anti_close_fence', evidence: 'Parent #99 remains open' }],
    };
  }
  if (action === 'close_if_policy_allows') {
    return {
      status: 'CLOSE_NOT_OBSERVED',
      action,
      issue: ISSUE,
      expectedState: 'closed',
      observedState: 'open',
      reason: 'allowed_closure_not_observed',
      closureBlockers: [],
    };
  }
  if (action === 'inspect_required') {
    return {
      status: 'INSPECT_REQUIRED',
      action,
      issue: ISSUE,
      expectedState: 'open',
      observedState: 'unknown',
      reason: 'issue_state_unknown',
      closureBlockers: [{ code: 'unresolved_criterion', criterion: 'state', sourceRef: 'issue#99' }],
    };
  }
  return {
    status: 'CONSISTENT_OPEN',
    action: 'none',
    issue: ISSUE,
    expectedState: 'open',
    observedState: 'open',
    reason: 'closure_forbidden_issue_open',
    closureBlockers: [{ code: 'anti_close_fence', evidence: 'Parent #99 remains open' }],
  };
}

function authorized(evidence = 'policy:trusted'): IssueClosureLifecycleMutationPolicyResult {
  return { status: 'authorized', evidence };
}

function confirmed(
  state: 'open' | 'closed',
  evidence = 'provider:confirmed',
): IssueClosureLifecycleMutationPortResult {
  return {
    status: 'confirmed',
    issue: ISSUE,
    state,
    evidence,
  };
}

describe('IssueClosureLifecycleMutationService', () => {
  it('does not call policy or provider when reconciliation requires no action', async () => {
    let policyCalls = 0;
    let mutationCalls = 0;
    const service = new IssueClosureLifecycleMutationService(
      {
        authorizeIssueLifecycleMutation: async (): Promise<IssueClosureLifecycleMutationPolicyResult> => {
          policyCalls += 1;
          return authorized();
        },
      },
      {
        setIssueState: async (): Promise<IssueClosureLifecycleMutationPortResult> => {
          mutationCalls += 1;
          return confirmed('open');
        },
      },
    );

    await expect(service.execute(decision('none'))).resolves.toEqual({
      status: 'not_mutated',
      disposition: 'no_action',
      issue: ISSUE,
      action: 'none',
      observedState: 'open',
      expectedState: 'open',
    });
    expect(policyCalls).toBe(0);
    expect(mutationCalls).toBe(0);
  });

  it('does not mutate when reconciliation itself requires inspection', async () => {
    let policyCalls = 0;
    let mutationCalls = 0;
    const service = new IssueClosureLifecycleMutationService(
      {
        authorizeIssueLifecycleMutation: async (): Promise<IssueClosureLifecycleMutationPolicyResult> => {
          policyCalls += 1;
          return authorized();
        },
      },
      {
        setIssueState: async (): Promise<IssueClosureLifecycleMutationPortResult> => {
          mutationCalls += 1;
          return confirmed('open');
        },
      },
    );

    await expect(service.execute(decision('inspect_required'))).resolves.toEqual({
      status: 'inspect_required',
      reason: 'reconciliation_inspect_required',
      issue: ISSUE,
      action: 'inspect_required',
      targetState: 'open',
      evidence: [],
    });
    expect(policyCalls).toBe(0);
    expect(mutationCalls).toBe(0);
  });

  it('reopens only after trusted policy authorization and returns bounded mutation evidence', async () => {
    const policyCalls: unknown[] = [];
    const mutationCalls: unknown[] = [];
    const policy: IssueClosureLifecycleMutationPolicyPort = {
      authorizeIssueLifecycleMutation: async (request): Promise<IssueClosureLifecycleMutationPolicyResult> => {
        policyCalls.push(request);
        return authorized('policy:reopen-approved');
      },
    };
    const mutation: IssueClosureLifecycleMutationPort = {
      setIssueState: async (request): Promise<IssueClosureLifecycleMutationPortResult> => {
        mutationCalls.push(request);
        return confirmed('open', 'github:reopened');
      },
    };
    const service = new IssueClosureLifecycleMutationService(policy, mutation);

    await expect(service.execute(decision('reopen_required'))).resolves.toEqual({
      status: 'mutated',
      action: 'reopened',
      issue: ISSUE,
      state: 'open',
      evidence: ['policy:reopen-approved', 'github:reopened'],
    });
    expect(policyCalls).toHaveLength(1);
    expect(mutationCalls).toEqual([{ issue: ISSUE, targetState: 'open' }]);
  });

  it('closes only after trusted policy authorization', async () => {
    const service = new IssueClosureLifecycleMutationService(
      {
        authorizeIssueLifecycleMutation: async ({ targetState }): Promise<IssueClosureLifecycleMutationPolicyResult> => {
          expect(targetState).toBe('closed');
          return authorized('policy:close-approved');
        },
      },
      {
        setIssueState: async ({ targetState }): Promise<IssueClosureLifecycleMutationPortResult> => {
          expect(targetState).toBe('closed');
          return confirmed('closed', 'github:closed');
        },
      },
    );

    await expect(service.execute(decision('close_if_policy_allows'))).resolves.toEqual({
      status: 'mutated',
      action: 'closed',
      issue: ISSUE,
      state: 'closed',
      evidence: ['policy:close-approved', 'github:closed'],
    });
  });

  it('fails closed when trusted policy denies the mutation', async () => {
    let mutationCalls = 0;
    const service = new IssueClosureLifecycleMutationService(
      {
        authorizeIssueLifecycleMutation: async (): Promise<IssueClosureLifecycleMutationPolicyResult> => ({
          status: 'denied',
        }),
      },
      {
        setIssueState: async (): Promise<IssueClosureLifecycleMutationPortResult> => {
          mutationCalls += 1;
          return confirmed('open');
        },
      },
    );

    await expect(service.execute(decision('reopen_required'))).resolves.toEqual({
      status: 'inspect_required',
      reason: 'mutation_not_authorized',
      issue: ISSUE,
      action: 'reopen_required',
      targetState: 'open',
      evidence: [],
    });
    expect(mutationCalls).toBe(0);
  });

  it('fails closed when policy state is ambiguous or policy provider throws', async () => {
    const ambiguous = new IssueClosureLifecycleMutationService(
      {
        authorizeIssueLifecycleMutation: async (): Promise<IssueClosureLifecycleMutationPolicyResult> => ({
          status: 'inspect_required',
        }),
      },
      {
        setIssueState: async (): Promise<IssueClosureLifecycleMutationPortResult> => confirmed('open'),
      },
    );
    await expect(ambiguous.execute(decision('reopen_required'))).resolves.toMatchObject({
      status: 'inspect_required',
      reason: 'policy_state_ambiguous',
      evidence: [],
    });

    const throwing = new IssueClosureLifecycleMutationService(
      {
        authorizeIssueLifecycleMutation: async (): Promise<IssueClosureLifecycleMutationPolicyResult> => {
          throw new Error('credential-bearing policy detail');
        },
      },
      {
        setIssueState: async (): Promise<IssueClosureLifecycleMutationPortResult> => confirmed('open'),
      },
    );
    await expect(throwing.execute(decision('reopen_required'))).resolves.toEqual({
      status: 'inspect_required',
      reason: 'policy_provider_error',
      issue: ISSUE,
      action: 'reopen_required',
      targetState: 'open',
      evidence: [],
      detail: 'issue lifecycle policy authorization failed',
    });
  });

  it('fails closed when mutation confirmation has wrong identity, state, or blank evidence', async () => {
    for (const result of [
      { status: 'confirmed', issue: 'soulzerox/Unified-MPC-Server#80', state: 'open', evidence: 'wrong-issue' },
      { status: 'confirmed', issue: ISSUE, state: 'closed', evidence: 'wrong-state' },
      { status: 'confirmed', issue: ISSUE, state: 'open', evidence: '   ' },
    ] as const) {
      const service = new IssueClosureLifecycleMutationService(
        {
          authorizeIssueLifecycleMutation: async (): Promise<IssueClosureLifecycleMutationPolicyResult> => authorized(),
        },
        {
          setIssueState: async (): Promise<IssueClosureLifecycleMutationPortResult> => result,
        },
      );

      await expect(service.execute(decision('reopen_required'))).resolves.toEqual({
        status: 'inspect_required',
        reason: 'mutation_contract_violation',
        issue: ISSUE,
        action: 'reopen_required',
        targetState: 'open',
        evidence: ['policy:trusted'],
      });
    }
  });

  it('sanitizes lifecycle provider failures after authorization', async () => {
    const service = new IssueClosureLifecycleMutationService(
      {
        authorizeIssueLifecycleMutation: async (): Promise<IssueClosureLifecycleMutationPolicyResult> => authorized(),
      },
      {
        setIssueState: async (): Promise<IssueClosureLifecycleMutationPortResult> => {
          throw new Error('credential-bearing provider detail');
        },
      },
    );

    await expect(service.execute(decision('reopen_required'))).resolves.toEqual({
      status: 'inspect_required',
      reason: 'mutation_provider_error',
      issue: ISSUE,
      action: 'reopen_required',
      targetState: 'open',
      evidence: ['policy:trusted'],
      detail: 'issue lifecycle mutation failed',
    });
  });
});
