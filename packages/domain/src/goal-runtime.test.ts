import { describe, expect, it } from 'vitest';
import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  isGoalBlockerKind,
  isGoalDesiredRuntimeState,
  isGoalIntegrationState,
  isGoalLifecycleState,
  isGoalRuntimeState,
  isGoalWorkspaceState,
  type GoalRuntimeProjection,
} from './goal-runtime.js';

describe('goal runtime contracts', () => {
  it('keeps lifecycle, runtime, integration and workspace truth independent', () => {
    const snapshot: GoalRuntimeProjection = {
      contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
      goalId: 'goal-1',
      workspaceId: 'workspace-1',
      lifecycleState: 'completed',
      runtimeState: 'idle',
      desiredRuntimeState: 'idle',
      integrationState: 'pending',
      workspaceState: 'dirty',
      phase: 'integration',
      lastActivityAt: '2026-09-21T11:40:00.000Z',
      blocker: {
        kind: 'dirty_workspace',
        detail: 'Workspace still contains unintegrated changes.',
      },
    };

    expect(snapshot).toMatchObject({
      lifecycleState: 'completed',
      runtimeState: 'idle',
      desiredRuntimeState: 'idle',
      integrationState: 'pending',
      workspaceState: 'dirty',
      blocker: { kind: 'dirty_workspace' },
    });
  });

  it('represents one concrete execution generation without collapsing it into Goal lifecycle', () => {
    const snapshot: GoalRuntimeProjection = {
      contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
      goalId: 'goal-2',
      workspaceId: 'workspace-2',
      lifecycleState: 'open',
      runtimeState: 'running',
      desiredRuntimeState: 'running',
      integrationState: 'not_started',
      workspaceState: 'clean',
      activeExecutionId: 'execution-42',
      executionGeneration: 3,
      phase: 'test',
      progress: {
        phase: 'test',
        steps: [
          { id: 'inspect', title: 'Inspect', state: 'completed' },
          { id: 'test', title: 'Integration tests', state: 'running' },
        ],
      },
      lastActivityAt: '2026-09-21T11:41:00.000Z',
      lastHeartbeatAt: '2026-09-21T11:41:00.000Z',
    };

    expect(snapshot.activeExecutionId).toBe('execution-42');
    expect(snapshot.executionGeneration).toBe(3);
    expect(snapshot.lifecycleState).toBe('open');
    expect(snapshot.runtimeState).toBe('running');
  });

  it('exposes strict guards for persisted/projected state decoding', () => {
    expect(isGoalLifecycleState('archived')).toBe(true);
    expect(isGoalLifecycleState('running')).toBe(false);

    expect(isGoalRuntimeState('recovery_required')).toBe(true);
    expect(isGoalRuntimeState('completed')).toBe(false);

    expect(isGoalDesiredRuntimeState('idle')).toBe(true);
    expect(isGoalDesiredRuntimeState('paused')).toBe(true);
    expect(isGoalDesiredRuntimeState('blocked')).toBe(false);

    expect(isGoalIntegrationState('integrated')).toBe(true);
    expect(isGoalIntegrationState('dirty')).toBe(false);

    expect(isGoalWorkspaceState('unavailable')).toBe(true);
    expect(isGoalWorkspaceState('queued')).toBe(false);

    expect(isGoalBlockerKind('worker_lost')).toBe(true);
    expect(isGoalBlockerKind('made_up')).toBe(false);
  });
});
