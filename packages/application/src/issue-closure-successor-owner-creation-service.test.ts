import { describe, expect, it } from 'vitest';
import {
  IssueClosureSuccessorOwnerCreationService,
  type ExecuteIssueClosureSuccessorOwnerCreationRequest,
  type IssueClosureSuccessorOwnerConditionalCreationPort,
  type IssueClosureSuccessorOwnerConditionalCreationRequest,
  type IssueClosureSuccessorOwnerConditionalCreationResult,
} from './issue-closure-successor-owner-creation-service.js';
import {
  IssueClosureSuccessorOwnerDiscoveryService,
  type IssueClosureSuccessorOwnerCandidate,
  type IssueClosureSuccessorOwnerDiscoveryResult,
  type IssueClosureSuccessorOwnerSearchPort,
} from './issue-closure-successor-owner-discovery-service.js';

const repository = 'soulzerox/Webtrans';
const scope = 'strict translation claim parity';
const searchedQueries = ['translation claim', 'strict claim parity'] as const;

function candidate(
  number: number,
  searchEvidence: string,
  repo = repository,
): IssueClosureSuccessorOwnerCandidate {
  return {
    ref: { repository: repo, number },
    title: `Owner #${number}`,
    state: 'open',
    searchEvidence,
  };
}

function ownerless(): IssueClosureSuccessorOwnerDiscoveryResult {
  return {
    status: 'discovered',
    disposition: 'ownerless',
    scope,
    repository,
    searchedQueries,
  };
}

function reuseExisting(): IssueClosureSuccessorOwnerDiscoveryResult {
  return {
    status: 'discovered',
    disposition: 'reuse_existing',
    scope,
    repository,
    searchedQueries,
    owner: {
      issue: 'soulzerox/Webtrans#86',
      state: 'open',
      evidence: ['search:existing'],
    },
  };
}

function discovery(
  searchOpenIssueOwners: IssueClosureSuccessorOwnerSearchPort['searchOpenIssueOwners'],
): IssueClosureSuccessorOwnerDiscoveryService {
  return new IssueClosureSuccessorOwnerDiscoveryService({ searchOpenIssueOwners });
}

function request(
  priorDiscovery: IssueClosureSuccessorOwnerDiscoveryResult,
): ExecuteIssueClosureSuccessorOwnerCreationRequest {
  return {
    discovery: priorDiscovery,
    excludeIssues: [{ repository, number: 99 }],
    title: 'Track strict translation claim parity',
    body: 'Follow-up scope transferred from parent closure audit.',
  };
}

describe('IssueClosureSuccessorOwnerCreationService', () => {
  it('reuses a previously discovered owner without re-searching or creating', async () => {
    let searches = 0;
    let creates = 0;
    const service = new IssueClosureSuccessorOwnerCreationService(
      discovery(async (): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        searches += 1;
        return [];
      }),
      {
        createIssueOwnerIfStillOwnerless: async (): Promise<IssueClosureSuccessorOwnerConditionalCreationResult> => {
          creates += 1;
          throw new Error('must not create');
        },
      },
    );

    await expect(service.execute(request(reuseExisting()))).resolves.toEqual({
      status: 'not_created',
      disposition: 'reuse_existing',
      scope,
      repository,
      searchedQueries,
      owner: {
        issue: 'soulzerox/Webtrans#86',
        state: 'open',
        evidence: ['search:existing'],
      },
    });
    expect(searches).toBe(0);
    expect(creates).toBe(0);
  });

  it('fails closed on an inspect-required discovery without attempting mutation', async () => {
    let searches = 0;
    let creates = 0;
    const service = new IssueClosureSuccessorOwnerCreationService(
      discovery(async (): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        searches += 1;
        return [];
      }),
      {
        createIssueOwnerIfStillOwnerless: async (): Promise<IssueClosureSuccessorOwnerConditionalCreationResult> => {
          creates += 1;
          throw new Error('must not create');
        },
      },
    );
    const prior: IssueClosureSuccessorOwnerDiscoveryResult = {
      status: 'inspect_required',
      reason: 'ambiguous_existing_owners',
      scope,
      repository,
      candidates: ['soulzerox/Webtrans#56', 'soulzerox/Webtrans#62'],
    };

    await expect(service.execute(request(prior))).resolves.toEqual({
      status: 'inspect_required',
      reason: 'ambiguous_existing_owners',
      scope,
      repository,
      candidates: ['soulzerox/Webtrans#56', 'soulzerox/Webtrans#62'],
    });
    expect(searches).toBe(0);
    expect(creates).toBe(0);
  });

  it('re-runs every original query and reuses an owner that appears before mutation', async () => {
    const calls: string[] = [];
    let creates = 0;
    const service = new IssueClosureSuccessorOwnerCreationService(
      discovery(async ({ query }): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        calls.push(query);
        return query === 'strict claim parity'
          ? [candidate(86, 'recheck:strict-claim')]
          : [];
      }),
      {
        createIssueOwnerIfStillOwnerless: async (): Promise<IssueClosureSuccessorOwnerConditionalCreationResult> => {
          creates += 1;
          throw new Error('must not create');
        },
      },
    );

    await expect(service.execute(request(ownerless()))).resolves.toEqual({
      status: 'not_created',
      disposition: 'reuse_existing',
      scope,
      repository,
      searchedQueries,
      owner: {
        issue: 'soulzerox/Webtrans#86',
        state: 'open',
        evidence: ['recheck:strict-claim'],
      },
    });
    expect(calls).toEqual(searchedQueries);
    expect(creates).toBe(0);
  });

  it('creates only after a complete recheck and a matching conditional-creation fence', async () => {
    const calls: string[] = [];
    let creationRequest: IssueClosureSuccessorOwnerConditionalCreationRequest | undefined;
    const creator: IssueClosureSuccessorOwnerConditionalCreationPort = {
      createIssueOwnerIfStillOwnerless: async (input) => {
        creationRequest = input;
        return {
          status: 'created',
          owner: candidate(117, 'create:117'),
          fence: {
            repository,
            searchedQueries,
            evidence: ['conditional-search:ownerless', 'create:117'],
          },
        };
      },
    };
    const service = new IssueClosureSuccessorOwnerCreationService(
      discovery(async ({ query }): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => {
        calls.push(query);
        return [];
      }),
      creator,
    );

    await expect(service.execute(request(ownerless()))).resolves.toEqual({
      status: 'created',
      scope,
      repository,
      searchedQueries,
      owner: {
        issue: 'soulzerox/Webtrans#117',
        state: 'open',
        evidence: ['conditional-search:ownerless', 'create:117'],
      },
    });
    expect(calls).toEqual(searchedQueries);
    expect(creationRequest).toEqual({
      repository,
      scope,
      searchedQueries,
      excludeIssues: [{ repository, number: 99 }],
      title: 'Track strict translation claim parity',
      body: 'Follow-up scope transferred from parent closure audit.',
    });
  });

  it('treats a conditional-create race winner as reuse instead of creating a duplicate owner', async () => {
    const service = new IssueClosureSuccessorOwnerCreationService(
      discovery(async (): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => []),
      {
        createIssueOwnerIfStillOwnerless: async (): Promise<IssueClosureSuccessorOwnerConditionalCreationResult> => ({
          status: 'existing_owner',
          owner: candidate(86, 'race:owner-won'),
          fence: {
            repository,
            searchedQueries,
            evidence: ['race:owner-won'],
          },
        }),
      },
    );

    await expect(service.execute(request(ownerless()))).resolves.toEqual({
      status: 'not_created',
      disposition: 'reuse_existing',
      scope,
      repository,
      searchedQueries,
      owner: {
        issue: 'soulzerox/Webtrans#86',
        state: 'open',
        evidence: ['race:owner-won'],
      },
    });
  });

  it('fails closed when conditional creation evidence does not match the searched ownerless scope', async () => {
    const service = new IssueClosureSuccessorOwnerCreationService(
      discovery(async (): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => []),
      {
        createIssueOwnerIfStillOwnerless: async (): Promise<IssueClosureSuccessorOwnerConditionalCreationResult> => ({
          status: 'created',
          owner: candidate(117, 'create:117'),
          fence: {
            repository,
            searchedQueries: ['different query'],
            evidence: ['create:117'],
          },
        }),
      },
    );

    await expect(service.execute(request(ownerless()))).resolves.toEqual({
      status: 'inspect_required',
      reason: 'creation_contract_violation',
      scope,
      repository,
      resource: 'soulzerox/Webtrans#117',
    });
  });

  it('sanitizes conditional creation provider failures instead of leaking provider detail', async () => {
    const service = new IssueClosureSuccessorOwnerCreationService(
      discovery(async (): Promise<readonly IssueClosureSuccessorOwnerCandidate[]> => []),
      {
        createIssueOwnerIfStillOwnerless: async (): Promise<IssueClosureSuccessorOwnerConditionalCreationResult> => {
          throw new Error('credential-bearing provider detail');
        },
      },
    );

    await expect(service.execute(request(ownerless()))).resolves.toEqual({
      status: 'inspect_required',
      reason: 'provider_error',
      scope,
      repository,
      detail: 'successor owner creation failed',
    });
  });
});
