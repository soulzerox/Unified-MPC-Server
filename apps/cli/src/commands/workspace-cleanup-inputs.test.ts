import { describe, expect, it } from 'vitest';
import { ok } from '@unified-mpc/domain';
import type { GoalRuntimeProjection } from '@unified-mpc/domain';
import type { WorkspaceCleanupEvaluationOptions } from '@unified-mpc/workspace';
import { createGoalWorkspaceCleanupPort, goalWorkspaceCleanupInputs } from './workspace-cleanup-inputs.js';

/**
 * The assembly is what the gate and the lifecycle path were getting wrong, so it
 * is asserted directly: both inputs, one list, no dependence on the caller
 * remembering one of them.
 */
describe('goalWorkspaceCleanupInputs', () => {
  it('protects the selection and every goal-attached workspace, once each', async () => {
    const counted: string[] = [];
    const journaled: readonly string[][] = [];
    const inputs = await goalWorkspaceCleanupInputs({
      settings: { get: () => JSON.stringify({ primaryWorkspaceId: 'project-1', activeWorkspaceIds: ['project-2'] }) },
      goals: {
        countWorkspaceGoalsForHost: async (workspaceId) => {
          counted.push(workspaceId);
          return workspaceId === 'goal-workspace' ? 1 : 0;
        },
      },
      journal: {
        goalDurableReferenceStates: (goalIds) => {
          journaled.push(goalIds);
          return new Map([['goal-1', 'clear' as const]]);
        },
      },
      workspaces: [
        { id: 'project-1', goalId: undefined },
        { id: 'project-2', goalId: undefined },
        { id: 'goal-workspace', goalId: 'goal-1' },
        { id: 'other-workspace', goalId: undefined },
      ],
    });

    expect(inputs.protectedWorkspaceIds).toEqual(['project-1', 'project-2', 'goal-workspace']);
    expect(inputs.goalDurableReferenceStates).toEqual(new Map([['goal-1', 'clear']]));
    expect(journaled).toEqual([['goal-1']]);
    expect(counted).toEqual(['goal-workspace', 'other-workspace']);
  });

  it('returns nothing to protect when the selection is unset and no goal is attached', async () => {
    const inputs = await goalWorkspaceCleanupInputs({
      settings: { get: () => null },
      goals: { countWorkspaceGoalsForHost: async () => 0 },
      journal: { goalDurableReferenceStates: () => new Map() },
      workspaces: [{ id: 'workspace-1', goalId: undefined }],
    });

    expect(inputs.protectedWorkspaceIds).toEqual([]);
    expect(inputs.goalDurableReferenceStates).toEqual(new Map());
  });
});

/**
 * The gate's own test injects a fake `gateCheck`, so the port composition was
 * the one place a narrowed spread (`...cleanupInputs` losing a field) would keep
 * every suite green while the close gate reported `allowed` for a protected or
 * durable-reference-pinned workspace. Assert the evaluator receives all three.
 */
describe('createGoalWorkspaceCleanupPort', () => {
  it('hands the evaluator the projections and both assembled inputs', async () => {
    const seen: WorkspaceCleanupEvaluationOptions[] = [];
    const goalRuntimeProjections = new Map<string, GoalRuntimeProjection>();
    const goalDurableReferenceStates = new Map([['goal-1', 'present' as const]]);
    const port = createGoalWorkspaceCleanupPort({
      cleanupInputs: { protectedWorkspaceIds: ['project-1'], goalDurableReferenceStates },
      goalRuntimeProjections,
      evaluate: async (input) => {
        seen.push(input);
        return ok([]);
      },
    });

    const result = await port({ workspaceId: 'goal-workspace', goalId: 'goal-1' });

    expect(result).toEqual(ok([]));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      goalRuntimeProjections,
      protectedWorkspaceIds: ['project-1'],
      goalDurableReferenceStates,
    });
  });
});
