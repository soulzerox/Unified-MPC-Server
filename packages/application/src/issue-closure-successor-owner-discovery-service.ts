export interface IssueClosureSuccessorOwnerResourceRef {
  readonly repository: string;
  readonly number: number;
}

export interface IssueClosureSuccessorOwnerCandidate {
  readonly ref: IssueClosureSuccessorOwnerResourceRef;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly searchEvidence: string;
}

export interface IssueClosureSuccessorOwnerSearchRequest {
  readonly repository: string;
  readonly scope: string;
  readonly query: string;
}

export interface IssueClosureSuccessorOwnerSearchPort {
  searchOpenIssueOwners(
    request: IssueClosureSuccessorOwnerSearchRequest,
  ): Promise<readonly IssueClosureSuccessorOwnerCandidate[]>;
}

export interface DiscoverIssueClosureSuccessorOwnerRequest {
  readonly scope: string;
  readonly repository: string;
  readonly queries: readonly string[];
  readonly excludeIssues?: readonly IssueClosureSuccessorOwnerResourceRef[];
}

export type IssueClosureSuccessorOwnerDiscoveryFailureReason =
  | 'search_queries_missing'
  | 'provider_error'
  | 'search_contract_violation'
  | 'ambiguous_existing_owners';

export type IssueClosureSuccessorOwnerDiscoveryResult =
  | {
    readonly status: 'discovered';
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
    readonly status: 'discovered';
    readonly disposition: 'ownerless';
    readonly scope: string;
    readonly repository: string;
    readonly searchedQueries: readonly string[];
  }
  | {
    readonly status: 'inspect_required';
    readonly reason: IssueClosureSuccessorOwnerDiscoveryFailureReason;
    readonly scope: string;
    readonly repository: string;
    readonly query?: string;
    readonly resource?: string;
    readonly candidates?: readonly string[];
    readonly detail?: string;
  };

interface OwnerEvidence {
  readonly candidate: IssueClosureSuccessorOwnerCandidate;
  readonly evidence: string[];
}

export class IssueClosureSuccessorOwnerDiscoveryService {
  public constructor(private readonly search: IssueClosureSuccessorOwnerSearchPort) {}

  public async discover(
    request: DiscoverIssueClosureSuccessorOwnerRequest,
  ): Promise<IssueClosureSuccessorOwnerDiscoveryResult> {
    const repository = request.repository.trim();
    const scope = request.scope.trim();
    const queries = normalizeQueries(request.queries);
    if (queries.length === 0) {
      return {
        status: 'inspect_required',
        reason: 'search_queries_missing',
        scope,
        repository,
      };
    }

    const excluded = new Set(
      (request.excludeIssues ?? []).map((ref) => formatResourceRef(ref)),
    );
    const owners = new Map<string, OwnerEvidence>();

    for (const query of queries) {
      let candidates: readonly IssueClosureSuccessorOwnerCandidate[];
      try {
        candidates = await this.search.searchOpenIssueOwners({
          repository,
          scope,
          query,
        });
      } catch {
        return {
          status: 'inspect_required',
          reason: 'provider_error',
          scope,
          repository,
          query,
          detail: 'successor owner search failed',
        };
      }

      for (const candidate of candidates) {
        const resource = formatResourceRef(candidate.ref);
        if (!validCandidate(candidate, repository)) {
          return {
            status: 'inspect_required',
            reason: 'search_contract_violation',
            scope,
            repository,
            resource,
          };
        }
        if (excluded.has(resource)) continue;

        const evidence = candidate.searchEvidence.trim();
        const prior = owners.get(resource);
        if (prior === undefined) {
          owners.set(resource, {
            candidate,
            evidence: evidence.length === 0 ? [] : [evidence],
          });
          continue;
        }
        if (evidence.length > 0 && !prior.evidence.includes(evidence)) {
          prior.evidence.push(evidence);
        }
      }
    }

    const ownerEntries = [...owners.entries()];
    if (ownerEntries.length === 0) {
      return {
        status: 'discovered',
        disposition: 'ownerless',
        scope,
        repository,
        searchedQueries: queries,
      };
    }

    if (ownerEntries.length > 1) {
      return {
        status: 'inspect_required',
        reason: 'ambiguous_existing_owners',
        scope,
        repository,
        candidates: ownerEntries.map(([resource]) => resource),
      };
    }

    const [issue, owner] = ownerEntries[0]!;
    return {
      status: 'discovered',
      disposition: 'reuse_existing',
      scope,
      repository,
      searchedQueries: queries,
      owner: {
        issue,
        state: 'open',
        evidence: owner.evidence,
      },
    };
  }
}

function normalizeQueries(queries: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const query of queries) {
    const value = query.trim();
    if (value.length === 0 || normalized.includes(value)) continue;
    normalized.push(value);
  }
  return normalized;
}

function validCandidate(
  candidate: IssueClosureSuccessorOwnerCandidate,
  repository: string,
): boolean {
  return candidate.state === 'open'
    && candidate.ref.repository.trim() === repository
    && Number.isInteger(candidate.ref.number)
    && candidate.ref.number > 0;
}

function formatResourceRef(ref: IssueClosureSuccessorOwnerResourceRef): string {
  return `${ref.repository.trim()}#${ref.number}`;
}
