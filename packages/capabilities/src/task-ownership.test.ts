import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_GOAL_CORRELATION_METADATA_KEY,
  CAPABILITY_TASK_OWNER_METADATA_KEY,
  readCapabilityGoalCorrelation,
  readCapabilityTaskOwner,
  withCapabilityGoalCorrelation,
} from './task-ownership.js';

const owner = { clientId: 'client-a', sessionId: 'session-a', workspaceId: 'workspace-a' };

describe('capability goal correlation', () => {
  it('rides beside the owner metadata without displacing it', () => {
    const input = { workspaceId: 'workspace-a', metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: owner } };
    const correlated = withCapabilityGoalCorrelation(input, { goalId: 'goal-1', executionGeneration: 3 });

    expect(correlated).toEqual({
      workspaceId: 'workspace-a',
      metadata: {
        [CAPABILITY_TASK_OWNER_METADATA_KEY]: owner,
        [CAPABILITY_GOAL_CORRELATION_METADATA_KEY]: { goalId: 'goal-1', executionGeneration: 3 },
      },
    });
    // The reader on the capability side is what turns the two keys into one
    // owner, so a task's persisted correlation is the same shape as its identity.
    expect(readCapabilityTaskOwner(correlated)).toEqual({ ...owner, goalId: 'goal-1', executionGeneration: 3 });
  });

  it('adds nothing when there is no goal to correlate with', () => {
    const input = { metadata: { [CAPABILITY_TASK_OWNER_METADATA_KEY]: owner } };

    expect(withCapabilityGoalCorrelation(input, undefined)).toBe(input);
    expect(readCapabilityGoalCorrelation(input)).toBeUndefined();
    expect(readCapabilityTaskOwner(input)).toEqual(owner);
  });

  it('ignores a malformed correlation instead of inventing a generation', () => {
    const malformed = (executionGeneration: unknown): unknown => ({
      metadata: {
        [CAPABILITY_TASK_OWNER_METADATA_KEY]: owner,
        [CAPABILITY_GOAL_CORRELATION_METADATA_KEY]: { goalId: 'goal-1', executionGeneration },
      },
    });

    for (const value of [-1, 1.5, Number.NaN, '3', undefined]) {
      expect(readCapabilityGoalCorrelation(malformed(value))).toBeUndefined();
      // The owner still resolves; a broken correlation must not hide the task.
      expect(readCapabilityTaskOwner(malformed(value))).toEqual(owner);
    }
    expect(readCapabilityGoalCorrelation({
      metadata: { [CAPABILITY_GOAL_CORRELATION_METADATA_KEY]: { goalId: '', executionGeneration: 1 } },
    })).toBeUndefined();
  });
});
