import { describe, expect, it } from 'vitest';
import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  type AppendGoalRuntimeEventRequest,
  type GoalRecord,
  type GoalRuntimeEventRecord,
  type GoalRuntimeEventRepository,
  type GoalRuntimeSnapshotRecord,
  type GoalRuntimeSnapshotRepository,
} from '@unified-mpc/domain';
import { GoalRuntimeControlPlaneError, GoalRuntimeControlPlaneService } from './goal-runtime-control-plane-service.js';

const workspaceId = 'workspace-1';

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    goalKey: 'runtime-producer',
    workspaceId,
    ownerClientId: 'client-1',
    objective: 'Publish truthful runtime state.',
    plan: { steps: [] },
    status: 'active',
    revision: 1,
    currentPhase: 'inspect',
    nextAction: 'continue',
    blockers: [],
    activeTaskIds: [],
    leaseGeneration: 1,
    executionId: 'execution-1',
    executionGeneration: 1,
    leaseActivitySeq: 0,
    leaseHeartbeatAt: '2026-09-22T00:00:00.000Z',
    leaseExpiresAt: '2026-09-22T00:10:00.000Z',
    createdAt: '2026-09-21T23:59:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    checkpoints: [],
    ...overrides,
  };
}

function fixture(options: {
  goals?: readonly GoalRecord[];
  snapshot?: GoalRuntimeSnapshotRecord;
  events?: readonly GoalRuntimeEventRecord[];
  replayWindowMissed?: boolean;
} = {}): {
  readonly service: GoalRuntimeControlPlaneService;
  readonly stored: GoalRuntimeSnapshotRecord[];
  readonly records: GoalRuntimeEventRecord[];
} {
  const goals = new Map((options.goals ?? [goal()]).map((entry) => [entry.id, entry]));
  let snapshot = options.snapshot ?? null;
  const stored: GoalRuntimeSnapshotRecord[] = [];
  const records = [...(options.events ?? [])];

  const snapshots: GoalRuntimeSnapshotRepository = {
    getGoalRuntimeSnapshot: async (goalId) =>
      snapshot?.projection.goalId === goalId ? snapshot : null,
    listWorkspaceGoalRuntimeSnapshots: async () => snapshot === null ? [] : [snapshot],
    storeGoalRuntimeSnapshot: async (request) => {
      snapshot = {
        projection: request.projection,
        lastEventSequence: request.lastEventSequence,
        updatedAt: request.updatedAt,
      };
      stored.push(snapshot);
      return snapshot;
    },
  };

  const events: GoalRuntimeEventRepository = {
    appendGoalRuntimeEvent: async (request: AppendGoalRuntimeEventRequest) => {
      const existing = records.find((entry) => entry.event.eventId === request.event.eventId);
      if (existing !== undefined) return { appended: false, record: existing };
      const record: GoalRuntimeEventRecord = {
        sequence: (records.at(-1)?.sequence ?? 0) + 1,
        event: request.event,
        recordedAt: request.recordedAt,
      };
      records.push(record);
      return { appended: true, record };
    },
    replayWorkspaceGoalRuntimeEvents: async (request) => {
      const scoped = records.filter((entry) => entry.event.workspaceId === request.workspaceId);
      const oldest = scoped[0]?.sequence;
      const latest = scoped.at(-1)?.sequence;
      const after = request.afterSequence ?? -1;
      return {
        events: scoped.filter((entry) => entry.sequence > after).slice(0, request.limit),
        ...(oldest === undefined ? {} : { oldestAvailableSequence: oldest }),
        ...(latest === undefined ? {} : { latestSequence: latest }),
        replayWindowMissed: options.replayWindowMissed === true,
      };
    },
    listGoalRuntimeEvents: async (request) =>
      records.filter((entry) => entry.event.goalId === request.goalId)
        .sort((left, right) => right.sequence - left.sequence)
        .slice(0, request.limit),
  };

  const service = new GoalRuntimeControlPlaneService({
    getById: async (goalId): Promise<GoalRecord | null> => goals.get(goalId) ?? null,
    list: async (request): Promise<readonly GoalRecord[]> => [...goals.values()]
      .filter((entry) => request.workspaceId === undefined || entry.workspaceId === request.workspaceId)
      .slice(0, request.limit),
  }, snapshots, events);

  return { service, stored, records };
}

describe('GoalRuntimeControlPlaneService', () => {
  it('bootstraps an active leased Goal as queued rather than fabricating running state', async () => {
    const runtime = fixture();
    const snapshot = await runtime.service.ensureGoalSnapshot('goal-1');

    expect(snapshot.projection).toMatchObject({
      contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
      lifecycleState: 'open',
      runtimeState: 'queued',
      desiredRuntimeState: 'running',
      integrationState: 'unknown',
      workspaceState: 'unknown',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
    });
    expect(snapshot.projection.lastHeartbeatAt).toBeUndefined();
  });

  it('projects real phase activity from queued to running and persists the event cursor', async () => {
    const runtime = fixture();
    const snapshot = await runtime.service.publishGoalRuntimeEvent({
      eventId: 'phase-1',
      type: 'phase_started',
      workspaceId,
      goalId: 'goal-1',
      executionId: 'execution-1',
      executionGeneration: 1,
      occurredAt: '2026-09-22T00:01:00.000Z',
      phase: 'test',
      detail: 'integration tests',
    });

    expect(snapshot.lastEventSequence).toBe(1);
    expect(snapshot.projection).toMatchObject({
      runtimeState: 'running',
      phase: 'test',
      progress: { phase: 'test', detail: 'integration tests' },
    });
  });

  it('ignores a stale previous-generation event while still advancing the durable cursor', async () => {
    const runtime = fixture({
      goals: [goal({
        leaseGeneration: 2,
        executionId: 'execution-2',
        executionGeneration: 2,
      })],
    });

    const snapshot = await runtime.service.publishGoalRuntimeEvent({
      eventId: 'stale-heartbeat',
      type: 'execution_heartbeat',
      workspaceId,
      goalId: 'goal-1',
      executionId: 'execution-1',
      executionGeneration: 1,
      occurredAt: '2026-09-22T00:01:00.000Z',
    });

    expect(snapshot.lastEventSequence).toBe(1);
    expect(snapshot.projection).toMatchObject({
      runtimeState: 'queued',
      activeExecutionId: 'execution-2',
      executionGeneration: 2,
    });
    expect(snapshot.projection.lastHeartbeatAt).toBeUndefined();
  });

  it('replays a durable crash-window event before publishing the next event', async () => {
    const initial: GoalRuntimeSnapshotRecord = {
      projection: {
        contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        workspaceId,
        lifecycleState: 'open',
        runtimeState: 'queued',
        desiredRuntimeState: 'running',
        integrationState: 'unknown',
        workspaceState: 'unknown',
        activeExecutionId: 'execution-1',
        executionGeneration: 1,
        lastActivityAt: '2026-09-22T00:00:00.000Z',
      },
      lastEventSequence: 0,
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    const runtime = fixture({
      snapshot: initial,
      events: [{
        sequence: 1,
        event: {
          eventId: 'heartbeat-1',
          type: 'execution_heartbeat',
          workspaceId,
          goalId: 'goal-1',
          executionId: 'execution-1',
          executionGeneration: 1,
          occurredAt: '2026-09-22T00:00:30.000Z',
        },
        recordedAt: '2026-09-22T00:00:31.000Z',
      }],
    });

    const snapshot = await runtime.service.publishGoalRuntimeEvent({
      eventId: 'phase-2',
      type: 'phase_started',
      workspaceId,
      goalId: 'goal-1',
      executionId: 'execution-1',
      executionGeneration: 1,
      occurredAt: '2026-09-22T00:01:00.000Z',
      phase: 'implement',
    });

    expect(snapshot.lastEventSequence).toBe(2);
    expect(snapshot.projection.lastHeartbeatAt).toBe('2026-09-22T00:00:30.000Z');
    expect(snapshot.projection).toMatchObject({ runtimeState: 'running', phase: 'implement' });
  });

  it('rejects a future-generation activity event instead of corrupting the projection', async () => {
    const runtime = fixture();
    await expect(runtime.service.publishGoalRuntimeEvent({
      eventId: 'future-heartbeat',
      type: 'execution_heartbeat',
      workspaceId,
      goalId: 'goal-1',
      executionId: 'execution-2',
      executionGeneration: 2,
      occurredAt: '2026-09-22T00:01:00.000Z',
    })).rejects.toMatchObject<Partial<GoalRuntimeControlPlaneError>>({
      reason: 'projection_rejected',
    });
    expect(runtime.records).toHaveLength(0);
  });

  it('does not confuse unrelated workspace retention with a brand-new Goal replay gap', async () => {
    const runtime = fixture({
      events: [{
        sequence: 100,
        event: {
          eventId: 'other-goal-event',
          type: 'goal_created',
          workspaceId,
          goalId: 'other-goal',
          occurredAt: '2026-09-22T00:00:00.000Z',
        },
        recordedAt: '2026-09-22T00:00:00.000Z',
      }],
    });

    const snapshot = await runtime.service.publishGoalRuntimeEvent({
      eventId: 'new-goal-phase',
      type: 'phase_started',
      workspaceId,
      goalId: 'goal-1',
      executionId: 'execution-1',
      executionGeneration: 1,
      occurredAt: '2026-09-22T00:01:00.000Z',
      phase: 'work',
    });

    expect(snapshot.lastEventSequence).toBe(101);
    expect(snapshot.projection).toMatchObject({ runtimeState: 'running', phase: 'work' });
  });

  it('keeps a Goal-local snapshot valid when only unrelated workspace history fell out of retention', async () => {
    const initial: GoalRuntimeSnapshotRecord = {
      projection: {
        contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        workspaceId,
        lifecycleState: 'open',
        runtimeState: 'queued',
        desiredRuntimeState: 'running',
        integrationState: 'unknown',
        workspaceState: 'unknown',
        activeExecutionId: 'execution-1',
        executionGeneration: 1,
        lastActivityAt: '2026-09-22T00:00:00.000Z',
      },
      lastEventSequence: 10,
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    const runtime = fixture({
      snapshot: initial,
      replayWindowMissed: true,
      events: [{
        sequence: 100,
        event: {
          eventId: 'other-goal-retained-event',
          type: 'goal_created',
          workspaceId,
          goalId: 'other-goal',
          occurredAt: '2026-09-22T00:05:00.000Z',
        },
        recordedAt: '2026-09-22T00:05:00.000Z',
      }],
    });

    const snapshot = await runtime.service.ensureGoalSnapshot('goal-1');

    expect(snapshot).toEqual(initial);
    expect(runtime.stored).toHaveLength(0);
  });

  it('repairs a stale running snapshot from durable terminal state after a crash window', async () => {
    const runningSnapshot: GoalRuntimeSnapshotRecord = {
      projection: {
        contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
        goalId: 'goal-1',
        workspaceId,
        lifecycleState: 'open',
        runtimeState: 'running',
        desiredRuntimeState: 'running',
        integrationState: 'unknown',
        workspaceState: 'unknown',
        activeExecutionId: 'execution-1',
        executionGeneration: 1,
        lastActivityAt: '2026-09-22T00:00:30.000Z',
      },
      lastEventSequence: 0,
      updatedAt: '2026-09-22T00:00:30.000Z',
    };
    const runtime = fixture({
      goals: [goal({
        status: 'cancelled',
        revision: 2,
        terminalAt: '2026-09-22T00:02:00.000Z',
        updatedAt: '2026-09-22T00:02:00.000Z',
        leaseHeartbeatAt: undefined,
        leaseExpiresAt: undefined,
      })],
      snapshot: runningSnapshot,
    });

    const snapshot = await runtime.service.ensureGoalSnapshot('goal-1');

    expect(snapshot.projection).toMatchObject({
      lifecycleState: 'abandoned',
      runtimeState: 'cancelled',
      desiredRuntimeState: 'cancelled',
      executionGeneration: 1,
    });
    expect(snapshot.projection.activeExecutionId).toBeUndefined();
    expect(runtime.records.map((entry) => entry.event.type)).toEqual([
      'execution_cancelled',
      'goal_abandoned',
    ]);
  });

  it('bootstraps terminal durable truth without retaining a fake active execution', async () => {
    const runtime = fixture({
      goals: [goal({
        status: 'cancelled',
        leaseExpiresAt: undefined,
        leaseHeartbeatAt: undefined,
      })],
    });
    const snapshot = await runtime.service.ensureGoalSnapshot('goal-1');
    expect(snapshot.projection).toMatchObject({
      lifecycleState: 'abandoned',
      runtimeState: 'cancelled',
      desiredRuntimeState: 'cancelled',
      executionGeneration: 1,
    });
    expect(snapshot.projection.activeExecutionId).toBeUndefined();
  });
});
