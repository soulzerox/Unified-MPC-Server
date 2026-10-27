import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeavyJobQueueRecoveryService } from '@unified-mpc/application';
import { PreEditDemandRuntime, preEditOperationId } from '@unified-mpc/mcp-server';
import { SqliteDatabase, SqliteHeavyJobQueueRepository } from '@unified-mpc/storage';
import { ResourceAdmissionController } from '@unified-mpc/workspace';

const T0 = new Date('2026-10-27T10:00:00.000Z');
/** The restarted owner starts two minutes later: past the 90 s heartbeat grace. */
const RESTART_AT = new Date(T0.getTime() + 2 * 60_000);
const WORKSPACE_ID = 'workspace-restart';

const roots: string[] = [];

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function controller(): ResourceAdmissionController {
  return new ResourceAdmissionController({
    globalCost: 8,
    workspaceCost: 8,
    sessionCost: 8,
    maxOperations: 4,
    resourceClassCost: { rag_indexing: 8 },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('durable pre-edit demand queue across restart (#145 U5)', () => {
  it('interrupts dead-owner running work and lets the next owner adopt queued intent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-heavy-job-restart-'));
    roots.push(root);
    const filename = path.join(root, 'state.sqlite');

    const runningOperationId = preEditOperationId(WORKSPACE_ID, 'src/running.ts', 'semantic_missing');
    const queuedOperationId = preEditOperationId(WORKSPACE_ID, 'src/queued.ts', 'semantic_missing');

    const crashedDatabase = new SqliteDatabase(filename);
    const crashedQueue = new SqliteHeavyJobQueueRepository(crashedDatabase, {
      ownerId: 'owner-crashed',
      now: (): Date => T0,
      heartbeatIntervalMs: 0,
    });
    // The single admission slot is held by a delta that never settles: the
    // process "crashes" with one running and one queued durable row.
    const crashedRuntime = new PreEditDemandRuntime({
      controller: controller(),
      cost: 8,
      queueLimit: 4,
      store: crashedQueue,
      now: (): Date => T0,
      executor: (): Promise<unknown> => new Promise(() => undefined),
    });
    expect(crashedRuntime.submit({
      workspaceId: WORKSPACE_ID,
      filePath: 'src/running.ts',
      evidenceState: 'semantic_missing',
      demandable: true,
    })?.queueState).toBe('admitted');
    expect(crashedRuntime.submit({
      workspaceId: WORKSPACE_ID,
      filePath: 'src/queued.ts',
      evidenceState: 'semantic_missing',
      demandable: true,
    })?.queueState).toBe('queued');
    crashedDatabase.close();

    const restartedDatabase = new SqliteDatabase(filename);
    try {
      const restartedQueue = new SqliteHeavyJobQueueRepository(restartedDatabase, {
        ownerId: 'owner-restarted',
        now: (): Date => RESTART_AT,
        heartbeatIntervalMs: 0,
      });
      const recovery = new HeavyJobQueueRecoveryService(restartedQueue, {
        currentOwnerId: restartedQueue.ownerId,
        now: (): Date => RESTART_AT,
      });
      expect(recovery.reconcileOnce()).toEqual({
        inspected: 2,
        interrupted: 1,
        orphaned: 1,
        expired: 0,
        retained: 0,
      });
      expect(restartedQueue.get(runningOperationId)).toMatchObject({ state: 'interrupted' });
      expect(restartedQueue.get(queuedOperationId)).toMatchObject({ state: 'queued' });
      expect(restartedQueue.get(queuedOperationId)).not.toHaveProperty('ownerId');

      const executed: string[] = [];
      const restartedRuntime = new PreEditDemandRuntime({
        controller: controller(),
        cost: 8,
        queueLimit: 4,
        store: restartedQueue,
        now: (): Date => RESTART_AT,
        executor: (job): Promise<unknown> => {
          executed.push(job.filePath);
          return Promise.resolve({ ok: true });
        },
      });
      // The identical re-submit adopts the orphaned row instead of piling a
      // duplicate; the interrupted generation is never revived by adoption.
      expect(restartedRuntime.submit({
        workspaceId: WORKSPACE_ID,
        filePath: 'src/queued.ts',
        evidenceState: 'semantic_missing',
        demandable: true,
      })?.queueState).toBe('admitted');
      await flush();

      expect(executed).toEqual(['src/queued.ts']);
      expect(restartedQueue.get(queuedOperationId)).toMatchObject({
        state: 'completed',
        ownerId: 'owner-restarted',
        attempt: 1,
      });
      expect(restartedQueue.get(runningOperationId)).toMatchObject({ state: 'interrupted' });
      expect(restartedQueue.depth()).toBe(0);
    } finally {
      restartedDatabase.close();
    }
  });
});
