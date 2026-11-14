import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { GitAdapter, type GitRunResult } from '@unified-mpc/git';
import {
  createGoalWorktreeReconciliationPort,
  type GoalWorktreeReconciliationLedgerEntry,
  type GoalWorktreeReconciliationPort,
  type GoalWorktreeReconciliationRequest,
} from './goal-worktree-reconciliation-port.js';
import { createGoalWorktreeRemovalPreviewPort } from './goal-worktree-removal-preview.js';
import type {
  GoalWorktreeClassificationEntry,
  GoalWorktreeClassificationReport,
} from './goal-worktree-reconciliation-service.js';

const WORKSPACE = 'ws-1';
const WORKTREE = '/tmp/unified/worktrees/goal-1';
const actor = { clientId: 'client-a', sessionId: 'session-new' };

function entry(
  overrides: Partial<GoalWorktreeClassificationEntry> = {},
): GoalWorktreeClassificationEntry {
  return {
    worktreePath: WORKTREE,
    ref: 'main',
    owner: actor.clientId,
    disposition: 'safe_to_clean',
    blockers: [],
    blockerDetails: [],
    ...overrides,
  };
}

function report(entries: readonly GoalWorktreeClassificationEntry[]): GoalWorktreeClassificationReport {
  return {
    integrationBase: 'origin/main',
    entries,
    safeToCleanCount: entries.filter((row) => row.disposition === 'safe_to_clean').length,
    keepCount: entries.filter((row) => row.disposition === 'keep').length,
  };
}

function previewPort(result: Result<GoalWorktreeClassificationReport>): {
  readonly requests: GoalWorktreeReconciliationRequest[];
  readonly port: ReturnType<typeof createGoalWorktreeRemovalPreviewPort>;
} {
  const requests: GoalWorktreeReconciliationRequest[] = [];
  return {
    requests,
    port: createGoalWorktreeRemovalPreviewPort({
      reconciliation: {
        async classify(request): Promise<Result<GoalWorktreeClassificationReport>> {
          requests.push(request);
          return result;
        },
      },
    }),
  };
}

describe('createGoalWorktreeRemovalPreviewPort', () => {
  it('asks the ledger as the client, not as the session that spawned the worktree', async () => {
    const { port, requests } = previewPort(ok(report([entry()])));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: WORKTREE, actor });

    expect(preview).toMatchObject({ ok: true, value: { status: 'clean', blockers: [] } });
    expect(requests).toEqual([{ workspaceId: WORKSPACE, actor, ownershipScope: 'client' }]);
  });

  it('reports an owned clean worktree with its owner and no ownership warning', async () => {
    const { port } = previewPort(ok(report([entry()])));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: WORKTREE, actor });
    if (!preview.ok) throw new Error('expected a preview');

    expect(preview.value).toMatchObject({
      worktreePath: WORKTREE,
      status: 'clean',
      blockers: [],
      blockerDetails: [],
      owner: 'client-a',
      externallyOwned: false,
      activeLease: false,
      pathMissing: false,
    });
    // `runCloseGate` accepts this shape without a cast: every field its removal
    // port reads is structurally present, including a status union wider than
    // the preview's.
    const compatible: {
      readonly worktreePath: string;
      readonly status: 'clean' | 'blocked' | 'unavailable';
      readonly blockers: readonly string[];
      readonly blockerDetails: readonly string[];
    } = preview.value;
    expect(compatible.worktreePath).toBe(WORKTREE);
    expect(compatible.status).toBe('clean');
    expect(compatible.blockers).toEqual([]);
    expect(compatible.blockerDetails).toEqual([]);
  });

  it('matches the ledger path exactly, including a relative form', async () => {
    const stored = '.unified-mpc/worktrees/goal-1';
    const { port } = previewPort(ok(report([entry({ worktreePath: stored })])));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: stored, actor });

    expect(preview).toMatchObject({
      ok: true,
      value: { worktreePath: stored, status: 'clean' },
    });
  });

  it('refuses a path that differs from the ledger form instead of normalizing it', async () => {
    const stored = '.unified-mpc/worktrees/goal-1';
    const { port } = previewPort(ok(report([entry({ worktreePath: stored })])));

    const preview = await port.preview({
      workspaceId: WORKSPACE,
      worktreePath: `./${stored}`,
      actor,
    });

    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected a refusal');
    expect(preview.error.message).toContain('cannot be attributed');
  });

  it('keeps a foreign client and its dirty tree as blockers instead of filtering them', async () => {
    const { port } = previewPort(ok(report([entry({
      owner: 'client-b',
      disposition: 'keep',
      blockers: ['externally_owned', 'dirty'],
      blockerDetails: ['status probe failed: permission denied'],
    })])));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: WORKTREE, actor });

    // The close receipt says "removal clean"; a foreign row must not produce that
    // claim while `git_worktree_remove` would refuse the same path.
    expect(preview).toMatchObject({
      ok: true,
      value: {
        status: 'blocked',
        blockers: ['externally_owned', 'dirty'],
        blockerDetails: ['status probe failed: permission denied'],
        owner: 'client-b',
        externallyOwned: true,
      },
    });
  });

  it('reports a live lease and an unverifiable probe as blockers', async () => {
    const { port } = previewPort(ok(report([entry({
      disposition: 'keep',
      blockers: ['active_lease', 'probe_failed'],
    })])));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: WORKTREE, actor });

    expect(preview).toMatchObject({
      ok: true,
      value: { status: 'blocked', blockers: ['active_lease', 'probe_failed'], activeLease: true },
    });
  });

  it('drops advisory blockers from the verdict but still reports a missing path', async () => {
    const { port } = previewPort(ok(report([entry({ blockers: ['path_missing', 'unintegrated_head'] })])));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: WORKTREE, actor });

    expect(preview).toMatchObject({
      ok: true,
      value: { status: 'clean', blockers: [], pathMissing: true },
    });
  });

  it('refuses a path the ledger does not record instead of guessing it is removable', async () => {
    const missing = path.join(path.dirname(WORKTREE), 'someone-else');
    const { port } = previewPort(ok(report([entry()])));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: missing, actor });

    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected a refusal');
    expect(preview.error.code).toBe('CONFLICT');
    expect(preview.error.message).toContain(missing);
    expect(preview.error.message).toContain(WORKSPACE);
  });

  it('propagates a classification failure unchanged', async () => {
    const failure = appError('INTERNAL_ERROR', 'ledger unavailable', true);
    const { port } = previewPort(err(failure));

    const preview = await port.preview({ workspaceId: WORKSPACE, worktreePath: WORKTREE, actor });

    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('expected a refusal');
    expect(preview.error).toBe(failure);
  });
});

describe('createGoalWorktreeRemovalPreviewPort over the real reconciliation port', () => {
  let root: string;
  let worktreePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'uw-goal-removal-preview-'));
    worktreePath = path.join(root, 'wt');
    await mkdir(worktreePath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function realPort(ownerSessionId: string): GoalWorktreeReconciliationPort {
    const runner = {
      async run(args: readonly string[]): Promise<GitRunResult> {
        if (args[0] === 'rev-parse') {
          return { exitCode: 0, stdout: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n', stderr: '' };
        }
        // `merge-base --is-ancestor HEAD origin/main` exits 0 for integrated HEADs.
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const ledger: readonly GoalWorktreeReconciliationLedgerEntry[] = [{
      workspaceId: WORKSPACE,
      worktreePath,
      ref: 'main',
      owner: actor.clientId,
      ownerSessionId,
    }];
    return createGoalWorktreeReconciliationPort({
      git: new GitAdapter(runner),
      listLedgerEntries: async () => ledger,
      listActivelyLeasedWorkspaceIds: async () => [],
    });
  }

  it('previews a worktree from an earlier session of the same client as clean', async () => {
    const reconciliation = realPort('session-old');
    const previews = createGoalWorktreeRemovalPreviewPort({ reconciliation });

    // The default session scope is exactly what makes the old preview
    // unreachable after a handoff.
    const sessionScoped = await reconciliation.classify({ workspaceId: WORKSPACE, actor });
    expect(sessionScoped).toMatchObject({
      ok: true,
      value: { entries: [{ blockers: ['externally_owned'] }] },
    });

    const preview = await previews.preview({ workspaceId: WORKSPACE, worktreePath, actor });
    expect(preview).toMatchObject({
      ok: true,
      value: { status: 'clean', blockers: [], externallyOwned: false },
    });
  });

  it('blocks a worktree owned by another client', async () => {
    const reconciliation = realPort('session-old');
    const previews = createGoalWorktreeRemovalPreviewPort({ reconciliation });
    const otherClient = { clientId: 'client-b', sessionId: 'session-old' };

    const preview = await previews.preview({ workspaceId: WORKSPACE, worktreePath, actor: otherClient });

    expect(preview).toMatchObject({
      ok: true,
      value: { status: 'blocked', blockers: ['externally_owned'], externallyOwned: true },
    });
  });
});
