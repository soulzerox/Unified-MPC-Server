import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GoalContinuationService,
  GoalRuntimeReconciliationService,
  type FileActor,
} from '@unified-mpc/application';
import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  projectGoalRuntimeEvent,
  type ExecutionScopedRuntimeEvent,
  type GoalRuntimeProjection,
  type ScheduledContinuationWorkerLiveness,
} from '@unified-mpc/domain';
import type { Workspace } from '@unified-mpc/workspace';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteGoalRuntimeEventRepository } from './goal-runtime-event-repository.js';
import { SqliteGoalRuntimeSnapshotRepository } from './goal-runtime-snapshot-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const actor = (sessionId: string): FileActor => ({
  clientId: 'restart-reconnect-client',
  clientName: 'Restart reconnect integration',
  sessionId,
});

async function fixture(): Promise<{ filename: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-restart-reconnect-'));
  temporaryRoots.push(root);
  return {
    filename: path.join(root, 'state.sqlite'),
    workspace: {
      id: 'workspace-restart-reconnect',
      displayName: 'Restart reconnect',
      rootPath: root,
      realRootPath: root,
      createdAt: '2026-09-21T14:00:00.000Z',
    },
  };
}

async function openDatabase(filename: string, workspace: Workspace): Promise<{
  database: SqliteDatabase;
  workspaces: SqliteWorkspaceRepository;
  goals: SqliteGoalRepository;
  events: SqliteGoalRuntimeEventRepository;
  snapshots: SqliteGoalRuntimeSnapshotRepository;
}> {
  const database = new SqliteDatabase(filename);
  const workspaces = new SqliteWorkspaceRepository(database);
  if (await workspaces.get(workspace.id) === null) await workspaces.insert(workspace);
  return {
    database,
    workspaces,
    goals: new SqliteGoalRepository(database),
    events: new SqliteGoalRuntimeEventRepository(database),
    snapshots: new SqliteGoalRuntimeSnapshotRepository(database),
  };
}

function initialProjection(goalId: string, workspaceId: string, at: string): GoalRuntimeProjection {
  return {
    contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
    goalId,
    workspaceId,
    lifecycleState: 'open',
    runtimeState: 'idle',
    desiredRuntimeState: 'idle',
    integrationState: 'not_started',
    workspaceState: 'clean',
    lastActivityAt: at,
  };
}

function executionEvent(
  type: ExecutionScopedRuntimeEvent['type'],
  goalId: string,
  workspaceId: string,
  executionId: string,
  executionGeneration: number,
  at: string,
): ExecutionScopedRuntimeEvent {
  return {
    eventId: `restart-reconnect-${executionGeneration}-${type}`,
    type,
    goalId,
    workspaceId,
    executionId,
    executionGeneration,
    occurredAt: at,
  };
}

describe('durable Goal restart + reconnect integration', () => {
  it('reconciles a lost worker after restart, then reclaims through a fenced new execution generation', async () => {
    const { filename, workspace } = await fixture();
    const startedAt = new Date('2026-09-21T14:00:00.000Z');

    const first = await openDatabase(filename, workspace);
    const firstService = new GoalContinuationService(first.workspaces, first.goals, {
      scheduledContinuations: first.goals,
      goalExecutions: first.goals,
      executionCancellation: first.goals,
      now: (): Date => startedAt,
    });
    const created = await firstService.runGoal(actor('session-a'), {
      workspaceId: workspace.id,
      goalKey: 'issue-64-restart-reconnect',
      objective: 'Prove durable execution survives transport/backend restart and reconnect.',
      plan: { steps: [{ id: 'work', title: 'Continue durable work' }] },
      leaseSeconds: 60,
    });
    if (!created.ok || created.value.executionId === undefined || created.value.executionGeneration === undefined) {
      throw new Error('goal create failed');
    }

    const submittedEvent = executionEvent(
      'execution_submitted',
      created.value.goalId,
      workspace.id,
      created.value.executionId,
      created.value.executionGeneration,
      '2026-09-21T14:00:01.000Z',
    );
    const submittedRecord = await first.events.appendGoalRuntimeEvent({
      event: submittedEvent,
      recordedAt: submittedEvent.occurredAt,
    });
    const submitted = projectGoalRuntimeEvent(
      initialProjection(created.value.goalId, workspace.id, startedAt.toISOString()),
      submittedEvent,
    );
    expect(submitted.decision).toEqual({ disposition: 'apply' });

    const startedEvent = executionEvent(
      'execution_started',
      created.value.goalId,
      workspace.id,
      created.value.executionId,
      created.value.executionGeneration,
      '2026-09-21T14:00:02.000Z',
    );
    const startedRecord = await first.events.appendGoalRuntimeEvent({
      event: startedEvent,
      recordedAt: startedEvent.occurredAt,
    });
    const running = projectGoalRuntimeEvent(submitted.projection, startedEvent);
    expect(running.decision).toEqual({ disposition: 'apply' });
    expect(startedRecord.record.sequence).toBeGreaterThan(submittedRecord.record.sequence);
    await first.snapshots.storeGoalRuntimeSnapshot({
      projection: running.projection,
      lastEventSequence: startedRecord.record.sequence,
      updatedAt: '2026-09-21T14:00:02.000Z',
    });
    first.database.close();

    const restartAt = new Date('2026-09-21T14:00:10.000Z');
    const second = await openDatabase(filename, workspace);
    const workerLiveness = {
      observe: async (goalId: string): Promise<ScheduledContinuationWorkerLiveness> => {
        const goal = await second.goals.getById(goalId);
        if (goal === null) throw new Error('goal missing during restart liveness probe');
        return {
          trustworthy: true,
          observedAt: restartAt.toISOString(),
          leaseGeneration: goal.leaseGeneration,
          leaseActivitySeq: goal.leaseActivitySeq,
          liveFencedCallCount: 0,
          blockingTaskStates: [],
        };
      },
    };

    const reconciliation = new GoalRuntimeReconciliationService(
      second.goals,
      second.snapshots,
      second.events,
      second.goals,
      workerLiveness,
      { now: (): Date => restartAt },
    );
    await expect(reconciliation.reconcileWorkspace(workspace.id)).resolves.toEqual([
      expect.objectContaining({
        goalId: created.value.goalId,
        disposition: 'reconciled',
        reason: 'no_live_worker',
      }),
    ]);
    await expect(second.snapshots.getGoalRuntimeSnapshot(created.value.goalId)).resolves.toMatchObject({
      projection: {
        activeExecutionId: created.value.executionId,
        executionGeneration: 1,
        runtimeState: 'recovery_required',
        blocker: { kind: 'worker_lost' },
      },
    });

    const reconnectService = new GoalContinuationService(second.workspaces, second.goals, {
      now: (): Date => restartAt,
      scheduledContinuations: second.goals,
      workerLiveness,
      goalExecutions: second.goals,
      executionCancellation: second.goals,
    });
    const resumed = await reconnectService.runGoal(actor('session-b'), {
      workspaceId: workspace.id,
      goalKey: 'issue-64-restart-reconnect',
      leaseSeconds: 60,
    });
    expect(resumed).toMatchObject({
      ok: true,
      value: {
        acquired: true,
        goalId: created.value.goalId,
        leaseRecovery: 'stale_worker_recovered',
        executionGeneration: 2,
      },
    });
    if (!resumed.ok || resumed.value.executionId === undefined) throw new Error('goal reconnect failed');
    expect(resumed.value.executionId).not.toBe(created.value.executionId);

    await expect(second.goals.getExecutionById(created.value.executionId)).resolves.toMatchObject({
      id: created.value.executionId,
      executionGeneration: 1,
      receiptState: 'superseded',
    });
    await expect(second.goals.getExecutionById(resumed.value.executionId)).resolves.toMatchObject({
      id: resumed.value.executionId,
      executionGeneration: 2,
      receiptState: 'active',
    });
    await expect(reconnectService.getGoal(actor('session-c'), { goalId: created.value.goalId })).resolves.toMatchObject({
      ok: true,
      value: {
        goalId: created.value.goalId,
        executionId: resumed.value.executionId,
        executionGeneration: 2,
      },
    });

    await expect(reconnectService.cancelGoalExecution(actor('stale-session'), {
      executionId: created.value.executionId,
      executionGeneration: 1,
      summary: 'stale execution must not cancel the resumed owner',
      evidence: [{ kind: 'note', value: 'test:restart-reconnect-stale-cancel' }],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });

    second.database.close();

    const third = await openDatabase(filename, workspace);
    try {
      await expect(third.goals.getExecutionById(resumed.value.executionId)).resolves.toMatchObject({
        id: resumed.value.executionId,
        goalId: created.value.goalId,
        executionGeneration: 2,
        receiptState: 'active',
      });
      const history = await third.goals.listGoalExecutions({ goalId: created.value.goalId, limit: 10 });
      expect(history).toEqual([
        expect.objectContaining({ id: resumed.value.executionId, executionGeneration: 2, receiptState: 'active' }),
        expect.objectContaining({ id: created.value.executionId, executionGeneration: 1, receiptState: 'superseded' }),
      ]);
    } finally {
      third.database.close();
    }
  });
});
