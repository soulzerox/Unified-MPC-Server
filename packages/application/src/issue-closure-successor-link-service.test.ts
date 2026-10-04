import { describe, expect, it } from 'vitest';
import {
  IssueClosureSuccessorLinkService,
  type IssueClosureSuccessorLinkPort,
  type IssueClosureSuccessorLinkPortResult,
  type IssueClosureSuccessorLinkRequest,
} from './issue-closure-successor-link-service.js';

const parent = { repository: 'soulzerox/Unified-MPC-Server', number: 99 } as const;
const successor = { repository: 'soulzerox/Webtrans', number: 86 } as const;

function request(): IssueClosureSuccessorLinkRequest {
  return {
    parent,
    successor,
    scope: 'strict translation claim parity',
  };
}

function confirmed(
  source = parent,
  target = successor,
  evidence = 'issuecomment:parent->successor',
): IssueClosureSuccessorLinkPortResult {
  return {
    status: 'confirmed',
    source,
    target,
    evidence,
  };
}

describe('IssueClosureSuccessorLinkService', () => {
  it('confirms both durable directions and returns linkEvidence suitable for closure evidence', async () => {
    const calls: Array<{ source: typeof parent | typeof successor; target: typeof parent | typeof successor }> = [];
    const port: IssueClosureSuccessorLinkPort = {
      ensureDurableIssueLink: async ({ source, target }): Promise<IssueClosureSuccessorLinkPortResult> => {
        calls.push({ source, target });
        return source.repository === parent.repository
          ? confirmed(source, target, 'issuecomment:parent->successor')
          : confirmed(source, target, 'issuecomment:successor->parent');
      },
    };
    const service = new IssueClosureSuccessorLinkService(port);

    await expect(service.ensureTwoWayLink(request())).resolves.toEqual({
      status: 'linked',
      parent: 'soulzerox/Unified-MPC-Server#99',
      successor: 'soulzerox/Webtrans#86',
      scope: 'strict translation claim parity',
      linkEvidence: [
        'issuecomment:parent->successor',
        'issuecomment:successor->parent',
      ],
    });
    expect(calls).toEqual([
      { source: parent, target: successor },
      { source: successor, target: parent },
    ]);
  });

  it('accepts an already-existing durable link as confirmed evidence', async () => {
    const service = new IssueClosureSuccessorLinkService({
      ensureDurableIssueLink: async ({ source, target }): Promise<IssueClosureSuccessorLinkPortResult> => ({
        status: 'confirmed',
        source,
        target,
        evidence: source.repository === parent.repository
          ? 'existing:parent->successor'
          : 'existing:successor->parent',
      }),
    });

    await expect(service.ensureTwoWayLink(request())).resolves.toMatchObject({
      status: 'linked',
      linkEvidence: ['existing:parent->successor', 'existing:successor->parent'],
    });
  });

  it('fails closed with partial evidence when only one direction is confirmed', async () => {
    let calls = 0;
    const service = new IssueClosureSuccessorLinkService({
      ensureDurableIssueLink: async ({ source, target }): Promise<IssueClosureSuccessorLinkPortResult> => {
        calls += 1;
        if (calls === 1) return confirmed(source, target, 'issuecomment:parent->successor');
        return {
          status: 'ambiguous',
          source,
          target,
        };
      },
    });

    await expect(service.ensureTwoWayLink(request())).resolves.toEqual({
      status: 'inspect_required',
      reason: 'link_state_ambiguous',
      parent: 'soulzerox/Unified-MPC-Server#99',
      successor: 'soulzerox/Webtrans#86',
      scope: 'strict translation claim parity',
      confirmedEvidence: ['issuecomment:parent->successor'],
      missingDirections: ['successor_to_parent'],
    });
  });

  it('fails closed when provider confirmation is for the wrong source or target', async () => {
    const service = new IssueClosureSuccessorLinkService({
      ensureDurableIssueLink: async ({ source, target }): Promise<IssueClosureSuccessorLinkPortResult> => ({
        status: 'confirmed',
        source,
        target: { repository: target.repository, number: target.number + 1 },
        evidence: 'wrong-target',
      }),
    });

    await expect(service.ensureTwoWayLink(request())).resolves.toEqual({
      status: 'inspect_required',
      reason: 'link_contract_violation',
      parent: 'soulzerox/Unified-MPC-Server#99',
      successor: 'soulzerox/Webtrans#86',
      scope: 'strict translation claim parity',
      confirmedEvidence: [],
      missingDirections: ['parent_to_successor', 'successor_to_parent'],
    });
  });

  it('fails closed on blank durable evidence', async () => {
    const service = new IssueClosureSuccessorLinkService({
      ensureDurableIssueLink: async ({ source, target }): Promise<IssueClosureSuccessorLinkPortResult> => ({
        status: 'confirmed',
        source,
        target,
        evidence: '   ',
      }),
    });

    await expect(service.ensureTwoWayLink(request())).resolves.toMatchObject({
      status: 'inspect_required',
      reason: 'link_contract_violation',
      confirmedEvidence: [],
    });
  });

  it('sanitizes provider failures without attempting the reverse direction', async () => {
    let calls = 0;
    const service = new IssueClosureSuccessorLinkService({
      ensureDurableIssueLink: async (): Promise<IssueClosureSuccessorLinkPortResult> => {
        calls += 1;
        throw new Error('credential-bearing provider detail');
      },
    });

    await expect(service.ensureTwoWayLink(request())).resolves.toEqual({
      status: 'inspect_required',
      reason: 'provider_error',
      parent: 'soulzerox/Unified-MPC-Server#99',
      successor: 'soulzerox/Webtrans#86',
      scope: 'strict translation claim parity',
      confirmedEvidence: [],
      missingDirections: ['parent_to_successor', 'successor_to_parent'],
      detail: 'successor link provider failed',
    });
    expect(calls).toBe(1);
  });

  it('rejects a self-link before provider mutation', async () => {
    let calls = 0;
    const service = new IssueClosureSuccessorLinkService({
      ensureDurableIssueLink: async (): Promise<IssueClosureSuccessorLinkPortResult> => {
        calls += 1;
        throw new Error('must not mutate');
      },
    });

    await expect(service.ensureTwoWayLink({
      parent,
      successor: parent,
      scope: 'same owner',
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'invalid_link_request',
      parent: 'soulzerox/Unified-MPC-Server#99',
      successor: 'soulzerox/Unified-MPC-Server#99',
      scope: 'same owner',
      confirmedEvidence: [],
      missingDirections: ['parent_to_successor', 'successor_to_parent'],
    });
    expect(calls).toBe(0);
  });
});
