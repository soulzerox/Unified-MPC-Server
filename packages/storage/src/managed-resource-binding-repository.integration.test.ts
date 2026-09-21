import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import {
  ManagedResourceBindingStoreError,
  SqliteManagedResourceBindingRepository,
  type StoreManagedResourceBinding,
} from './managed-resource-binding-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ filename: string; database: SqliteDatabase; repository: SqliteManagedResourceBindingRepository }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-managed-resource-binding-'));
  temporaryRoots.push(root);
  const filename = path.join(root, 'state.sqlite');
  const database = new SqliteDatabase(filename);
  return { filename, database, repository: new SqliteManagedResourceBindingRepository(database) };
}

function binding(operationId = 'goal-call-1'): StoreManagedResourceBinding {
  return {
    lease: {
      operationId,
      workspaceId: 'workspace-a',
      sessionId: 'session-a',
      resourceClass: 'goal_process',
      cost: 8,
    },
    logicalHandle: 'process-1',
    platform: 'linux',
    pid: 4242,
    processStartedAt: '2026-09-21T00:00:00.000Z',
    createdAt: '2026-09-21T00:00:01.000Z',
  };
}

describe('SqliteManagedResourceBindingRepository', () => {
  it('persists active resource ownership across database reopen', async () => {
    const { filename, database, repository } = await fixture();
    repository.storeActive(binding());
    database.close();

    const reopened = new SqliteDatabase(filename);
    try {
      const recovered = new SqliteManagedResourceBindingRepository(reopened).listUnreleased();
      expect(recovered).toEqual([{
        operationId: 'goal-call-1',
        workspaceId: 'workspace-a',
        sessionId: 'session-a',
        resourceClass: 'goal_process',
        cost: 8,
        logicalHandle: 'process-1',
        platform: 'linux',
        pid: 4242,
        processStartedAt: '2026-09-21T00:00:00.000Z',
        state: 'active',
        createdAt: '2026-09-21T00:00:01.000Z',
        updatedAt: '2026-09-21T00:00:01.000Z',
      }]);
    } finally {
      reopened.close();
    }
  });

  it('is idempotent for the exact same operation and fails closed on conflicting ownership', async () => {
    const { database, repository } = await fixture();
    try {
      const first = repository.storeActive(binding());
      expect(repository.storeActive(binding())).toEqual(first);
      expect(() => repository.storeActive({
        ...binding(),
        lease: { ...binding().lease, workspaceId: 'workspace-b' },
      })).toThrowError(ManagedResourceBindingStoreError);
      try {
        repository.storeActive({ ...binding(), lease: { ...binding().lease, workspaceId: 'workspace-b' } });
      } catch (error) {
        expect(error).toMatchObject({ reason: 'operation_conflict' });
      }
      expect(repository.listUnreleased()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('retains termination-unverified debt and excludes only explicitly released bindings from recovery', async () => {
    const { database, repository } = await fixture();
    try {
      repository.storeActive(binding('goal-call-1'));
      repository.storeActive({
        ...binding('delegated-1'),
        lease: {
          operationId: 'delegated-1',
          workspaceId: 'workspace-b',
          sessionId: 'session-b',
          resourceClass: 'delegated_agent',
          cost: 4,
        },
        logicalHandle: 'codex-task-1',
        pid: 5252,
      });

      expect(repository.markTerminationUnverified('delegated-1', '2026-09-21T00:00:02.000Z'))
        .toMatchObject({ state: 'termination_unverified', updatedAt: '2026-09-21T00:00:02.000Z' });
      expect(repository.markReleased('goal-call-1', '2026-09-21T00:00:03.000Z'))
        .toMatchObject({ state: 'released', updatedAt: '2026-09-21T00:00:03.000Z' });

      expect(repository.listUnreleased()).toEqual([
        expect.objectContaining({
          operationId: 'delegated-1',
          resourceClass: 'delegated_agent',
          state: 'termination_unverified',
          pid: 5252,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it('never resurrects an operation after it was durably released', async () => {
    const { database, repository } = await fixture();
    try {
      repository.storeActive(binding());
      repository.markReleased('goal-call-1', '2026-09-21T00:00:02.000Z');
      expect(() => repository.storeActive(binding())).toThrowError(
        expect.objectContaining({ reason: 'operation_conflict' }),
      );
    } finally {
      database.close();
    }
  });
});
