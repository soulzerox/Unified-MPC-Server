import { describe, expect, it, vi } from 'vitest';
import {
  createAuthoritativeMergeSubjectSource,
  observeOpenPullRequest,
} from './github-pull-request-subject.js';

const REPOSITORY = 'soulzerox/Unified-MPC-Server';
const HEAD = '1111111111111111111111111111111111111111';
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function githubFor(payload: unknown): { get: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async () => payload) };
}

function pullRequest(overrides: {
  state?: string;
  merged?: boolean;
  baseRepository?: string;
  headSha?: string;
  baseSha?: string;
  baseRef?: string;
} = {}): Record<string, unknown> {
  return {
    number: 17,
    state: overrides.state ?? 'open',
    merged: overrides.merged ?? false,
    head: { sha: overrides.headSha ?? HEAD },
    base: {
      ref: overrides.baseRef ?? 'main',
      sha: overrides.baseSha ?? BASE,
      repo: { full_name: overrides.baseRepository ?? REPOSITORY },
    },
  };
}

describe('observeOpenPullRequest', () => {
  it('returns the subject the provider holds, not the caller claim', async () => {
    await expect(observeOpenPullRequest(githubFor(pullRequest()), REPOSITORY, 17)).resolves.toEqual({
      ok: true,
      value: {
        repository: REPOSITORY,
        pullRequest: 17,
        headSha: HEAD,
        baseSha: BASE,
        baseBranch: 'main',
      },
    });
  });

  it('normalizes hex SHAs to lowercase so one commit has one spelling', async () => {
    const result = await observeOpenPullRequest(
      githubFor(pullRequest({ headSha: HEAD.toUpperCase(), baseSha: BASE.toUpperCase() })),
      REPOSITORY,
      17,
    );
    expect(result.ok && result.value.headSha).toBe(HEAD);
    expect(result.ok && result.value.baseSha).toBe(BASE);
  });

  it('refuses a closed or already merged pull request', async () => {
    const closed = await observeOpenPullRequest(githubFor(pullRequest({ state: 'closed' })), REPOSITORY, 17);
    const merged = await observeOpenPullRequest(githubFor(pullRequest({ merged: true })), REPOSITORY, 17);
    expect(closed.ok).toBe(false);
    expect(merged.ok).toBe(false);
  });

  it('refuses a pull request whose base belongs to another repository', async () => {
    const result = await observeOpenPullRequest(
      githubFor(pullRequest({ baseRepository: 'someone/else' })),
      REPOSITORY,
      17,
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a pull request number that does not match the request', async () => {
    const result = await observeOpenPullRequest(githubFor({ ...pullRequest(), number: 99 }), REPOSITORY, 17);
    expect(result.ok).toBe(false);
  });
});

describe('createAuthoritativeMergeSubjectSource', () => {
  it('adapts the observation to the guarded merge subject facts', async () => {
    const source = createAuthoritativeMergeSubjectSource(githubFor(pullRequest()));
    await expect(source.read({ repository: REPOSITORY, pullRequest: 17 })).resolves.toEqual({
      headSha: HEAD,
      baseBranch: 'main',
      baseSha: BASE,
    });
  });

  it('throws when the subject cannot be confirmed, so the merge fails closed', async () => {
    const source = createAuthoritativeMergeSubjectSource(githubFor(pullRequest({ state: 'closed' })));
    await expect(source.read({ repository: REPOSITORY, pullRequest: 17 })).rejects.toThrow();
  });
});