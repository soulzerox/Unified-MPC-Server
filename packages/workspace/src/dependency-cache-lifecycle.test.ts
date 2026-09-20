import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareManagedWorktreeDependencyBootstrap } from './dependency-cache-lifecycle.js';
import { ResourceAdmissionController } from './resource-admission.js';

const temporaryRoots: string[] = [];

async function pnpmWorktree(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-dependency-lifecycle-'));
  temporaryRoots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'pnpm@10.15.0' }));
  await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('managed worktree dependency lifecycle contract', () => {
  it('fails closed before dependency probing when weighted admission is exhausted', async () => {
    const root = await pnpmWorktree();
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-dependency-shared-'));
    temporaryRoots.push(sharedCacheRoot);
    const controller = new ResourceAdmissionController({ globalCost: 1, workspaceCost: 1, maxOperations: 1 });
    const held = controller.tryAcquire({
      operationId: 'held-bootstrap',
      workspaceId: 'workspace-a',
      resourceClass: 'dependency_bootstrap',
      cost: 1,
    });
    if (!held.admitted) throw new Error('expected held admission');

    const input: Parameters<typeof prepareManagedWorktreeDependencyBootstrap>[0] = {
      lifecycle: 'goal' as const,
      rootPath: root,
      sharedCacheRoot,
      worktree: { isNew: true },
      admission: {
        controller,
        operationId: 'blocked-bootstrap',
        workspaceId: 'workspace-b',
        cost: 1,
      },
    };

    await expect(prepareManagedWorktreeDependencyBootstrap(input)).rejects.toMatchObject({
      code: 'RESOURCE_PRESSURE',
      reason: 'global_cost_exhausted',
      lifecycle: 'goal',
    });
    expect(controller.snapshot()).toMatchObject({ activeCost: 1, activeOperations: 1, rejected: 1 });
  });

  it('releases weighted capacity after a successful managed bootstrap', async () => {
    const root = await pnpmWorktree();
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-dependency-shared-'));
    temporaryRoots.push(sharedCacheRoot);
    const controller = new ResourceAdmissionController({ globalCost: 2, workspaceCost: 2, maxOperations: 1 });
    const input: Parameters<typeof prepareManagedWorktreeDependencyBootstrap>[0] = {
      lifecycle: 'delegated' as const,
      rootPath: root,
      sharedCacheRoot,
      worktree: { isNew: true },
      admission: { controller, operationId: 'bootstrap-a', workspaceId: 'workspace-a', cost: 2 },
    };

    const result = await prepareManagedWorktreeDependencyBootstrap(input);

    expect(result.plan.status).toBe('ready');
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0, rejected: 0 });
  });

  it('releases weighted capacity when dependency probing errors', async () => {
    const root = await pnpmWorktree();
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-dependency-shared-'));
    temporaryRoots.push(sharedCacheRoot);
    const controller = new ResourceAdmissionController({ globalCost: 2, workspaceCost: 2, maxOperations: 1 });
    const input: Parameters<typeof prepareManagedWorktreeDependencyBootstrap>[0] = {
      lifecycle: 'goal' as const,
      rootPath: root,
      sharedCacheRoot,
      worktree: { isNew: true },
      fileSystem: {
        exists: async () => { throw new Error('probe failed'); },
        readText: async () => '',
        lstat: async () => ({ isSymbolicLink: () => false }),
        readLink: async () => '',
        ensureDirectory: async () => undefined,
        removePath: async () => undefined,
      },
      admission: { controller, operationId: 'bootstrap-error', workspaceId: 'workspace-a', cost: 2 },
    };

    await expect(prepareManagedWorktreeDependencyBootstrap(input)).rejects.toThrow('probe failed');
    expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0, rejected: 0 });
  });
  it('routes goal and delegated bootstrap through the same #34 policy without package-manager branching', async () => {
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-dependency-shared-'));
    temporaryRoots.push(sharedCacheRoot);
    const [goalRoot, delegatedRoot] = await Promise.all([pnpmWorktree(), pnpmWorktree()]);

    const [goal, delegated] = await Promise.all([
      prepareManagedWorktreeDependencyBootstrap({
        lifecycle: 'goal',
        rootPath: goalRoot,
        sharedCacheRoot,
        worktree: { isNew: true },
      }),
      prepareManagedWorktreeDependencyBootstrap({
        lifecycle: 'delegated',
        rootPath: delegatedRoot,
        sharedCacheRoot,
        worktree: { isNew: true },
      }),
    ]);

    expect(goal.lifecycle).toBe('goal');
    expect(delegated.lifecycle).toBe('delegated');
    expect(goal.plan.status).toBe('ready');
    expect(delegated.plan.status).toBe('ready');
    expect(goal.plan.strategy.commands).toEqual(delegated.plan.strategy.commands.map((command) => ({
      ...command,
      cwd: goalRoot,
    })));
    expect(goal.plan.strategy.sharedPaths).toEqual(delegated.plan.strategy.sharedPaths);
    expect(goal.plan.strategy.worktreeLocalPaths).toContain(path.join(goalRoot, 'node_modules'));
    expect(delegated.plan.strategy.worktreeLocalPaths).toContain(path.join(delegatedRoot, 'node_modules'));
  });

  it('keeps active lifecycle-owned mutable state blocked for both consumers', async () => {
    const root = await pnpmWorktree();
    const sharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-dependency-shared-'));
    temporaryRoots.push(sharedCacheRoot);

    for (const lifecycle of ['goal', 'delegated'] as const) {
      const result = await prepareManagedWorktreeDependencyBootstrap({
        lifecycle,
        rootPath: root,
        sharedCacheRoot,
        worktree: { active: true, processOwned: true },
      });
      expect(result.lifecycle).toBe(lifecycle);
      expect(result.plan.status).toBe('blocked');
      expect(result.plan.strategy.migration.mayReplaceMutableRuntimeState).toBe(false);
    }
  });
});
