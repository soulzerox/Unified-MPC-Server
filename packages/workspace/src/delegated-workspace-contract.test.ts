import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDelegatedWorkspaceDependencyContract } from './delegated-workspace-contract.js';

const temporaryRoots: string[] = [];

async function pnpmWorktree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-delegated-worktree-'));
  temporaryRoots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'pnpm@10.15.0' }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('delegated workspace dependency contract', () => {
  it('reuses the managed policy while keeping parent and child mutable trees distinct', async () => {
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-delegated-cache-'));
    temporaryRoots.push(sharedCacheRoot);
    const parentRoot = await pnpmWorktree();
    const childRoot = await pnpmWorktree();

    const contract = await prepareDelegatedWorkspaceDependencyContract({
      parent: { rootPath: parentRoot, sharedCacheRoot, worktree: { isNew: true } },
      child: { rootPath: childRoot, sharedCacheRoot, worktree: { isNew: true } },
    });

    expect(contract.status).toBe('ready');
    expect(contract.parent.lifecycle).toBe('goal');
    expect(contract.child.lifecycle).toBe('delegated');
    expect(contract.parent.plan.strategy.sharedPaths).toEqual(contract.child.plan.strategy.sharedPaths);
    expect(contract.parent.plan.strategy.worktreeLocalPaths).not.toEqual(contract.child.plan.strategy.worktreeLocalPaths);
    expect(contract.blockingReasons).toEqual([]);
  });

  it('blocks a delegated child that would reuse the parent mutable dependency tree', async () => {
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-delegated-cache-'));
    temporaryRoots.push(sharedCacheRoot);
    const root = await pnpmWorktree();

    const contract = await prepareDelegatedWorkspaceDependencyContract({
      parent: { rootPath: root, sharedCacheRoot, worktree: { isNew: true } },
      child: { rootPath: root, sharedCacheRoot, worktree: { isNew: true } },
    });

    expect(contract.status).toBe('blocked');
    expect(contract.blockingReasons).toContain('parent and delegated workspaces must not share mutable dependency trees');
  });

  it('preserves #35 lifecycle safety when the child workspace is active', async () => {
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-delegated-cache-'));
    temporaryRoots.push(sharedCacheRoot);
    const parentRoot = await pnpmWorktree();
    const childRoot = await pnpmWorktree();

    const contract = await prepareDelegatedWorkspaceDependencyContract({
      parent: { rootPath: parentRoot, sharedCacheRoot, worktree: { isNew: true } },
      child: { rootPath: childRoot, sharedCacheRoot, worktree: { active: true, processOwned: true } },
    });

    expect(contract.status).toBe('blocked');
    expect(contract.child.plan.status).toBe('blocked');
    expect(contract.child.plan.strategy.migration.mayReplaceMutableRuntimeState).toBe(false);
    expect(contract.blockingReasons).toContain('delegated dependency bootstrap is blocked');
  });
});
