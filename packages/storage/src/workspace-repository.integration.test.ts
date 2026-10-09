import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceAdmissionReceipt, WorkspaceBaseRebaseReceipt } from '@unified-mpc/domain';
import type { Workspace } from '@unified-mpc/workspace';
import { SqliteDatabase } from './database.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteWorkspaceRepository', () => {
  it('commits a durable authority generation for independent connections, direct SQL and unregister/relink replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'authority-crossprocess-db-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'state.sqlite');
    const first = new SqliteDatabase(filename);
    const second = new SqliteDatabase(filename);
    try {
      const reader = new SqliteWorkspaceRepository(first);
      const writer = new SqliteWorkspaceRepository(second);
      const workspace: Workspace = {
        id: 'crossprocess', displayName: 'Crossprocess', rootPath: '/tmp/crossprocess',
        realRootPath: '/tmp/crossprocess', createdAt: new Date(0).toISOString(),
      };
      const initial = reader.readAuthorityGeneration();
      expect(initial).toBeGreaterThan(0);
      await writer.insert(workspace);
      expect(reader.readAuthorityGeneration()).toBe(initial + 1);
      second.connection.prepare('UPDATE workspaces SET display_name = ? WHERE id = ?').run('Renamed elsewhere', workspace.id);
      expect(reader.readAuthorityGeneration()).toBe(initial + 2);
      second.connection.exec('BEGIN IMMEDIATE;');
      second.connection.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run('2026-10-09T00:00:00.000Z', workspace.id);
      expect(reader.readAuthorityGeneration()).toBe(initial + 2);
      second.connection.exec('ROLLBACK;');
      expect(reader.readAuthorityGeneration()).toBe(initial + 2);
      await writer.archive(workspace.id);
      await writer.restore(workspace.id);
      expect(reader.readAuthorityGeneration()).toBe(initial + 4);
    } finally { second.close(); first.close(); }
  });

  it('fences live worker authority before insert, archive, restore and delete write boundaries', async () => {
    const database = new SqliteDatabase(':memory:');
    const snapshots: string[] = [];
    const ws: Workspace = {
      id: 'authority-event-ws', displayName: 'Authority event', rootPath: '/tmp/authority-event',
      realRootPath: '/tmp/authority-event', createdAt: new Date(0).toISOString(),
    };
    const repository = new SqliteWorkspaceRepository(database, {
      onBeforeAuthorityMutation: (): void => {
        const state = database.connection.prepare('SELECT archived_at FROM workspaces WHERE id = ?')
          .get(ws.id) as { archived_at: string | null } | undefined;
        snapshots.push(state === undefined ? 'missing' : state.archived_at === null ? 'active' : 'archived');
      },
    });
    try {
      await repository.insert(ws);
      await repository.archive(ws.id);
      await repository.restore(ws.id);
      await repository.delete(ws.id);
      expect(snapshots).toEqual(['missing', 'active', 'archived', 'active']);
    } finally { database.close(); }
  });

  it('fails closed without changing registration when the trusted revocation publisher fails', async () => {
    const database = new SqliteDatabase(':memory:');
    const ws: Workspace = {
      id: 'authority-denied-ws', displayName: 'Authority denied', rootPath: '/tmp/authority-denied',
      realRootPath: '/tmp/authority-denied', createdAt: new Date(0).toISOString(),
    };
    try {
      await new SqliteWorkspaceRepository(database).insert(ws);
      const repository = new SqliteWorkspaceRepository(database, {
        onBeforeAuthorityMutation: (): void => { throw new Error('trusted_authority_event_unavailable'); },
      });
      await expect(repository.archive(ws.id)).rejects.toThrow('trusted_authority_event_unavailable');
      await expect(repository.get(ws.id)).resolves.toEqual(ws);
      await expect(repository.delete(ws.id)).rejects.toThrow('trusted_authority_event_unavailable');
      await expect(repository.get(ws.id)).resolves.toEqual(ws);
    } finally { database.close(); }
  });

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
        baseRef: 'origin/main',
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

  it('round-trips snapshot provenance and fences writer lease generations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-snapshot-lease-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    try {
      const repository = new SqliteWorkspaceRepository(database);
      const workspace: Workspace = {
        id: 'goal-snapshot-1', displayName: 'Snapshot goal', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-snapshot', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'snapshot',
        parentSource: 'snapshot', baseRevision: 'source-v1', integrationState: 'pending',
      };
      await repository.insert(workspace);
      await expect(repository.get(workspace.id)).resolves.toEqual(workspace);

      const first = await repository.acquireGoalWriterLease(workspace.id, 'lease-a', 'client-a', '2026-09-22T19:00:00.000Z', '2026-09-22T19:00:01.000Z');
      expect(first).toEqual({ leaseId: 'lease-a', ownerId: 'client-a', generation: 1, expiresAt: '2026-09-22T19:00:01.000Z' });
      await expect(repository.acquireGoalWriterLease(workspace.id, 'lease-b', 'client-b', '2026-09-22T19:00:00.500Z', '2026-09-22T19:00:02.000Z')).resolves.toBeNull();
      await expect(repository.renewGoalWriterLease(workspace.id, 'lease-a', 0, '2026-09-22T19:00:00.500Z', '2026-09-22T19:00:02.000Z')).resolves.toBe(false);
      await expect(repository.acquireGoalWriterLease(workspace.id, 'lease-b', 'client-b', '2026-09-22T19:00:01.001Z', '2026-09-22T19:00:02.000Z')).resolves.toMatchObject({ generation: 2 });
    } finally {
      database.close();
    }
  });

  it('synchronizes Goal Workspace writer ownership to the durable goal lease generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-writer-sync-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    try {
      const repository = new SqliteWorkspaceRepository(database);
      const workspace: Workspace = {
        id: 'goal-workspace-sync-1',
        displayName: 'Goal sync',
        rootPath: root,
        realRootPath: root,
        createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal',
        goalId: 'goal-sync-1',
        parentWorkspaceId: 'project-1',
        goalWorkspaceKind: 'git_worktree',
        parentSource: 'committed_head',
        baseRevision: 'a'.repeat(40),
        branchName: 'goal/goal-sync-1',
        integrationState: 'pending',
      };
      await repository.insert(workspace);

      await expect(repository.synchronizeGoalWriterLease(
        workspace.id, workspace.goalId!, 'lease-1', 'client-a:session-a', 1,
        '2026-09-22T19:10:00.000Z', '2026-09-22T19:00:00.000Z',
      )).resolves.toEqual({
        leaseId: 'lease-1', ownerId: 'client-a:session-a', generation: 1, expiresAt: '2026-09-22T19:10:00.000Z',
      });

      await expect(repository.synchronizeGoalWriterLease(
        workspace.id, workspace.goalId!, 'lease-2', 'client-b:session-b', 2,
        '2026-09-22T19:20:00.000Z', '2026-09-22T19:01:00.000Z',
      )).resolves.toMatchObject({ leaseId: 'lease-2', ownerId: 'client-b:session-b', generation: 2 });

      await expect(repository.synchronizeGoalWriterLease(
        workspace.id, workspace.goalId!, 'lease-stale', 'client-a:session-a', 1,
        '2026-09-22T19:30:00.000Z', '2026-09-22T19:02:00.000Z',
      )).resolves.toBeNull();
      await expect(repository.synchronizeGoalWriterLease(
        workspace.id, 'another-goal', 'lease-3', 'client-c:session-c', 3,
        '2026-09-22T19:30:00.000Z', '2026-09-22T19:02:00.000Z',
      )).resolves.toBeNull();
      await expect(repository.get(workspace.id)).resolves.toMatchObject({
        writerLease: { leaseId: 'lease-2', ownerId: 'client-b:session-b', generation: 2 },
      });
    } finally {
      database.close();
    }
  });

  it('persists admission receipts and compare-and-swaps only with the expected admission and writer lease generations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-workspace-admission-db-'));
    temporaryRoots.push(root);
    const databasePath = path.join(root, 'state.sqlite');
    let database = new SqliteDatabase(databasePath);
    try {
      let repository = new SqliteWorkspaceRepository(database);
      const workspace: Workspace = {
        id: 'admission-workspace-1', displayName: 'Admission workspace', rootPath: root,
        realRootPath: root, createdAt: new Date(0).toISOString(), lifecycleKind: 'goal', goalId: 'goal-1',
      };
      await repository.insert(workspace);
      const lease = await repository.acquireGoalWriterLease(
        workspace.id, 'lease-1', 'owner-1', '2026-09-23T00:00:00.000Z', '2026-09-23T01:00:00.000Z',
      );
      expect(lease).not.toBeNull();

      const receipt: WorkspaceAdmissionReceipt = {
        admissionId: 'admission-1', projectId: 'project-1', workspaceId: workspace.id, goalId: 'goal-1',
        workspaceKind: 'git', repositoryIdentity: 'repo-1', worktreeIdentity: root, branchName: 'goal/1',
        expectedWorkspaceHead: '1111111111111111111111111111111111111111',
        observedWorkspaceHead: '1111111111111111111111111111111111111111',
        baseRef: 'refs/heads/main', expectedBaseSha: '2222222222222222222222222222222222222222',
        resolvedBaseSha: '2222222222222222222222222222222222222222', mergeBaseSha: '2222222222222222222222222222222222222222',
        dirtyState: 'clean', dirtyFingerprint: 'clean:sha256:0', checkpointId: 'checkpoint-1', checkpointRevision: 1,
        writeLeaseGeneration: lease!.generation, runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'deploy-1',
        runtimeBuildVersion: '1.0.0', runtimeBuildCommit: 'abc123', runtimeBuildDirty: false,
        runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-09-23T00:00:00.000Z', workflowVersion: 1,
        admissionGeneration: 1, createdAt: '2026-09-23T00:00:00.000Z',
      };
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 0, lease!.generation, {
        ...receipt, dirtyFingerprint: 'x'.repeat(20_000),
      })).resolves.toBe(false);
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 0, lease!.generation, {
        ...receipt, sourceText: 'must never be persisted',
      } as WorkspaceAdmissionReceipt)).resolves.toBe(false);
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 0, lease!.generation, {
        ...receipt, createdAt: '2026-09-23T01:00:00.000Z',
      })).resolves.toBe(false);
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 0, lease!.generation, receipt)).resolves.toBe(true);
      await expect(repository.getAdmissionReceipt(workspace.id)).resolves.toEqual(receipt);

      const nextReceipt = { ...receipt, admissionId: 'admission-2', admissionGeneration: 2 };
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 0, lease!.generation, nextReceipt)).resolves.toBe(false);
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 1, lease!.generation + 1, nextReceipt)).resolves.toBe(false);
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 1, lease!.generation, nextReceipt)).resolves.toBe(true);
      await expect(repository.invalidateAdmissionReceipt(workspace.id, 1, 'unexpected_workspace_change', '2026-09-23T00:30:00.000Z')).resolves.toBe(false);
      await expect(repository.invalidateAdmissionReceipt(workspace.id, 2, 'unexpected_workspace_change', '2026-09-23T00:30:00.000Z')).resolves.toBe(true);

      database.close();
      database = new SqliteDatabase(databasePath);
      repository = new SqliteWorkspaceRepository(database);
      await expect(repository.getAdmissionReceipt(workspace.id)).resolves.toEqual({
        ...nextReceipt, invalidatedAt: '2026-09-23T00:30:00.000Z', invalidationReason: 'unexpected_workspace_change',
      });
    } finally {
      database.close();
    }
  });

  it('persists guarded rebase receipts only with the current admission and writer-lease generations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-workspace-rebase-db-'));
    temporaryRoots.push(root);
    const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
    try {
      const repository = new SqliteWorkspaceRepository(database);
      const workspace: Workspace = {
        id: 'rebase-workspace-1', displayName: 'Rebase workspace', rootPath: root, realRootPath: root,
        createdAt: new Date(0).toISOString(), lifecycleKind: 'goal', goalId: 'goal-1',
      };
      await repository.insert(workspace);
      const writerLease = await repository.acquireGoalWriterLease(
        workspace.id, 'lease-1', 'owner-1', '2026-09-23T00:00:00.000Z', '2026-09-23T01:00:00.000Z',
      );
      expect(writerLease).not.toBeNull();
      const admission: WorkspaceAdmissionReceipt = {
        admissionId: 'admission-1', projectId: 'project-1', workspaceId: workspace.id, goalId: 'goal-1',
        workspaceKind: 'git', worktreeIdentity: root, branchName: 'goal/1',
        expectedWorkspaceHead: '1'.repeat(40), observedWorkspaceHead: '1'.repeat(40),
        baseRef: 'origin/main', expectedBaseSha: '2'.repeat(40), resolvedBaseSha: '2'.repeat(40),
        mergeBaseSha: '2'.repeat(40), dirtyState: 'clean', dirtyFingerprint: 'clean',
        checkpointId: 'checkpoint-1', checkpointRevision: 7, writeLeaseGeneration: writerLease!.generation,
        runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'generation-1', runtimeBuildVersion: '1.0.0',
        runtimeBuildDirty: false, runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-09-23T00:00:00.000Z',
        workflowVersion: 1, admissionGeneration: 1, createdAt: '2026-09-23T00:00:00.000Z',
      };
      await expect(repository.compareAndSwapAdmissionReceipt(workspace.id, 0, writerLease!.generation, admission)).resolves.toBe(true);
      const started: WorkspaceBaseRebaseReceipt = {
        operationId: 'operation-1', receiptRevision: 1, workspaceId: workspace.id, goalId: 'goal-1',
        branchName: 'goal/1', status: 'started', oldHead: '1'.repeat(40), oldBaseSha: '2'.repeat(40),
        newBaseSha: '3'.repeat(40), checkpointId: 'checkpoint-1', checkpointRevision: 7,
        checkpointHead: '1'.repeat(40), recoveryRef: 'refs/unified-mpc/recovery/rebase/operation-1',
        admissionGeneration: 1, writeLeaseGeneration: writerLease!.generation,
        remoteGoalRef: 'refs/heads/goal/1', startedAt: '2026-09-23T00:30:00.000Z',
      };
      for (const invalid of [
        { ...started, operationId: 'bad/operation' },
        { ...started, checkpointId: 'x'.repeat(129) },
        { ...started, remoteGoalRef: `refs/heads/${'x'.repeat(2048)}` },
        { ...started, conflictedPaths: ['x'.repeat(4097)] },
        { ...started, startedAt: 'not-a-timestamp' },
        { ...started, failureReason: 'x'.repeat(257) },
      ] satisfies WorkspaceBaseRebaseReceipt[]) {
        await expect(repository.compareAndSwapBaseRebaseReceipt(
          workspace.id, 0, 1, writerLease!.generation, invalid,
        )).resolves.toBe(false);
      }
      await expect(repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, 0, 2, writerLease!.generation, started,
      )).resolves.toBe(false);
      await expect(repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, 0, 1, writerLease!.generation + 1, started,
      )).resolves.toBe(false);
      await expect(repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, 0, 1, writerLease!.generation, started,
      )).resolves.toBe(true);
      await expect(repository.getBaseRebaseReceipt(workspace.id)).resolves.toEqual(started);

      const completed: WorkspaceBaseRebaseReceipt = {
        ...started, receiptRevision: 2, status: 'completed', resultHead: '4'.repeat(40),
        finishedAt: '2026-09-23T00:31:00.000Z',
      };
      await expect(repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, 1, 1, writerLease!.generation, completed,
      )).resolves.toBe(true);
      await expect(repository.getBaseRebaseReceipt(workspace.id)).resolves.toEqual(completed);

      database.connection.prepare(
        'UPDATE workspace_base_rebase_receipts SET receipt_json = ? WHERE workspace_id = ?',
      ).run('{ malformed', workspace.id);
      await expect(repository.getBaseRebaseReceipt(workspace.id)).rejects.toThrow(/malformed/i);

      database.connection.exec('PRAGMA ignore_check_constraints = ON;');
      database.connection.prepare(
        'UPDATE workspace_base_rebase_receipts SET receipt_json = ? WHERE workspace_id = ?',
      ).run(JSON.stringify({ ...completed, conflictedPaths: ['x'.repeat(20_000)] }), workspace.id);
      await expect(repository.getBaseRebaseReceipt(workspace.id)).rejects.toThrow(/size limit/i);
      database.connection.exec('PRAGMA ignore_check_constraints = OFF;');
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
