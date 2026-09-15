import type { GoalRecord } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';
import { createGoalControl, runWeb, parseWebArgs } from './web.js';

describe('web CLI command', () => {
  describe('parseWebArgs', () => {
    it('parses empty args with loopback web port', () => {
      const parsed = parseWebArgs([]);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          port: 3000,
        },
      });
    });

    it('parses custom port and rejects custom host', () => {
      const parsed = parseWebArgs(['--port', '19000']);
      expect(parsed).toEqual({
        ok: true,
        value: {
          kind: 'web',
          port: 19000,
        },
      });
      expect(parseWebArgs(['--host', '0.0.0.0'])).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });
  });

  describe('goal control', () => {
    it('summarizes open goals and persists a preferred continuation goal without acquiring its lease', async () => {
      const goal = {
        id: 'goal-a',
        goalKey: 'project-goals',
        workspaceId: 'workspace-a',
        ownerClientId: 'client-a',
        objective: 'Expose open goals in the Projects view.',
        plan: {
          steps: [
            { id: 'inspect', title: 'Inspect', status: 'completed' },
            { id: 'frontend', title: 'Build UI', status: 'in_progress' },
          ],
        },
        status: 'active',
        revision: 2,
        currentPhase: 'frontend',
        nextAction: 'Finish the UI.',
        blockers: ['Need browser verification'],
        activeTaskIds: [],
        leaseGeneration: 3,
        leaseActivitySeq: 0,
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T01:00:00.000Z',
        checkpoints: [],
      } as GoalRecord;
      const values = new Map<string, string>();
      const settings = {
        get: (key: string): string | null => values.get(key) ?? null,
        set: (key: string, value: string): void => { values.set(key, value); },
      };
      const repository = {
        countWorkspaceGoalsForHost: async (workspaceId: string): Promise<number> => workspaceId === 'workspace-a' ? 1 : 0,
        listWorkspaceGoalsForHost: async (): Promise<readonly GoalRecord[]> => [goal],
        getById: async (goalId: string): Promise<GoalRecord | null> => goalId === goal.id ? goal : null,
      };
      const control = createGoalControl(repository as never, settings as never);

      expect(await control.countOpen('workspace-a')).toBe(1);
      expect(await control.preferred('workspace-a')).toBeNull();
      expect(await control.listOpen('workspace-a')).toEqual([expect.objectContaining({
        goalId: 'goal-a',
        objective: goal.objective,
        progress: { completed: 1, total: 2 },
        blockers: goal.blockers,
      })]);

      expect(await control.continue('workspace-a', 'goal-a')).toMatchObject({ goalId: 'goal-a', currentPhase: 'frontend' });
      expect(await control.preferred('workspace-a')).toBe('goal-a');
      expect([...values.values()].join('\n')).toContain('goal-a');
    });
  });

  describe('runWeb', () => {
    it('starts control plane server and returns handle with bound url', async () => {
      const result = await runWeb({ port: 0 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.url).toContain('http://127.0.0.1:');
        await result.value.handle.close();
      }
    });
  });
});
