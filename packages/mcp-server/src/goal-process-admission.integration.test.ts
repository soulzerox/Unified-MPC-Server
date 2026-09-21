import { describe, expect, it, vi } from 'vitest';
import { ok } from '@unified-mpc/domain';
import { permissionProfiles } from '@unified-mpc/permissions';
import {
  DEFAULT_GOAL_PROCESS_ADMISSION_COST,
  ResourceAdmissionController,
  tryAdmitGoalProcess,
} from '@unified-mpc/workspace';
import { GoalProcessAdmissionTracker, sharedProcessGoalProcessAdmissionTracker } from './goal-process-admission.js';
import { ToolRegistry, type McpApplicationServices } from './tool-registry.js';

const actor = { clientId: 'goal-process-client', clientName: 'goal-process-test', sessionId: 'session-a' };
const goalLease = { goalId: 'goal-1', leaseToken: 'lease-token', leaseGeneration: 2 };

function controller(): ResourceAdmissionController {
  return new ResourceAdmissionController({
    globalCost: 8,
    workspaceCost: 8,
    sessionCost: 8,
    maxOperations: 4,
    resourceClassCost: { goal_process: 8 },
  });
}

function runningProcess(processId = 'process-1') {
  return {
    processId,
    executable: 'pnpm',
    args: ['test'],
    cwd: '/workspace',
    state: 'running' as const,
    startedAt: '2026-09-21T16:00:00.000Z',
  };
}

describe('Goal-owned managed process resource admission', () => {
  it('holds #13 capacity after project_test returns until the real process becomes terminal', async () => {
    const admission = controller();
    let state: 'running' | 'exited' = 'running';
    const inspectWorkspaceFence = vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', leaseGeneration: 2 }));
    const begin = vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', leaseGeneration: 2 }));
    const end = vi.fn().mockResolvedValue(undefined);
    const statusForGoalLiveness = vi.fn(() => ok({ ...runningProcess(), state }));
    const startProjectCommand = vi.fn().mockResolvedValue(ok(runningProcess()));
    const services = {
      goalMutationFence: { inspectWorkspaceFence, begin, heartbeat: vi.fn(), end },
      process: {
        previewProjectCommand: vi.fn().mockResolvedValue(ok({ executable: 'pnpm', args: ['test'] })),
        startProjectCommand,
        statusForGoalLiveness,
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      sessionId: actor.sessionId,
      profileProvider: () => permissionProfiles.full,
      authorizationModeProvider: () => 'full_bypass',
      resourceAdmissionController: admission,
      goalProcessAdmissionCost: DEFAULT_GOAL_PROCESS_ADMISSION_COST,
    });

    const response = await registry.invoke('project_test', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
      goalLease,
    });

    expect(response.isError).not.toBe(true);
    expect(startProjectCommand).toHaveBeenCalledTimes(1);
    expect(admission.snapshot()).toMatchObject({
      activeCost: 8,
      activeOperations: 1,
      activeCostByClass: { goal_process: 8 },
    });
    const tracker = sharedProcessGoalProcessAdmissionTracker(admission);
    expect(tracker.has('workspace-1', 'process-1')).toBe(true);

    state = 'exited';
    expect(tracker.reconcile('workspace-1', 'process-1', { state })).toBe(true);
    expect(admission.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
  });

  it('rejects a second Goal process before backend launch when shared capacity is saturated', async () => {
    const admission = controller();
    const held = tryAdmitGoalProcess(admission, {
      operationId: 'already-running',
      workspaceId: 'workspace-2',
      sessionId: 'session-b',
      cost: 8,
    });
    if (!held.admitted) throw new Error('expected saturation lease');

    const startProjectCommand = vi.fn().mockResolvedValue(ok(runningProcess('process-2')));
    const end = vi.fn().mockResolvedValue(undefined);
    const services = {
      goalMutationFence: {
        inspectWorkspaceFence: vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', leaseGeneration: 2 })),
        begin: vi.fn().mockResolvedValue(ok({ goalId: 'goal-1', leaseGeneration: 2 })),
        heartbeat: vi.fn(),
        end,
      },
      process: {
        previewProjectCommand: vi.fn().mockResolvedValue(ok({ executable: 'pnpm', args: ['test'] })),
        startProjectCommand,
        statusForGoalLiveness: vi.fn(() => ok(runningProcess('process-2'))),
      },
    } as unknown as McpApplicationServices;
    const registry = new ToolRegistry(services, actor, {
      sessionId: actor.sessionId,
      profileProvider: () => permissionProfiles.full,
      authorizationModeProvider: () => 'full_bypass',
      resourceAdmissionController: admission,
      goalProcessAdmissionCost: 8,
    });

    const response = await registry.invoke('project_test', {
      workspaceId: 'workspace-1',
      userConfirmed: true,
      goalLease,
    });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'RESOURCE_PRESSURE' } },
    });
    expect(startProjectCommand).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(admission.release(held.lease)).toBe(true);
  });

  it('releases process-owned capacity without client polling once the process reaches terminal state', async () => {
    vi.useFakeTimers();
    try {
      const admission = controller();
      const held = tryAdmitGoalProcess(admission, {
        operationId: 'poll-owned',
        workspaceId: 'workspace-1',
        sessionId: 'session-a',
        cost: 8,
      });
      if (!held.admitted) throw new Error('expected process admission');
      let state: 'running' | 'exited' = 'running';
      const tracker = new GoalProcessAdmissionTracker(admission, { pollIntervalMs: 10 });
      expect(tracker.bind({
        workspaceId: 'workspace-1',
        processId: 'process-poll',
        lease: held.lease,
        initialStatus: { state },
        readStatus: () => ok({ state }),
      })).toBe(true);

      state = 'exited';
      await vi.advanceTimersByTimeAsync(10);

      expect(admission.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
      expect(tracker.has('workspace-1', 'process-poll')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
