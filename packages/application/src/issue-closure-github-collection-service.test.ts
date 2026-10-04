import { describe, expect, it } from 'vitest';
import {
  IssueClosureGitHubCollectionService,
  type IssueClosureGitHubCollectionPort,
  type IssueClosureGitHubComment,
  type IssueClosureGitHubIssue,
  type IssueClosureGitHubPullRequest,
  type IssueClosureGitHubResourceRef,
} from './issue-closure-github-collection-service.js';

const issueRef: IssueClosureGitHubResourceRef = {
  repository: 'soulzerox/Unified-MPC-Server',
  number: 99,
};

const prRef: IssueClosureGitHubResourceRef = {
  repository: 'soulzerox/Webtrans',
  number: 116,
};

function issue(overrides: Partial<IssueClosureGitHubIssue> = {}): IssueClosureGitHubIssue {
  return {
    ref: issueRef,
    title: 'Closure safety',
    body: 'Parent acceptance body',
    state: 'closed',
    ...overrides,
  };
}

function pullRequest(overrides: Partial<IssueClosureGitHubPullRequest> = {}): IssueClosureGitHubPullRequest {
  return {
    ref: prRef,
    title: 'Implement one closure slice',
    body: 'Refs soulzerox/Unified-MPC-Server#99',
    state: 'closed',
    merged: true,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    mergedAt: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}

function comment(
  id: string,
  createdAt: string,
  body = `comment-${id}`,
): IssueClosureGitHubComment {
  return { id, body, createdAt };
}

function port(overrides: Partial<IssueClosureGitHubCollectionPort> = {}): IssueClosureGitHubCollectionPort {
  return {
    readIssue: async () => issue(),
    listIssueComments: async () => [],
    readPullRequest: async () => pullRequest(),
    listPullRequestComments: async () => [],
    ...overrides,
  };
}

describe('IssueClosureGitHubCollectionService', () => {
  it('collects issue, PR and pre-cutoff comments into one bounded reconciliation snapshot', async () => {
    const service = new IssueClosureGitHubCollectionService(port({
      listIssueComments: async () => [
        comment('later', '2026-10-04T10:05:00.000Z'),
        comment('first', '2026-10-04T09:30:00.000Z'),
        comment('cutoff', '2026-10-04T10:00:00.000Z'),
      ],
      listPullRequestComments: async () => [
        comment('pr-after', '2026-10-04T10:00:00.001Z'),
        comment('pr-before', '2026-10-04T09:45:00.000Z'),
      ],
    }));

    const result = await service.collect({
      issue: issueRef,
      implementationPRs: [prRef],
      cutoffAt: '2026-10-04T10:00:00.000Z',
    });

    expect(result).toEqual({
      status: 'collected',
      snapshot: {
        cutoffAt: '2026-10-04T10:00:00.000Z',
        observation: {
          issue: 'soulzerox/Unified-MPC-Server#99',
          state: 'closed',
        },
        issue: {
          ref: issueRef,
          title: 'Closure safety',
          body: 'Parent acceptance body',
          state: 'closed',
          comments: [
            {
              id: 'first',
              body: 'comment-first',
              createdAt: '2026-10-04T09:30:00.000Z',
              ref: 'soulzerox/Unified-MPC-Server#99:comment:first',
            },
            {
              id: 'cutoff',
              body: 'comment-cutoff',
              createdAt: '2026-10-04T10:00:00.000Z',
              ref: 'soulzerox/Unified-MPC-Server#99:comment:cutoff',
            },
          ],
        },
        implementationPRs: [{
          ref: prRef,
          title: 'Implement one closure slice',
          body: 'Refs soulzerox/Unified-MPC-Server#99',
          state: 'closed',
          merged: true,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          mergedAt: '2026-10-04T10:00:00.000Z',
          comments: [{
            id: 'pr-before',
            body: 'comment-pr-before',
            createdAt: '2026-10-04T09:45:00.000Z',
            ref: 'soulzerox/Webtrans#116:comment:pr-before',
          }],
        }],
      },
    });
  });

  it('fails closed when an implementation PR cannot be collected', async () => {
    const service = new IssueClosureGitHubCollectionService(port({
      readPullRequest: async () => null,
    }));

    await expect(service.collect({
      issue: issueRef,
      implementationPRs: [prRef],
      cutoffAt: '2026-10-04T10:00:00.000Z',
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'implementation_pr_not_found',
      resource: 'soulzerox/Webtrans#116',
    });
  });

  it('fails closed instead of silently truncating pre-cutoff comments', async () => {
    const service = new IssueClosureGitHubCollectionService(port({
      listIssueComments: async () => [
        comment('1', '2026-10-04T09:00:00.000Z'),
        comment('2', '2026-10-04T09:01:00.000Z'),
        comment('3', '2026-10-04T09:02:00.000Z'),
      ],
    }));

    await expect(service.collect({
      issue: issueRef,
      implementationPRs: [],
      cutoffAt: '2026-10-04T10:00:00.000Z',
      maxCommentsPerResource: 2,
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'comment_limit_exceeded',
      resource: 'soulzerox/Unified-MPC-Server#99',
    });
  });

  it('fails closed when a comment timestamp cannot be ordered against the audit cutoff', async () => {
    const service = new IssueClosureGitHubCollectionService(port({
      listIssueComments: async () => [comment('bad-time', 'not-a-time')],
    }));

    await expect(service.collect({
      issue: issueRef,
      implementationPRs: [],
      cutoffAt: '2026-10-04T10:00:00.000Z',
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'comment_timestamp_invalid',
      resource: 'soulzerox/Unified-MPC-Server#99:comment:bad-time',
    });
  });

  it('fails closed when the provider returns a different resource identity', async () => {
    const service = new IssueClosureGitHubCollectionService(port({
      readIssue: async () => issue({
        ref: { repository: 'soulzerox/Unified-MPC-Server', number: 82 },
      }),
    }));

    await expect(service.collect({
      issue: issueRef,
      implementationPRs: [],
      cutoffAt: '2026-10-04T10:00:00.000Z',
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'resource_identity_mismatch',
      resource: 'soulzerox/Unified-MPC-Server#99',
      detail: 'provider returned soulzerox/Unified-MPC-Server#82',
    });
  });

  it('turns provider failures into inspect-required evidence instead of guessing lifecycle state', async () => {
    const service = new IssueClosureGitHubCollectionService(port({
      readIssue: async () => {
        throw new Error('GitHub unavailable');
      },
    }));

    await expect(service.collect({
      issue: issueRef,
      implementationPRs: [],
      cutoffAt: '2026-10-04T10:00:00.000Z',
    })).resolves.toEqual({
      status: 'inspect_required',
      reason: 'provider_error',
      resource: 'soulzerox/Unified-MPC-Server#99',
      detail: 'GitHub provider failed',
    });
  });
});
