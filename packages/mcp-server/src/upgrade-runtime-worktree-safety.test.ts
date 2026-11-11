import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import type {
  FileActor,
  GoalWorktreeBlocker,
  GoalWorktreeClassificationEntry,
  GoalWorktreeClassificationReport,
  GoalWorktreeReconciliationRequest,
} from '@unified-mpc/application';
import { UpgradeRuntimeService } from './upgrade-runtime.js';
import { UpgradeRuntimeStateStore } from './upgrade-runtime-state-store.js';
import type { McpApplicationServices } from './tools/tool-types.js';

const actor: FileActor = { clientId: 'client-a', clientName: 'test', sessionId: 'session-a' };
const workspaceId = 'ws-1';
const worktreePath = '.worktrees/agent-1';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function entry(options: {
  readonly blockers?: readonly GoalWorktreeBlocker[];
  readonly worktreePath?: string;
} = {}): GoalWorktreeClassificationEntry {
  const blockers = options.blockers ?? [];
  return {
    worktreePath: options.worktreePath ?? worktreePath,
    ref: 'main',
    owner: actor.clientId,
    disposition: blockers.length === 0 ? 'safe_to_clean' : 'keep',
    blockers,
    blockerDetails: blockers.map((blocker) => `${blocker} detail`),
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

interface Fixture {
  readonly runtime: UpgradeRuntimeService;
  readonly gitCalls: unknown[];
  readonly requests: unknown[];
  readonly state: UpgradeRuntimeStateStore;
}

async function fixture(
  classify: (request: GoalWorktreeReconciliationRequest) => Promise<Result<GoalWorktreeClassificationReport>>,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-worktree-safety-'));
  temporaryRoots.push(root);
  const workspaceRoot = path.join(root, 'repo');
  await mkdir(path.join(workspaceRoot, worktreePath), { recursive: true });
  const runtimeStatePath = path.join(root, 'upgrade-runtime.json');
  const state = new UpgradeRuntimeStateStore(runtimeStatePath, 'seed');
  await state.updateShared(() => ({
    plugins: [],
    worktrees: [{
      workspaceId,
      worktreePath,
      ref: 'main',
      owner: actor.clientId,
      ownerSessionId: actor.sessionId,
      createdAt: '2026-11-11T00:00:00.000Z',
    }],
  }));

  const gitCalls: unknown[] = [];
  const requests: unknown[] = [];
  const runtime = new UpgradeRuntimeService({
    runtimeStatePath,
    platform: 'linux',
    workspaceInfo: {
      async info(): Promise<ReturnType<typeof ok>> {
        return ok({
          id: workspaceId,
          displayName: 'fixture',
          rootPath: workspaceRoot,
          realRootPath: workspaceRoot,
          createdAt: '2026-11-11T00:00:00.000Z',
        });
      },
    },
    git: {
      async run(_actor, request): Promise<ReturnType<typeof ok>> {
        gitCalls.push(request);
        return ok({ exitCode: 0, stdout: 'removed', stderr: '' });
      },
    },
    goalWorktrees: {
      async classify(request): Promise<Result<GoalWorktreeClassificationReport>> {
        requests.push(request);
        return classify(request);
      },
    },
  } as unknown as McpApplicationServices, actor);
  return { runtime, gitCalls, requests, state };
}

function remove(runtime: UpgradeRuntimeService, input: Record<string, unknown> = {}): Promise<Result<unknown>> {
  return runtime.execute('git_worktree_remove', {
    workspaceId,
    worktreePath,
    dryRun: false,
    userConfirmed: true,
    ...input,
  });
}

describe('git_worktree_remove worktree safety gate', () => {
  it('refuses to discard uncommitted work and leaves the ledger alone', async () => {
    const { runtime, gitCalls, requests, state } = await fixture(async () => ok(report([entry({ blockers: ['dirty'] })])));

    const refused = await remove(runtime);

    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    if (!refused.ok) expect(refused.error.message).toContain('dirty detail');
    expect(gitCalls).toEqual([]);
    // Session scope is the default: removal stays strict to the owning session.
    expect(requests).toEqual([{ workspaceId, actor: { clientId: actor.clientId, sessionId: actor.sessionId } }]);
    expect((await state.readShared()).worktrees).toHaveLength(1);
  });

  it('refuses conflicted, unverifiable and leaselessly-owned worktrees but not a vanished path', async () => {
    const blocked = await fixture(async () => ok(report([entry({ blockers: ['unmerged_changes', 'dirty'] })])));
    await expect(remove(blocked.runtime)).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const unverifiable = await fixture(async () => ok(report([entry({ blockers: ['probe_failed'] })])));
    await expect(remove(unverifiable.runtime)).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const leased = await fixture(async () => ok(report([entry({ blockers: ['active_lease'] })])));
    await expect(remove(leased.runtime)).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    const vanished = await fixture(async () => ok(report([entry({ blockers: ['path_missing'] })])));
    const removed = await remove(vanished.runtime);
    expect(removed).toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(vanished.gitCalls).toHaveLength(1);
  });

  it('does not block on the advisory unintegrated head that a squash merge leaves behind', async () => {
    const { runtime, gitCalls } = await fixture(async () => ok(report([entry({ blockers: ['unintegrated_head'] })])));

    const removed = await remove(runtime);

    expect(removed).toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(gitCalls).toEqual([{ workspaceId, args: ['worktree', 'remove', worktreePath] }]);
  });

  it('fails closed when classification or the ledger entry itself cannot be verified', async () => {
    const unclassified = await fixture(async () => err(appError('INTERNAL_ERROR', 'ledger unavailable')));
    const refused = await remove(unclassified.runtime);
    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    if (!refused.ok) expect(refused.error.message).toContain('could not be verified');
    expect(unclassified.gitCalls).toEqual([]);

    const missing = await fixture(async () => ok(report([])));
    const missingRefused = await remove(missing.runtime);
    expect(missingRefused).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(missing.gitCalls).toEqual([]);
  });

  it('reports the classification in a dry run without touching git or the ledger', async () => {
    const { runtime, gitCalls, state } = await fixture(async () => ok(report([entry({ blockers: ['dirty'] })])));

    const preview = await remove(runtime, { dryRun: true });

    expect(preview).toMatchObject({
      ok: true,
      value: {
        dryRun: true,
        worktreeSafety: { status: 'blocked', blockers: ['dirty'] },
      },
    });
    expect(gitCalls).toEqual([]);
    expect((await state.readShared()).worktrees).toHaveLength(1);
  });

  it('removes a clean worktree and drops its ledger entry', async () => {
    const { runtime, gitCalls, state } = await fixture(async () => ok(report([entry()])));

    const removed = await remove(runtime);

    expect(removed).toMatchObject({
      ok: true,
      value: {
        dryRun: false,
        status: 'completed',
        worktreeSafety: { status: 'clean', blockers: [] },
        result: { exitCode: 0 },
      },
    });
    expect(gitCalls).toEqual([{ workspaceId, args: ['worktree', 'remove', worktreePath] }]);
    expect((await state.readShared()).worktrees).toEqual([]);
  });
});
