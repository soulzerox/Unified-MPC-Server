import { describe, expect, it } from 'vitest';
import type { GoalRuntimeEvent } from '@unified-mpc/domain';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteGoalRuntimeEventRepository } from './goal-runtime-event-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const now = '2026-09-21T12:30:00.000Z';

async function fixture(options: { maxEventsPerWorkspace?: number; retentionSlack?: number } = {}): Promise<{
  database: SqliteDatabase;
  events: SqliteGoalRuntimeEventRepository;
  executionId: string;
}> {
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
      })).rejects.toMatchObject({
        reason: 'event_id_conflict',
      });
    } finally {
      runtime.database.close();
    }
  });

  it('rejects events whose execution generation does not match the durable receipt', async () => {
    const runtime = await fixture();
    try {
      const mismatched = {
        ...executionEvent('event-wrong-generation', runtime.executionId, 'execution_started'),
        executionGeneration: 2,
      };
      await expect(runtime.events.appendGoalRuntimeEvent({
        event: mismatched,
        recordedAt: now,
      })).rejects.toMatchObject({
        reason: 'invalid_event',
        message: expect.stringContaining('generation'),
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

  it('replays one global cursor across selected workspaces in durable sequence order', async () => {
    const runtime = await fixture();
    try {
      const workspaces = new SqliteWorkspaceRepository(runtime.database);
      await workspaces.insert({
        id: 'workspace-2',
        displayName: 'Runtime events 2',
        rootPath: '/tmp/unified-runtime-events-2',
        realRootPath: '/tmp/unified-runtime-events-2',
        createdAt: now,
      });
      const goals = new SqliteGoalRepository(runtime.database);
      const acquired = await goals.acquire({
        goalId: 'goal-2',
        workspaceId: 'workspace-2',
        goalKey: 'runtime-events-2',
        ownerClientId: 'client-2',
        ownerSessionId: 'session-2',
        objective: 'Persist a second workspace runtime stream.',
        plan: { steps: [] },
        leaseTokenHash: 'lease-hash-2',
        leaseSeconds: 60,
        now,
      });
      if (!acquired.acquired || acquired.goal.executionId === undefined) {
        throw new Error('second goal execution fixture was not acquired');
      }

      await runtime.events.appendGoalRuntimeEvent({
        event: executionEvent('global-1', runtime.executionId, 'execution_started'),
        recordedAt: now,
      });
      await runtime.events.appendGoalRuntimeEvent({
        event: {
          ...executionEvent('global-2', acquired.goal.executionId, 'execution_started'),
          workspaceId: 'workspace-2',
          goalId: 'goal-2',
        },
        recordedAt: '2026-09-21T12:30:01.000Z',
      });
      await runtime.events.appendGoalRuntimeEvent({
        event: executionEvent('global-3', runtime.executionId, 'execution_heartbeat'),
        recordedAt: '2026-09-21T12:30:02.000Z',
      });

      const page = await runtime.events.replayGoalRuntimeEvents({
        workspaceIds: ['workspace-1', 'workspace-2'],
        afterSequence: 1,
        limit: 20,
      });
      expect(page.events.map((entry) => entry.sequence)).toEqual([2, 3]);
      expect(page.events.map((entry) => entry.event.workspaceId)).toEqual(['workspace-2', 'workspace-1']);
      expect(page.latestSequence).toBe(3);
      expect(page.replayWindowMissed).toBe(false);
      expect(page.workspaceBounds).toEqual([
        { workspaceId: 'workspace-1', oldestAvailableSequence: 1, latestSequence: 3 },
        { workspaceId: 'workspace-2', oldestAvailableSequence: 2, latestSequence: 2 },
      ]);

      const filtered = await runtime.events.replayGoalRuntimeEvents({
        workspaceIds: ['workspace-2'],
        afterSequence: 0,
        limit: 20,
      });
      expect(filtered.events.map((entry) => entry.sequence)).toEqual([2]);
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

  it('round-trips structured workspace observations without execution identity', async () => {
    const runtime = await fixture();
    try {
      const event: GoalRuntimeEvent = {
        eventId: 'workspace-observed-1',
        type: 'workspace_observed',
        workspaceId: 'workspace-1',
        goalId: 'goal-1',
        workspaceState: 'dirty',
        occurredAt: now,
        detail: 'registered workspace has uncommitted changes',
      };
      const appended = await runtime.events.appendGoalRuntimeEvent({ event, recordedAt: now });
      expect(appended.record.event).toEqual(event);

      const replay = await runtime.events.listGoalRuntimeEvents({ goalId: 'goal-1', limit: 10 });
      expect(replay[0]?.event).toEqual(event);
    } finally {
      runtime.database.close();
    }
  });

  it('round-trips structured integration observations without execution identity and fences event IDs by state', async () => {
    const runtime = await fixture();
    try {
      const event = {
        eventId: 'integration-observed-1',
        type: 'integration_observed',
        workspaceId: 'workspace-1',
        goalId: 'goal-1',
        integrationState: 'pending',
        occurredAt: now,
        detail: 'caller-verified Goal Workspace integration metadata',
      } as GoalRuntimeEvent;
      const appended = await runtime.events.appendGoalRuntimeEvent({ event, recordedAt: now });
      expect(appended.record.event).toEqual(event);

      const retry = await runtime.events.appendGoalRuntimeEvent({
        event,
        recordedAt: '2026-09-21T12:30:01.000Z',
      });
      expect(retry.appended).toBe(false);

      await expect(runtime.events.appendGoalRuntimeEvent({
        event: { ...event, integrationState: 'integrated' } as GoalRuntimeEvent,
        recordedAt: now,
      })).rejects.toMatchObject({ reason: 'event_id_conflict' });

      const replay = await runtime.events.listGoalRuntimeEvents({ goalId: 'goal-1', limit: 10 });
      expect(replay[0]?.event).toEqual(event);
    } finally {
      runtime.database.close();
    }
  });

  it('round-trips durable Goal blocker observations without execution identity', async () => {
    const runtime = await fixture();
    try {
      const blocked: GoalRuntimeEvent = {
        eventId: 'goal-blocker-observed-1',
        type: 'goal_blocker_observed',
        workspaceId: 'workspace-1',
        goalId: 'goal-1',
        blockerKind: 'goal_blocked',
        occurredAt: now,
        detail: 'Durable Goal blockers at revision 2: dependency unavailable',
      };
      const clear: GoalRuntimeEvent = {
        eventId: 'goal-blocker-observed-2',
        type: 'goal_blocker_observed',
        workspaceId: 'workspace-1',
        goalId: 'goal-1',
        occurredAt: '2026-09-21T12:30:01.000Z',
      };

      const first = await runtime.events.appendGoalRuntimeEvent({ event: blocked, recordedAt: now });
      const second = await runtime.events.appendGoalRuntimeEvent({ event: clear, recordedAt: '2026-09-21T12:30:01.000Z' });
      expect(first.record.event).toEqual(blocked);
      expect(second.record.event).toEqual(clear);

      const replay = await runtime.events.listGoalRuntimeEvents({ goalId: 'goal-1', limit: 10 });
      expect(replay.slice(0, 2).map((entry) => entry.event)).toEqual([clear, blocked]);
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
