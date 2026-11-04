import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CanonicalRefStore } from './canonical-ref-store.js';
import {
  advanceRevisionFromGit,
  classifySourcePath,
  repositoryIdForRemoteUrl,
  type CanonicalGitRevision,
  type CanonicalGitSource,
  type CanonicalGitTreeEntry,
} from './git-revision-advance.js';

const REF = 'refs/remotes/origin/main';
const REMOTE = 'git@github.com:example/repo.git';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Deterministic in-memory Git: the commit's tree is the file map, and the blob
 * for a path is keyed by the path so callers can mutate content between calls.
 */
class FakeGit implements CanonicalGitSource {
  public constructor(
    public files: Record<string, string>,
    public commitSha: string = 'c'.repeat(40),
    public parents: readonly string[] = [],
    public remote: string | null = REMOTE,
    public modes: Record<string, string> = {},
    public overrideHashes: Record<string, string> = {},
  ) {}

  public async resolveRevision(targetRef: string): Promise<CanonicalGitRevision | null> {
    if (targetRef !== REF) return null;
    return { commitSha: this.commitSha, treeOid: this.treeOid(), parents: this.parents };
  }

  public async listTree(): Promise<readonly CanonicalGitTreeEntry[]> {
    return Object.entries(this.files)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([filePath]) => ({ path: filePath, blobOid: blobOid(filePath), mode: this.modes[filePath] ?? '100644' }));
  }

  public async hashBlobs(blobOids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const hashes = new Map<string, string>();
    for (const [filePath, content] of Object.entries(this.files)) {
      const oid = blobOid(filePath);
      if (!blobOids.includes(oid)) continue;
      hashes.set(oid, this.overrideHashes[filePath] ?? sha256(content));
    }
    return hashes;
  }

  public async remoteUrl(): Promise<string | null> {
    return this.remote;
  }

  public treeOid(): string {
    return sha256(JSON.stringify(Object.entries(this.files).sort(([a], [b]) => (a < b ? -1 : 1))));
  }
}

function blobOid(filePath: string): string {
  return createHash('sha256').update(`blob:${filePath}`, 'utf8').digest('hex');
}

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'git-revision-advance-'));
}

describe('advance revision from git (#210 §3 producer)', () => {
  it('promotes a first revision, registering every classified path as a new artifact', async () => {
    const root = await tempRoot();
    try {
      const result = await advanceRevisionFromGit({
        root,
        source: new FakeGit({ 'src/a.ts': 'a', 'src/b.ts': 'b', 'assets/logo.png': 'png' }),
        targetRef: REF,
        now: new Date('2026-11-04T00:00:00.000Z'),
      });

      expect(result.status).toBe('promoted');
      if (result.status !== 'promoted') return;
      expect(result.commitSha).toBe('c'.repeat(40));
      expect(result.targetRef).toBe(REF);
      expect(result.repositoryId).toBe(repositoryIdForRemoteUrl(REMOTE));
      expect(result.reuse.newPaths).toEqual(['assets/logo.png', 'src/a.ts', 'src/b.ts']);
      expect(result.reuse.reusedPaths).toEqual([]);
      expect(result.artifacts.status).toBe('registered');
      if (result.artifacts.status !== 'registered') return;
      expect(result.artifacts.registered).toBe(2);
      expect(result.artifacts.reused).toBe(0);
      // A binary asset is not claimed as source-indexed; the gap is reported.
      expect(result.artifacts.unclassified).toEqual(['assets/logo.png']);

      const stored = await new CanonicalRefStore(root).read(REF);
      expect(stored?.manifestId).toBe(result.manifestId);
      expect(stored?.commitSha).toBe('c'.repeat(40));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a second pass over the same revision as a noop with every artifact reused', async () => {
    const root = await tempRoot();
    try {
      const source = new FakeGit({ 'src/a.ts': 'a', 'src/b.ts': 'b' });
      const first = await advanceRevisionFromGit({ root, source, targetRef: REF, now: new Date() });
      const second = await advanceRevisionFromGit({ root, source, targetRef: REF, now: new Date() });

      expect(first.status).toBe('promoted');
      expect(second.status).toBe('noop');
      if (second.status !== 'noop' || second.artifacts.status !== 'registered') return;
      expect(second.artifacts.registered).toBe(0);
      expect(second.artifacts.reused).toBe(2);
      expect(second.reuse.reusedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses unchanged content across a new commit and registers only the changed file', async () => {
    const root = await tempRoot();
    try {
      const source = new FakeGit({ 'src/a.ts': 'a', 'src/b.ts': 'b', 'src/c.ts': 'c' });
      const first = await advanceRevisionFromGit({ root, source, targetRef: REF, now: new Date() });

      source.files = { 'src/a.ts': 'a', 'src/b.ts': 'b2', 'src/c.ts': 'c' };
      source.commitSha = 'd'.repeat(40);
      const second = await advanceRevisionFromGit({ root, source, targetRef: REF, now: new Date() });

      expect(first.status).toBe('promoted');
      expect(second.status).toBe('promoted');
      if (second.status !== 'promoted' || second.artifacts.status !== 'registered') return;
      expect(second.reuse.reusedPaths).toEqual(['src/a.ts', 'src/c.ts']);
      expect(second.reuse.newPaths).toEqual(['src/b.ts']);
      expect(second.artifacts.reused).toBe(2);
      expect(second.artifacts.registered).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a rename with identical content as reuse, not a new artifact', async () => {
    const root = await tempRoot();
    try {
      const source = new FakeGit({ 'src/old.ts': 'same' });
      await advanceRevisionFromGit({ root, source, targetRef: REF, now: new Date() });

      source.files = { 'src/new.ts': 'same' };
      source.commitSha = 'e'.repeat(40);
      const renamed = await advanceRevisionFromGit({ root, source, targetRef: REF, now: new Date() });

      expect(renamed.status).toBe('promoted');
      if (renamed.status !== 'promoted' || renamed.artifacts.status !== 'registered') return;
      expect(renamed.reuse.renamedPaths).toEqual(['src/new.ts']);
      expect(renamed.reuse.reusedPaths).toEqual(['src/new.ts']);
      // A rename is not a delete: the base path was claimed by the rename.
      expect(renamed.reuse.deletedPaths).toEqual([]);
      expect(renamed.artifacts.registered).toBe(0);
      expect(renamed.artifacts.reused).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses the whole advance when the ref does not resolve to a commit', async () => {
    const root = await tempRoot();
    try {
      const result = await advanceRevisionFromGit({
        root,
        source: new FakeGit({ 'src/a.ts': 'a' }),
        targetRef: 'refs/remotes/origin/does-not-exist',
        now: new Date(),
      });
      expect(result).toEqual({
        status: 'refused',
        targetRef: 'refs/remotes/origin/does-not-exist',
        reason: 'ref refs/remotes/origin/does-not-exist does not resolve to a commit',
      });
      expect(await new CanonicalRefStore(root).read('refs/remotes/origin/does-not-exist')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a non-blob tree entry instead of skipping it', async () => {
    const root = await tempRoot();
    try {
      const result = await advanceRevisionFromGit({
        root,
        source: new FakeGit({ 'src/a.ts': 'a', 'vendor/lib': 'gitlink' }, 'c'.repeat(40), [], REMOTE, {
          'vendor/lib': '160000',
        }),
        targetRef: REF,
        now: new Date(),
      });
      expect(result.status).toBe('refused');
      if (result.status !== 'refused') return;
      expect(result.reason).toContain('vendor/lib');
      expect(await new CanonicalRefStore(root).read(REF)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses when the repository has no remote and no explicit id', async () => {
    const root = await tempRoot();
    try {
      const result = await advanceRevisionFromGit({
        root,
        source: new FakeGit({ 'src/a.ts': 'a' }, 'c'.repeat(40), [], null),
        targetRef: REF,
        now: new Date(),
      });
      expect(result).toMatchObject({ status: 'refused', reason: 'repository has no remote; pass an explicit repository id' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an explicitly pinned repository id', async () => {
    const root = await tempRoot();
    try {
      const result = await advanceRevisionFromGit({
        root,
        source: new FakeGit({ 'src/a.ts': 'a' }, 'c'.repeat(40), [], null),
        targetRef: REF,
        now: new Date(),
        repositoryId: 'repo_pinned',
      });
      expect(result.status).toBe('promoted');
      if (result.status !== 'promoted') return;
      expect(result.repositoryId).toBe('repo_pinned');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a source that cannot produce a byte-exact content hash', async () => {
    const root = await tempRoot();
    try {
      const result = await advanceRevisionFromGit({
        root,
        source: new FakeGit({ 'src/a.ts': 'a' }, 'c'.repeat(40), [], REMOTE, {}, { 'src/a.ts': 'not-a-sha256' }),
        targetRef: REF,
        now: new Date(),
      });
      expect(result).toMatchObject({ status: 'refused' });
      if (result.status !== 'refused') return;
      expect(result.reason).toContain('not an exact SHA-256');
      expect(await new CanonicalRefStore(root).read(REF)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('conflicts instead of clobbering a ref that moved while the tree was hashed', async () => {
    const root = await tempRoot();
    try {
      const source = new FakeGit({ 'src/a.ts': 'a' });
      await advanceRevisionFromGit({ root, source, targetRef: REF, now: new Date() });
      const outer = new FakeGit({ 'src/a.ts': 'outer' }, 'f'.repeat(40));
      const racer = new FakeGit({ 'src/a.ts': 'racer' }, 'a'.repeat(40));

      // Race: a concurrent promoter advances the ref to a *different* revision
      // between this caller's read of the believed-current state and its own
      // promote. A racing advance to the same revision would be an idempotent
      // noop, so the two targets must differ for the conflict to be observable.
      const racingSource: CanonicalGitSource = {
        resolveRevision: (targetRef) => outer.resolveRevision(targetRef),
        listTree: (commitSha) => outer.listTree(commitSha),
        remoteUrl: () => outer.remoteUrl(),
        hashBlobs: async (blobOids) => {
          const hashes = await outer.hashBlobs(blobOids);
          const raced = await advanceRevisionFromGit({ root, source: racer, targetRef: REF, now: new Date() });
          expect(raced.status).toBe('promoted');
          return hashes;
        },
      };

      const result = await advanceRevisionFromGit({ root, source: racingSource, targetRef: REF, now: new Date() });
      expect(result.status).toBe('conflict');
      if (result.status !== 'conflict') return;
      expect(result.currentCommitSha).toBe('a'.repeat(40));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('repository identity from remote URL (#210 §1)', () => {
  it('is stable across trailing slash and .git spelling, and distinct across remotes', () => {
    const base = repositoryIdForRemoteUrl('git@github.com:example/repo.git');
    expect(repositoryIdForRemoteUrl('git@github.com:example/repo')).toBe(base);
    expect(repositoryIdForRemoteUrl('git@github.com:example/repo.git/')).toBe(base);
    expect(repositoryIdForRemoteUrl('  git@github.com:example/repo.git  ')).toBe(base);
    expect(repositoryIdForRemoteUrl('git@github.com:example/other.git')).not.toBe(base);
    expect(base.startsWith('repo:v1:')).toBe(true);
  });

  it('refuses an empty remote', () => {
    expect(() => repositoryIdForRemoteUrl('   ')).toThrow(TypeError);
  });
});

describe('source classification policy (#210 §1/§8)', () => {
  it('classifies known source extensions and leaves assets unclassified', () => {
    expect(classifySourcePath('src/app.ts')).toMatchObject({ language: 'typescript', sourceKind: 'source', representationVersion: 'v1' });
    expect(classifySourcePath('docs/README.md')).toMatchObject({ language: 'markdown' });
    expect(classifySourcePath('Dockerfile')).toMatchObject({ language: 'dockerfile' });
    expect(classifySourcePath('assets/logo.png')).toBeNull();
    expect(classifySourcePath('pnpm-lock.yaml')).toMatchObject({ language: 'yaml' });
  });

  it('honours an explicit language override', () => {
    expect(classifySourcePath('script', 'python')).toMatchObject({ language: 'python', path: 'script' });
  });
});
