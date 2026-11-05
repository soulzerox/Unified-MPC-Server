import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { advanceRevisionFromGit, legacyRepositoryIdForRemoteUrl, repositoryIdForRemoteUrl } from '@unified-mpc/workspace';
import { createCanonicalGitSource, resolveGoalBaseBranch, resolveGoalRepositoryIds } from './canonical-git-source.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...args], { cwd });
  return result.stdout;
}

async function tempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canonical-git-source-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('canonical Git source adapter (#210 §2)', () => {
  it('resolves the exact commit, tree and parents of a ref', async () => {
    const dir = await tempRepo();
    try {
      await writeFile(path.join(dir, 'a.ts'), 'export const a = 1;\n');
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'first']);
      const source = createCanonicalGitSource(dir);

      const first = await source.resolveRevision('refs/heads/main');
      expect(first).not.toBeNull();
      expect(first?.commitSha).toBe((await git(dir, ['rev-parse', 'HEAD'])).trim());
      expect(first?.treeOid).toBe((await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim());
      expect(first?.parents).toEqual([]);

      await writeFile(path.join(dir, 'a.ts'), 'export const a = 2;\n');
      await git(dir, ['commit', '-am', 'second']);
      const second = await source.resolveRevision('refs/heads/main');
      expect(second?.parents).toEqual([first?.commitSha]);

      expect(await source.resolveRevision('refs/heads/nope')).toBeNull();
      // A bare branch name is not a canonical ref and must not resolve.
      expect(await source.resolveRevision('main')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hashes blob bytes exactly, including empty, large and non-UTF-8 blobs', async () => {
    const dir = await tempRepo();
    try {
      const empty = Buffer.alloc(0);
      const large = Buffer.from('x'.repeat(300_000), 'utf8');
      // Invalid UTF-8: decoding as text would replace these bytes and change the hash.
      const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f]);
      const duplicate = Buffer.from('same content\n', 'utf8');

      await mkdir(path.join(dir, 'nested'), { recursive: true });
      await writeFile(path.join(dir, 'empty.bin'), empty);
      await writeFile(path.join(dir, 'nested/large.txt'), large);
      await writeFile(path.join(dir, 'binary.bin'), binary);
      await writeFile(path.join(dir, 'one.txt'), duplicate);
      await writeFile(path.join(dir, 'two.txt'), duplicate);
      await writeFile(path.join(dir, 'run.sh'), '#!/bin/sh\necho hi\n');
      await execFileAsync('chmod', ['755', path.join(dir, 'run.sh')]);
      await symlink('one.txt', path.join(dir, 'link.txt'));
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'blobs']);

      const source = createCanonicalGitSource(dir);
      const revision = await source.resolveRevision('refs/heads/main');
      const tree = await source.listTree(revision!.commitSha);
      const byPath = new Map(tree.map((entry) => [entry.path, entry]));
      expect(byPath.get('run.sh')?.mode).toBe('100755');
      expect(byPath.get('link.txt')?.mode).toBe('120000');

      const hashes = await source.hashBlobs(tree.map((entry) => entry.blobOid));

      const hashOf = (file: string): string => hashes.get(byPath.get(file)!.blobOid)!;
      expect(hashOf('empty.bin')).toBe(sha256(empty));
      expect(hashOf('nested/large.txt')).toBe(sha256(large));
      expect(hashOf('binary.bin')).toBe(sha256(binary));
      expect(hashOf('one.txt')).toBe(sha256(duplicate));
      // Identical content is one blob and one hash, not two.
      expect(hashOf('two.txt')).toBe(hashOf('one.txt'));
      // A symlink is content-addressed by its target path, as Git stores it.
      expect(hashOf('link.txt')).toBe(sha256(Buffer.from('one.txt', 'utf8')));
      expect(hashes.size).toBe(tree.length - 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports the remote URL, or null when the repository has none', async () => {
    const dir = await tempRepo();
    try {
      const source = createCanonicalGitSource(dir);
      expect(await source.remoteUrl()).toBeNull();
      await git(dir, ['remote', 'add', 'origin', 'git@github.com:example/repo.git']);
      expect(await source.remoteUrl()).toBe('git@github.com:example/repo.git');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('advances a real commit end to end and reuses every unchanged artifact', async () => {
    const repo = await tempRepo();
    const root = await mkdtemp(path.join(os.tmpdir(), 'canonical-store-'));
    try {
      await git(repo, ['remote', 'add', 'origin', 'git@github.com:example/repo.git']);
      for (const [name, content] of [['a.ts', 'a'], ['b.ts', 'b'], ['c.md', '# c'], ['logo.png', 'png']] as const) {
        await writeFile(path.join(repo, name), `${content}\n`);
      }
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'first']);

      const source = createCanonicalGitSource(repo);
      const first = await advanceRevisionFromGit({ root, source, targetRef: 'refs/heads/main', now: new Date() });
      expect(first.status).toBe('promoted');
      if (first.status !== 'promoted' || first.artifacts.status !== 'registered') return;
      expect(first.artifacts.registered).toBe(3);
      expect(first.artifacts.unclassified).toEqual(['logo.png']);

      // One of four files changes: three must be reused, not rebuilt.
      await writeFile(path.join(repo, 'b.ts'), 'b2\n');
      await git(repo, ['commit', '-am', 'change one file']);

      const second = await advanceRevisionFromGit({ root, source, targetRef: 'refs/heads/main', now: new Date() });
      expect(second.status).toBe('promoted');
      if (second.status !== 'promoted' || second.artifacts.status !== 'registered') return;
      expect(second.reuse.reusedPaths).toEqual(['a.ts', 'c.md', 'logo.png']);
      expect(second.reuse.newPaths).toEqual(['b.ts']);
      expect(second.artifacts.reused).toBe(2);
      expect(second.artifacts.registered).toBe(1);

      // The recorded commit is the one the ref actually points at, not HEAD's
      // predecessor and not the worktree.
      expect(second.commitSha).toBe((await git(repo, ['rev-parse', 'refs/heads/main^{commit}'])).trim());
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Goal repository identity resolution (#210 §1)', () => {
  it('accepts the current and released-legacy ids for one GitHub remote', async () => {
    const dir = await tempRepo();
    try {
      const remote = 'git@github.com:Example/Repo.git';
      await git(dir, ['remote', 'add', 'origin', remote]);

      const ids = await resolveGoalRepositoryIds(dir);

      expect(ids).toEqual([
        repositoryIdForRemoteUrl(remote),
        legacyRepositoryIdForRemoteUrl(remote),
      ]);
      expect(ids?.[0]).not.toBe(ids?.[1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the checkout has no origin remote', async () => {
    const dir = await tempRepo();
    try {
      expect(await resolveGoalRepositoryIds(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Goal admission base branch resolution (#210 §1)', () => {
  function policyFor(defaultBranch: string, expectedRepository = 'Example/Repo'): {
    readonly getByRepository: (repository: string) => Promise<{ readonly defaultBranch: string } | undefined>;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    return {
      calls,
      getByRepository: async (repository: string): Promise<{ readonly defaultBranch: string } | undefined> => {
        calls.push(repository);
        return repository === expectedRepository ? { defaultBranch } : undefined;
      },
    };
  }

  it('uses the merge policy default branch instead of main', async () => {
    const dir = await tempRepo();
    try {
      await git(dir, ['remote', 'add', 'origin', 'git@github.com:Example/Repo.git']);
      const policy = policyFor('trunk');

      expect(await resolveGoalBaseBranch(dir, 'main', policy)).toBe('trunk');
      expect(policy.calls).toEqual(['Example/Repo']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a master checkout on master when no policy exists', async () => {
    const dir = await tempRepo();
    try {
      await git(dir, ['remote', 'add', 'origin', 'git@github.com:Example/Repo.git']);

      expect(await resolveGoalBaseBranch(dir, 'master', policyFor('main', 'Other/Repo'))).toBe('master');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to main for a feature branch without a policy', async () => {
    const dir = await tempRepo();
    try {
      await git(dir, ['remote', 'add', 'origin', 'git@github.com:Example/Repo.git']);

      expect(await resolveGoalBaseBranch(dir, 'feature/x', policyFor('trunk', 'Other/Repo'))).toBe('main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not look up a policy without a GitHub origin', async () => {
    const dir = await tempRepo();
    try {
      const policy = policyFor('trunk');
      expect(await resolveGoalBaseBranch(dir, 'main', policy)).toBe('main');
      expect(policy.calls).toEqual([]);

      await git(dir, ['remote', 'add', 'origin', '/tmp/local-origin.git']);
      expect(await resolveGoalBaseBranch(dir, 'master', policy)).toBe('master');
      expect(policy.calls).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
