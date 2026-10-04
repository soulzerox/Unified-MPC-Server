import {
  type IssueClosureSuccessorOwnerCandidate,
  type IssueClosureSuccessorOwnerDiscoveryFailureReason,
  type IssueClosureSuccessorOwnerDiscoveryResult,
  IssueClosureSuccessorOwnerDiscoveryService,
  type IssueClosureSuccessorOwnerResourceRef,
} from './issue-closure-successor-owner-discovery-service.js';

export interface IssueClosureSuccessorOwnerConditionalCreationRequest {
  readonly repository: string;
  readonly scope: string;
  readonly searchedQueries: readonly string[];
  readonly excludeIssues?: readonly IssueClosureSuccessorOwnerResourceRef[];
  readonly title: string;
  readonly body: string;
}

export interface IssueClosureSuccessorOwnerCreationFence {
  readonly repository: string;
  readonly searchedQueries: readonly string[];
  readonly evidence: readonly string[];
}

export type IssueClosureSuccessorOwnerConditionalCreationResult =
  | {
    readonly status: 'created';
    readonly owner: IssueClosureSuccessorOwnerCandidate;
    readonly fence: IssueClosureSuccessorOwnerCreationFence;
  }
  | {
    readonly status: 'existing_owner';
    readonly owner: IssueClosureSuccessorOwnerCandidate;
    readonly fence: IssueClosureSuccessorOwnerCreationFence;
  }
  | {
    readonly status: 'inspect_required';
    readonly reason: 'creation_race_unresolved';
  };

export interface IssueClosureSuccessorOwnerConditionalCreationPort {
  createIssueOwnerIfStillOwnerless(
    request: IssueClosureSuccessorOwnerConditionalCreationRequest,
  ): Promise<IssueClosureSuccessorOwnerConditionalCreationResult>;
}

export interface ExecuteIssueClosureSuccessorOwnerCreationRequest {
  readonly discovery: IssueClosureSuccessorOwnerDiscoveryResult;
  readonly excludeIssues?: readonly IssueClosureSuccessorOwnerResourceRef[];
  readonly title: string;
  readonly body: string;
}

export type IssueClosureSuccessorOwnerCreationFailureReason =
  | IssueClosureSuccessorOwnerDiscoveryFailureReason
  | 'creation_contract_violation'
  | 'creation_race_unresolved'
  | 'provider_error';

export type IssueClosureSuccessorOwnerCreationResult =
  | {
    readonly status: 'created';
    readonly scope: string;
    readonly repository: string;
    readonly searchedQueries: readonly string[];
    readonly owner: {
      readonly issue: string;
      readonly state: 'open';
      readonly evidence: readonly string[];
    };
  }
  | {
    readonly status: 'not_created';
    readonly disposition: 'reuse_existing';
    readonly scope: string;
    readonly repository: string;
    readonly searchedQueries: readonly string[];
    readonly owner: {
      readonly issue: string;
      readonly state: 'open';
      readonly evidence: readonly string[];
    };
  }
  | {
    readonly status: 'inspect_required';
    readonly reason: IssueClosureSuccessorOwnerCreationFailureReason;
    readonly scope: string;
    readonly repository: string;
    readonly query?: string;
    readonly resource?: string;
    readonly candidates?: readonly string[];
    readonly detail?: string;
  };

export class IssueClosureSuccessorOwnerCreationService {
  public constructor(
    private readonly discovery: IssueClosureSuccessorOwnerDiscoveryService,
    private readonly creation: IssueClosureSuccessorOwnerConditionalCreationPort,
  ) {}

  public async execute(
    request: ExecuteIssueClosureSuccessorOwnerCreationRequest,
  ): Promise<IssueClosureSuccessorOwnerCreationResult> {
    const prior = request.discovery;
    if (prior.status === 'inspect_required') return prior;

    if (prior.disposition === 'reuse_existing') {
      return reuseResult(prior);
    }

    const rechecked = await this.discovery.discover({
      scope: prior.scope,
      repository: prior.repository,
      queries: prior.searchedQueries,
      ...(request.excludeIssues === undefined
        ? {}
        : { excludeIssues: request.excludeIssues }),
    });

    if (rechecked.status === 'inspect_required') return rechecked;
    if (rechecked.disposition === 'reuse_existing') {
      return reuseResult(rechecked);
    }

    let conditional: IssueClosureSuccessorOwnerConditionalCreationResult;
    try {
      conditional = await this.creation.createIssueOwnerIfStillOwnerless({
        repository: rechecked.repository,
        scope: rechecked.scope,
        searchedQueries: rechecked.searchedQueries,
        ...(request.excludeIssues === undefined
          ? {}
          : { excludeIssues: request.excludeIssues }),
        title: request.title,
        body: request.body,
      });
    } catch {
      return {
        status: 'inspect_required',
        reason: 'provider_error',
        scope: rechecked.scope,
        repository: rechecked.repository,
        detail: 'successor owner creation failed',
      };
    }

    if (conditional.status === 'inspect_required') {
      return {
        status: 'inspect_required',
        reason: conditional.reason,
        scope: rechecked.scope,
        repository: rechecked.repository,
      };
    }

    const resource = formatResourceRef(conditional.owner.ref);
    if (!validConditionalResult(
      conditional,
      rechecked.repository,
      rechecked.searchedQueries,
      request.excludeIssues ?? [],
    )) {
      return {
        status: 'inspect_required',
        reason: 'creation_contract_violation',
        scope: rechecked.scope,
        repository: rechecked.repository,
        resource,
      };
    }

    const owner = {
      issue: resource,
      state: 'open' as const,
      evidence: normalizeEvidence(conditional.fence.evidence),
    };

    if (conditional.status === 'existing_owner') {
      return {
        status: 'not_created',
        disposition: 'reuse_existing',
        scope: rechecked.scope,
        repository: rechecked.repository,
        searchedQueries: rechecked.searchedQueries,
        owner,
      };
    }

    return {
      status: 'created',
      scope: rechecked.scope,
      repository: rechecked.repository,
      searchedQueries: rechecked.searchedQueries,
      owner,
    };
  }
}

function reuseResult(
  discovery: Extract<
    IssueClosureSuccessorOwnerDiscoveryResult,
    { readonly status: 'discovered'; readonly disposition: 'reuse_existing' }
  >,
): IssueClosureSuccessorOwnerCreationResult {
  return {
    status: 'not_created',
    disposition: 'reuse_existing',
    scope: discovery.scope,
    repository: discovery.repository,
    searchedQueries: discovery.searchedQueries,
    owner: discovery.owner,
  };
}

function validConditionalResult(
  result: Extract<
    IssueClosureSuccessorOwnerConditionalCreationResult,
    { readonly status: 'created' | 'existing_owner' }
  >,
  repository: string,
  searchedQueries: readonly string[],
  excludedIssues: readonly IssueClosureSuccessorOwnerResourceRef[],
): boolean {
  const resource = formatResourceRef(result.owner.ref);
  const excluded = new Set(excludedIssues.map((ref) => formatResourceRef(ref)));
  return result.owner.state === 'open'
    && result.owner.ref.repository.trim() === repository
    && Number.isInteger(result.owner.ref.number)
    && result.owner.ref.number > 0
    && !excluded.has(resource)
    && result.fence.repository.trim() === repository
    && sameQueries(result.fence.searchedQueries, searchedQueries)
    && normalizeEvidence(result.fence.evidence).length > 0;
}

function sameQueries(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && actual.every((query, index) => query.trim() === expected[index]);
}

function normalizeEvidence(evidence: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const item of evidence) {
    const value = item.trim();
    if (value.length === 0 || normalized.includes(value)) continue;
    normalized.push(value);
  }
  return normalized;
}

function formatResourceRef(ref: IssueClosureSuccessorOwnerResourceRef): string {
  return `${ref.repository.trim()}#${ref.number}`;
}
