import { describe, expect, it } from 'vitest';
import { goalWorkspaceCleanupInputs } from './workspace-cleanup-inputs.js';

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
