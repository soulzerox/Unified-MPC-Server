import { describe, expect, it, vi } from 'vitest';
import { createGitHubMergeObservationPort, type GitHubApiReader } from './github-merge-observer.js';

const REPOSITORY = 'soulzerox/Unified-MPC-Server';
const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MERGE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function pull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 281,
    merged: true,
    merged_at: '2026-10-06T21:00:38Z',
    updated_at: '2026-10-06T21:00:39Z',
    merge_commit_sha: MERGE,
    head: { sha: HEAD },
    base: {
      ref: 'main',
      sha: BASE,
      repo: { full_name: REPOSITORY },
    },
    ...overrides,
  };
}

describe('createGitHubMergeObservationPort', () => {
  it('observes a normal merge from GitHub canonical PR and commit state', async () => {
    const get = vi.fn(async (path: string): Promise<unknown> => {
      if (path.endsWith('/pulls/281')) return pull();
      if (path.endsWith(`/commits/${MERGE}`)) {
        return { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const observer = createGitHubMergeObservationPort({ get });

    await expect(observer.observe({ repository: REPOSITORY, pullRequest: 281 })).resolves.toEqual({
      repository: REPOSITORY,
      pullRequest: 281,
      headSha: HEAD,
      baseBranch: 'main',
      baseSha: BASE,
      merged: true,
      mergeMethod: 'merge',
      mergeSha: MERGE,
      observedAt: '2026-10-06T21:00:38Z',
    });
    expect(get).toHaveBeenNthCalledWith(1, 'repos/soulzerox/Unified-MPC-Server/pulls/281');
    expect(get).toHaveBeenNthCalledWith(2, `repos/soulzerox/Unified-MPC-Server/commits/${MERGE}`);
  });

  it('does not invent a merge method when the commit graph cannot prove a normal merge', async () => {
    const github: GitHubApiReader = {
      async get(path): Promise<unknown> {
        if (path.endsWith('/pulls/281')) return pull();
        return { sha: MERGE, parents: [{ sha: BASE }] };
      },
    };
    const observer = createGitHubMergeObservationPort(github);

    await expect(observer.observe({ repository: REPOSITORY, pullRequest: 281 })).resolves.toMatchObject({
      merged: true,
      mergeSha: MERGE,
    });
    const observed = await observer.observe({ repository: REPOSITORY, pullRequest: 281 });
    expect(observed.mergeMethod).toBeUndefined();
  });

  it('returns stable provider time for an unmerged PR and does not inspect a commit', async () => {
    const get = vi.fn(async (): Promise<unknown> => pull({
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      updated_at: '2026-10-06T20:58:00Z',
    }));
    const observer = createGitHubMergeObservationPort({ get });

    await expect(observer.observe({ repository: REPOSITORY, pullRequest: 281 })).resolves.toMatchObject({
      merged: false,
      observedAt: '2026-10-06T20:58:00Z',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('fails closed on provider repository identity mismatch', async () => {
    const observer = createGitHubMergeObservationPort({
      async get(): Promise<unknown> {
        return pull({ base: { ref: 'main', sha: BASE, repo: { full_name: 'other/repository' } } });
      },
    });

    await expect(observer.observe({ repository: REPOSITORY, pullRequest: 281 }))
      .rejects.toThrow('repository identity mismatch');
  });
});
