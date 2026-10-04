import { describe, expect, it } from 'vitest';
import {
  IssueClosureSuccessorOwnerDiscoveryService,
  type IssueClosureSuccessorOwnerCandidate,
  type IssueClosureSuccessorOwnerSearchPort,
} from './issue-closure-successor-owner-discovery-service.js';

const repository = 'soulzerox/Webtrans';

function candidate(
  number: number,
  searchEvidence: string,
  state: 'open' | 'closed' = 'open',
): IssueClosureSuccessorOwnerCandidate {
  return {
    ref: { repository, number },
    title: `Owner #${number}`,
    state,
    searchEvidence,
  };
}

describe('IssueClosureSuccessorOwnerDiscoveryService', () => {
  it('searches every query and reuses one open owner even when multiple queries return it', async () => {
    const calls: string[] = [];
    const port: IssueClosureSuccessorOwnerSearchPort = {
      searchOpenIssueOwners: async ({ query }): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        calls.push(query);
        return query === 'translation claim'
          ? [candidate(86, 'search:translation-claim')]
          : [candidate(86, 'search:strict-claim')];
      },
    };
    const service = new IssueClosureSuccessorOwnerDiscoveryService(port);

    const result = await service.discover({
      scope: 'strict translation claim parity',
      repository,
      queries: ['translation claim', 'strict claim parity'],
      excludeIssues: [{ repository, number: 99 }],
    });

    expect(calls).toEqual(['translation claim', 'strict claim parity']);
    expect(result).toEqual({
      status: 'discovered',
      disposition: 'reuse_existing',
      scope: 'strict translation claim parity',
      repository,
      searchedQueries: ['translation claim', 'strict claim parity'],
      owner: {
        issue: 'soulzerox/Webtrans#86',
        state: 'open',
        evidence: ['search:translation-claim', 'search:strict-claim'],
      },
    });
  });

  it('returns ownerless only after every configured search query completed with no owner', async () => {
    const calls: string[] = [];
    const service = new IssueClosureSuccessorOwnerDiscoveryService({
      searchOpenIssueOwners: async ({ query }): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        calls.push(query);
        return [];
      },
    });

    const result = await service.discover({
      scope: 'new ownerless scope',
      repository,
      queries: ['ownerless scope', 'new follow-up'],
    });

    expect(calls).toEqual(['ownerless scope', 'new follow-up']);
    expect(result).toEqual({
      status: 'discovered',
      disposition: 'ownerless',
      scope: 'new ownerless scope',
      repository,
      searchedQueries: ['ownerless scope', 'new follow-up'],
    });
  });

  it('ignores explicitly excluded issues such as the parent while still completing every search', async () => {
    const calls: string[] = [];
    const service = new IssueClosureSuccessorOwnerDiscoveryService({
      searchOpenIssueOwners: async ({ query }): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        calls.push(query);
        return [candidate(99, `search:${query}`)];
      },
    });

    const result = await service.discover({
      scope: 'remaining parent scope',
      repository,
      queries: ['remaining parent', 'follow-up owner'],
      excludeIssues: [{ repository, number: 99 }],
    });

    expect(calls).toEqual(['remaining parent', 'follow-up owner']);
    expect(result).toMatchObject({
      status: 'discovered',
      disposition: 'ownerless',
      searchedQueries: ['remaining parent', 'follow-up owner'],
    });
  });

  it('fails closed when distinct existing owners make reuse ambiguous', async () => {
    const service = new IssueClosureSuccessorOwnerDiscoveryService({
      searchOpenIssueOwners: async ({ query }): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => query === 'first'
        ? [candidate(56, 'search:first')]
        : [candidate(62, 'search:second')],
    });

    const result = await service.discover({
      scope: 'ambiguous downstream owner',
      repository,
      queries: ['first', 'second'],
    });

    expect(result).toEqual({
      status: 'inspect_required',
      reason: 'ambiguous_existing_owners',
      scope: 'ambiguous downstream owner',
      repository,
      candidates: ['soulzerox/Webtrans#56', 'soulzerox/Webtrans#62'],
    });
  });

  it('fails closed when the search provider violates the open-owner repository contract', async () => {
    const service = new IssueClosureSuccessorOwnerDiscoveryService({
      searchOpenIssueOwners: async (): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => [{
        ...candidate(86, 'search:bad', 'closed'),
        ref: { repository: 'soulzerox/Unified-MPC-Server', number: 86 },
      }],
    });

    const result = await service.discover({
      scope: 'strict translation claim parity',
      repository,
      queries: ['strict claim parity'],
    });

    expect(result).toEqual({
      status: 'inspect_required',
      reason: 'search_contract_violation',
      scope: 'strict translation claim parity',
      repository,
      resource: 'soulzerox/Unified-MPC-Server#86',
    });
  });

  it('fails closed on missing queries or provider failure instead of authorizing creation', async () => {
    const service = new IssueClosureSuccessorOwnerDiscoveryService({
      searchOpenIssueOwners: async (): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        throw new Error('credential-bearing provider detail');
      },
    });

    await expect(service.discover({
      scope: 'no search plan',
      repository,
      queries: [],
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'search_queries_missing',
      scope: 'no search plan',
      repository,
    });

    await expect(service.discover({
      scope: 'provider failure',
      repository,
      queries: ['owner search'],
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'provider_error',
      scope: 'provider failure',
      repository,
      query: 'owner search',
      detail: 'successor owner search failed',
    });
  });
});
