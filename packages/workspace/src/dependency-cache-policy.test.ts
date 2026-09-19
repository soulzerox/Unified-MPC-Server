import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canPruneSharedDependencyStore,
  classifyExistingWorktree,
  cleanupWorktreeRuntime,
  evaluateDependencyMetadata,
  migrationStateFromStrategy,
  parseDependencyMigrationState,
  prepareDependencyBootstrap,
  resolveDependencyStrategy,
  serializeDependencyMigrationState,
  validateMutableRuntimeIsolation,
} from './dependency-cache-policy.js';

const temporaryRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function write(root: string, name: string, value: string): Promise<void> {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, value, 'utf8');
}

async function pnpmProject(version = '10.15.0'): Promise<string> {
  const root = await tempDir('unified-deps-pnpm-');
  await write(root, 'package.json', JSON.stringify({ name: 'fixture', packageManager: `pnpm@${version}` }));
  await write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('worktree dependency/cache policy', () => {
  it('shares pnpm package content while keeping node_modules local to each worktree', async () => {
    const shared = await tempDir('unified-deps-cache-');
    const leftRoot = await pnpmProject();
    const rightRoot = await pnpmProject();

    const [left, right] = await Promise.all([
      resolveDependencyStrategy({ rootPath: leftRoot, sharedCacheRoot: shared, worktree: { isNew: true } }),
      resolveDependencyStrategy({ rootPath: rightRoot, sharedCacheRoot: shared, worktree: { isNew: true } }),
    ]);

    expect(left.status).toBe('ready');
    expect(left.sharedPaths).toEqual(right.sharedPaths);
    expect(left.diagnostics.sharedStoreIdentity).toBe(right.diagnostics.sharedStoreIdentity);
    expect(left.diagnostics.localRuntimeIdentity).not.toBe(right.diagnostics.localRuntimeIdentity);
    expect(left.worktreeLocalPaths).toContain(path.join(leftRoot, 'node_modules'));
    expect(right.worktreeLocalPaths).toContain(path.join(rightRoot, 'node_modules'));
    expect(left.directCrossWorktreeMutableSymlinkAllowed).toBe(false);
    expect(left.commands).toEqual([
      expect.objectContaining({
        executable: 'corepack',
        phase: 'install',
        args: [
          'pnpm@10.15.0',
          'install',
          '--frozen-lockfile',
          '--prefer-offline',
          '--store-dir',
          path.join(shared, 'pnpm', 'store'),
        ],
      }),
    ]);
    expect(left.versionCheck?.expectedVersion).toBe('10.15.0');
  });

  it('keeps explicit dependency updates mutable and scoped to one worktree', async () => {
    const root = await pnpmProject();
    const shared = await tempDir('unified-deps-cache-');

    const strategy = await resolveDependencyStrategy({
      rootPath: root,
      sharedCacheRoot: shared,
      installMode: 'mutable',
      worktree: { isNew: true },
    });

    expect(strategy.installMode).toBe('mutable');
    expect(strategy.commands[0]?.args).not.toContain('--frozen-lockfile');
    expect(strategy.worktreeLocalPaths).toContain(path.join(root, 'node_modules'));
  });

  it('respects npm-pinned repositories instead of migrating them to pnpm', async () => {
    const root = await tempDir('unified-deps-npm-');
    const shared = await tempDir('unified-deps-cache-');
    await write(root, 'package.json', JSON.stringify({ name: 'fixture', packageManager: 'npm@11.6.0' }));
    await write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3 }));

    const strategy = await resolveDependencyStrategy({ rootPath: root, sharedCacheRoot: shared, worktree: { isNew: true } });

    expect(strategy.ecosystem).toBe('node-npm');
    expect(strategy.packageManager).toBe('npm');
    expect(strategy.packageManagerVersion).toBe('11.6.0');
    expect(strategy.commands[0]).toMatchObject({ executable: 'npm', args: ['ci', '--prefer-offline', '--cache', path.join(shared, 'npm', 'cache')] });
    expect(strategy.versionCheck).toEqual({ executable: 'npm', args: ['--version'], expectedVersion: '11.6.0' });
  });

  it('requires a Node lockfile in frozen mode but permits explicit mutable bootstrap', async () => {
    const root = await tempDir('unified-deps-node-no-lock-');
    const shared = await tempDir('unified-deps-cache-');
    await write(root, 'package.json', JSON.stringify({ name: 'fixture' }));

    const frozen = await resolveDependencyStrategy({ rootPath: root, sharedCacheRoot: shared, worktree: { isNew: true } });
    const mutable = await resolveDependencyStrategy({
      rootPath: root,
      sharedCacheRoot: shared,
      installMode: 'mutable',
      worktree: { isNew: true },
    });

    expect(frozen.status).toBe('blocked');
    expect(frozen.blockingReasons.join(' ')).toContain('requires its lockfile');
    expect(mutable.status).toBe('ready');
    expect(mutable.commands[0]?.args[0]).toBe('install');
  });

  it('fails closed when package-manager declaration and lockfiles disagree', async () => {
    const root = await pnpmProject();
    const shared = await tempDir('unified-deps-cache-');
    await write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3 }));

    const strategy = await resolveDependencyStrategy({ rootPath: root, sharedCacheRoot: shared, worktree: { isNew: true } });

    expect(strategy.status).toBe('blocked');
    expect(strategy.blockingReasons.join(' ')).toContain('Multiple package-manager lockfile families');
  });

  it('blocks frozen mode when a manifest changed without its lockfile', () => {
    expect(evaluateDependencyMetadata(
      { manifestDigest: 'new', lockfileDigest: 'same', packageManagerSpec: 'pnpm@10.15.0' },
      { manifestDigest: 'old', lockfileDigest: 'same', packageManagerSpec: 'pnpm@10.15.0' },
    )).toMatchObject({
      state: 'manifest_changed_lockfile_unchanged',
      compatibleWithFrozenMode: false,
      requiresRebootstrap: true,
    });
  });

  it('classifies brownfield worktrees conservatively', () => {
    expect(classifyExistingWorktree({ isNew: true }).disposition).toBe('adopt');
    expect(classifyExistingWorktree({ cleanInactive: true }).disposition).toBe('rebootstrap');
    expect(classifyExistingWorktree({}).disposition).toBe('grandfather');
    expect(classifyExistingWorktree({ dirty: true }).mayReplaceMutableRuntimeState).toBe(false);
    expect(classifyExistingWorktree({ active: true }).mayReplaceMutableRuntimeState).toBe(false);
    expect(classifyExistingWorktree({ processOwned: true }).mayReplaceMutableRuntimeState).toBe(false);
    expect(classifyExistingWorktree({ leased: true }).mayReplaceMutableRuntimeState).toBe(false);
  });

  it('shares uv download cache while isolating each virtual environment', async () => {
    const shared = await tempDir('unified-deps-cache-');
    const leftRoot = await tempDir('unified-deps-py-a-');
    const rightRoot = await tempDir('unified-deps-py-b-');
    for (const root of [leftRoot, rightRoot]) {
      await write(root, 'pyproject.toml', '[project]\nname="fixture"\nversion="0.1.0"\n');
      await write(root, 'uv.lock', 'version = 1\n');
    }

    const [left, right] = await Promise.all([
      resolveDependencyStrategy({ rootPath: leftRoot, sharedCacheRoot: shared, worktree: { isNew: true } }),
      resolveDependencyStrategy({ rootPath: rightRoot, sharedCacheRoot: shared, worktree: { isNew: true } }),
    ]);

    expect(left.ecosystem).toBe('python-uv');
    expect(left.sharedPaths).toEqual(right.sharedPaths);
    expect(left.worktreeLocalPaths).toContain(path.join(leftRoot, '.venv'));
    expect(right.worktreeLocalPaths).toContain(path.join(rightRoot, '.venv'));
    expect(left.commands[0]?.args).toContain('--frozen');
  });

  it('creates a worktree-local venv before pip installs into it', async () => {
    const root = await tempDir('unified-deps-pip-');
    const shared = await tempDir('unified-deps-cache-');
    await write(root, 'requirements.txt', 'example==1.0.0\n');

    const strategy = await resolveDependencyStrategy({ rootPath: root, sharedCacheRoot: shared, worktree: { isNew: true } });

    expect(strategy.ecosystem).toBe('python-pip');
    expect(strategy.commands[0]).toEqual({
      executable: 'python',
      args: ['-m', 'venv', path.join(root, '.venv')],
      cwd: root,
      environment: {},
      phase: 'setup',
    });
    expect(strategy.commands[1]?.executable).toContain(path.join(root, '.venv'));
    expect(strategy.sharedPaths).toContain(path.join(shared, 'python', 'pip'));
  });

  it('rejects mutable runtime roots symlinked into another worktree', async () => {
    const shared = await tempDir('unified-deps-cache-');
    const leftRoot = await pnpmProject();
    const rightRoot = await pnpmProject();
    await mkdir(path.join(rightRoot, 'node_modules'));
    await symlink(
      path.join(rightRoot, 'node_modules'),
      path.join(leftRoot, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const strategy = await resolveDependencyStrategy({ rootPath: leftRoot, sharedCacheRoot: shared, worktree: { isNew: true } });

    const isolation = await validateMutableRuntimeIsolation(strategy);

    expect(isolation.safe).toBe(false);
    expect(isolation.violations[0]?.target).toBe(path.join(rightRoot, 'node_modules'));
  });

  it('initializes the same shared cache directories idempotently under concurrency', async () => {
    const root = await pnpmProject();
    const shared = await tempDir('unified-deps-cache-');

    const results = await Promise.all(Array.from({ length: 8 }, async () => (
      prepareDependencyBootstrap({ rootPath: root, sharedCacheRoot: shared, worktree: { isNew: true } })
    )));

    expect(results.every((entry) => entry.status === 'ready')).toBe(true);
    await expect(access(path.join(shared, 'pnpm', 'store'))).resolves.toBeUndefined();
    expect(new Set(results.map((entry) => entry.strategy.diagnostics.sharedStoreIdentity)).size).toBe(1);
  });

  it('cleans only worktree-local runtime state and preserves shared stores', async () => {
    const root = await pnpmProject();
    const shared = await tempDir('unified-deps-cache-');
    const strategy = await resolveDependencyStrategy({ rootPath: root, sharedCacheRoot: shared, worktree: { isNew: true } });
    await mkdir(path.join(root, 'node_modules'));
    await mkdir(path.join(shared, 'pnpm', 'store'), { recursive: true });

    const unknown = await cleanupWorktreeRuntime({ strategy, execute: true });
    expect(unknown.status).toBe('deferred');
    const active = await cleanupWorktreeRuntime({ strategy, worktree: { active: true }, execute: true });
    expect(active.status).toBe('deferred');

    const cleaned = await cleanupWorktreeRuntime({
      strategy,
      worktree: { cleanInactive: true },
      execute: true,
    });
    expect(cleaned.status).toBe('completed');
    await expect(access(path.join(root, 'node_modules'))).rejects.toThrow();
    await expect(access(path.join(shared, 'pnpm', 'store'))).resolves.toBeUndefined();
  });

  it('blocks destructive shared-store pruning while references are active', () => {
    expect(canPruneSharedDependencyStore(2).allowed).toBe(false);
    expect(canPruneSharedDependencyStore(0).allowed).toBe(true);
    expect(canPruneSharedDependencyStore(-1).allowed).toBe(false);
  });

  it('serializes migration state deterministically across restart', async () => {
    const root = await pnpmProject();
    const shared = await tempDir('unified-deps-cache-');
    const strategy = await resolveDependencyStrategy({
      rootPath: root,
      sharedCacheRoot: shared,
      worktree: { dirty: true },
    });
    const state = migrationStateFromStrategy(strategy, 'grandfathered');

    const serialized = serializeDependencyMigrationState(state);

    expect(parseDependencyMigrationState(serialized)).toEqual(state);
    expect(parseDependencyMigrationState('{bad-json')).toBeUndefined();
    expect(parseDependencyMigrationState({ ...state, version: 999 })).toBeUndefined();
    expect(parseDependencyMigrationState({ ...state, manifestDigest: 42 })).toBeUndefined();
  });

  it('treats unknown ecosystems as unsupported instead of applying Node semantics', async () => {
    const root = await tempDir('unified-deps-unknown-');
    const shared = await tempDir('unified-deps-cache-');

    const strategy = await resolveDependencyStrategy({ rootPath: root, sharedCacheRoot: shared, worktree: { isNew: true } });

    expect(strategy.status).toBe('unsupported');
    expect(strategy.ecosystem).toBe('unknown');
    expect(strategy.commands).toEqual([]);
  });
});
