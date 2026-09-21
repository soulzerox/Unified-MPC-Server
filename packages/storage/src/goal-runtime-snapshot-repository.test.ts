import { describe, expect, it } from 'vitest';
import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  projectGoalRuntimeEvent,
  type ExecutionScopedRuntimeEvent,
  type GoalRuntimeProjection,
} from '@unified-mpc/domain';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteGoalRuntimeEventRepository } from './goal-runtime-event-repository.js';
import { SqliteGoalRuntimeSnapshotRepository } from './goal-runtime-snapshot-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const now = '2026-09-21T14:00:00.000Z';

async function fixture(): Promise<{
  database: SqliteDatabase;
  events: SqliteGoalRuntimeEventRepository;
  snapshots: SqliteGoalRuntimeSnapshotRepository;
  goals: SqliteGoalRepository;
  executionId: string;
  initial: GoalRuntimeProjection;
}> {
  const database = new SqliteDatabase(':memory:');
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-1',
    displayName: 'Runtime snapshots',
    rootPath: '/tmp/unified-runtime-snapshots',
    realRootPath: '/tmp/unified-runtime-snapshots',
    createdAt: now,
  });
  const goals = new SqliteGoalRepository(database);
  const acquired = await goals.acquire({
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    goalKey: 'runtime-snapshots',
    ownerClientId: 'client-1',
    ownerSessionId: 'session-1',
    objective: 'Persist authoritative runtime snapshots.',
    plan: { steps: [] },
    leaseTokenHash: 'lease-hash',
    leaseSeconds: 60,
    now,
  });
  if (!acquired.acquired || acquired.goal.executionId === undefined) {
    throw new Error('goal execution fixture was not acquired');
  }

  return {
    database,
    events: new SqliteGoalRuntimeEventRepository(database),
    snapshots: new SqliteGoalRuntimeSnapshotRepository(database),
    goals,
    executionId: acquired.goal.executionId,
    initial: baseProjection(),
  };
}

function baseProjection(overrides: Partial<GoalRuntimeProjection> = {}): GoalRuntimeProjection {
  return {
    contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    lifecycleState: 'open',
    runtimeState: 'idle',
    desiredRuntimeState: 'idle',
    integrationState: 'not_started',
    workspaceState: 'clean',
    lastActivityAt: now,
    ...overrides,
  };
}

function executionEvent(
  executionId: string,
  type: ExecutionScopedRuntimeEvent['type'],
  sequenceHint: number,
  overrides: Partial<ExecutionScopedRuntimeEvent> = {},
): ExecutionScopedRuntimeEvent {
  return {
    eventId: `event-${sequenceHint}-${type}`,
    type,
    workspaceId: 'workspace-1',
    goalId: 'goal-1',
    executionId,
    executionGeneration: 1,
    occurredAt: new Date(Date.parse(now) + sequenceHint * 1_000).toISOString(),
    ...overrides,
  };
}

async function appendAndProject(
  runtime: Awaited<ReturnType<typeof fixture>>,
  current: GoalRuntimeProjection,
  event: ExecutionScopedRuntimeEvent,
): Promise<{ projection: GoalRuntimeProjection; sequence: number }> {
  const appended = await runtime.events.appendGoalRuntimeEvent({
    event,
    recordedAt: event.occurredAt,
  });
  const projected = projectGoalRuntimeEvent(current, event);
  expect(projected.decision).toEqual({ disposition: 'apply' });
  return { projection: projected.projection, sequence: appended.record.sequence };
}

async function storeRunningSnapshot(
  runtime: Awaited<ReturnType<typeof fixture>>,
): Promise<{ projection: GoalRuntimeProjection; sequence: number }> {
  const submitted = await appendAndProject(
    runtime,
    runtime.initial,
    executionEvent(runtime.executionId, 'execution_submitted', 1),
  );
  const started = await appendAndProject(
    runtime,
    submitted.projection,
    executionEvent(runtime.executionId, 'execution_started', 2),
  );
  await runtime.snapshots.storeGoalRuntimeSnapshot({
    projection: started.projection,
    lastEventSequence: started.sequence,
    updatedAt: '2026-09-21T14:00:03.000Z',
  });
  return started;
}

describe('SqliteGoalRuntimeSnapshotRepository', () => {
  it('persists a projected snapshot with its durable replay cursor and round-trips truthful progress', async () => {
    const runtime = await fixture();
    try {
      const submitted = await appendAndProject(
        runtime,
        runtime.initial,
        executionEvent(runtime.executionId, 'execution_submitted', 1),
      );
      const started = await appendAndProject(
        runtime,
        submitted.projection,
        executionEvent(runtime.executionId, 'execution_started', 2),
      );
      const phase = await appendAndProject(
        runtime,
        started.projection,
        executionEvent(runtime.executionId, 'phase_started', 3, {
          phase: 'test',
          detail: '18/24 tests passed',
        }),
      );

      const stored = await runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: phase.projection,
        lastEventSequence: phase.sequence,
        updatedAt: '2026-09-21T14:00:04.000Z',
      });

      expect(stored).toMatchObject({
        lastEventSequence: 3,
        projection: {
          runtimeState: 'running',
          activeExecutionId: runtime.executionId,
          executionGeneration: 1,
          phase: 'test',
          progress: { phase: 'test', detail: '18/24 tests passed' },
        },
      });
      expect(JSON.stringify(stored)).not.toContain('lease-hash');

      await expect(runtime.snapshots.getGoalRuntimeSnapshot('goal-1')).resolves.toEqual(stored);
      const listed = await runtime.snapshots.listWorkspaceGoalRuntimeSnapshots({
        workspaceId: 'workspace-1',
        limit: 50_000,
      });
      expect(listed).toEqual([stored]);
    } finally {
      runtime.database.close();
    }
  });

  it('is idempotent for the same cursor/state and rejects a conflicting projection at that cursor', async () => {
    const runtime = await fixture();
    try {
      const submitted = await appendAndProject(
        runtime,
        runtime.initial,
        executionEvent(runtime.executionId, 'execution_submitted', 1),
      );
      const first = await runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: submitted.projection,
        lastEventSequence: submitted.sequence,
        updatedAt: '2026-09-21T14:00:02.000Z',
      });
      const retry = await runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: submitted.projection,
        lastEventSequence: submitted.sequence,
        updatedAt: '2026-09-21T14:00:03.000Z',
      });
      expect(retry).toEqual(first);

      await expect(runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: {
          ...submitted.projection,
          workspaceState: 'dirty',
        },
        lastEventSequence: submitted.sequence,
        updatedAt: '2026-09-21T14:00:03.000Z',
      })).rejects.toMatchObject({ reason: 'sequence_conflict' });
    } finally {
      runtime.database.close();
    }
  });

  it('never lets an older event cursor replace a newer authoritative snapshot', async () => {
    const runtime = await fixture();
    try {
      const submitted = await appendAndProject(
        runtime,
        runtime.initial,
        executionEvent(runtime.executionId, 'execution_submitted', 1),
      );
      const started = await appendAndProject(
        runtime,
        submitted.projection,
        executionEvent(runtime.executionId, 'execution_started', 2),
      );
      await runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: started.projection,
        lastEventSequence: started.sequence,
        updatedAt: '2026-09-21T14:00:03.000Z',
      });

      await expect(runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: submitted.projection,
        lastEventSequence: submitted.sequence,
        updatedAt: '2026-09-21T14:00:04.000Z',
      })).rejects.toMatchObject({ reason: 'stale_sequence' });

      await expect(runtime.snapshots.getGoalRuntimeSnapshot('goal-1')).resolves.toMatchObject({
        lastEventSequence: 2,
        projection: { runtimeState: 'running' },
      });
    } finally {
      runtime.database.close();
    }
  });

  it('rejects a cursor that does not identify a durable event for the same Goal', async () => {
    const runtime = await fixture();
    try {
      await expect(runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: runtime.initial,
        lastEventSequence: 99,
        updatedAt: now,
      })).rejects.toMatchObject({
        reason: 'invalid_projection',
        message: expect.stringContaining('cursor'),
      });
    } finally {
      runtime.database.close();
    }
  });

  it('persists terminal execution projection while retaining generation history and clearing active identity', async () => {
    const runtime = await fixture();
    try {
      const submitted = await appendAndProject(
        runtime,
        runtime.initial,
        executionEvent(runtime.executionId, 'execution_submitted', 1),
      );
      const started = await appendAndProject(
        runtime,
        submitted.projection,
        executionEvent(runtime.executionId, 'execution_started', 2),
      );
      const completed = await appendAndProject(
        runtime,
        started.projection,
        executionEvent(runtime.executionId, 'execution_completed', 3),
      );
      const stored = await runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: completed.projection,
        lastEventSequence: completed.sequence,
        updatedAt: '2026-09-21T14:00:04.000Z',
      });

      expect(stored.projection).toMatchObject({
        runtimeState: 'idle',
        executionGeneration: 1,
      });
      expect(stored.projection.activeExecutionId).toBeUndefined();
    } finally {
      runtime.database.close();
    }
  });

  it('rejects active execution identity that has no matching durable receipt', async () => {
    const runtime = await fixture();
    try {
      const submitted = await appendAndProject(
        runtime,
        runtime.initial,
        executionEvent(runtime.executionId, 'execution_submitted', 1),
      );
      await expect(runtime.snapshots.storeGoalRuntimeSnapshot({
        projection: {
          ...submitted.projection,
          activeExecutionId: 'not-a-real-execution',
        },
        lastEventSequence: submitted.sequence,
        updatedAt: '2026-09-21T14:00:02.000Z',
      })).rejects.toMatchObject({
        reason: 'invalid_projection',
        message: expect.stringContaining('receipt'),
      });
    } finally {
      runtime.database.close();
    }
  });

  it('atomically appends worker_lost only while the probed runtime fence is still current', async () => {
    const runtime = await fixture();
    try {
      const running = await storeRunningSnapshot(runtime);
      const workerLost = executionEvent(runtime.executionId, 'worker_lost', 3, {
        blockerKind: 'worker_lost',
        detail: 'restart reconciliation: no_live_worker',
      });

      const committed = await runtime.events.appendGoalRuntimeReconciliationEvent({
        event: workerLost,
        recordedAt: workerLost.occurredAt,
        expectedSnapshotSequence: running.sequence,
        expectedLeaseGeneration: 1,
        expectedLeaseActivitySeq: 0,
        expectedLiveScheduledContinuation: null,
      });

      expect(committed).toMatchObject({
        disposition: 'appended',
        record: { sequence: 3, event: workerLost },
      });
    } finally {
      runtime.database.close();
    }
  });

  it('does not append worker_lost when the event stream advances after the liveness probe', async () => {
    const runtime = await fixture();
    try {
      const running = await storeRunningSnapshot(runtime);
      await runtime.events.appendGoalRuntimeEvent({
        event: executionEvent(runtime.executionId, 'execution_heartbeat', 3),
        recordedAt: '2026-09-21T14:00:03.000Z',
      });

      const result = await runtime.events.appendGoalRuntimeReconciliationEvent({
        event: executionEvent(runtime.executionId, 'worker_lost', 4, {
          blockerKind: 'worker_lost',
        }),
        recordedAt: '2026-09-21T14:00:04.000Z',
        expectedSnapshotSequence: running.sequence,
        expectedLeaseGeneration: 1,
        expectedLeaseActivitySeq: 0,
        expectedLiveScheduledContinuation: null,
      });

      expect(result).toEqual({
        disposition: 'concurrent_change',
        reason: 'event_stream_advanced',
      });
      expect((await runtime.events.listGoalRuntimeEvents({ goalId: 'goal-1', limit: 10 }))
        .some((entry) => entry.event.type === 'worker_lost')).toBe(false);
    } finally {
      runtime.database.close();
    }
  });

  it('does not append worker_lost when lease generation rotates after the liveness probe', async () => {
    const runtime = await fixture();
    try {
      const running = await storeRunningSnapshot(runtime);
      const takeover = await runtime.goals.acquire({
        goalId: 'ignored-for-existing-goal',
        workspaceId: 'workspace-1',
        goalKey: 'runtime-snapshots',
        ownerClientId: 'client-2',
        ownerSessionId: 'session-2',
        leaseTokenHash: 'lease-hash-2',
        leaseSeconds: 60,
        now: '2026-09-21T14:02:00.000Z',
      });
      expect(takeover.acquired).toBe(true);
      expect(takeover.goal.leaseGeneration).toBe(2);

      const result = await runtime.events.appendGoalRuntimeReconciliationEvent({
        event: executionEvent(runtime.executionId, 'worker_lost', 3, {
          blockerKind: 'worker_lost',
        }),
        recordedAt: '2026-09-21T14:02:00.000Z',
        expectedSnapshotSequence: running.sequence,
        expectedLeaseGeneration: 1,
        expectedLeaseActivitySeq: 0,
        expectedLiveScheduledContinuation: null,
      });

      expect(result).toEqual({
        disposition: 'concurrent_change',
        reason: 'lease_changed',
      });
      expect((await runtime.events.listGoalRuntimeEvents({ goalId: 'goal-1', limit: 10 }))
        .some((entry) => entry.event.type === 'worker_lost')).toBe(false);
    } finally {
      runtime.database.close();
    }
  });
});