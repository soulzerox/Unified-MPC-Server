import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceService, type WorkspaceRepository } from './workspace-service.js';
import type { Workspace } from './workspace-types.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function repositorySpy(): WorkspaceRepository & { inserted: Workspace[] } {
  const inserted: Workspace[] = [];
  return {
    inserted,
    async list(): Promise<Workspace[]> { return [...inserted]; },
    async get(id: string): Promise<Workspace | null> { return inserted.find((workspace) => workspace.id === id) ?? null; },
    async insert(workspace: Workspace): Promise<void> { inserted.push(workspace); },
    async delete(id: string): Promise<void> { const index = inserted.findIndex((workspace) => workspace.id === id); if (index >= 0) inserted.splice(index, 1); },
  };
}

function lifecycleRepository(initial: readonly Workspace[]): WorkspaceRepository & { entries: Workspace[] } {
  const entries = [...initial];
  return {
    entries,
    async list(): Promise<Workspace[]> { return entries.filter((entry) => entry.archivedAt === undefined || entry.archivedAt === null); },
    async listAll(): Promise<Workspace[]> { return [...entries]; },
    async get(id: string): Promise<Workspace | null> {
      return entries.find((entry) => entry.id === id && (entry.archivedAt === undefined || entry.archivedAt === null)) ?? null;
    },
    async insert(workspace: Workspace): Promise<void> { entries.push(workspace); },
    async delete(id: string): Promise<void> {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) entries.splice(index, 1);
    },
    async archive(id: string, archivedAt: string = new Date().toISOString()): Promise<void> {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) entries[index] = { ...entries[index]!, archivedAt };
    },
    async setUnavailableSince(id: string, unavailableSince: string | null): Promise<void> {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) entries[index] = { ...entries[index]!, unavailableSince };
    },
  };
}

function archivalRepository(): WorkspaceRepository & { archived: Workspace[] } {
  const archived: Workspace[] = [];
  return {
    archived,
    async list(): Promise<Workspace[]> { return []; },
    async listAll(): Promise<Workspace[]> { return [...archived]; },
    async get(): Promise<Workspace | null> { return null; },
    async insert(workspace: Workspace): Promise<void> { archived.push(workspace); },
    async delete(): Promise<void> {},
    async archive(id: string): Promise<void> {
      const workspace = archived.find((entry) => entry.id === id);
      if (workspace !== undefined) archived[archived.indexOf(workspace)] = { ...workspace, archivedAt: '2026-08-24T00:00:00.000Z' };
    },
    async restore(id: string, workspace?: Workspace): Promise<void> {
      const index = archived.findIndex((entry) => entry.id === id);
      if (index >= 0 && workspace !== undefined) archived[index] = workspace;
    },
  };
}

describe('WorkspaceService', () => {
  it('stores the canonical realRootPath when adding a directory', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-service-'));
    temporaryRoots.push(parent);
    const rootPath = path.join(parent, 'project');
    await mkdir(rootPath);
    const repository = repositorySpy();
    const result = await new WorkspaceService(repository).add('Project', rootPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rootPath).toBe(path.resolve(rootPath));
      expect(result.value.realRootPath).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(rootPath)));
      expect(repository.inserted).toEqual([result.value]);
    }
  });

  it('rejects a nonexistent or file root without writing to the repository', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-service-'));
    temporaryRoots.push(parent);
    const filePath = path.join(parent, 'not-a-directory.txt');
    await writeFile(filePath, 'fixture', 'utf8');
    const repository = repositorySpy();
    const service = new WorkspaceService(repository);

    const missing = await service.add('Missing', path.join(parent, 'missing'));
    const file = await service.add('File', filePath);

    expect(missing).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    expect(file).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(repository.inserted).toEqual([]);
  });

  it('rejects POSIX mount roots and foreign persisted paths before touching the repository', async () => {
    const repository = repositorySpy();
    const service = new WorkspaceService(repository, { platform: 'linux' });

    await expect(service.add('Root', '/')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await expect(service.add('Windows path', 'C:\\Users\\alice\\project')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(repository.inserted).toEqual([]);
  });

  it('unregisters a workspace without deleting its source directory', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-service-remove-'));
    temporaryRoots.push(parent);
    const rootPath = path.join(parent, 'project');
    await mkdir(rootPath);
    await writeFile(path.join(rootPath, 'keep.txt'), 'keep source files', 'utf8');
    const repository = repositorySpy();
    const service = new WorkspaceService(repository);
    const added = await service.add('Project', rootPath);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    await service.delete(added.value.id);

    expect(repository.inserted).toEqual([]);
    await expect(import('node:fs/promises').then(({ stat }) => stat(rootPath))).resolves.toMatchObject({});
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(path.join(rootPath, 'keep.txt'), 'utf8'))).resolves.toBe('keep source files');
  });

  it('restores the archived identity when the canonical source path is registered again', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-service-relink-'));
    temporaryRoots.push(parent);
    const rootPath = path.join(parent, 'project');
    await mkdir(rootPath);
    const repository = archivalRepository();
    const initial: Workspace = {
      id: 'workspace-relinked',
      displayName: 'Original',
      rootPath,
      realRootPath: rootPath,
      createdAt: new Date(0).toISOString(),
      archivedAt: '2026-08-24T00:00:00.000Z',
    };
    repository.archived.push(initial);

    const result = await new WorkspaceService(repository).add('Reconnected', rootPath);

    expect(result).toMatchObject({ ok: true, value: { id: initial.id, displayName: 'Reconnected' } });
    expect(repository.archived).toEqual([expect.objectContaining({ id: initial.id, displayName: 'Reconnected' })]);
  });

  it('marks a missing persistent project unavailable without auto-archiving it', async () => {
    const missingRoot = path.join(os.tmpdir(), 'unified-mpc-missing-persistent-project');
    const repository = lifecycleRepository([{
      id: 'persistent',
      displayName: 'Persistent',
      rootPath: missingRoot,
      realRootPath: missingRoot,
      createdAt: new Date(0).toISOString(),
    }]);
    const now = new Date('2026-09-22T12:00:00.000Z');
    const result = await new WorkspaceService(repository, { now: () => now }).reconcileLifecycle();

    expect(result).toEqual({
      ok: true,
      value: {
        inspected: 1,
        archivedWorkspaceIds: [],
        unavailableWorkspaceIds: ['persistent'],
        skippedProtectedWorkspaceIds: [],
      },
    });
    expect(repository.entries[0]).toMatchObject({ id: 'persistent', unavailableSince: now.toISOString() });
    expect(repository.entries[0]?.archivedAt).toBeUndefined();
  });

  it('archives a missing auto-cleanup temporary workspace but protects an active reference', async () => {
    const missingA = path.join(os.tmpdir(), 'unified-mpc-missing-temp-a');
    const missingB = path.join(os.tmpdir(), 'unified-mpc-missing-temp-b');
    const repository = lifecycleRepository([
      {
        id: 'temporary-a',
        displayName: 'Temporary A',
        rootPath: missingA,
        realRootPath: missingA,
        createdAt: new Date(0).toISOString(),
        lifecycleKind: 'temporary',
        autoCleanup: true,
      },
      {
        id: 'temporary-b',
        displayName: 'Temporary B',
        rootPath: missingB,
        realRootPath: missingB,
        createdAt: new Date(0).toISOString(),
        lifecycleKind: 'temporary',
        autoCleanup: true,
      },
    ]);
    const service = new WorkspaceService(repository, { now: () => new Date('2026-09-22T12:00:00.000Z') });
    const first = await service.reconcileLifecycle({ protectedWorkspaceIds: ['temporary-b'] });
    const second = await service.reconcileLifecycle({ protectedWorkspaceIds: ['temporary-b'] });

    expect(first).toMatchObject({
      ok: true,
      value: {
        archivedWorkspaceIds: ['temporary-a'],
        unavailableWorkspaceIds: ['temporary-b'],
        skippedProtectedWorkspaceIds: ['temporary-b'],
      },
    });
    expect(second).toMatchObject({ ok: true, value: { archivedWorkspaceIds: [] } });
    expect(repository.entries.find((entry) => entry.id === 'temporary-a')?.archivedAt).toBe('2026-09-22T12:00:00.000Z');
    expect(repository.entries.find((entry) => entry.id === 'temporary-b')?.archivedAt).toBeUndefined();
  });

  it('archives an expired inspection workspace without deleting its directory', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-expired-inspection-'));
    temporaryRoots.push(rootPath);
    await writeFile(path.join(rootPath, 'keep.txt'), 'keep', 'utf8');
    const repository = lifecycleRepository([{
      id: 'inspection',
      displayName: 'Inspection',
      rootPath,
      realRootPath: await realpath(rootPath),
      createdAt: new Date(0).toISOString(),
      lifecycleKind: 'inspection',
      autoCleanup: true,
      expiresAt: '2026-09-22T11:00:00.000Z',
    }]);

    const result = await new WorkspaceService(repository, { now: () => new Date('2026-09-22T12:00:00.000Z') }).reconcileLifecycle();

    expect(result).toMatchObject({ ok: true, value: { archivedWorkspaceIds: ['inspection'] } });
    await expect(readFile(path.join(rootPath, 'keep.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('relinks an archived transient identity as a persistent project by default', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-relink-transient-'));
    temporaryRoots.push(rootPath);
    const repository = archivalRepository();
    repository.archived.push({
      id: 'transient-old',
      displayName: 'Old inspection',
      rootPath,
      realRootPath: await realpath(rootPath),
      createdAt: new Date(0).toISOString(),
      lifecycleKind: 'inspection',
      autoCleanup: true,
      expiresAt: '2026-09-01T00:00:00.000Z',
      archivedAt: '2026-09-02T00:00:00.000Z',
    });
    const result = await new WorkspaceService(repository).add('Restored project', rootPath);
    expect(result).toMatchObject({ ok: true, value: { id: 'transient-old', displayName: 'Restored project' } });
    if (result.ok) {
      expect(result.value.lifecycleKind).toBeUndefined();
      expect(result.value.autoCleanup).toBeUndefined();
      expect(result.value.expiresAt).toBeUndefined();
    }
  });

  it('rejects auto-cleanup for persistent project registrations', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-persistent-autocleanup-'));
    temporaryRoots.push(rootPath);
    const result = await new WorkspaceService(repositorySpy()).add('Project', rootPath, { autoCleanup: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('fails closed when multiple archived identities match the canonical source path', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-service-ambiguous-relink-'));
    temporaryRoots.push(parent);
    const rootPath = path.join(parent, 'project');
    await mkdir(rootPath);
    const repository = archivalRepository();
    repository.archived.push(
      { id: 'workspace-old-a', displayName: 'Old A', rootPath, realRootPath: rootPath, createdAt: new Date(0).toISOString(), archivedAt: '2026-08-24T00:00:00.000Z' },
      { id: 'workspace-old-b', displayName: 'Old B', rootPath, realRootPath: rootPath, createdAt: new Date(1).toISOString(), archivedAt: '2026-08-25T00:00:00.000Z' },
    );

    await expect(new WorkspaceService(repository).add('Reconnected', rootPath))
      .resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(repository.archived).toHaveLength(2);
  });
});
