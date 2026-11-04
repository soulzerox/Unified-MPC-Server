import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RepositoryMergePolicy } from '@unified-mpc/domain';
import type { CanonicalGitRevision, CanonicalGitSource, CanonicalGitTreeEntry } from '@unified-mpc/workspace';
import { canonicalRefForBranch, createCanonicalMergeAdvance } from './canonical-merge-advance.js';

const REF = 'refs/remotes/origin/main';
const COMMIT = 'a'.repeat(40);
const REMOTE = 'git@github.com:example/repo.git';

const policy: RepositoryMergePolicy = {
  repository: 'example/repo',
  defaultBranch: 'main',
  verificationMode: 'local_exact_head',
  requiredGates: [],
  reviewPolicy: { required: false, acceptedOutcomes: [] },
  checkoutPath: '/srv/checkouts/repo',
};

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

class FakeGit implements CanonicalGitSource {
  public constructor(
    public files: Record<string, string> = { 'src/a.ts': 'a' },
    public commitSha: string = COMMIT,
    public remote: string | null = REMOTE,
  ) {}

  public async resolveRevision(targetRef: string): Promise<CanonicalGitRevision | null> {
    if (targetRef !== REF) return null;
    return { commitSha: this.commitSha, treeOid: this.treeOid(), parents: [] };
  }

  public async listTree(): Promise<readonly CanonicalGitTreeEntry[]> {
    return Object.keys(this.files).sort().map((filePath) => ({
      path: filePath,
      blobOid: sha256(`blob:${filePath}`),
      mode: '100644',
    }));
  }

  public async hashBlobs(blobOids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const hashes = new Map<string, string>();
    for (const [filePath, content] of Object.entries(this.files)) {
      const oid = sha256(`blob:${filePath}`);
      if (blobOids.includes(oid)) hashes.set(oid, sha256(content));
    }
    return hashes;
  }

  public async remoteUrl(): Promise<string | null> {
    return this.remote;
  }

  private treeOid(): string {
    return sha256(JSON.stringify(Object.entries(this.files).sort(([a], [b]) => (a < b ? -1 : 1))));
  }
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'canonical-merge-advance-'));
}

describe('canonical ref for a merge branch (#210 §2)', () => {
  it('reads the origin remote-tracking ref, never a local branch', () => {
    expect(canonicalRefForBranch('main')).toBe('refs/remotes/origin/main');
  });
});

describe('canonical advance after merge (#210 §3)', () => {
  it('refuses when the policy names no checkout instead of guessing one', async () => {
    const advance = createCanonicalMergeAdvance({
      canonicalRoot: '/nonexistent',
      fetchBranch: async () => undefined,
      sourceFor: () => new FakeGit(),
    });

    const outcome = await advance({
      policy: { ...policy, checkoutPath: undefined },
      expectedCommitSha: COMMIT,
    });

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toMatch(/checkoutPath/);
  });

  it('refuses a commit id that is not an exact Git sha', async () => {
    const advance = createCanonicalMergeAdvance({
      canonicalRoot: '/nonexistent',
      fetchBranch: async () => undefined,
      sourceFor: () => new FakeGit(),
    });

    const outcome = await advance({ policy, expectedCommitSha: 'a1b2c3' });

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toMatch(/exact Git commit id/);
  });

  it('refuses when the fetch fails and never advances a checkout it cannot read', async () => {
    const sourceFor = vi.fn(() => new FakeGit());
    const advance = createCanonicalMergeAdvance({
      canonicalRoot: '/nonexistent',
      fetchBranch: async () => { throw new Error('could not read from remote'); },
      sourceFor,
    });

    const outcome = await advance({ policy, expectedCommitSha: COMMIT });

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toMatch(/cannot fetch main/);
    expect(sourceFor).not.toHaveBeenCalled();
  });

  it('refuses a stale checkout instead of moving the canonical ref backwards', async () => {
    const root = await tempRoot();
    try {
      const advance = createCanonicalMergeAdvance({
        canonicalRoot: root,
        fetchBranch: async () => undefined,
        sourceFor: () => new FakeGit({ 'src/a.ts': 'a' }, 'b'.repeat(40)),
      });

      const outcome = await advance({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/not the merged commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses when the branch ref does not resolve in the checkout', async () => {
    const advance = createCanonicalMergeAdvance({
      canonicalRoot: '/nonexistent',
      fetchBranch: async () => undefined,
      sourceFor: () => ({
        ...new FakeGit(),
        resolveRevision: async (): Promise<CanonicalGitRevision | null> => null,
      }),
    });

    const outcome = await advance({ policy, expectedCommitSha: COMMIT });

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toMatch(/does not resolve/);
  });

  it('advances the canonical ref to the merged commit, then reports a noop on the same commit', async () => {
    const root = await tempRoot();
    try {
      const advance = createCanonicalMergeAdvance({
        canonicalRoot: root,
        now: () => new Date('2026-11-04T00:00:00.000Z'),
        fetchBranch: async () => undefined,
        sourceFor: () => new FakeGit(),
      });

      const first = await advance({ policy, expectedCommitSha: COMMIT });

      expect(first).toMatchObject({ status: 'advanced', ref: REF, commitSha: COMMIT, reusedPaths: 0, changedPaths: 1 });
      if (first.status === 'refused') throw new Error(first.reason);
      expect(first.manifestId).toMatch(/^man:v1:/);

      const second = await advance({ policy, expectedCommitSha: COMMIT });

      expect(second).toMatchObject({ status: 'noop', ref: REF, manifestId: first.manifestId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes a gate refusal through instead of reporting an advance', async () => {
    const root = await tempRoot();
    try {
      const advance = createCanonicalMergeAdvance({
        canonicalRoot: root,
        fetchBranch: async () => undefined,
        // A checkout with no remote cannot be given a trust boundary.
        sourceFor: () => new FakeGit({ 'src/a.ts': 'a' }, COMMIT, null),
      });

      const outcome = await advance({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/remote/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
