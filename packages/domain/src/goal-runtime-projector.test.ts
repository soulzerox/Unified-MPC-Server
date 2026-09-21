import { describe, expect, it } from 'vitest';
import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  projectGoalRuntimeEvent,
  type GoalRuntimeEvent,
  type GoalRuntimeProjection,
} from './index.js';

const base = (overrides: Partial<GoalRuntimeProjection> = {}): GoalRuntimeProjection => ({
  contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
  goalId: 'goal-1',
  workspaceId: 'workspace-1',
  lifecycleState: 'open',
  runtimeState: 'idle',
  desiredRuntimeState: 'idle',
  integrationState: 'not_started',
  workspaceState: 'clean',
  lastActivityAt: '2026-09-21T13:00:00.000Z',
  ...overrides,
});

const executionEvent = (
  type: Extract<GoalRuntimeEvent, { executionId: string }>['type'],
  overrides: Partial<Extract<GoalRuntimeEvent, { executionId: string }>> = {},
): Extract<GoalRuntimeEvent, { executionId: string }> => ({
  eventId: `event-${type}`,
  type,
  workspaceId: 'workspace-1',
  goalId: 'goal-1',
  executionId: 'execution-1',
  executionGeneration: 1,
  occurredAt: '2026-09-21T13:00:01.000Z',
  ...overrides,
});

describe('projectGoalRuntimeEvent', () => {
  it('projects submission/start/heartbeat from durable execution identity', () => {
    const submitted = projectGoalRuntimeEvent(base(), executionEvent('execution_submitted'));
    expect(submitted).toMatchObject({
      decision: { disposition: 'apply' },
      projection: {
        runtimeState: 'queued',
        desiredRuntimeState: 'running',
        activeExecutionId: 'execution-1',
        executionGeneration: 1,
      },
    });

    const started = projectGoalRuntimeEvent(submitted.projection, executionEvent('execution_started'));
    expect(started.projection.runtimeState).toBe('running');

    const heartbeat = projectGoalRuntimeEvent(started.projection, executionEvent('execution_heartbeat', {
      occurredAt: '2026-09-21T13:00:05.000Z',
    }));
    expect(heartbeat.projection.lastHeartbeatAt).toBe('2026-09-21T13:00:05.000Z');
  });

  it('keeps desired pause/cancel separate from observed runtime until acknowledgement', () => {
    const running = base({
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
    });

    const pauseRequested = projectGoalRuntimeEvent(running, executionEvent('execution_pause_requested'));
    expect(pauseRequested.projection).toMatchObject({
      desiredRuntimeState: 'paused',
      runtimeState: 'running',
    });

    const paused = projectGoalRuntimeEvent(pauseRequested.projection, executionEvent('execution_paused'));
    expect(paused.projection).toMatchObject({
      desiredRuntimeState: 'paused',
      runtimeState: 'paused',
    });

    const resumed = projectGoalRuntimeEvent(paused.projection, executionEvent('execution_resumed'));
    const cancelRequested = projectGoalRuntimeEvent(resumed.projection, executionEvent('execution_cancel_requested'));
    expect(cancelRequested.projection).toMatchObject({
      desiredRuntimeState: 'cancelled',
      runtimeState: 'running',
    });
  });

  it('turns approval/input/task failure into first-class blockers and clears matching blockers', () => {
    const running = base({
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
    });

    const approval = projectGoalRuntimeEvent(running, executionEvent('approval_required', {
      detail: 'Host approval required.',
    }));
    expect(approval.projection).toMatchObject({
      runtimeState: 'waiting_approval',
      blocker: { kind: 'waiting_approval', detail: 'Host approval required.' },
    });

    const approved = projectGoalRuntimeEvent(approval.projection, executionEvent('approval_resolved'));
    expect(approved.projection.runtimeState).toBe('running');
    expect(approved.projection.blocker).toBeUndefined();

    const failedTask = projectGoalRuntimeEvent(approved.projection, executionEvent('task_failed', {
      taskId: 'task-1',
      detail: 'Integration test failed.',
    }));
    expect(failedTask.projection).toMatchObject({
      runtimeState: 'blocked',
      blocker: { kind: 'task_failed' },
    });
  });

  it('requires structured fields instead of fabricating phase/task/checkpoint progress', () => {
    const running = base({
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
    });

    expect(projectGoalRuntimeEvent(running, executionEvent('phase_started'))).toMatchObject({
      decision: { disposition: 'reject', reason: 'missing_event_data' },
      projection: running,
    });
    expect(projectGoalRuntimeEvent(running, executionEvent('task_progress'))).toMatchObject({
      decision: { disposition: 'reject', reason: 'missing_event_data' },
    });
    expect(projectGoalRuntimeEvent(running, executionEvent('checkpoint_created'))).toMatchObject({
      decision: { disposition: 'reject', reason: 'missing_event_data' },
    });
  });

  it('completes one execution without fabricating Goal lifecycle or integration completion', () => {
    const running = base({
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      integrationState: 'pending',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
    });

    const completed = projectGoalRuntimeEvent(running, executionEvent('execution_completed'));
    expect(completed.projection).toMatchObject({
      lifecycleState: 'open',
      runtimeState: 'idle',
      desiredRuntimeState: 'idle',
      integrationState: 'pending',
      executionGeneration: 1,
    });
    expect(completed.projection.activeExecutionId).toBeUndefined();

    const lateProgress = projectGoalRuntimeEvent(completed.projection, executionEvent('task_progress', {
      taskId: 'task-late',
    }));
    expect(lateProgress.decision).toEqual({ disposition: 'reject', reason: 'terminal_generation' });

    const integration = projectGoalRuntimeEvent(completed.projection, executionEvent('integration_started'));
    expect(integration.projection.integrationState).toBe('integrating');
  });

  it('projects worker loss as recovery_required rather than fake completion', () => {
    const running = base({
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
      lastHeartbeatAt: '2026-09-21T13:00:00.000Z',
    });
    const lost = projectGoalRuntimeEvent(running, executionEvent('worker_lost', {
      detail: 'Heartbeat lease expired.',
    }));
    expect(lost.projection).toMatchObject({
      lifecycleState: 'open',
      runtimeState: 'recovery_required',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
      blocker: { kind: 'worker_lost' },
    });
  });

  it('rejects goal completion while runtime evidence still says an execution is active', () => {
    const running = base({
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
    });
    const event: GoalRuntimeEvent = {
      eventId: 'goal-completed',
      type: 'goal_completed',
      workspaceId: 'workspace-1',
      goalId: 'goal-1',
      occurredAt: '2026-09-21T13:00:02.000Z',
    };
    expect(projectGoalRuntimeEvent(running, event)).toMatchObject({
      decision: { disposition: 'reject', reason: 'projection_invariant' },
      projection: running,
    });
  });

  it('accepts a takeover submission only as the next generation and replaces active identity', () => {
    const running = base({
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      activeExecutionId: 'execution-1',
      executionGeneration: 1,
    });
    const takeover = projectGoalRuntimeEvent(running, executionEvent('execution_submitted', {
      executionId: 'execution-2',
      executionGeneration: 2,
    }));
    expect(takeover).toMatchObject({
      decision: { disposition: 'apply' },
      projection: {
        activeExecutionId: 'execution-2',
        executionGeneration: 2,
        runtimeState: 'queued',
      },
    });
  });

  it('never treats goal_selected as runtime activity', () => {
    const current = base();
    const selected: GoalRuntimeEvent = {
      eventId: 'selected-1',
      type: 'goal_selected',
      workspaceId: 'workspace-1',
      goalId: 'goal-1',
      occurredAt: '2026-09-21T13:10:00.000Z',
    };
    expect(projectGoalRuntimeEvent(current, selected)).toEqual({
      decision: { disposition: 'apply' },
      projection: current,
    });
  });
});
