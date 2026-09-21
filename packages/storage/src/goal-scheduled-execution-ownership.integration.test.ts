import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GoalContinuationService,
  ScheduledContinuationService,
  type FileActor,
} from '@unified-mpc/application';
import { SqliteDatabase } from './database.js';
import { SqliteGoalRepository } from './goal-repository.js';
import { SqliteWorkspaceRepository } from './workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const actor = (sessionId: string): FileActor => ({
  clientId: 'scheduled-execution-owner',
  clientName: 'Scheduled execution ownership integration',
  sessionId,
});

async function proveScheduledExecutionOwnership(
  occurrence: 'interval' | 'once',
  expectedOutcome: 'recurring_acquired' | 'acquired',
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-scheduled-execution-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: `workspace-scheduled-${occurrence}`,
    displayName: `Scheduled ${occurrence}`,
    rootPath: root,
    realRootPath: root,
    createdAt: '2026-09-21T15:30:00.000Z',
  });

  let now = new Date('2026-09-21T15:30:00.000Z');
  const nowFn = (): Date => now;
  const repository = new SqliteGoalRepository(database);
  const goals = new GoalContinuationService(workspaces, repository, {
    now: nowFn,
    scheduledContinuations: repository,
    goalExecutions: repository,
    executionCancellation: repository,
  });
  const scheduled = new ScheduledContinuationService(repository, {
    now: nowFn,
    hostTimeZone: 'Asia/Bangkok',
  });

  try {
    const created = await goals.runGoal(actor('initial-session'), {
      workspaceId: `workspace-scheduled-${occurrence}`,
      goalKey: `issue-64-scheduled-${occurrence}`,
      objective: 'Keep scheduled continuation ownership on the durable execution primitive.',
      plan: { steps: [{ id: 'continue', title: 'Continue durable work' }] },
      leaseSeconds: 600,
    });
    if (
      !created.ok
      || created.value.leaseToken === undefined
      || created.value.executionId === undefined
      || created.value.executionGeneration === undefined
    ) {
      throw new Error('initial durable execution was not created');
    }
    const firstExecutionId = created.value.executionId;
    expect(created.value.executionGeneration).toBe(1);

    const prepared = await scheduled.prepareScheduledContinuation(actor('initial-session'), {
      goalId: created.value.goalId,
      leaseToken: created.value.leaseToken,
      expectedRevision: created.value.revision,
      currentPhase: 'scheduled-handoff',
      summary: 'A durable scheduled wake will take over this goal.',
      stepUpdates: [],
      nextAction: 'Claim the same goal through the scheduled continuation.',
      blockers: [],
      evidence: [],
      activeTaskIds: [],
      successorDelayMinutes: 25,
      executionPreference: 'cloud',
    });
    if (!prepared.ok) throw new Error('scheduled continuation was not prepared');

    const receipt = await scheduled.recordScheduledContinuationReceipt(actor('initial-session'), {
      continuationId: prepared.value.continuation.continuationId,
      expectedVersion: prepared.value.continuation.version,
      outcome: 'created',
      nativeTaskId: `native-scheduled-${occurrence}`,
      dueAt: prepared.value.continuation.dueAt,
      runsOn: 'cloud',
    });
    if (!receipt.ok) throw new Error('scheduled continuation receipt was not recorded');

    if (occurrence === 'once') {
      database.connection.prepare(
        "UPDATE goal_scheduled_continuations SET occurrence = 'once', interval_minutes = NULL WHERE id = ?",
      ).run(prepared.value.continuation.continuationId);
    }

    const dueAtMs = Date.parse(prepared.value.continuation.dueAt);
    const expiredAt = new Date(dueAtMs - 1_000).toISOString();
    database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
      .run(expiredAt, created.value.goalId);
    now = new Date(dueAtMs);

    const claimed = await scheduled.claimScheduledContinuation(actor('scheduled-wake'), {
      continuationId: prepared.value.continuation.continuationId,
      leaseSeconds: 600,
    });
    if (!claimed.ok || claimed.value.outcome !== expectedOutcome) {
      throw new Error(`scheduled continuation did not acquire ownership: ${JSON.stringify(claimed)}`);
    }

    expect(claimed.value.goal).toMatchObject({
      goalId: created.value.goalId,
      executionId: expect.any(String),
      executionGeneration: 2,
      leaseGeneration: 2,
    });
    const secondExecutionId = claimed.value.goal.executionId;
    if (secondExecutionId === undefined) throw new Error('scheduled takeover lost execution identity');
    expect(secondExecutionId).not.toBe(firstExecutionId);

    await expect(repository.getExecutionById(firstExecutionId)).resolves.toMatchObject({
      id: firstExecutionId,
      executionGeneration: 1,
      receiptState: 'superseded',
    });
    await expect(repository.getExecutionById(secondExecutionId)).resolves.toMatchObject({
      id: secondExecutionId,
      executionGeneration: 2,
      receiptState: 'active',
    });
    await expect(repository.listGoalExecutions({ goalId: created.value.goalId, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        id: secondExecutionId,
        executionGeneration: 2,
        receiptState: 'active',
      }),
      expect.objectContaining({
        id: firstExecutionId,
        executionGeneration: 1,
        receiptState: 'superseded',
      }),
    ]);

    await expect(goals.cancelGoalExecution(actor('stale-observer'), {
      executionId: firstExecutionId,
      executionGeneration: 1,
      summary: 'A stale scheduled execution handle must not cancel the new owner.',
      evidence: [{ kind: 'note', value: 'test:scheduled-execution-stale-cancel' }],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
  } finally {
    database.close();
  }
}

describe('scheduled continuation durable execution ownership', () => {
  it('rotates the durable execution receipt for an hourly recurring wake', async () => {
    await proveScheduledExecutionOwnership('interval', 'recurring_acquired');
  });

  it('rotates the durable execution receipt for a one-time wake', async () => {
    await proveScheduledExecutionOwnership('once', 'acquired');
  });
});
