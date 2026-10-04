export interface IssueClosureSuccessorLinkRef {
  readonly repository: string;
  readonly number: number;
}

export type IssueClosureSuccessorLinkDirection =
  | 'parent_to_successor'
  | 'successor_to_parent';

export interface EnsureIssueClosureSuccessorLinkRequest {
  readonly source: IssueClosureSuccessorLinkRef;
  readonly target: IssueClosureSuccessorLinkRef;
  readonly scope: string;
}

export type IssueClosureSuccessorLinkPortResult =
  | {
    readonly status: 'confirmed';
    readonly source: IssueClosureSuccessorLinkRef;
    readonly target: IssueClosureSuccessorLinkRef;
    readonly evidence: string;
  }
  | {
    readonly status: 'ambiguous';
    readonly source: IssueClosureSuccessorLinkRef;
    readonly target: IssueClosureSuccessorLinkRef;
  };

export interface IssueClosureSuccessorLinkPort {
  ensureDurableIssueLink(
    request: EnsureIssueClosureSuccessorLinkRequest,
  ): Promise<IssueClosureSuccessorLinkPortResult>;
}

export interface IssueClosureSuccessorLinkRequest {
  readonly parent: IssueClosureSuccessorLinkRef;
  readonly successor: IssueClosureSuccessorLinkRef;
  readonly scope: string;
}

export type IssueClosureSuccessorLinkFailureReason =
  | 'invalid_link_request'
  | 'link_state_ambiguous'
  | 'link_contract_violation'
  | 'provider_error';

export type IssueClosureSuccessorLinkResult =
  | {
    readonly status: 'linked';
    readonly parent: string;
    readonly successor: string;
    readonly scope: string;
    readonly linkEvidence: readonly string[];
  }
  | {
    readonly status: 'inspect_required';
    readonly reason: IssueClosureSuccessorLinkFailureReason;
    readonly parent: string;
    readonly successor: string;
    readonly scope: string;
    readonly confirmedEvidence: readonly string[];
    readonly missingDirections: readonly IssueClosureSuccessorLinkDirection[];
    readonly detail?: string;
  };

export class IssueClosureSuccessorLinkService {
  public constructor(private readonly port: IssueClosureSuccessorLinkPort) {}

  public async ensureTwoWayLink(
    request: IssueClosureSuccessorLinkRequest,
  ): Promise<IssueClosureSuccessorLinkResult> {
    const parent = normalizeRef(request.parent);
    const successor = normalizeRef(request.successor);
    const scope = request.scope.trim();
    const parentRef = formatRef(parent);
    const successorRef = formatRef(successor);

    if (
      !validRef(parent)
      || !validRef(successor)
      || parentRef === successorRef
      || scope.length === 0
    ) {
      return inspectRequired(
        'invalid_link_request',
        parentRef,
        successorRef,
        scope,
        [],
        ['parent_to_successor', 'successor_to_parent'],
      );
    }

    const forward = await this.ensureDirection(
      { source: parent, target: successor, scope },
      parentRef,
      successorRef,
      scope,
      [],
      ['parent_to_successor', 'successor_to_parent'],
    );
    if (forward.status === 'inspect_required') return forward;

    const confirmedEvidence = [forward.evidence];
    const reverse = await this.ensureDirection(
      { source: successor, target: parent, scope },
      parentRef,
      successorRef,
      scope,
      confirmedEvidence,
      ['successor_to_parent'],
    );
    if (reverse.status === 'inspect_required') return reverse;

    return {
      status: 'linked',
      parent: parentRef,
      successor: successorRef,
      scope,
      linkEvidence: [forward.evidence, reverse.evidence],
    };
  }

  private async ensureDirection(
    request: EnsureIssueClosureSuccessorLinkRequest,
    parent: string,
    successor: string,
    scope: string,
    confirmedEvidence: readonly string[],
    missingDirections: readonly IssueClosureSuccessorLinkDirection[],
  ): Promise<
    | { readonly status: 'confirmed'; readonly evidence: string }
    | Extract<IssueClosureSuccessorLinkResult, { readonly status: 'inspect_required' }>
  > {
    let result: IssueClosureSuccessorLinkPortResult;
    try {
      result = await this.port.ensureDurableIssueLink(request);
    } catch {
      return inspectRequired(
        'provider_error',
        parent,
        successor,
        scope,
        confirmedEvidence,
        missingDirections,
        'successor link provider failed',
      );
    }

    if (result.status === 'ambiguous') {
      if (!sameRef(result.source, request.source) || !sameRef(result.target, request.target)) {
        return inspectRequired(
          'link_contract_violation',
          parent,
          successor,
          scope,
          confirmedEvidence,
          missingDirections,
        );
      }
      return inspectRequired(
        'link_state_ambiguous',
        parent,
        successor,
        scope,
        confirmedEvidence,
        missingDirections,
      );
    }

    const evidence = result.evidence.trim();
    if (
      !sameRef(result.source, request.source)
      || !sameRef(result.target, request.target)
      || evidence.length === 0
    ) {
      return inspectRequired(
        'link_contract_violation',
        parent,
        successor,
        scope,
        confirmedEvidence,
        missingDirections,
      );
    }

    return {
      status: 'confirmed',
      evidence,
    };
  }
}

function inspectRequired(
  reason: IssueClosureSuccessorLinkFailureReason,
  parent: string,
  successor: string,
  scope: string,
  confirmedEvidence: readonly string[],
  missingDirections: readonly IssueClosureSuccessorLinkDirection[],
  detail?: string,
): Extract<IssueClosureSuccessorLinkResult, { readonly status: 'inspect_required' }> {
  return {
    status: 'inspect_required',
    reason,
    parent,
    successor,
    scope,
    confirmedEvidence,
    missingDirections,
    ...(detail === undefined ? {} : { detail }),
  };
}

function normalizeRef(ref: IssueClosureSuccessorLinkRef): IssueClosureSuccessorLinkRef {
  return {
    repository: ref.repository.trim(),
    number: ref.number,
  };
}

function validRef(ref: IssueClosureSuccessorLinkRef): boolean {
  return ref.repository.length > 0
    && Number.isInteger(ref.number)
    && ref.number > 0;
}

function sameRef(
  actual: IssueClosureSuccessorLinkRef,
  expected: IssueClosureSuccessorLinkRef,
): boolean {
  return formatRef(normalizeRef(actual)) === formatRef(normalizeRef(expected));
}

function formatRef(ref: IssueClosureSuccessorLinkRef): string {
  return `${ref.repository}#${ref.number}`;
}
