import { describe, expect, it } from 'vitest';
import type {
  GoalRecord,
  GoalTrackedTask,
  ScheduledContinuationWorkerLiveness,
} from './index.js';
import {
  assessGoalWorkerLiveness,
  DEFAULT_GOAL_STALE_HEARTBEAT_GRACE_SECONDS,
} from './goal-runtime-liveness.js';

const now = '2026-09-21T13:01:00.000Z';

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    goalKey: 'runtime-liveness',
    workspaceId: 'workspace-1',
    ownerClientId: 'client-1',
    objective: 'Keep Goal runtime truth aligned with trustworthy worker liveness.',
    plan: { steps: [] },
    status: 'active',
    revision: 2,
    currentPhase: 'test',
    nextAction: 'continue',
    blockers: [],
    activeTaskIds: [],
    leaseGeneration: 3,
    leaseActivitySeq: 4,
    leaseHeartbeatAt: '2026-09-21T13:00:00.000Z',
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T13:00:00.000Z',
    checkpoints: [],
    ...overrides,
  };
}

function task(
  taskId: string,
  provider: GoalTrackedTask['provider'] = 'shell',
): GoalTrackedTask {
  return { taskId, provider, role: 'blocking_job', cancelWithGoal: true };
}

function evidence(
  overrides: Partial<ScheduledContinuationWorkerLiveness> = {},
): ScheduledContinuationWorkerLiveness {
  return {
    trustworthy: true,
    observedAt: now,
    leaseGeneration: 3,
    leaseActivitySeq: 4,
    liveFencedCallCount: 0,
    blockingTaskStates: [],
    ...overrides,
  };
}

describe('assessGoalWorkerLiveness', () => {
  it('fails closed when evidence is missing, untrusted, or belongs to another generation', () => {
    expect(assessGoalWorkerLiveness({
      goal: goal(),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'untrusted', reason: 'missing_evidence' });

    expect(assessGoalWorkerLiveness({
      goal: goal(),
      evidence: evidence({ trustworthy: false }),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'untrusted', reason: 'evidence_untrustworthy' });

    expect(assessGoalWorkerLiveness({
      goal: goal(),
      evidence: evidence({ leaseGeneration: 2 }),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'untrusted', reason: 'generation_mismatch' });
  });

  it('treats a live fenced call or goal-owned blocking task as authoritative activity', () => {
    expect(assessGoalWorkerLiveness({
      goal: goal(),
      evidence: evidence({ liveFencedCallCount: 1 }),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'live', reason: 'fenced_call' });

    expect(assessGoalWorkerLiveness({
      goal: goal({ trackedTasks: [task('shell-1')] }),
      evidence: evidence({
        blockingTaskStates: [{ taskId: 'shell-1', provider: 'shell', state: 'running' }],
      }),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'live', reason: 'blocking_task' });
  });

  it('fails closed when a required blocking task is unknown or missing from evidence', () => {
    const tracked = goal({ trackedTasks: [task('shell-1')] });

    expect(assessGoalWorkerLiveness({
      goal: tracked,
      evidence: evidence({
        trustworthy: false,
        blockingTaskStates: [{ taskId: 'shell-1', provider: 'shell', state: 'unknown' }],
      }),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'untrusted', reason: 'evidence_untrustworthy' });

    expect(assessGoalWorkerLiveness({
      goal: tracked,
      evidence: evidence(),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'untrusted', reason: 'blocking_task_unknown' });
  });

  it('allows immediate inactivity only when no live rolling watchdog remains', () => {
    expect(assessGoalWorkerLiveness({
      goal: goal(),
      evidence: evidence(),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'inactive', reason: 'no_live_worker' });
  });

  it('preserves the shared 60-second stale-heartbeat grace for a live watchdog', () => {
    expect(DEFAULT_GOAL_STALE_HEARTBEAT_GRACE_SECONDS).toBe(60);
    expect(assessGoalWorkerLiveness({
      goal: goal({ leaseHeartbeatAt: '2026-09-21T13:00:30.000Z' }),
      evidence: evidence(),
      now,
      hasLiveScheduledContinuation: true,
    })).toEqual({
      state: 'live',
      reason: 'heartbeat_grace',
      retryAfterSeconds: 30,
    });

    expect(assessGoalWorkerLiveness({
      goal: goal({ leaseHeartbeatAt: '2026-09-21T12:59:59.000Z' }),
      evidence: evidence(),
      now,
      hasLiveScheduledContinuation: true,
    })).toEqual({ state: 'inactive', reason: 'stale_heartbeat' });
  });

  it('does not turn missing or future heartbeat data into worker loss', () => {
    expect(assessGoalWorkerLiveness({
      goal: goal({ leaseHeartbeatAt: undefined }),
      evidence: evidence(),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'untrusted', reason: 'missing_heartbeat' });

    expect(assessGoalWorkerLiveness({
      goal: goal({ leaseHeartbeatAt: '2026-09-21T13:02:00.000Z' }),
      evidence: evidence(),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'untrusted', reason: 'future_heartbeat' });
  });

  it('supports migrated legacy task evidence without weakening provider matching', () => {
    expect(assessGoalWorkerLiveness({
      goal: goal({ activeTaskIds: ['legacy-1'] }),
      evidence: evidence({
        blockingTaskStates: undefined,
        activeTaskStates: [{ taskId: 'legacy-1', state: 'terminal' }],
      }),
      now,
      hasLiveScheduledContinuation: false,
    })).toEqual({ state: 'inactive', reason: 'no_live_worker' });
  });
});
