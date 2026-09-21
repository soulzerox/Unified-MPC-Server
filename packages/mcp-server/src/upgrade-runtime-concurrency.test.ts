import { access, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import type { FileActor } from '@unified-mpc/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import { UpgradeRuntimeStateStore } from './upgrade-runtime-state-store.js';

const actorA: FileActor = { clientId: 'client', clientName: 'test', sessionId: 'session-a' };
const actorB: FileActor = { clientId: 'client', clientName: 'test', sessionId: 'session-b' };

describe('upgrade runtime multi-session persistence', () => {
  it('merges concurrent checkpoints for the same session while isolating another session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-concurrency-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const first = new UpgradeRuntimeService({ runtimeStatePath }, actorA);
    const second = new UpgradeRuntimeService({ runtimeStatePath }, actorA);

    await Promise.all([
      first.execute('session_checkpoint', { summary: 'checkpoint-a' }),
      second.execute('session_checkpoint', { summary: 'checkpoint-b' }),
    ]);

    const resumed = await new UpgradeRuntimeService({ runtimeStatePath }, actorA).execute('session_history', {});
    expect(resumed).toMatchObject({ ok: true, value: { checkpoints: expect.arrayContaining([
      expect.objectContaining({ summary: 'checkpoint-a' }),
      expect.objectContaining({ summary: 'checkpoint-b' }),
    ]) } });
    if (resumed.ok) expect(resumed.value.checkpoints).toHaveLength(2);

    const isolated = await new UpgradeRuntimeService({ runtimeStatePath }, actorB).execute('session_context', {});
    expect(isolated).toMatchObject({ ok: true, value: { session: {}, checkpoints: [] } });
  });

  it('merges global plugin mutations from independent sessions through locked shared state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-concurrency-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const first = new UpgradeRuntimeService({ runtimeStatePath }, actorA);
    const second = new UpgradeRuntimeService({ runtimeStatePath }, actorB);

    const results = await Promise.all([
      first.execute('plugin_install', { name: 'plugin-a' }),
      second.execute('plugin_install', { name: 'plugin-b' }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 'ready', executed: true, persistence: 'shared_locked_state', name: 'plugin-a' }) }),
      expect.objectContaining({ ok: true, value: expect.objectContaining({ status: 'ready', executed: true, persistence: 'shared_locked_state', name: 'plugin-b' }) }),
    ]);
    const shared = await new UpgradeRuntimeStateStore(runtimeStatePath, 'audit').readShared();
    expect(shared.plugins).toHaveLength(2);
    expect(shared.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'plugin-a', enabled: true, trustTier: 'external', namespace: 'plugin:plugin-a' }),
      expect.objectContaining({ name: 'plugin-b', enabled: true, trustTier: 'external', namespace: 'plugin:plugin-b' }),
    ]));
  });

  it('bootstraps a new npm worktree through the shared cache without network dependencies', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-deps-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const worktreeRoot = path.join(directory, '.worktrees', 'bootstrap');
    await mkdir(worktreeRoot, { recursive: true });
    await writeFile(path.join(worktreeRoot, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
    }), 'utf8');
    await writeFile(path.join(worktreeRoot, 'package-lock.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
      },
    }), 'utf8');

    const services = {
      runtimeStatePath,
      workspaceInfo: {
        async info(): Promise<ReturnType<typeof ok>> {
          return ok({
            id: 'ws-deps',
            displayName: 'fixture',
            rootPath: directory,
            realRootPath: directory,
            createdAt: new Date(0).toISOString(),
            kind: 'project',
          });
        },
      },
      git: {
        async run(): Promise<ReturnType<typeof ok>> {
          return ok({ exitCode: 0, stdout: 'ok', stderr: '' });
        },
      },
    };

    try {
      const result = await new UpgradeRuntimeService(services, actorA).execute('git_worktree_spawn', {
        workspaceId: 'ws-deps',
        worktreePath: '.worktrees/bootstrap',
        ref: 'main',
        dryRun: false,
        userConfirmed: true,
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          dependencyPolicy: {
            status: 'ready',
            packageManager: 'npm',
            lastBootstrapResult: 'installed',
            integration: 'dependency_resource_manager_v1',
            migrationPhase: 'migrated',
          },
        },
      });
      await expect(access(path.join(directory, 'dependency-cache', 'npm', 'cache'))).resolves.toBeUndefined();
      const shared = await new UpgradeRuntimeStateStore(runtimeStatePath, 'audit-deps').readShared();
      expect(shared.worktrees).toEqual(expect.arrayContaining([
        expect.objectContaining({
          worktreePath: '.worktrees/bootstrap',
          dependencyPolicy: expect.objectContaining({
            status: 'ready',
            packageManager: 'npm',
            lastBootstrapResult: 'installed',
          }),
        }),
      ]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps shared worktree ledger entries session-owned', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-concurrency-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const calls: unknown[] = [];
    const services = {
      runtimeStatePath,
      runtimeDeploymentReferenceOptions: {
        runtimeDir: path.join(directory, 'runtime'),
        deploymentStateDir: path.join(directory, 'deployments'),
        homeDir: directory,
        env: {},
      },
      workspaceInfo: {
        async info(): Promise<ReturnType<typeof ok>> {
          return ok({ rootPath: directory, realRootPath: directory });
        },
      },
      git: {
        async run(_actor: FileActor, request: unknown): Promise<ReturnType<typeof ok>> {
          calls.push(request);
          return ok({ exitCode: 0, stdout: 'ok', stderr: '' });
        },
      },
    };
    const first = new UpgradeRuntimeService(services, actorA);
    const second = new UpgradeRuntimeService(services, actorB);
    const [spawnA, spawnB] = await Promise.all([
      first.execute('git_worktree_spawn', {
        workspaceId: 'ws-1', worktreePath: '.worktrees/session-a', ref: 'main', dryRun: false, userConfirmed: true,
      }),
      second.execute('git_worktree_spawn', {
        workspaceId: 'ws-1', worktreePath: '.worktrees/session-b', ref: 'main', dryRun: false, userConfirmed: true,
      }),
    ]);
    expect(spawnA).toMatchObject({ ok: true, value: { status: 'completed', ownerSessionId: 'session-a' } });
    expect(spawnB).toMatchObject({ ok: true, value: { status: 'completed', ownerSessionId: 'session-b' } });

    const other = new UpgradeRuntimeService(services, actorB);
    await expect(other.execute('git_worktree_remove', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/session-a', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toHaveLength(2);

    await expect(new UpgradeRuntimeService(services, actorA).execute('git_worktree_remove', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/session-a', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    await expect(new UpgradeRuntimeService(services, actorB).execute('git_worktree_remove', {
      workspaceId: 'ws-1', worktreePath: '.worktrees/session-b', dryRun: false, userConfirmed: true,
    })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(calls).toHaveLength(4);
  });

  it('blocks runtime-referenced worktree cleanup across runtime restart until the reference is removed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-reference-fence-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const runtimeDir = path.join(directory, 'runtime');
    const deploymentStateDir = path.join(directory, 'deployments');
    const worktreePath = path.join(directory, '.worktrees', 'runtime-bound');
    const calls: unknown[] = [];
    await mkdir(worktreePath, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await symlink(worktreePath, path.join(runtimeDir, 'current'));

    const services = {
      runtimeStatePath,
      runtimeDeploymentReferenceOptions: {
        runtimeDir,
        deploymentStateDir,
        homeDir: directory,
        env: {},
      },
      workspaceInfo: {
        async info(): Promise<ReturnType<typeof ok>> {
          return ok({ rootPath: directory, realRootPath: directory });
        },
      },
      git: {
        async run(_actor: FileActor, request: unknown): Promise<ReturnType<typeof ok>> {
          calls.push(request);
          return ok({ exitCode: 0, stdout: 'ok', stderr: '' });
        },
      },
    };

    try {
      const owner = new UpgradeRuntimeService(services, actorA);
      await expect(owner.execute('git_worktree_spawn', {
        workspaceId: 'ws-runtime',
        worktreePath: '.worktrees/runtime-bound',
        ref: 'main',
        bootstrapDependencies: false,
        dependencyEmergencyOverride: true,
        dryRun: false,
        userConfirmed: true,
      })).resolves.toMatchObject({ ok: true, value: { status: 'completed' } });
      expect(calls).toHaveLength(1);

      await expect(owner.execute('git_worktree_remove', {
        workspaceId: 'ws-runtime',
        worktreePath: '.worktrees/runtime-bound',
      })).resolves.toMatchObject({
        ok: true,
        value: {
          dryRun: true,
          cleanupBlocker: {
            blocked: true,
            reason: 'active_runtime_reference',
            references: [expect.objectContaining({ kind: 'current', path: worktreePath })],
          },
        },
      });

      await expect(owner.execute('git_worktree_remove', {
        workspaceId: 'ws-runtime',
        worktreePath: '.worktrees/runtime-bound',
        dryRun: false,
        userConfirmed: true,
      })).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONFLICT', message: expect.stringContaining('active_runtime_reference') },
      });
      expect(calls).toHaveLength(1);

      const restarted = new UpgradeRuntimeService(services, actorA);
      await expect(restarted.execute('git_worktree_remove', {
        workspaceId: 'ws-runtime',
        worktreePath: '.worktrees/runtime-bound',
        dryRun: false,
        userConfirmed: true,
      })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(calls).toHaveLength(1);

      await unlink(path.join(runtimeDir, 'current'));
      await expect(restarted.execute('git_worktree_remove', {
        workspaceId: 'ws-runtime',
        worktreePath: '.worktrees/runtime-bound',
        dryRun: false,
        userConfirmed: true,
      })).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'completed',
          cleanupBlocker: { blocked: false, reason: null },
        },
      });
      expect(calls).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('grandfathers legacy worktree ledger rows after restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-legacy-worktree-'));
    const runtimeStatePath = path.join(directory, 'upgrade-runtime.json');
    const store = new UpgradeRuntimeStateStore(runtimeStatePath, 'seed');
    await store.updateShared((current) => ({
      plugins: current.plugins,
      worktrees: [{
        workspaceId: 'ws-legacy',
        worktreePath: '.worktrees/legacy',
        ref: 'main',
        owner: actorA.clientId,
        ownerSessionId: actorA.sessionId,
        createdAt: new Date(0).toISOString(),
      }],
    }));

    try {
      const runtime = new UpgradeRuntimeService({ runtimeStatePath }, actorA);
      await expect(runtime.execute('git_worktree_remove', {
        workspaceId: 'ws-legacy',
        worktreePath: '.worktrees/legacy',
      })).resolves.toMatchObject({
        ok: true,
        value: {
          dryRun: true,
          dependencyPolicy: {
            policyVersion: 1,
            disposition: 'grandfather',
            status: 'grandfathered',
            lastBootstrapResult: 'skipped',
          },
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
