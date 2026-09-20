import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRuntimeVersion,
  resolveDependencyResourcePlan,
  supportsPnpmGlobalVirtualStore,
  supportsUvCentralizedProjectEnvs,
} from './dependency-resource-manager.js';

describe('dependency resource manager', () => {
  it('uses pnpm global virtual-store semantics for the pinned 10.15 runtime', () => {
    const plan = resolveDependencyResourcePlan({
      rootPath: '/worktrees/a',
      sharedCacheRoot: '/shared',
      ecosystem: 'node-pnpm',
      packageManager: 'pnpm',
      packageManagerVersion: '10.15.0',
      manifestDigest: 'manifest',
      lockfileDigest: 'lock',
      migrationDisposition: 'adopt',
    });

    expect(plan).toMatchObject({
      runtimeView: 'global_virtual_store',
      linkMode: 'symlink',
      migrationPhase: 'preparing_shared_runtime',
      enforced: true,
      managerArguments: ['--config.enable-global-virtual-store=true'],
    });
    expect(plan.resourcePoolPath).toBe(path.resolve('/shared/pnpm/store/links'));
    expect(plan.fallbackReason).toBeUndefined();
  });

  it('falls back truthfully before pnpm global virtual-store support', () => {
    const plan = resolveDependencyResourcePlan({
      rootPath: '/worktrees/a',
      sharedCacheRoot: '/shared',
      ecosystem: 'node-pnpm',
      packageManager: 'pnpm',
      packageManagerVersion: '10.11.0',
      migrationDisposition: 'adopt',
    });

    expect(plan.runtimeView).toBe('local');
    expect(plan.linkMode).toBe('local');
    expect(plan.managerArguments).toEqual([]);
    expect(plan.fallbackReason).toContain('10.12.1');
    expect(supportsPnpmGlobalVirtualStore('10.12.1')).toBe(true);
    expect(supportsPnpmGlobalVirtualStore('10.11.9')).toBe(false);
  });

  it('reuses compatibility identity across worktrees with the same dependency graph', () => {
    const base = {
      sharedCacheRoot: '/shared',
      ecosystem: 'node-pnpm',
      packageManager: 'pnpm',
      packageManagerVersion: '10.15.0',
      manifestDigest: 'same-manifest',
      lockfileDigest: 'same-lock',
      migrationDisposition: 'adopt' as const,
    };
    const left = resolveDependencyResourcePlan({ ...base, rootPath: '/worktrees/a' });
    const right = resolveDependencyResourcePlan({ ...base, rootPath: '/other-drive/worktrees/b' });

    expect(left.compatibilityIdentity).toBe(right.compatibilityIdentity);
    expect(left.resourcePoolId).toBe(right.resourcePoolId);
  });

  it('uses uv centralized project environments only after runtime support is proven', () => {
    const supported = resolveDependencyResourcePlan({
      rootPath: '/worktrees/a',
      sharedCacheRoot: '/shared',
      ecosystem: 'python-uv',
      packageManager: 'uv',
      runtimeVersion: '0.11.25',
      migrationDisposition: 'rebootstrap',
    });
    const old = resolveDependencyResourcePlan({
      rootPath: '/worktrees/b',
      sharedCacheRoot: '/shared',
      ecosystem: 'python-uv',
      packageManager: 'uv',
      runtimeVersion: '0.11.24',
      migrationDisposition: 'grandfather',
    });

    expect(supported).toMatchObject({
      runtimeView: 'centralized_env',
      linkMode: 'symlink',
      migrationPhase: 'migration_pending',
      environment: { UV_PREVIEW_FEATURES: 'centralized-project-envs' },
    });
    expect(old).toMatchObject({
      runtimeView: 'local',
      linkMode: 'local',
      migrationPhase: 'waiting_for_idle',
    });
    expect(supportsUvCentralizedProjectEnvs('0.11.25')).toBe(true);
    expect(supportsUvCentralizedProjectEnvs('0.11.24')).toBe(false);
  });

  it('parses package-manager version output without accepting unrelated text', () => {
    expect(parseRuntimeVersion('uv 0.11.25 (abc123)\n', 'uv')).toBe('0.11.25');
    expect(parseRuntimeVersion('10.15.0\n', 'pnpm')).toBe('10.15.0');
    expect(parseRuntimeVersion('not-a-version', 'uv')).toBeUndefined();
  });
});
