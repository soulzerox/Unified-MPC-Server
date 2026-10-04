import type { IssueClosureStateObservation } from '@unified-mpc/domain';

const DEFAULT_MAX_COMMENTS_PER_RESOURCE = 100;

export interface IssueClosureGitHubResourceRef {
  readonly repository: string;
  readonly number: number;
}

export interface IssueClosureGitHubComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface IssueClosureGitHubIssue {
  readonly ref: IssueClosureGitHubResourceRef;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
}

export interface IssueClosureGitHubPullRequest {
  readonly ref: IssueClosureGitHubResourceRef;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly mergedAt?: string;
}

export interface IssueClosureGitHubCollectionPort {
  readIssue(ref: IssueClosureGitHubResourceRef): Promise<IssueClosureGitHubIssue | null>;
  listIssueComments(ref: IssueClosureGitHubResourceRef): Promise<readonly IssueClosureGitHubComment[]>;
  readPullRequest(ref: IssueClosureGitHubResourceRef): Promise<IssueClosureGitHubPullRequest | null>;
  listPullRequestComments(ref: IssueClosureGitHubResourceRef): Promise<readonly IssueClosureGitHubComment[]>;
}

export interface CollectIssueClosureGitHubStateRequest {
  readonly issue: IssueClosureGitHubResourceRef;
  readonly implementationPRs: readonly IssueClosureGitHubResourceRef[];
  readonly cutoffAt: string;
  readonly maxCommentsPerResource?: number;
}

export interface CollectedIssueClosureGitHubComment extends IssueClosureGitHubComment {
  readonly ref: string;
}

export interface CollectedIssueClosureGitHubIssue extends IssueClosureGitHubIssue {
  readonly comments: readonly CollectedIssueClosureGitHubComment[];
}

export interface CollectedIssueClosureGitHubPullRequest extends IssueClosureGitHubPullRequest {
  readonly comments: readonly CollectedIssueClosureGitHubComment[];
}

export interface IssueClosureGitHubCollectionSnapshot {
  readonly cutoffAt: string;
  readonly observation: IssueClosureStateObservation;
  readonly issue: CollectedIssueClosureGitHubIssue;
  readonly implementationPRs: readonly CollectedIssueClosureGitHubPullRequest[];
}

export type IssueClosureGitHubCollectionFailureReason =
  | 'invalid_cutoff'
  | 'issue_not_found'
  | 'implementation_pr_not_found'
  | 'provider_error'
  | 'resource_identity_mismatch'
  | 'comment_limit_exceeded'
  | 'comment_timestamp_invalid';

export type IssueClosureGitHubCollectionResult =
  | {
    readonly status: 'collected';
    readonly snapshot: IssueClosureGitHubCollectionSnapshot;
  }
  | {
    readonly status: 'inspect_required';
    readonly reason: IssueClosureGitHubCollectionFailureReason;
    readonly resource: string;
    readonly detail?: string;
  };

export class IssueClosureGitHubCollectionService {
  public constructor(private readonly github: IssueClosureGitHubCollectionPort) {}

  public async collect(
    request: CollectIssueClosureGitHubStateRequest,
  ): Promise<IssueClosureGitHubCollectionResult> {
    const issueResource = formatResourceRef(request.issue);
    const cutoffMs = Date.parse(request.cutoffAt);
    if (!Number.isFinite(cutoffMs)) {
      return {
        status: 'inspect_required',
        reason: 'invalid_cutoff',
        resource: issueResource,
      };
    }
    const maxComments = normalizeCommentLimit(request.maxCommentsPerResource);

    const issue = await this.readIssue(request.issue);
    if (issue.status === 'inspect_required') return issue;
    if (issue.value === null) {
      return {
        status: 'inspect_required',
        reason: 'issue_not_found',
        resource: issueResource,
      };
    }
    if (!sameResourceRef(request.issue, issue.value.ref)) {
      return {
        status: 'inspect_required',
        reason: 'resource_identity_mismatch',
        resource: issueResource,
        detail: `provider returned ${formatResourceRef(issue.value.ref)}`,
      };
    }

    const issueComments = await this.readComments(
      request.issue,
      cutoffMs,
      maxComments,
      (): Promise<readonly IssueClosureGitHubComment[]> => this.github.listIssueComments(request.issue),
    );
    if (issueComments.status === 'inspect_required') return issueComments;

    const implementationPRs: CollectedIssueClosureGitHubPullRequest[] = [];
    for (const ref of request.implementationPRs) {
      const resource = formatResourceRef(ref);
      const pullRequest = await this.readPullRequest(ref);
      if (pullRequest.status === 'inspect_required') return pullRequest;
      if (pullRequest.value === null) {
        return {
          status: 'inspect_required',
          reason: 'implementation_pr_not_found',
          resource,
        };
      }
      if (!sameResourceRef(ref, pullRequest.value.ref)) {
        return {
          status: 'inspect_required',
          reason: 'resource_identity_mismatch',
          resource,
          detail: `provider returned ${formatResourceRef(pullRequest.value.ref)}`,
        };
      }

      const comments = await this.readComments(
        ref,
        cutoffMs,
        maxComments,
        (): Promise<readonly IssueClosureGitHubComment[]> => this.github.listPullRequestComments(ref),
      );
      if (comments.status === 'inspect_required') return comments;

      implementationPRs.push({
        ...pullRequest.value,
        comments: comments.value,
      });
    }

    return {
      status: 'collected',
      snapshot: {
        cutoffAt: request.cutoffAt,
        observation: {
          issue: issueResource,
          state: issue.value.state,
        },
        issue: {
          ...issue.value,
          comments: issueComments.value,
        },
        implementationPRs,
      },
    };
  }

  private async readIssue(
    ref: IssueClosureGitHubResourceRef,
  ): Promise<ReadResult<IssueClosureGitHubIssue | null>> {
    const resource = formatResourceRef(ref);
    try {
      return { status: 'ok', value: await this.github.readIssue(ref) };
    } catch {
      return providerFailure(resource);
    }
  }

  private async readPullRequest(
    ref: IssueClosureGitHubResourceRef,
  ): Promise<ReadResult<IssueClosureGitHubPullRequest | null>> {
    const resource = formatResourceRef(ref);
    try {
      return { status: 'ok', value: await this.github.readPullRequest(ref) };
    } catch {
      return providerFailure(resource);
    }
  }

  private async readComments(
    ref: IssueClosureGitHubResourceRef,
    cutoffMs: number,
    maxComments: number,
    reader: () => Promise<readonly IssueClosureGitHubComment[]>,
  ): Promise<ReadResult<readonly CollectedIssueClosureGitHubComment[]>> {
    const resource = formatResourceRef(ref);
    let comments: readonly IssueClosureGitHubComment[];
    try {
      comments = await reader();
    } catch {
      return providerFailure(resource);
    }

    const eligible: Array<{
      comment: IssueClosureGitHubComment;
      createdAtMs: number;
    }> = [];

    for (const comment of comments) {
      const createdAtMs = Date.parse(comment.createdAt);
      if (!Number.isFinite(createdAtMs)) {
        return {
          status: 'inspect_required',
          reason: 'comment_timestamp_invalid',
          resource: commentRef(resource, comment.id),
        };
      }
      if (createdAtMs <= cutoffMs) eligible.push({ comment, createdAtMs });
    }

    if (eligible.length > maxComments) {
      return {
        status: 'inspect_required',
        reason: 'comment_limit_exceeded',
        resource,
      };
    }

    eligible.sort((left, right) =>
      left.createdAtMs - right.createdAtMs
      || left.comment.id.localeCompare(right.comment.id));

    return {
      status: 'ok',
      value: eligible.map(({ comment }) => ({
        ...comment,
        ref: commentRef(resource, comment.id),
      })),
    };
  }
}

type ReadResult<T> =
  | {
    readonly status: 'ok';
    readonly value: T;
  }
  | Extract<IssueClosureGitHubCollectionResult, { readonly status: 'inspect_required' }>;

function providerFailure(
  resource: string,
): Extract<IssueClosureGitHubCollectionResult, { readonly status: 'inspect_required' }> {
  return {
    status: 'inspect_required',
    reason: 'provider_error',
    resource,
    detail: 'GitHub provider failed',
  };
}

function normalizeCommentLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_COMMENTS_PER_RESOURCE;
  return Math.max(1, Math.floor(value));
}

function sameResourceRef(
  expected: IssueClosureGitHubResourceRef,
  actual: IssueClosureGitHubResourceRef,
): boolean {
  return expected.repository.trim() === actual.repository.trim()
    && expected.number === actual.number;
}

function formatResourceRef(ref: IssueClosureGitHubResourceRef): string {
  return `${ref.repository.trim()}#${ref.number}`;
}

function commentRef(resource: string, commentId: string): string {
  return `${resource}:comment:${commentId}`;
}
