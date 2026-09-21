import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GoalStateError,
  type GoalRuntimeSnapshotRecord,
  type ScheduledContinuationRepository,
} from '@unified-mpc/domain';
import { GoalMutationFenceService } from './goal-mutation-fence-service.js';
import type { GoalRuntimeEventPublisher } from './goal-runtime-control-plane-service.js';

const actor = { clientId: 'client-a', clientName: 'Client A', sessionId: 'shared-session' };

function repository(overrides: Partial<ScheduledContinuationRepository> = {}): ScheduledContinuationRepository {
  return {
    getWorkspaceMutationFence: vi.fn(async () => null),
    beginGoalFencedMutation: vi.fn(async (request) => ({ goalId: request.goalId, leaseGeneration: request.leaseGeneration })),
    heartbeatGoalFencedMutation: vi.fn(async () => undefined),
    endGoalFencedMutation: vi.fn(async () => undefined),
    observeGoalFencedMutations: vi.fn(async () => ({ workspaceId: 'workspace-1', leaseGeneration: 3, leaseActivitySeq: 4, liveFencedCallCount: 0 })),
    prepareScheduledContinuation: vi.fn() as never,
    recordScheduledContinuationReceipt: vi.fn() as never,
    claimScheduledContinuation: vi.fn() as never,
    expediteScheduledContinuation: vi.fn() as never,
    getScheduledContinuation: vi.fn() as never,
    getLiveScheduledContinuation: vi.fn() as never,
    markGoalFinishedForScheduledContinuation: vi.fn() as never,
    ...overrides,
  };
}

describe('GoalMutationFenceService', () => {
  it('hashes the private token, preserves lease generation, and never forwards the raw token to storage', async (): Promise<void> => {
    const beginGoalFencedMutation = vi.fn(async (request): Promise<{ goalId: string; leaseGeneration: number }> => ({ goalId: request.goalId, leaseGeneration: request.leaseGeneration }));
    const repo = repository({ beginGoalFencedMutation });
    const service = new GoalMutationFenceService(repo, { now: (): Date => new Date('2026-08-27T10:00:00.000Z') });
    const result = await service.begin(actor, 'workspace-1', 'call-1', {
      goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 7,
    });
    expect(result).toMatchObject({ ok: true, value: { goalId: 'goal-1', leaseGeneration: 7 } });
    expect(beginGoalFencedMutation).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1', workspaceId: 'workspace-1', leaseGeneration: 7,
      ownerClientId: 'client-a', ownerSessionId: 'shared-session',
      leaseTokenHash: createHash('sha256').update('private-token').digest('hex'),
    }));
    expect(JSON.stringify(beginGoalFencedMutation.mock.calls)).not.toContain('private-token');
  });

  it('exposes an active workspace fence to a different client so takeover is decided by the current lease proof, not creator identity', async (): Promise<void> => {
    const service = new GoalMutationFenceService(repository({
      getWorkspaceMutationFence: vi.fn(async () => ({
        goal: { id: 'goal-1', ownerClientId: 'creator-client', leaseGeneration: 9 } as never,
        continuation: {} as never,
      })),
    }));

    await expect(service.inspectWorkspaceFence(
      { clientId: 'takeover-client', clientName: 'Takeover', sessionId: 'session-b' },
      'workspace-1',
    )).resolves.toMatchObject({ ok: true, value: { goalId: 'goal-1', leaseGeneration: 9 } });
  });

  it('fails closed when a stale token/generation is rejected by the CAS repository', async (): Promise<void> => {
    const repo = repository({
      beginGoalFencedMutation: vi.fn(async (): Promise<never> => { throw new GoalStateError('lease_invalid', 'stale generation'); }),
    });
    const service = new GoalMutationFenceService(repo);
    await expect(service.begin(actor, 'workspace-1', 'call-old', {
      goalId: 'goal-1', leaseToken: 'old-token', leaseGeneration: 1,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        recoverable: true,
        message: expect.stringContaining('reacquire or claim the scheduled continuation'),
      },
    });
  });

  it('marks liveness untrustworthy when any managed task state is unknown', async (): Promise<void> => {
    const read = vi.fn(async (_workspaceId: string, taskId: string): Promise<'running' | 'unknown'> => (
      taskId === 'running' ? 'running' : 'unknown'
    ));
    const service = new GoalMutationFenceService(repository(), {
      now: (): Date => new Date('2026-08-27T10:00:00.000Z'),
      taskStateReader: { read },
    });
    await expect(service.observe('goal-1', ['running', 'unknown'])).resolves.toMatchObject({
      trustworthy: false,
      leaseGeneration: 3,
      leaseActivitySeq: 4,
      activeTaskStates: [
        { taskId: 'running', state: 'running' },
        { taskId: 'unknown', state: 'unknown' },
      ],
    });
    expect(read).toHaveBeenNthCalledWith(1, 'workspace-1', 'running');
    expect(read).toHaveBeenNthCalledWith(2, 'workspace-1', 'unknown');
  });

  it('treats an empty process/task view with no live fenced calls as trustworthy inactivity', async (): Promise<void> => {
    const read = vi.fn();
    const service = new GoalMutationFenceService(repository(), {
      now: (): Date => new Date('2026-08-27T10:00:00.000Z'),
      taskStateReader: { read: read as never },
    });

    await expect(service.observe('goal-1', [])).resolves.toMatchObject({
      trustworthy: true,
      leaseGeneration: 3,
      leaseActivitySeq: 4,
      liveFencedCallCount: 0,
      blockingTaskStates: [],
      activeTaskStates: [],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('observes only blocking goal tasks for worker liveness', async (): Promise<void> => {
    const read = vi.fn(async (_workspaceId: string, task: { taskId: string }): Promise<'running' | 'terminal'> => (
      task.taskId === 'job-1' ? 'running' : 'terminal'
    ));
    const service = new GoalMutationFenceService(repository(), {
      taskStateReader: { read: read as never },
    });

    await expect(service.observe('goal-1', [
      { taskId: 'job-1', provider: 'shell', role: 'blocking_job', cancelWithGoal: true },
      { taskId: 'db-1', provider: 'shell', role: 'supporting_service', cancelWithGoal: false },
    ] as never)).resolves.toMatchObject({
      trustworthy: true,
      blockingTaskStates: [{ taskId: 'job-1', provider: 'shell', state: 'running' }],
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('publishes execution activity only after an exact-generation fenced mutation is admitted', async (): Promise<void> => {
    const ensureGoalSnapshot = vi.fn(async (): Promise<GoalRuntimeSnapshotRecord> => runtimeSnapshot());
    const publishGoalRuntimeEvent = vi.fn(async (): Promise<GoalRuntimeSnapshotRecord> =>
      runtimeSnapshot({ runtimeState: 'running', lastHeartbeatAt: '2026-08-27T10:00:10.000Z' }));
    const runtimeEvents: GoalRuntimeEventPublisher = { ensureGoalSnapshot, publishGoalRuntimeEvent };
    const times = [
      new Date('2026-08-27T10:00:00.000Z'),
      new Date('2026-08-27T10:00:10.000Z'),
      new Date('2026-08-27T10:00:20.000Z'),
    ];
    const service = new GoalMutationFenceService(repository(), {
      now: (): Date => times.shift() ?? new Date('2026-08-27T10:00:20.000Z'),
      runtimeEvents,
    });

    await expect(service.begin(actor, 'workspace-1', 'call-runtime', {
      goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 3,
    })).resolves.toMatchObject({ ok: true });

    expect(ensureGoalSnapshot).toHaveBeenCalledWith('goal-1');
    expect(publishGoalRuntimeEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'execution_started',
      workspaceId: 'workspace-1',
      goalId: 'goal-1',
      executionId: 'execution-3',
      executionGeneration: 3,
      occurredAt: '2026-08-27T10:00:00.000Z',
    }));

    await service.heartbeat('call-runtime', 3);
    expect(publishGoalRuntimeEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'execution_heartbeat',
      executionId: 'execution-3',
      executionGeneration: 3,
      occurredAt: '2026-08-27T10:00:10.000Z',
    }));

    await service.end('call-runtime');
    await service.heartbeat('call-runtime', 3);
    expect(publishGoalRuntimeEvent).toHaveBeenCalledTimes(2);
  });

  it('refreshes workspace truth after admitted fenced work ends without probing on heartbeat', async (): Promise<void> => {
    const refreshGoalWorkspaceTruth = vi.fn(async (): Promise<GoalRuntimeSnapshotRecord> =>
      runtimeSnapshot({ workspaceState: 'dirty' }));
    const runtimeEvents: GoalRuntimeEventPublisher = {
      ensureGoalSnapshot: vi.fn(async (): Promise<GoalRuntimeSnapshotRecord> => runtimeSnapshot()),
      publishGoalRuntimeEvent: vi.fn(async (): Promise<GoalRuntimeSnapshotRecord> =>
        runtimeSnapshot({ runtimeState: 'running' })),
      refreshGoalWorkspaceTruth,
    };
    const times = [
      new Date('2026-08-27T10:00:00.000Z'),
      new Date('2026-08-27T10:00:10.000Z'),
      new Date('2026-08-27T10:00:20.000Z'),
    ];
    const service = new GoalMutationFenceService(repository(), {
      now: (): Date => times.shift() ?? new Date('2026-08-27T10:00:20.000Z'),
      runtimeEvents,
    });

    await service.begin(actor, 'workspace-1', 'call-workspace', {
      goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 3,
    });
    await service.heartbeat('call-workspace', 3);
    expect(refreshGoalWorkspaceTruth).not.toHaveBeenCalled();

    await expect(service.end('call-workspace')).resolves.toBeUndefined();
    expect(refreshGoalWorkspaceTruth).toHaveBeenCalledTimes(1);
    expect(refreshGoalWorkspaceTruth).toHaveBeenCalledWith('goal-1');
  });

  it('keeps fence completion successful when workspace observation fails', async (): Promise<void> => {
    const runtimeEvents: GoalRuntimeEventPublisher = {
      ensureGoalSnapshot: vi.fn(async (): Promise<GoalRuntimeSnapshotRecord> => runtimeSnapshot()),
      publishGoalRuntimeEvent: vi.fn(async (): Promise<GoalRuntimeSnapshotRecord> => runtimeSnapshot()),
      refreshGoalWorkspaceTruth: vi.fn(async (): Promise<never> => {
        throw new Error('workspace probe unavailable');
      }),
    };
    const service = new GoalMutationFenceService(repository(), { runtimeEvents });

    await service.begin(actor, 'workspace-1', 'call-workspace-side-path', {
      goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 3,
    });
    await expect(service.end('call-workspace-side-path')).resolves.toBeUndefined();
  });

  it('keeps durable fence admission successful when runtime projection delivery is unavailable', async (): Promise<void> => {
    const service = new GoalMutationFenceService(repository(), {
      runtimeEvents: {
        ensureGoalSnapshot: vi.fn(async (): Promise<never> => { throw new Error('runtime store unavailable'); }),
        publishGoalRuntimeEvent: vi.fn() as never,
      },
    });

    await expect(service.begin(actor, 'workspace-1', 'call-side-path', {
      goalId: 'goal-1', leaseToken: 'private-token', leaseGeneration: 3,
    })).resolves.toMatchObject({ ok: true });
  });
});

function runtimeSnapshot(
  overrides: Partial<GoalRuntimeSnapshotRecord['projection']> = {},
): GoalRuntimeSnapshotRecord {
  return {
    projection: {
      contractVersion: 1,
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      lifecycleState: 'open',
      runtimeState: 'queued',
      desiredRuntimeState: 'running',
      integrationState: 'unknown',
      workspaceState: 'unknown',
      activeExecutionId: 'execution-3',
      executionGeneration: 3,
      lastActivityAt: '2026-08-27T10:00:00.000Z',
      ...overrides,
    },
    lastEventSequence: 1,
    updatedAt: '2026-08-27T10:00:00.000Z',
  };
}
