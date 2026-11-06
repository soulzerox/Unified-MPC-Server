import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonicalSourceExpectations,
  CanonicalSourceExpectationError,
  hashLivePath,
} from './canonical-source-expectations.js';

const HELLO = 'hello\n';
const HELLO_HASH = sha256(HELLO);
const DIRTY = 'dirty\n';
const DIRTY_HASH = sha256(DIRTY);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'canonical-source-expectations-'));
  roots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

describe('buildCanonicalSourceExpectations (#210 §13)', () => {
  it('fences live bytes and reports every view path the worktree no longer holds', async () => {
    const root = await tempRoot();
    await write(root, 'src/a.ts', HELLO);
    await write(root, 'src/dirty.ts', DIRTY);
    await symlink(path.join(root, 'src/a.ts'), path.join(root, 'src/link.ts'));
    const view = new Map<string, string>([
      ['src/a.ts', HELLO_HASH],
      // The declared revision says this path holds different bytes than disk:
      // the fence publishes what the scanner will read and reports the drift,
      // because no hash here can make the worktree match the view.
      ['src/dirty.ts', 'f'.repeat(64)],
      // Tracked in the revision but removed from the worktree.
      ['src/gone.ts', 'e'.repeat(64)],
      // The scanner skips symlinks; a hash here would look stale.
      ['src/link.ts', 'a'.repeat(64)],
    ]);
    const plan = await buildCanonicalSourceExpectations({
      rootPath: root,
      requestedPaths: null,
      view,
    });
    expect(plan.expectedPaths).toEqual({
      'src/a.ts': HELLO_HASH,
      'src/dirty.ts': DIRTY_HASH,
    });
    expect(plan.deletedPaths).toEqual(['src/gone.ts']);
    expect(plan.driftedPaths).toEqual(['src/dirty.ts', 'src/gone.ts']);
  });

  it('keeps the view hash for a tracked path that still matches and hashes untracked paths live', async () => {
    const root = await tempRoot();
    await write(root, 'src/a.ts', HELLO);
    await write(root, 'src/b.ts', DIRTY);
    await write(root, 'src/untracked.ts', DIRTY);
    const view = new Map<string, string>([
      ['src/a.ts', HELLO_HASH],
      // The worktree disagrees with the view: live hash plus drift, never the
      // view hash, so the request cannot claim bytes the view does not hold.
      ['src/b.ts', HELLO_HASH],
      ['src/only-in-view.ts', 'c'.repeat(64)],
    ]);
    const plan = await buildCanonicalSourceExpectations({
      rootPath: root,
      requestedPaths: ['src/a.ts', 'src/b.ts', 'src/untracked.ts', 'src/only-in-view.ts'],
      view,
    });
    expect(plan.expectedPaths).toEqual({
      'src/a.ts': HELLO_HASH,
      'src/b.ts': DIRTY_HASH,
      'src/untracked.ts': DIRTY_HASH,
    });
    expect(plan.deletedPaths).toEqual(['src/only-in-view.ts']);
    expect(plan.driftedPaths).toEqual(['src/b.ts', 'src/only-in-view.ts']);

    await expect(buildCanonicalSourceExpectations({
      rootPath: root,
      requestedPaths: ['src/missing.ts'],
      view,
    })).rejects.toBeInstanceOf(CanonicalSourceExpectationError);
  });

  it('never fences a tracked deletion, even when a copy is still readable', async () => {
    const root = await tempRoot();
    await write(root, 'src/a.ts', HELLO);
    const plan = await buildCanonicalSourceExpectations({
      rootPath: root,
      requestedPaths: null,
      view: new Map([['src/a.ts', HELLO_HASH]]),
      deletedPaths: ['src/a.ts'],
    });
    expect(plan.expectedPaths).toEqual({});
    expect(plan.deletedPaths).toEqual(['src/a.ts']);
    // A removal the caller already declared is not drift.
    expect(plan.driftedPaths).toEqual([]);
  });

  it('sends nothing for a full request with no revision view', async () => {
    const root = await tempRoot();
    await write(root, 'src/a.ts', HELLO);
    const plan = await buildCanonicalSourceExpectations({
      rootPath: root,
      requestedPaths: null,
      view: null,
    });
    expect(plan.expectedPaths).toEqual({});
    expect(plan.deletedPaths).toEqual([]);
  });

  it('omits an unfenceable requested path instead of refusing the whole request', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'src'));
    await symlink(path.join(root, 'src'), path.join(root, 'src-link'));
    await write(root, 'src/a.ts', HELLO);
    const plan = await buildCanonicalSourceExpectations({
      rootPath: root,
      requestedPaths: ['src-link', 'src/a.ts', '../escape.ts'],
      view: null,
    });
    expect(plan.expectedPaths).toEqual({ 'src/a.ts': HELLO_HASH });
    expect(plan.deletedPaths).toEqual([]);
  });

  it('reports a directory and a missing path distinctly', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, 'src'));
    await expect(hashLivePath(root, 'src')).resolves.toEqual({ kind: 'unfenceable' });
    await expect(hashLivePath(root, 'missing.ts')).resolves.toEqual({ kind: 'absent' });
  });
});
