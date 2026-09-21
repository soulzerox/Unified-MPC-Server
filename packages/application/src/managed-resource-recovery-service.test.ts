import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PosixProcessRecoveryObservation } from '@unified-mpc/process';
import {
  SqliteDatabase,
  SqliteManagedResourceBindingRepository,
} from '@unified-mpc/storage';
import {
  ResourceAdmissionController,
  tryAdmitDependencyBootstrap,
} from '@unified-mpc/workspace';
import {
  ManagedResourceRecoveryService,
  type ManagedResourceRecoveryProbe,
} from './managed-resource-recovery-service.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-managed-resource-recovery-'));
  roots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const repository = new SqliteManagedResourceBindingRepository(database);
  const controller = new ResourceAdmissionController({
    globalCost: 4,
    workspaceCost: 4,
    sessionCost: 4,
    maxOperations: 4,
  });
  return { database, repository, controller };
}

function store(
  repository: SqliteManagedResourceBindingRepository,
  operationId: string,
  workspaceId = 'workspace-a',
  resourceClass: 'goal_process' | 'delegated_agent' = 'goal_process',
  cost = 4,
) {
  repository.storeActive({
    lease: {
      operationId,
      workspaceId,
      sessionId: `session-${workspaceId}`,
      resourceClass,
      cost,
    },
    logicalHandle: `handle-${operationId}`,
    platform: 'linux',
    pid: operationId.length + 4000,
    processStartedAt: '2026-09-21T00:00:00.000Z',
    createdAt: '2026-09-21T00:00:01.000Z',
  });
}

function probe(observation: () => PosixProcessRecoveryObservation): ManagedResourceRecoveryProbe {
  return { inspect: async () => observation() };
}

describe('ManagedResourceRecoveryService', () => {
  it('restores verified surviving debt before competing admission and releases it once gone', async () => {
    const { database, repository, controller } = await fixture();
    try {
      store(repository, 'goal-live', 'workspace-a', 'goal_process', 8);
      let state: PosixProcessRecoveryObservation = {
        state: 'verified_live',
        pid: 4009,
        startedAt: '2026-09-21T00:00:00.000Z',
      };
      let tick = 0;
      const service = new ManagedResourceRecoveryService(repository, controller, {
        platform: 'linux',
        probe: probe(() => state),
        now: () => new Date(`2026-09-21T00:00:0${++tick}.000Z`),
      });

      expect(await service.reconcileOnce()).toMatchObject({ restored: 1, released: 0 });
      expect(controller.snapshot()).toMatchObject({
        activeCost: 8,
        activeOperations: 1,
        activeCostByWorkspace: { 'workspace-a': 8 },
      });
      expect(tryAdmitDependencyBootstrap(controller, {
        operationId: 'new-work',
        workspaceId: 'workspace-b',
        sessionId: 'session-b',
        cost: 1,
      })).toMatchObject({ admitted: false, reason: 'global_cost_exhausted' });

      state = { state: 'verified_gone', pid: 4009 };
      expect(await service.reconcileOnce()).toMatchObject({ restored: 0, released: 1 });
      expect(repository.listUnreleased()).toEqual([]);
      expect(controller.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
    } finally {
      database.close();
    }
  });

  it('fails closed for ambiguous liveness and is idempotent across repeated reconciliation', async () => {
    const { database, repository, controller } = await fixture();
    try {
      store(repository, 'delegated-live', 'workspace-a', 'delegated_agent');
      const service = new ManagedResourceRecoveryService(repository, controller, {
        platform: 'linux',
        probe: probe(() => ({
          state: 'termination_unverified',
          pid: 4014,
          reason: 'orphan_group',
        })),
        now: () => new Date('2026-09-21T00:00:02.000Z'),
      });

      await service.reconcileOnce();
      await service.reconcileOnce();

      expect(repository.listUnreleased()).toEqual([
        expect.objectContaining({
          operationId: 'delegated-live',
          state: 'termination_unverified',
        }),
      ]);
      expect(controller.snapshot()).toMatchObject({
        activeCost: 4,
        activeOperations: 1,
      });
    } finally {
      database.close();
    }
  });

  it('treats PID identity mismatch as the original child gone without signalling the reused process', async () => {
    const { database, repository, controller } = await fixture();
    try {
      store(repository, 'pid-reused');
      const service = new ManagedResourceRecoveryService(repository, controller, {
        platform: 'linux',
        probe: probe(() => ({
          state: 'identity_mismatch',
          pid: 4010,
          expectedStartedAt: '2026-09-21T00:00:00.000Z',
          observedStartedAt: '2026-09-21T00:01:00.000Z',
        })),
        now: () => new Date('2026-09-21T00:00:02.000Z'),
      });

      expect(await service.reconcileOnce()).toMatchObject({ restored: 0, released: 1 });
      expect(repository.listUnreleased()).toEqual([]);
      expect(controller.snapshot().activeOperations).toBe(0);
    } finally {
      database.close();
    }
  });

  it('preserves independent workspace debt and cross-workspace accounting', async () => {
    const { database, repository, controller } = await fixture();
    try {
      store(repository, 'goal-a', 'workspace-a', 'goal_process', 2);
      store(repository, 'agent-b', 'workspace-b', 'delegated_agent', 2);
      const service = new ManagedResourceRecoveryService(repository, controller, {
        platform: 'linux',
        probe: probe(() => ({
          state: 'verified_live',
          pid: 4006,
          startedAt: '2026-09-21T00:00:00.000Z',
        })),
      });

      await service.reconcileOnce();
      expect(controller.snapshot()).toMatchObject({
        activeCost: 4,
        activeOperations: 2,
        activeCostByWorkspace: {
          'workspace-a': 2,
          'workspace-b': 2,
        },
      });
    } finally {
      database.close();
    }
  });

  it('keeps persisted POSIX debt fail-closed when recovery runs on a non-POSIX host', async () => {
    const { database, repository, controller } = await fixture();
    try {
      store(repository, 'windows-unverifiable');
      const service = new ManagedResourceRecoveryService(repository, controller, {
        platform: 'win32',
        now: () => new Date('2026-09-21T00:00:02.000Z'),
      });

      expect(await service.reconcileOnce()).toMatchObject({
        restored: 1,
        terminationUnverified: 1,
      });
      expect(repository.listUnreleased()[0]).toMatchObject({
        operationId: 'windows-unverifiable',
        state: 'termination_unverified',
      });
      expect(controller.snapshot().activeOperations).toBe(1);
    } finally {
      database.close();
    }
  });
});
