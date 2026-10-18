import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitAdapter, type GitRunResult } from '@unified-mpc/git';
import {
  createGoalWorktreeReconciliationPort,
  type GoalWorktreeReconciliationLedgerEntry,
  type GoalWorktreeReconciliationPort,
} from './goal-worktree-reconciliation-port.js';

const actor = { clientId: 'client-a', sessionId: 'session-a' };

interface ScriptedGitOptions {
  readonly status?: string;
  readonly head?: string;
  readonly ancestryExit?: number;
}

function scriptedGit(options: ScriptedGitOptions = {}): { readonly git: GitAdapter; readonly calls: string[][] } {
  const calls: string[][] = [];
  const runner = {
    async run(args: readonly string[], cwd: string): Promise<GitRunResult> {
      calls.push([cwd, ...args]);
      if (args[0] === 'status') return { exitCode: 0, stdout: options.status ?? '', stderr: '' };
      if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${options.head ?? 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'}\n`, stderr: '' };
      return { exitCode: options.ancestryExit ?? 0, stdout: '', stderr: '' };
    },
  };
  return { git: new GitAdapter(runner), calls };
}

describe('createGoalWorktreeReconciliationPort', () => {
  let root: string;
  let worktrees: readonly GoalWorktreeReconciliationLedgerEntry[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'uw-goal-worktree-port-'));
    await mkdir(path.join(root, 'wt-a'));
    await mkdir(path.join(root, 'wt-b'));
    worktrees = [
      { workspaceId: 'ws-1', worktreePath: path.join(root, 'wt-a'), ref: 'main', owner: actor.clientId, ownerSessionId: actor.sessionId },
      { workspaceId: 'ws-2', worktreePath: path.join(root, 'wt-b'), ref: 'main', owner: actor.clientId, ownerSessionId: actor.sessionId },
    ];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function port(options: {
    readonly git?: ScriptedGitOptions;
    readonly leasedWorkspaceIds?: readonly string[];
    readonly leaseProbe?: () => Promise<readonly string[]>;
    readonly ledger?: readonly GoalWorktreeReconciliationLedgerEntry[];
  } = {}): { readonly calls: string[][]; readonly port: GoalWorktreeReconciliationPort } {
    const git = scriptedGit(options.git);
    return {
      calls: git.calls,
      port: createGoalWorktreeReconciliationPort({
        git: git.git,
        listLedgerEntries: async (): Promise<readonly GoalWorktreeReconciliationLedgerEntry[]> => options.ledger ?? worktrees,
        listActivelyLeasedWorkspaceIds: options.leaseProbe ?? (async (): Promise<readonly string[]> => options.leasedWorkspaceIds ?? []),
      }),
    };
  }

  it('reports a clean integrated worktree as safe to clean over the default integration base', async () => {
    const result = await port().port.classify({ workspaceId: 'ws-1', actor });
    expect(result).toMatchObject({
      ok: true,
      value: {
        integrationBase: 'origin/main',
        safeToCleanCount: 1,
        keepCount: 0,
        entries: [{
          worktreePath: path.join(root, 'wt-a'),
          ref: 'main',
          owner: actor.clientId,
          disposition: 'safe_to_clean',
          blockers: [],
        }],
      },
    });
  });

  it('keeps every worktree of a workspace that still holds a goal writer lease', async () => {
    const result = await port({ leasedWorkspaceIds: ['ws-1'] }).port.classify({ workspaceId: 'ws-1', actor });
    expect(result).toMatchObject({
      ok: true,
      value: { safeToCleanCount: 0, keepCount: 1, entries: [{ disposition: 'keep', blockers: ['active_lease'] }] },
    });
  });

  it('keeps dirty and conflicted worktrees with their exact blockers in canonical order', async () => {
    const result = await port({ git: { status: ' M tracked.txt\u0000UU conflict.txt\u0000' } }).port
      .classify({ workspaceId: 'ws-1', actor });
    expect(result).toMatchObject({
      ok: true,
      value: { entries: [{ disposition: 'keep', blockers: ['dirty', 'unmerged_changes'] }] },
    });
  });

  it('blocks cross-session ownership and unintegrated heads instead of guessing', async () => {
    const other = await port({ git: { ancestryExit: 1 } }).port.classify({
      workspaceId: 'ws-1',
      actor: { clientId: actor.clientId, sessionId: 'session-b' },
    });
    expect(other).toMatchObject({
      ok: true,
      value: { entries: [{ disposition: 'keep', blockers: ['externally_owned', 'unintegrated_head'] }] },
    });
  });

  it('classifies only the requested workspace and never probes the others', async () => {
    const scoped = port();
    const result = await scoped.port.classify({ workspaceId: 'ws-1', actor });
    expect(result).toMatchObject({ ok: true, value: { entries: [{ worktreePath: path.join(root, 'wt-a') }] } });
    expect(scoped.calls.every(([cwd]) => cwd === path.join(root, 'wt-a'))).toBe(true);
  });

  it('fails closed when the lease probe rejects instead of reporting cleanable worktrees', async () => {
    const result = await port({ leaseProbe: async () => { throw new Error('goal store unavailable'); } }).port
      .classify({ workspaceId: 'ws-1', actor });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('fails closed when the ledger cannot be read', async () => {
    const result = await createGoalWorktreeReconciliationPort({
      git: scriptedGit().git,
      listLedgerEntries: async () => { throw new Error('ledger unavailable'); },
      listActivelyLeasedWorkspaceIds: async () => [],
    }).classify({ workspaceId: 'ws-1', actor });
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
  });
});
