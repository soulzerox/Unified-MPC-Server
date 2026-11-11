import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type { FileActor } from './file-service.js';
import {
  GoalContinuationService,
  goalCompletionWorktreeBlockers,
} from './goal-continuation-service.js';
import type {
  GoalWorktreeBlocker,
  GoalWorktreeClassificationEntry,
  GoalWorktreeClassificationReport,
} from './goal-worktree-reconciliation-service.js';
import { SqliteDatabase } from '../../storage/src/database.js';
import { SqliteGoalRepository } from '../../storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../storage/src/workspace-repository.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const actor: FileActor = {
  clientId: 'client',
  clientName: 'test',
  sessionId: 'session-a',
};

function entry(
  worktreePath: string,
  blockers: readonly GoalWorktreeBlocker[],
): GoalWorktreeClassificationEntry {
  return {
    worktreePath,
    ref: 'main',
    owner: actor.clientId,
    disposition: blockers.length === 0 ? 'safe_to_clean' : 'keep',
    blockers,
    blockerDetails: [],
  };
}

function report(entries: readonly GoalWorktreeClassificationEntry[]): GoalWorktreeClassificationReport {
  return {
    integrationBase: 'origin/main',
    entries,
    safeToCleanCount: entries.filter((item) => item.disposition === 'safe_to_clean').length,
    keepCount: entries.filter((item) => item.disposition === 'keep').length,
  };
}

async function fixture(
  classify: () => Promise<Result<GoalWorktreeClassificationReport>>,
): Promise<GoalContinuationService> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-worktree-gate-'));
  temporaryRoots.push(root);
  const database = new SqliteDatabase(path.join(root, 'state.sqlite'));
  const workspaces = new SqliteWorkspaceRepository(database);
  await workspaces.insert({
    id: 'workspace-1',
    displayName: 'Fixture',
    rootPath: root,
    realRootPath: root,
    createdAt: '2026-08-27T10:00:00.000Z',
  });
  const goals = new SqliteGoalRepository(database);
  return new GoalContinuationService(workspaces, goals, {
    goalWorktrees: {
      async classify(): Promise<Result<GoalWorktreeClassificationReport>> {
        return classify();
      },
    },
  });
}

async function startedGoal(service: GoalContinuationService): Promise<{
  readonly goalId: string;
  readonly leaseToken: string;
  readonly revision: number;
}> {
  const started = await service.runGoal(actor, {
    workspaceId: 'workspace-1',
    goalKey: 'completion-gate',
    objective: 'Finish the durable goal without abandoning work.',
    plan: { steps: [] },
    leaseSeconds: 600,
  });
  expect(started.ok).toBe(true);
  if (!started.ok || started.value.leaseToken === undefined) throw new Error('failed to start goal');
  return {
    goalId: started.value.goalId,
    leaseToken: started.value.leaseToken,
    revision: started.value.revision,
  };
}

describe('goal completion worktree gate', () => {
  it('blocks only recoverable work that completion would abandon', () => {
    const blockers = goalCompletionWorktreeBlockers([
      entry('/w/dirty', ['dirty']),
      entry('/w/conflict', ['unmerged_changes']),
      entry('/w/unverifiable', ['probe_failed']),
      entry('/w/squashed', ['unintegrated_head']),
      entry('/w/leased', ['active_lease']),
      entry('/w/foreign', ['dirty', 'externally_owned']),
      entry('/w/clean', []),
    ]);

    expect(blockers).toEqual([
      { worktreePath: '/w/dirty', blockers: ['dirty'] },
      { worktreePath: '/w/conflict', blockers: ['unmerged_changes'] },
      { worktreePath: '/w/unverifiable', blockers: ['probe_failed'] },
    ]);
  });

  it('refuses completion while a goal-owned worktree has uncommitted work', async () => {
    let classified = report([entry('worktrees/agent-1', ['dirty'])]);
    const service = await fixture(async () => ok(classified));
    const started = await startedGoal(service);

    const refused = await service.finishGoal(actor, {
      goalId: started.goalId,
      leaseToken: started.leaseToken,
      expectedRevision: started.revision,
      status: 'completed',
      summary: 'Done.',
      evidence: [],
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    if (!refused.ok) expect(refused.error.message).toContain('worktrees/agent-1');

    // A squash-merged worktree is not an ancestor of origin/main even though
    // its work is integrated, so `unintegrated_head` must stay advisory.
    classified = report([entry('worktrees/agent-1', ['unintegrated_head'])]);
    const completed = await service.finishGoal(actor, {
      goalId: started.goalId,
      leaseToken: started.leaseToken,
      expectedRevision: started.revision,
      status: 'completed',
      summary: 'Done.',
      evidence: [],
    });
    expect(completed).toMatchObject({ ok: true, value: { status: 'completed' } });
  });

  it('fails closed when worktree safety cannot be verified', async () => {
    const service = await fixture(async () => err(appError('INTERNAL_ERROR', 'ledger unavailable')));
    const started = await startedGoal(service);

    const refused = await service.finishGoal(actor, {
      goalId: started.goalId,
      leaseToken: started.leaseToken,
      expectedRevision: started.revision,
      status: 'completed',
      summary: 'Done.',
      evidence: [],
    });

    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    if (!refused.ok) expect(refused.error.message).toContain('could not be verified');
  });
});
