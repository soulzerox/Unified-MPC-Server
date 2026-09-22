import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace } from '@unified-mpc/workspace';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteWorkspaceRepository', () => {
  it('round-trips workspaces through the initial schema', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.db'));
    const repository = new SqliteWorkspaceRepository(database);
    const workspace: Workspace = {
      id: 'workspace-1',
      displayName: 'Fixture',
      rootPath: 'C:\\workspace',
      realRootPath: 'C:\\workspace',
      createdAt: new Date(0).toISOString(),
    };

    await repository.insert(workspace);

    await expect(repository.get(workspace.id)).resolves.toEqual(workspace);
    await expect(repository.list()).resolves.toEqual([workspace]);
    await repository.delete(workspace.id);
    await expect(repository.get(workspace.id)).resolves.toBeNull();
    database.close();
  });

  it('round-trips lifecycle metadata while legacy project defaults remain conservative', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-lifecycle-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    try {
      const repository = new SqliteWorkspaceRepository(database);
      const temporary: Workspace = {
        id: 'workspace-temporary',
        displayName: 'Temporary',
        rootPath: root,
        realRootPath: root,
        createdAt: new Date(0).toISOString(),
        lifecycleKind: 'temporary',
        ownerSessionId: 'session-1',
        ownerJobId: 'job-1',
        autoCleanup: true,
        expiresAt: '2026-09-22T13:00:00.000Z',
        unavailableSince: '2026-09-22T12:00:00.000Z',
      };
      await repository.insert(temporary);
      await expect(repository.get(temporary.id)).resolves.toEqual(temporary);

      database.connection.prepare(
        'INSERT INTO workspaces (id, display_name, root_path, real_root_path, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('legacy', 'Legacy', '/legacy', '/legacy', new Date(0).toISOString(), null);
      await expect(repository.get('legacy')).resolves.toEqual({
        id: 'legacy',
        displayName: 'Legacy',
        rootPath: '/legacy',
        realRootPath: '/legacy',
        createdAt: new Date(0).toISOString(),
      });
    } finally {
      database.close();
    }
  });

  it('round-trips durable Goal Workspace ownership and source metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-workspace-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    try {
      const repository = new SqliteWorkspaceRepository(database);
      const goalWorkspace: Workspace = {
        id: 'goal-workspace-1',
        displayName: 'Goal workspace',
        rootPath: root,
        realRootPath: root,
        createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal',
        goalId: 'goal-1',
        parentWorkspaceId: 'project-1',
        goalWorkspaceKind: 'git_worktree',
        parentSource: 'committed_head',
        baseRevision: 'abc123',
        branchName: 'goal/goal-1',
        checkpointId: 'checkpoint-1',
        integrationState: 'pending',
      };

      await repository.insert(goalWorkspace);

      await expect(repository.get(goalWorkspace.id)).resolves.toEqual(goalWorkspace);
      await expect(repository.list()).resolves.toEqual([goalWorkspace]);
    } finally {
      database.close();
    }
  });

  it('archives registrations outside the runtime view and restores them without deleting project data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-workspace-archive-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    try {
      const repository = new SqliteWorkspaceRepository(database);
      const workspace = { id: 'workspace-archived', displayName: 'Archived', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString() };
      await repository.insert(workspace);
      await repository.archive(workspace.id, '2026-08-24T00:00:00.000Z');

      await expect(repository.list()).resolves.toEqual([]);
      await expect(repository.get(workspace.id)).resolves.toBeNull();
      await expect(repository.getAny(workspace.id)).resolves.toMatchObject({ id: workspace.id, archivedAt: '2026-08-24T00:00:00.000Z' });
      await expect(repository.listAll()).resolves.toEqual([expect.objectContaining({ id: workspace.id, archivedAt: '2026-08-24T00:00:00.000Z' })]);

      await repository.restore(workspace.id);
      await expect(repository.get(workspace.id)).resolves.toMatchObject({ id: workspace.id });
      expect((await repository.getAny(workspace.id))?.archivedAt).toBeUndefined();

      await repository.archive(workspace.id, '2026-08-25T00:00:00.000Z');
      await repository.restore(workspace.id, {
        ...workspace,
        displayName: 'Relinked',
        rootPath: `${root}/alias`,
        realRootPath: root,
      });
      await expect(repository.get(workspace.id)).resolves.toMatchObject({
        id: workspace.id,
        displayName: 'Relinked',
        realRootPath: root,
      });
    } finally {
      database.close();
    }
  });

});
