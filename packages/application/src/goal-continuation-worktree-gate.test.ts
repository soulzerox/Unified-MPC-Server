import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { GitAdapter, type GitRunResult } from '@unified-mpc/git';
import type { FileActor } from './file-service.js';
import {
  GoalContinuationService,
  goalCompletionWorktreeBlockers,
} from './goal-continuation-service.js';
import {
  createGoalWorktreeReconciliationPort,
  type GoalWorktreeReconciliationRequest,
} from './goal-worktree-reconciliation-port.js';
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

interface GateClassifyRequest {
  readonly actor: { readonly clientId: string; readonly sessionId?: string };
  readonly ownershipScope?: 'session' | 'client';
  readonly workspaceId?: string;
}

async function fixture(
  classify: (request: GoalWorktreeReconciliationRequest) => Promise<Result<GoalWorktreeClassificationReport>>,
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
      async classify(request): Promise<Result<GoalWorktreeClassificationReport>> {
        return classify(request);
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

  it('classifies with client-scoped ownership so an earlier session still counts', async () => {
    let observed: GateClassifyRequest | undefined;
    const service = await fixture(async (request) => {
      observed = request;
      return ok(report([]));
    });
    const started = await startedGoal(service);

    const completed = await service.finishGoal(actor, {
      goalId: started.goalId,
      leaseToken: started.leaseToken,
      expectedRevision: started.revision,
      status: 'completed',
      summary: 'Done.',
      evidence: [],
    });

    expect(completed).toMatchObject({ ok: true, value: { status: 'completed' } });
    // Client scope: the classifier treats every session of this client as the
    // goal's own work, so a worktree spawned before a continuation rollover is
    // still gated. Cleanup keeps the default session scope.
    expect(observed).toEqual({
      actor: { clientId: 'client', sessionId: 'session-a' },
      ownershipScope: 'client',
      workspaceId: 'workspace-1',
    });
  });

  it('refuses completion when an earlier session of the same client left dirty work', async () => {
    const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-gate-worktree-'));
    temporaryRoots.push(worktreeRoot);
    const worktreePath = path.join(worktreeRoot, 'agent-earlier');
    await mkdir(worktreePath);
    const port = createGoalWorktreeReconciliationPort({
      git: new GitAdapter({
        async run(args): Promise<GitRunResult> {
          if (args[0] === 'status') return { exitCode: 0, stdout: ' M tracked.txt\u0000', stderr: '' };
          if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
      listLedgerEntries: async () => [{
        workspaceId: 'workspace-1',
        worktreePath,
        ref: 'main',
        owner: actor.clientId,
        ownerSessionId: 'session-earlier',
      }],
      listActivelyLeasedWorkspaceIds: async () => [],
    });
    const service = await fixture(port.classify);
    const started = await startedGoal(service);

    const refused = await service.finishGoal(actor, {
      goalId: started.goalId,
      leaseToken: started.leaseToken,
      expectedRevision: started.revision,
      status: 'completed',
      summary: 'Done.',
      evidence: [],
    });

    // End-to-end through the real port: the worktree belongs to an earlier
    // session of this client, so client scope turns it into `dirty` instead of
    // `externally_owned` and completion is refused.
    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    if (!refused.ok) expect(refused.error.message).toContain(worktreePath);
  });
});
