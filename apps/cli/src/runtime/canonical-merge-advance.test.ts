import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RepositoryMergePolicy } from '@unified-mpc/domain';
import {
  CanonicalRefStore,
  type CanonicalGitRevision,
  type CanonicalGitSource,
  type CanonicalGitTreeEntry,
  type GitRevisionAdvanceResult,
} from '@unified-mpc/workspace';
import {
  canonicalAdvanceOutcome,
  canonicalRefForBranch,
  createCanonicalMergeAdvance,
  type CanonicalAdvanceAfterMerge,
} from './canonical-merge-advance.js';

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

function advanceWith(
  canonicalRoot: string,
  overrides: {
    readonly source?: CanonicalGitSource;
    readonly fetchBranch?: (checkoutPath: string, branch: string) => Promise<void>;
    readonly isAncestor?: (checkoutPath: string, ancestor: string, descendant: string) => Promise<boolean>;
  } = {},
): CanonicalAdvanceAfterMerge {
  return createCanonicalMergeAdvance({
    canonicalRoot,
    now: (): Date => new Date('2026-11-04T00:00:00.000Z'),
    fetchBranch: overrides.fetchBranch ?? (async (): Promise<void> => undefined),
    isAncestor: overrides.isAncestor ?? (async (): Promise<boolean> => true),
    sourceFor: () => overrides.source ?? new FakeGit(),
  });
}

describe('canonical ref for a merge branch (#210 §2)', () => {
  it('reads the origin remote-tracking ref, never a local branch', () => {
    expect(canonicalRefForBranch('main')).toBe('refs/remotes/origin/main');
  });
});

describe('gate result projection (#210 §3)', () => {
  const reuse = { reusedPaths: ['a.ts', 'b.ts'], newPaths: ['c.ts'], renamedPaths: [], deletedPaths: [] };
  // The projection reads only status, ids and reuse counts, so these fixtures
  // carry exactly those fields instead of a full GitRevisionAdvanceReport.
  const result = (value: object): GitRevisionAdvanceResult => value as GitRevisionAdvanceResult;
  const target = { commitSha: COMMIT, treeOid: 't', manifestId: 'man:v1:x' };

  it('reports a promotion as advanced with the reuse counts', () => {
    const outcome = canonicalAdvanceOutcome(
      result({ status: 'promoted', manifestId: 'man:v1:x', decision: { action: 'promote', target }, commitSha: COMMIT, reuse }),
      REF,
    );

    expect(outcome).toEqual({
      status: 'advanced',
      ref: REF,
      commitSha: COMMIT,
      manifestId: 'man:v1:x',
      reusedPaths: 2,
      changedPaths: 1,
    });
  });

  it('reports an unchanged manifest as a noop', () => {
    const outcome = canonicalAdvanceOutcome(
      result({ status: 'noop', manifestId: 'man:v1:x', decision: { action: 'noop', target }, commitSha: COMMIT, reuse }),
      REF,
    );

    expect(outcome).toMatchObject({ status: 'noop', manifestId: 'man:v1:x' });
  });

  it('reports a concurrent promotion as a refusal naming the new head', () => {
    const outcome = canonicalAdvanceOutcome(
      result({ status: 'conflict', targetRef: REF, currentCommitSha: 'b'.repeat(40) }),
      REF,
    );

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toContain('advanced concurrently');
    expect(outcome.reason).toContain('b'.repeat(40));
  });

  it('reports a gate rejection verbatim', () => {
    const outcome = canonicalAdvanceOutcome(result({ status: 'refused', targetRef: REF, reason: 'unverifiable entries: a.ts' }), REF);

    expect(outcome).toEqual({ status: 'refused', reason: 'unverifiable entries: a.ts' });
  });
});

describe('canonical advance after merge (#210 §3)', () => {
  it('refuses when the policy names no checkout instead of guessing one', async () => {
    const advance = advanceWith('/nonexistent');

    const outcome = await advance({
      policy: { ...policy, checkoutPath: undefined },
      expectedCommitSha: COMMIT,
    });

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toMatch(/checkoutPath/);
  });

  it('refuses a commit id that is not an exact Git sha', async () => {
    const advance = advanceWith('/nonexistent');

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
      isAncestor: async () => true,
      sourceFor,
    });

    const outcome = await advance({ policy, expectedCommitSha: COMMIT });

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toMatch(/cannot fetch main/);
  });

  it('refuses a checkout that does not contain the merged commit', async () => {
    const root = await tempRoot();
    try {
      const advance = advanceWith(root, { isAncestor: async () => false });

      const outcome = await advance({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/does not contain the merged commit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses when the ancestry question cannot be answered at all', async () => {
    const root = await tempRoot();
    try {
      const advance = advanceWith(root, { isAncestor: async () => { throw new Error('bad object'); } });

      const outcome = await advance({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/cannot verify/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses when the branch ref does not resolve in the checkout', async () => {
    const base = new FakeGit();
    const advance = advanceWith('/nonexistent', {
      source: {
        resolveRevision: async (): Promise<CanonicalGitRevision | null> => null,
        listTree: (): ReturnType<CanonicalGitSource['listTree']> => base.listTree(),
        hashBlobs: (oids: readonly string[]): ReturnType<CanonicalGitSource['hashBlobs']> => base.hashBlobs(oids),
        remoteUrl: (): Promise<string | null> => base.remoteUrl(),
      },
    });

    const outcome = await advance({ policy, expectedCommitSha: COMMIT });

    expect(outcome).toMatchObject({ status: 'refused' });
    if (outcome.status !== 'refused') throw new Error('unexpected');
    expect(outcome.reason).toMatch(/does not resolve/);
  });

  it('advances the canonical ref to the merged commit, then reports a noop on the same commit', async () => {
    const root = await tempRoot();
    try {
      const advance = advanceWith(root);

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

  it('refuses when the branch ref moves between the ancestry check and the gate', async () => {
    const root = await tempRoot();
    try {
      // The gate resolves the ref a second time. A fetch that lands in between
      // must not promote a commit the ancestry check never saw.
      const fake = new FakeGit();
      const movedTo = 'b'.repeat(40);
      const advance = advanceWith(root, {
        source: fake,
        isAncestor: async (): Promise<boolean> => {
          fake.commitSha = movedTo;
          return true;
        },
      });

      const outcome = await advance({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/moved to/);
      expect(outcome.reason).toContain(movedTo);
      expect(await new CanonicalRefStore(root).read(REF)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a second repository into a canonical root already bound to another one', async () => {
    const root = await tempRoot();
    try {
      const advance = advanceWith(root);
      const first = await advance({ policy, expectedCommitSha: COMMIT });
      expect(first.status).toBe('advanced');

      // Same branch ref, different trust boundary: the ref store keys by Git ref
      // path only, so this must refuse instead of replacing the first repository.
      const second = await advanceWith(root, {
        source: new FakeGit({ 'src/b.ts': 'b' }, COMMIT, 'git@github.com:other/repo.git'),
      })({ policy: { ...policy, repository: 'other/repo' }, expectedCommitSha: COMMIT });

      expect(second).toMatchObject({ status: 'refused' });
      if (second.status !== 'refused') throw new Error('unexpected');
      expect(second.reason).toMatch(/bound to/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a checkout whose origin is a different repository than the policy', async () => {
    const root = await tempRoot();
    try {
      // A fork shares commit objects, so ancestry alone would not catch this:
      // the advance would promote the fork's branch under this policy.
      const advance = advanceWith(root, {
        source: new FakeGit({ 'src/a.ts': 'a' }, COMMIT, 'git@github.com:someone-else/repo.git'),
      });

      const outcome = await advance({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/origin is someone-else\/repo, not example\/repo/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts the same repository over a different remote URL form', async () => {
    const root = await tempRoot();
    try {
      const advance = advanceWith(root, {
        source: new FakeGit({ 'src/a.ts': 'a' }, COMMIT, 'https://github.com/Example/Repo.git'),
      });

      const outcome = await advance({ policy: { ...policy, repository: 'example/repo' }, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'advanced' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a corrupt canonical ref instead of overwriting it as a first promotion', async () => {
    const root = await tempRoot();
    try {
      const refFile = path.join(root, 'refs', 'remotes', 'origin', 'main.json');
      await mkdir(path.dirname(refFile), { recursive: true });
      await writeFile(refFile, '{"commitSha": 42}', 'utf8');

      const outcome = await advanceWith(root)({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/cannot read the canonical ref/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a SHA-256 commit id', async () => {
    const root = await tempRoot();
    try {
      const outcome = await advanceWith(root)({ policy, expectedCommitSha: 'c'.repeat(64) });

      expect(outcome).toMatchObject({ status: 'advanced' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a checkout with no remote, because the trust boundary is unknown', async () => {
    const root = await tempRoot();
    try {
      const advance = advanceWith(root, { source: new FakeGit({ 'src/a.ts': 'a' }, COMMIT, null) });

      const outcome = await advance({ policy, expectedCommitSha: COMMIT });

      expect(outcome).toMatchObject({ status: 'refused' });
      if (outcome.status !== 'refused') throw new Error('unexpected');
      expect(outcome.reason).toMatch(/no remote/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
