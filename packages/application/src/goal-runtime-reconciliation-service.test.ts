import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  type AppendGoalRuntimeReconciliationEventRequest,
  type AppendGoalRuntimeReconciliationEventResult,
  type GoalRecord,
  type GoalRuntimeReconciliationEventRepository,
  type GoalRuntimeSnapshotRecord,
  type GoalRuntimeSnapshotRepository,
  type ScheduledContinuationRepository,
  type ScheduledContinuationWorkerLivenessPort,
} from '@unified-mpc/domain';
import { GoalRuntimeReconciliationService } from './goal-runtime-reconciliation-service.js';

const now = '2026-09-21T15:00:00.000Z';

type ReconciliationAppend = (
  request: AppendGoalRuntimeReconciliationEventRequest,
) => Promise<AppendGoalRuntimeReconciliationEventResult>;

interface FixtureRuntime {
  readonly service: GoalRuntimeReconciliationService;
  readonly append: Mock<ReconciliationAppend>;
  readonly stored: GoalRuntimeSnapshotRecord[];
}

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    goalKey: 'restart-reconciliation',
    workspaceId: 'workspace-1',
    ownerClientId: 'client-1',
    objective: 'Reconcile authoritative runtime state after restart.',
    plan: { steps: [] },
    status: 'active',
    revision: 2,
    currentPhase: 'run',
    nextAction: 'continue',
    blockers: [],
    activeTaskIds: [],
    leaseGeneration: 1,
    executionId: 'execution-1',
    executionGeneration: 1,
    leaseActivitySeq: 0,
    leaseHeartbeatAt: '2026-09-21T14:58:00.000Z',
    leaseExpiresAt: '2026-09-21T15:08:00.000Z',
    createdAt: '2026-09-21T14:00:00.000Z',
    updatedAt: '2026-09-21T14:58:00.000Z',
    checkpoints: [],
    ...overrides,
  };
}

function snapshot(runtimeState: GoalRuntimeSnapshotRecord['projection']['runtimeState'] = 'running'): GoalRuntimeSnapshotRecord {
  return {
    projection: {
      contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      lifecycleState: 'open',
      runtimeState,
      desiredRuntimeState: 'running',
      integrationState: 'not_started',
      workspaceState: 'clean',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
      lastActivityAt: '2026-09-21T14:58:00.000Z',
      lastHeartbeatAt: '2026-09-21T14:58:00.000Z',
    },
    lastEventSequence: 2,
    updatedAt: '2026-09-21T14:58:00.000Z',
  };
}

function fixture(options: {
  runtimeState?: GoalRuntimeSnapshotRecord['projection']['runtimeState'];
  liveFencedCallCount?: number;
  trustworthy?: boolean;
  commitDisposition?: 'appended' | 'concurrent_change';
  failFirstStore?: boolean;
} = {}): FixtureRuntime {
  let current = snapshot(options.runtimeState);
  const stored: GoalRuntimeSnapshotRecord[] = [];
  let storeAttempts = 0;
  const snapshots: GoalRuntimeSnapshotRepository = {
    getGoalRuntimeSnapshot: async () => current,
    listWorkspaceGoalRuntimeSnapshots: async () => [current],
    storeGoalRuntimeSnapshot: async (request) => {
      storeAttempts += 1;
      if (options.failFirstStore === true && storeAttempts === 1) {
        throw new Error('simulated snapshot write failure');
      }
      current = {
        projection: request.projection,
        lastEventSequence: request.lastEventSequence,
        updatedAt: request.updatedAt,
      };
      stored.push(current);
      return current;
    },
  };

  let committedEvent: AppendGoalRuntimeReconciliationEventRequest['event'] | undefined;
  const append = vi.fn<ReconciliationAppend>(async (request: AppendGoalRuntimeReconciliationEventRequest) => {
    if (options.commitDisposition === 'concurrent_change') {
      return {
        disposition: 'concurrent_change' as const,
        reason: 'lease_changed' as const,
      };
    }
    if (committedEvent !== undefined) {
      return {
        disposition: 'duplicate' as const,
        record: {
          sequence: 3,
          event: committedEvent,
          recordedAt: now,
        },
      };
    }
    committedEvent = request.event;
    return {
      disposition: 'appended' as const,
      record: {
        sequence: 3,
        event: request.event,
        recordedAt: request.recordedAt,
      },
    };
  });
  const events: GoalRuntimeReconciliationEventRepository = {
    appendGoalRuntimeReconciliationEvent: append,
  };
  const scheduledContinuations = {
    getLiveScheduledContinuation: vi.fn(async () => null),
  } as unknown as Pick<ScheduledContinuationRepository, 'getLiveScheduledContinuation'>;
  const workerLiveness: ScheduledContinuationWorkerLivenessPort = {
    observe: async () => ({
      trustworthy: options.trustworthy ?? true,
      observedAt: now,
      leaseGeneration: 1,
      leaseActivitySeq: 0,
      liveFencedCallCount: options.liveFencedCallCount ?? 0,
      blockingTaskStates: [],
    }),
  };

  const service = new GoalRuntimeReconciliationService(
    { getById: async (): Promise<GoalRecord> => goal() },
    snapshots,
    events,
    scheduledContinuations,
    workerLiveness,
    { now: (): Date => new Date(now) },
  );
  return { service, append, stored };
}

describe('GoalRuntimeReconciliationService', () => {
  it('marks a stale running execution recovery_required with a deterministic worker_lost event', async () => {
    const runtime = fixture();
    const result = await runtime.service.reconcileGoal('goal-1');

    expect(result).toEqual({
      goalId: 'goal-1',
      disposition: 'reconciled',
      reason: 'no_live_worker',
      eventSequence: 3,
    });
    expect(runtime.append).toHaveBeenCalledTimes(1);
    const request = runtime.append.mock.calls[0]![0];
    expect(request).toMatchObject({
      expectedSnapshotSequence: 2,
      expectedLeaseGeneration: 1,
      expectedLeaseActivitySeq: 0,
      expectedLiveScheduledContinuation: null,
      event: {
        type: 'worker_lost',
        goalId: 'goal-1',
        executionId: 'execution-1',
        executionGeneration: 1,
        blockerKind: 'worker_lost',
        occurredAt: '2026-09-21T14:58:00.000Z',
      },
    });
    expect(request.event.eventId).toMatch(/^restart-worker-lost-[a-f0-9]{64}$/);
    expect(runtime.stored).toHaveLength(1);
    expect(runtime.stored[0]!.projection).toMatchObject({
      runtimeState: 'recovery_required',
      blocker: { kind: 'worker_lost' },
    });
  });

  it('preserves running state when a fenced worker call is still live', async () => {
    const runtime = fixture({ liveFencedCallCount: 1 });
    await expect(runtime.service.reconcileGoal('goal-1')).resolves.toEqual({
      goalId: 'goal-1',
      disposition: 'live_worker',
      reason: 'fenced_call',
    });
    expect(runtime.append).not.toHaveBeenCalled();
    expect(runtime.stored).toHaveLength(0);
  });

  it('fails closed when liveness evidence is untrusted', async () => {
    const runtime = fixture({ trustworthy: false });
    await expect(runtime.service.reconcileGoal('goal-1')).resolves.toEqual({
      goalId: 'goal-1',
      disposition: 'liveness_untrusted',
      reason: 'evidence_untrustworthy',
    });
    expect(runtime.append).not.toHaveBeenCalled();
  });

  it('does not project worker loss after the atomic commit fence detects concurrent lease change', async () => {
    const runtime = fixture({ commitDisposition: 'concurrent_change' });
    await expect(runtime.service.reconcileGoal('goal-1')).resolves.toEqual({
      goalId: 'goal-1',
      disposition: 'concurrent_change',
      reason: 'lease_changed',
    });
    expect(runtime.stored).toHaveLength(0);
  });

  it('does not treat approval/input pauses as lost workers', async () => {
    const runtime = fixture({ runtimeState: 'waiting_approval' });
    await expect(runtime.service.reconcileGoal('goal-1')).resolves.toEqual({
      goalId: 'goal-1',
      disposition: 'state_not_worker_backed',
      reason: 'waiting_approval',
    });
    expect(runtime.append).not.toHaveBeenCalled();
  });

  it('retries snapshot projection idempotently after a crash-window write failure', async () => {
    const runtime = fixture({ failFirstStore: true });
    await expect(runtime.service.reconcileGoal('goal-1')).resolves.toEqual({
      goalId: 'goal-1',
      disposition: 'projection_pending',
      reason: 'snapshot_write_failed',
      eventSequence: 3,
    });
    await expect(runtime.service.reconcileGoal('goal-1')).resolves.toMatchObject({
      goalId: 'goal-1',
      disposition: 'reconciled',
      eventSequence: 3,
    });

    expect(runtime.append).toHaveBeenCalledTimes(2);
    expect(runtime.append.mock.calls[1]![0].event).toEqual(runtime.append.mock.calls[0]![0].event);
    expect(runtime.stored).toHaveLength(1);
    expect(runtime.stored[0]!.projection.runtimeState).toBe('recovery_required');
  });
});
