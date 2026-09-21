import { ok } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';
import { ModernTasksProtocol } from './modern-tasks-protocol.js';
import type { McpToolResponse } from './result-mapper.js';
import type { McpApplicationServices } from './tool-registry.js';

const actor = {
  clientId: 'modern-goal-client',
  clientName: 'modern-goal-client',
  sessionId: 'modern-goal-session',
};

function runGoalResponse(
  executionId: string,
  executionGeneration: number,
  leaseToken = 'secret-lease-token-that-must-not-enter-task-id',
): McpToolResponse {
  const structuredContent = {
    goalId: 'goal-1',
    executionId,
    executionGeneration,
    goalKey: 'issue-64',
    status: 'active',
    revision: 0,
    acquired: true,
    leaseToken,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

describe('ModernTasksProtocol durable goal execution bridge', () => {
  it('creates a non-secret task handle backed by the persisted exact execution and cancels that generation', async () => {
    let receiptState: 'active' | 'terminal' = 'active';
    let goalStatus: 'active' | 'cancelled' = 'active';
    const cancellations: Array<{ executionId: string; executionGeneration: number }> = [];
    const goals = {
      async getGoalExecution(_actor: unknown, request: { executionId: string }) {
        return ok({
          id: request.executionId,
          goalId: 'goal-1',
          workspaceId: 'workspace-1',
          executionGeneration: 3,
          leaseGeneration: 3,
          ownerClientId: actor.clientId,
          ownerSessionId: actor.sessionId,
          receiptState,
          createdAt: '2026-09-21T10:00:00.000Z',
          updatedAt: '2026-09-21T10:00:01.000Z',
        });
      },
      async getGoal() {
        return ok({
          goalId: 'goal-1',
          workspaceId: 'workspace-1',
          status: goalStatus,
        });
      },
      async cancelGoalExecution(
        _actor: unknown,
        request: { executionId: string; executionGeneration: number },
      ) {
        cancellations.push(request);
        receiptState = 'terminal';
        goalStatus = 'cancelled';
        return ok({ goalId: 'goal-1', status: 'cancelled' });
      },
    } as unknown as NonNullable<McpApplicationServices['goals']>;
    const protocol = new ModernTasksProtocol({ goals }, { actor });

    const created = await protocol.maybeCreateTask(
      'run_goal',
      { workspaceId: 'workspace-1' },
      runGoalResponse('execution-3', 3),
    );
    expect(created).toMatchObject({
      resultType: 'task',
      status: 'working',
    });
    if (created === undefined) throw new Error('expected durable goal task');

    const encodedDescriptor = JSON.parse(
      Buffer.from(created.taskId.slice('unified-mpc-task-v1.'.length), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(encodedDescriptor).toMatchObject({
      provider: 'goal',
      backingId: 'execution-3',
      goalId: 'goal-1',
      executionGeneration: 3,
      workspaceId: 'workspace-1',
    });
    expect(encodedDescriptor).not.toHaveProperty('leaseToken');
    expect(JSON.stringify(encodedDescriptor)).not.toContain('secret-lease-token');

    await expect(protocol.getTask({ taskId: created.taskId })).resolves.toMatchObject({
      status: 'working',
    });
    await expect(protocol.cancelTask({ taskId: created.taskId })).resolves.toEqual({
      resultType: 'complete',
    });
    expect(cancellations).toEqual([
      { executionId: 'execution-3', executionGeneration: 3 },
    ]);
    await expect(protocol.getTask({ taskId: created.taskId })).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('treats a superseded stale execution handle as terminal and never forwards cancellation to the newer generation', async () => {
    let cancelCalls = 0;
    const goals = {
      async getGoalExecution() {
        return ok({
          id: 'execution-1',
          goalId: 'goal-1',
          workspaceId: 'workspace-1',
          executionGeneration: 1,
          leaseGeneration: 1,
          ownerClientId: actor.clientId,
          ownerSessionId: actor.sessionId,
          receiptState: 'superseded',
          createdAt: '2026-09-21T09:00:00.000Z',
          updatedAt: '2026-09-21T10:00:00.000Z',
        });
      },
      async getGoal() {
        return ok({
          goalId: 'goal-1',
          workspaceId: 'workspace-1',
          status: 'active',
          executionId: 'execution-2',
          executionGeneration: 2,
        });
      },
      async cancelGoalExecution() {
        cancelCalls += 1;
        throw new Error('stale task cancellation must not be forwarded');
      },
    } as unknown as NonNullable<McpApplicationServices['goals']>;
    const protocol = new ModernTasksProtocol({ goals }, { actor });

    const created = await protocol.maybeCreateTask(
      'run_goal',
      { workspaceId: 'workspace-1' },
      runGoalResponse('execution-1', 1),
    );
    expect(created).toMatchObject({
      resultType: 'task',
      status: 'cancelled',
      statusMessage: 'Execution was superseded by a newer generation',
    });
    if (created === undefined) throw new Error('expected stale execution task');

    await expect(protocol.cancelTask({ taskId: created.taskId })).resolves.toEqual({
      resultType: 'complete',
    });
    expect(cancelCalls).toBe(0);
  });
});
