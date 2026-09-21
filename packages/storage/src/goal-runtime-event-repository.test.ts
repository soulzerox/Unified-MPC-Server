import { describe, expect, it } from 'vitest';
import type { GoalRuntimeEvent } from '@unified-mpc/domain';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import {
  GoalRuntimeEventStoreError,
  SqliteGoalRuntimeEventRepository,
} from './goal-runtime-event-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const now = '2026-09-21T12:30:00.000Z';

async function fixture(options: { maxEventsPerWorkspace?: number; retentionSlack?: number } = {}) {
  const database = new SqliteDatabase(':memory:');
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-1',
    displayName: 'Runtime events',
    rootPath: '/tmp/unified-runtime-events',
    realRootPath: '/tmp/unified-runtime-events',
    createdAt: now,
  });
  const goals = new SqliteGoalRepository(database);
  const acquired = await goals.acquire({
    goalId: 'goal-1',
    workspaceId: 'workspace-1',
    goalKey: 'runtime-events',
    ownerClientId: 'client-1',
    ownerSessionId: 'session-1',
    objective: 'Persist authoritative runtime events.',
    plan: { steps: [] },
    leaseTokenHash: 'lease-hash',
    leaseSeconds: 60,
    now,
  });
  if (!acquired.acquired || acquired.goal.executionId === undefined) {
    throw new Error('goal execution fixture was not acquired');
  }
  return {
    database,
    events: new SqliteGoalRuntimeEventRepository(database, options),
    executionId: acquired.goal.executionId,
  };
}

function executionEvent(
  eventId: string,
  executionId: string,
  type: 'execution_started' | 'execution_heartbeat' | 'phase_started' = 'execution_heartbeat',
): GoalRuntimeEvent {
  return {
    eventId,
    type,
    workspaceId: 'workspace-1',
    goalId: 'goal-1',
    executionId,
    executionGeneration: 1,
    occurredAt: now,
    ...(type === 'phase_started' ? { phase: 'test' } : {}),
  };
}

describe('SqliteGoalRuntimeEventRepository', () => {
  it('appends idempotently and rejects one event ID identifying different content', async () => {
    const runtime = await fixture();
    try {
      const event = executionEvent('event-1', runtime.executionId, 'execution_started');
      const first = await runtime.events.appendGoalRuntimeEvent({ event, recordedAt: now });
      const retry = await runtime.events.appendGoalRuntimeEvent({
        event,
        recordedAt: '2026-09-21T12:30:01.000Z',
      });

      expect(first).toMatchObject({ appended: true, record: { sequence: 1, event } });
      expect(retry).toMatchObject({ appended: false, record: { sequence: 1, event } });

      await expect(runtime.events.appendGoalRuntimeEvent({
        event: { ...event, detail: 'different content' },
        recordedAt: now,
      })).rejects.toMatchObject<Partial<GoalRuntimeEventStoreError>>({
        reason: 'event_id_conflict',
      });
    } finally {
      runtime.database.close();
    }
  });

  it('replays in durable sequence order and signals when bounded retention dropped the requested cursor', async () => {
    const runtime = await fixture({ maxEventsPerWorkspace: 3, retentionSlack: 0 });
    try {
      for (const [index, type] of [
        'execution_started',
        'execution_heartbeat',
        'phase_started',
        'execution_heartbeat',
      ].entries()) {
        await runtime.events.appendGoalRuntimeEvent({
          event: executionEvent(
            `event-${index + 1}`,
            runtime.executionId,
            type as 'execution_started' | 'execution_heartbeat' | 'phase_started',
          ),
          recordedAt: new Date(Date.parse(now) + index * 1_000).toISOString(),
        });
      }

      const missed = await runtime.events.replayWorkspaceGoalRuntimeEvents({
        workspaceId: 'workspace-1',
        afterSequence: 0,
        limit: 20,
      });
      expect(missed).toMatchObject({
        oldestAvailableSequence: 2,
        latestSequence: 4,
        replayWindowMissed: true,
      });
      expect(missed.events.map((entry) => entry.sequence)).toEqual([2, 3, 4]);
      expect(missed.events.map((entry) => entry.event.eventId)).toEqual(['event-2', 'event-3', 'event-4']);

      const resumed = await runtime.events.replayWorkspaceGoalRuntimeEvents({
        workspaceId: 'workspace-1',
        afterSequence: 2,
        limit: 20,
      });
      expect(resumed.replayWindowMissed).toBe(false);
      expect(resumed.events.map((entry) => entry.sequence)).toEqual([3, 4]);

      const goalHistory = await runtime.events.listGoalRuntimeEvents({ goalId: 'goal-1', limit: 2 });
      expect(goalHistory.map((entry) => entry.sequence)).toEqual([4, 3]);
    } finally {
      runtime.database.close();
    }
  });

  it('round-trips goal-scoped events without execution-only fields', async () => {
    const runtime = await fixture();
    try {
      const event: GoalRuntimeEvent = {
        eventId: 'goal-event-1',
        type: 'goal_completed',
        workspaceId: 'workspace-1',
        goalId: 'goal-1',
        occurredAt: now,
        detail: 'Execution finished; integration remains separate.',
      };
      const appended = await runtime.events.appendGoalRuntimeEvent({ event, recordedAt: now });

      expect(appended.record.event).toEqual(event);
      expect(JSON.stringify(appended.record)).not.toContain('lease-hash');
    } finally {
      runtime.database.close();
    }
  });

  it('bounds replay reads even when callers request an excessive limit', async () => {
    const runtime = await fixture();
    try {
      await runtime.events.appendGoalRuntimeEvent({
        event: executionEvent('event-1', runtime.executionId),
        recordedAt: now,
      });
      const page = await runtime.events.replayWorkspaceGoalRuntimeEvents({
        workspaceId: 'workspace-1',
        limit: 50_000,
      });
      expect(page.events).toHaveLength(1);
    } finally {
      runtime.database.close();
    }
  });
});
