import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteDatabase,
  SqliteGoalRepository,
  SqliteGoalRuntimeEventRepository,
  SqliteGoalRuntimeSnapshotRepository,
  SqliteWorkspaceRepository,
} from '@unified-mpc/storage';
import { GoalContinuationService } from './goal-continuation-service.js';
import { GoalRuntimeControlPlaneService } from './goal-runtime-control-plane-service.js';

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture(): Promise<{
  readonly goals: SqliteGoalRepository;
  readonly events: SqliteGoalRuntimeEventRepository;
  readonly snapshots: SqliteGoalRuntimeSnapshotRepository;
  readonly runtime: GoalRuntimeControlPlaneService;
  readonly service: GoalContinuationService;
  readonly actor: { readonly clientId: string; readonly clientName: string; readonly sessionId: string };
}> {
  const database = new SqliteDatabase(':memory:');
  databases.push(database);
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-1',
    displayName: 'Runtime producer',
    rootPath: '/tmp/runtime-producer',
    realRootPath: '/tmp/runtime-producer',
    createdAt: '2026-09-22T00:00:00.000Z',
  });
  const goals = new SqliteGoalRepository(database);
  const events = new SqliteGoalRuntimeEventRepository(database);
  const snapshots = new SqliteGoalRuntimeSnapshotRepository(database);
  const runtime = new GoalRuntimeControlPlaneService(goals, snapshots, events);
  const service = new GoalContinuationService(workspaces, goals, {
    runtimeEvents: runtime,
    goalExecutions: goals,
    executionCancellation: goals,
    now: (): Date => new Date('2026-09-22T00:01:00.000Z'),
  });
  const actor = {
    clientId: 'runtime-producer-test',
    clientName: 'Runtime Producer Test',
    sessionId: 'session-1',
  };
  return { goals, events, snapshots, runtime, service, actor };
}

describe('GoalContinuationService authoritative runtime producer', () => {
  it('publishes queued -> running -> explicit cancellation without treating selection as runtime truth', async () => {
    const { service, events, snapshots, actor } = await fixture();

    const started = await service.runGoal(actor, {
      workspaceId: 'workspace-1',
      goalKey: 'producer-flow',
      objective: 'Prove runtime producer flow.',
      plan: { steps: [{ id: 'test', title: 'Run tests' }] },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);
    expect(started.value.acquired).toBe(true);
    expect(started.value.leaseToken).toBeDefined();

    const queued = await snapshots.getGoalRuntimeSnapshot(started.value.goalId);
    expect(queued?.projection).toMatchObject({
      lifecycleState: 'open',
      runtimeState: 'queued',
      desiredRuntimeState: 'running',
      activeExecutionId: started.value.executionId,
      executionGeneration: started.value.executionGeneration,
    });

    const initialEvents = await events.listGoalRuntimeEvents({ goalId: started.value.goalId, limit: 10 });
    expect(initialEvents.map((entry) => entry.event.type)).toEqual([
      'execution_submitted',
      'goal_created',
    ]);

    const checkpointed = await service.checkpointGoal(actor, {
      goalId: started.value.goalId,
      leaseToken: started.value.leaseToken!,
      expectedRevision: started.value.revision,
      currentPhase: 'test',
      summary: 'Tests are running',
      stepUpdates: [{ stepId: 'test', status: 'in_progress' }],
      nextAction: 'Finish tests',
      blockers: [],
      evidence: [],
    });
    expect(checkpointed.ok).toBe(true);
    if (!checkpointed.ok) throw new Error(checkpointed.error.message);

    const running = await snapshots.getGoalRuntimeSnapshot(started.value.goalId);
    expect(running?.projection).toMatchObject({
      lifecycleState: 'open',
      runtimeState: 'running',
      phase: 'test',
      progress: { phase: 'test', detail: 'Tests are running' },
    });
    expect(running?.projection.lastHeartbeatAt).toBe('2026-09-22T00:01:00.000Z');

    const cancelled = await service.cancelGoal(actor, {
      goalId: started.value.goalId,
      expectedRevision: checkpointed.value.revision,
      summary: 'Explicit operator cancellation',
      evidence: [],
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) throw new Error(cancelled.error.message);

    const terminal = await snapshots.getGoalRuntimeSnapshot(started.value.goalId);
    expect(terminal?.projection).toMatchObject({
      lifecycleState: 'abandoned',
      runtimeState: 'cancelled',
      desiredRuntimeState: 'cancelled',
    });
    expect(terminal?.projection.activeExecutionId).toBeUndefined();

    const types = (await events.listGoalRuntimeEvents({ goalId: started.value.goalId, limit: 20 }))
      .map((entry) => entry.event.type);
    expect(types).toEqual(expect.arrayContaining([
      'execution_cancel_requested',
      'execution_cancelled',
      'goal_abandoned',
      'checkpoint_created',
      'phase_started',
      'execution_heartbeat',
      'execution_submitted',
      'goal_created',
    ]));
  });

  it('keeps a newly acquired Goal queued until runtime activity is actually observed', async () => {
    const { service, snapshots, actor } = await fixture();
    const started = await service.runGoal(actor, {
      workspaceId: 'workspace-1',
      goalKey: 'queued-only',
      objective: 'Wait for real work.',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.message);

    const snapshot = await snapshots.getGoalRuntimeSnapshot(started.value.goalId);
    expect(snapshot?.projection.runtimeState).toBe('queued');
    expect(snapshot?.projection.lastHeartbeatAt).toBeUndefined();
  });
});
