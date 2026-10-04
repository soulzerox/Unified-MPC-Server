import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitCommandResult, GitGuardedRebaseResult, GitStatusResult, GitWorkspaceSnapshot } from '@unified-mpc/git';
import type { Result, WorkspaceAdmissionReceipt, WorkspaceBaseRebaseReceipt } from '@unified-mpc/domain';
import type { Workspace, WorkspaceRepository, WorkspaceWriterLease } from '@unified-mpc/workspace';
import { GoalWorkspaceService, type GoalWorkspaceGitPort } from './goal-workspace-service.js';

class MemoryWorkspaceRepository implements WorkspaceRepository {
  public readonly workspaces: Workspace[] = [];

  public async list(): Promise<Workspace[]> { return this.workspaces.filter((workspace) => workspace.archivedAt == null); }
  public async listAll(): Promise<Workspace[]> { return [...this.workspaces]; }
  public async get(id: string): Promise<Workspace | null> { return this.workspaces.find((workspace) => workspace.id === id && workspace.archivedAt == null) ?? null; }
  public async insert(workspace: Workspace): Promise<void> { this.workspaces.push(workspace); }
  public async insertIfAvailable(workspace: Workspace): Promise<boolean> {
    if (this.workspaces.some((current) => current.archivedAt == null && current.realRootPath === workspace.realRootPath)) return false;
    this.workspaces.push(workspace);
    return true;
  }
  public async archive(id: string, archivedAt = new Date().toISOString()): Promise<void> {
    const workspace = this.workspaces.find((current) => current.id === id);
    if (workspace !== undefined) this.workspaces[this.workspaces.indexOf(workspace)] = { ...workspace, archivedAt };
  }
  public async restore(id: string, workspace?: Workspace): Promise<void> {
    if (workspace === undefined) return;
    const index = this.workspaces.findIndex((current) => current.id === id);
    if (index >= 0) this.workspaces[index] = workspace;
  }
  public async delete(id: string): Promise<void> {
    const index = this.workspaces.findIndex((workspace) => workspace.id === id);
    if (index >= 0) this.workspaces.splice(index, 1);
  }

  public async acquireGoalWriterLease(id: string, leaseId: string, ownerId: string, now: string, expiresAt: string): Promise<WorkspaceWriterLease | null> {
    const current = this.workspaces.find((workspace) => workspace.id === id && workspace.archivedAt == null);
    if (current === undefined) return null;
    if (current.writerLease !== undefined && current.writerLease.expiresAt > now && current.writerLease.leaseId !== leaseId) return null;
    const generation = (current.writerLease?.generation ?? 0) + (current.writerLease?.leaseId === leaseId ? 0 : 1);
    const lease = { leaseId, ownerId, generation, expiresAt };
    this.workspaces[this.workspaces.indexOf(current)] = { ...current, writerLease: lease };
    return lease;
  }

  public async renewGoalWriterLease(id: string, leaseId: string, generation: number, now: string, expiresAt: string): Promise<boolean> {
    const current = this.workspaces.find((workspace) => workspace.id === id && workspace.archivedAt == null);
    if (current?.writerLease === undefined || current.writerLease.leaseId !== leaseId || current.writerLease.generation !== generation || current.writerLease.expiresAt <= now) return false;
    this.workspaces[this.workspaces.indexOf(current)] = { ...current, writerLease: { ...current.writerLease, expiresAt } };
    return true;
  }

  public async releaseGoalWriterLease(id: string, leaseId: string, generation: number): Promise<boolean> {
    const current = this.workspaces.find((workspace) => workspace.id === id && workspace.archivedAt == null);
    if (current?.writerLease === undefined || current.writerLease.leaseId !== leaseId || current.writerLease.generation !== generation) return false;
    const { writerLease: releasedWriterLease, ...withoutLease } = current;
    void releasedWriterLease;
    this.workspaces[this.workspaces.indexOf(current)] = withoutLease;
    return true;
  }
}

class FakeGitPort implements GoalWorkspaceGitPort {
  public readonly commands: string[][] = [];
  public readonly removed: string[] = [];
  public readonly refreshedRefs: Array<{ remote: string; sourceRef: string }> = [];
  public refreshedBaseSha = 'c'.repeat(40);
  public statusEntries: GitStatusResult['entries'] = [];
  public runResults: GitCommandResult[] = [];

  public async status(): Promise<Result<GitStatusResult>> {
    return { ok: true, value: { entries: this.statusEntries } };
  }

  public async run(_cwd: string, args: readonly string[]): Promise<Result<GitCommandResult>> {
    this.commands.push([...args]);
    if (args[0] === 'worktree' && args[1] === 'remove') this.removed.push(args[2] ?? '');
    return { ok: true, value: this.runResults.shift() ?? { exitCode: 0, stdout: '', stderr: '' } };
  }

  public async refreshRemoteRef(_cwd: string, remote: string, sourceRef: string): Promise<Result<string>> {
    this.refreshedRefs.push({ remote, sourceRef });
    return { ok: true, value: this.refreshedBaseSha };
  }
}

interface GuardedRebaseHarnessOptions {
  readonly workspacePatch?: Partial<Workspace>;
  readonly admissionPatch?: Partial<WorkspaceAdmissionReceipt>;
  readonly admissionMissing?: boolean;
  readonly observedHead?: string;
  readonly observedDirtyFingerprint?: string;
  readonly observedStatusEntries?: GitStatusResult['entries'];
  readonly remoteGoalSha?: string | null;
  readonly ancestry?: boolean;
  readonly priorReceipt?: WorkspaceBaseRebaseReceipt | null;
  readonly failStartedReceiptCas?: boolean;
  readonly rebaseResult?: Result<GitGuardedRebaseResult>;
  readonly expireLeaseAfterRebase?: boolean;
}

interface GuardedRebaseHarness {
  readonly repository: MemoryWorkspaceRepository;
  readonly service: GoalWorkspaceService;
  readonly head: string;
  readonly oldBase: string;
  readonly newBase: string;
  readonly newHead: string;
  readonly lease: WorkspaceWriterLease;
  readonly admission: WorkspaceAdmissionReceipt;
  readonly receipts: WorkspaceBaseRebaseReceipt[];
  readonly invalidationReasons: string[];
  readonly guardedRebaseCalls: () => number;
}

function guardedRebaseHarness(options: GuardedRebaseHarnessOptions = {}): GuardedRebaseHarness {
  const repository = new MemoryWorkspaceRepository();
  const head = 'a'.repeat(40);
  const oldBase = 'b'.repeat(40);
  const newBase = 'c'.repeat(40);
  const newHead = 'd'.repeat(40);
  const lease: WorkspaceWriterLease = {
    leaseId: 'lease-1', ownerId: 'owner-1', generation: 3, expiresAt: '2026-09-23T01:00:00.000Z',
  };
  const workspace: Workspace = {
    id: 'goal-workspace-1', displayName: 'Goal', rootPath: '/goal', realRootPath: '/goal',
    createdAt: '2026-09-23T00:00:00.000Z', lifecycleKind: 'goal', goalId: 'goal-1',
    parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree', baseRef: 'origin/main',
    baseRevision: oldBase, branchName: 'codex/goal-1', checkpointId: 'checkpoint-1',
    integrationState: 'pending', writerLease: lease, ...options.workspacePatch,
  };
  repository.workspaces.push(workspace);
  const admission: WorkspaceAdmissionReceipt = {
    admissionId: 'admission-1', projectId: 'project-1', workspaceId: workspace.id, goalId: 'goal-1',
    workspaceKind: 'git', repositoryIdentity: 'repo-1', worktreeIdentity: 'worktree-1',
    branchName: 'codex/goal-1', expectedWorkspaceHead: head, observedWorkspaceHead: head,
    baseRef: 'origin/main', expectedBaseSha: oldBase, resolvedBaseSha: oldBase, mergeBaseSha: oldBase,
    dirtyState: 'clean', dirtyFingerprint: 'clean-1', stagedFingerprint: 'staged-1',
    checkpointId: 'checkpoint-1', checkpointRevision: 7, writeLeaseGeneration: 3,
    runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'generation-1',
    runtimeBuildVersion: '4.61.0+0123456789ab',
    runtimeBuildCommit: '0123456789abcdef0123456789abcdef01234567', runtimeBuildDirty: false,
    runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-09-23T00:00:00.000Z',
    workflowVersion: 1, admissionGeneration: 4, createdAt: '2026-09-23T00:00:00.000Z',
    ...options.admissionPatch,
  };
  const receipts: WorkspaceBaseRebaseReceipt[] = [];
  const invalidationReasons: string[] = [];
  let storedReceipt = options.priorReceipt ?? null;
  Object.assign(repository, {
    getAdmissionReceipt: async () => options.admissionMissing === true ? null : admission,
    getBaseRebaseReceipt: async () => storedReceipt,
    compareAndSwapBaseRebaseReceipt: async (
      _workspaceId: string,
      expectedRevision: number,
      _expectedAdmissionGeneration: number,
      _writeLeaseGeneration: number,
      receipt: WorkspaceBaseRebaseReceipt,
    ) => {
      if (options.failStartedReceiptCas === true && receipt.status === 'started') return false;
      if ((storedReceipt?.receiptRevision ?? 0) !== expectedRevision) return false;
      storedReceipt = receipt;
      receipts.push(receipt);
      return true;
    },
    invalidateAdmissionReceipt: async (
      _workspaceId: string,
      _generation: number,
      reason: string,
    ) => {
      invalidationReasons.push(reason);
      return true;
    },
  });

  const git = new FakeGitPort();
  git.refreshedBaseSha = newBase;
  let guardedRebaseCalls = 0;
  Object.assign(git, {
    observeWorkspace: async () => ({ ok: true, value: {
      repositoryIdentity: 'repo-1', gitCommonDirIdentity: 'common-1', worktreeIdentity: 'worktree-1',
      branch: 'codex/goal-1', head: options.observedHead ?? head,
      statusEntries: options.observedStatusEntries ?? [],
      stagedFingerprint: 'staged-1', dirtyFingerprint: options.observedDirtyFingerprint ?? 'clean-1',
      baseRef: oldBase, baseSha: oldBase, mergeBaseSha: oldBase,
    } }),
    remoteBranchSha: async () => ({ ok: true, value: options.remoteGoalSha ?? null }),
    isAncestor: async () => ({ ok: true, value: options.ancestry ?? true }),
    createRecoveryRef: async () => ({ ok: true, value: undefined }),
    guardedRebase: async () => {
      guardedRebaseCalls += 1;
      if (options.expireLeaseAfterRebase === true) {
        repository.workspaces[0] = {
          ...repository.workspaces[0]!,
          writerLease: { ...lease, expiresAt: '2026-09-23T00:00:00.000Z' },
        };
      }
      return options.rebaseResult ?? { ok: true, value: { status: 'completed', newHead } };
    },
  });
  return {
    repository,
    service: new GoalWorkspaceService(repository, git, { now: () => new Date('2026-09-23T00:30:00.000Z') }),
    head, oldBase, newBase, newHead, lease, admission, receipts, invalidationReasons,
    guardedRebaseCalls: () => guardedRebaseCalls,
  };
}

describe('GoalWorkspaceService', () => {
  it('creates a new worktree from the freshly fetched origin/main commit and records that exact SHA', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-main-'));
    const repository = new MemoryWorkspaceRepository();
    repository.workspaces.push({
      id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: '2026-09-23T00:00:00.000Z', lifecycleKind: 'project',
    });
    const git = new FakeGitPort();
    git.runResults = [
      { exitCode: 0, stdout: `${git.refreshedBaseSha}\n`, stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    ];

    try {
      await mkdir(path.join(parentRoot, '.unified-mpc', 'worktrees', 'goal-1'), { recursive: true });
      const result = await new GoalWorkspaceService(repository, git).create({
        goalId: 'goal-1', parentWorkspaceId: 'project-1', branchName: 'codex/goal-1',
      });

      expect(result.ok).toBe(true);
      expect(git.refreshedRefs).toEqual([{ remote: 'origin', sourceRef: 'refs/heads/main' }]);
      expect(git.commands.find((command) => command[0] === 'worktree')).toEqual([
        'worktree', 'add', '-b', 'codex/goal-1', path.join(parentRoot, '.unified-mpc', 'worktrees', 'goal-1'), git.refreshedBaseSha,
      ]);
      expect(repository.workspaces.find((workspace) => workspace.id !== 'project-1')).toMatchObject({
        baseRef: 'origin/main',
        baseRevision: git.refreshedBaseSha,
      });
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('rejects Goal Workspace creation when the managed worktree root canonicalizes elsewhere', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-symlink-'));
    const nonManagedRoot = path.join(parentRoot, 'non-managed');
    const repository = new MemoryWorkspaceRepository();
    repository.workspaces.push({
      id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: '2026-09-23T00:00:00.000Z', lifecycleKind: 'project',
    });
    const git = new FakeGitPort();
    git.runResults = [
      { exitCode: 0, stdout: `${git.refreshedBaseSha}\n`, stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
    ];

    try {
      await mkdir(path.join(parentRoot, '.unified-mpc'), { recursive: true });
      await mkdir(nonManagedRoot, { recursive: true });
      await symlink(nonManagedRoot, path.join(parentRoot, '.unified-mpc', 'worktrees'), 'dir');

      const result = await new GoalWorkspaceService(repository, git).create({
        goalId: 'goal-escape', parentWorkspaceId: 'project-1', branchName: 'goal/escape',
      });

      expect(result).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_WORKSPACE' } });
      expect(git.commands.some((command) => command[0] === 'worktree')).toBe(false);
      expect(repository.workspaces).toHaveLength(1);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('persists admission only when exact checkpoint, current writer lease, and runtime identity agree', async () => {
    const repository = new MemoryWorkspaceRepository();
    const head = 'a'.repeat(40);
    const base = 'b'.repeat(40);
    repository.workspaces.push({
      id: 'goal-workspace-1', displayName: 'Goal', rootPath: '/goal', realRootPath: '/goal', createdAt: '2026-09-23T00:00:00.000Z',
      lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
      baseRevision: base, branchName: 'codex/goal-1', checkpointId: 'checkpoint-1',
      writerLease: { leaseId: 'lease-1', ownerId: 'owner-1', generation: 3, expiresAt: '2026-09-23T01:00:00.000Z' },
    });
    let stored: WorkspaceAdmissionReceipt | null = null;
    repository.getAdmissionReceipt = async (): Promise<WorkspaceAdmissionReceipt | null> => stored;
    repository.compareAndSwapAdmissionReceipt = async (_id, expectedGeneration, _leaseGeneration, receipt): Promise<boolean> => {
      if ((stored?.admissionGeneration ?? 0) !== expectedGeneration) return false;
      stored = receipt;
      return true;
    };
    const git = new FakeGitPort();
    git.observeWorkspace = async (): Promise<Result<GitWorkspaceSnapshot>> => ({
      ok: true,
      value: {
        repositoryIdentity: 'repo-1', gitCommonDirIdentity: 'common-1', worktreeIdentity: 'worktree-1',
        branch: 'codex/goal-1', head, statusEntries: [], stagedFingerprint: 'staged-1', dirtyFingerprint: 'dirty-1',
        baseRef: base, baseSha: base, mergeBaseSha: base,
      },
    });
    const service = new GoalWorkspaceService(repository, git, { now: (): Date => new Date('2026-09-23T00:30:00.000Z') });

    const result = await service.captureAdmission({
      workspaceId: 'goal-workspace-1', checkpointId: 'checkpoint-1', checkpointRevision: 7, checkpointHead: head,
      workflowVersion: 1,
      runtime: {
        runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'generation-1', runtimeBuildVersion: '4.61.0+0123456789ab',
        runtimeBuildCommit: '0123456789abcdef0123456789abcdef01234567', runtimeBuildDirty: false,
        runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-09-23T00:00:00.000Z',
      },
    });

    expect(result).toMatchObject({ ok: true, value: { admissionGeneration: 1, expectedWorkspaceHead: head, observedWorkspaceHead: head, expectedBaseSha: base, resolvedBaseSha: base, checkpointRevision: 7, writeLeaseGeneration: 3, runtimeGeneration: 'generation-1' } });
    expect(stored).toEqual(result.ok ? result.value : null);
  });

  it('refuses an admission receipt when the workspace head no longer matches its checkpoint', async () => {
    const repository = new MemoryWorkspaceRepository();
    repository.workspaces.push({
      id: 'goal-workspace-1', displayName: 'Goal', rootPath: '/goal', realRootPath: '/goal', createdAt: '2026-09-23T00:00:00.000Z',
      lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
      baseRevision: 'b'.repeat(40), branchName: 'codex/goal-1', checkpointId: 'checkpoint-1',
      writerLease: { leaseId: 'lease-1', ownerId: 'owner-1', generation: 3, expiresAt: '2026-09-23T01:00:00.000Z' },
    });
    let writes = 0;
    repository.getAdmissionReceipt = async (): Promise<WorkspaceAdmissionReceipt | null> => null;
    repository.compareAndSwapAdmissionReceipt = async (): Promise<boolean> => { writes += 1; return true; };
    const git = new FakeGitPort();
    git.observeWorkspace = async (): Promise<Result<GitWorkspaceSnapshot>> => ({ ok: true, value: {
      repositoryIdentity: 'repo-1', gitCommonDirIdentity: 'common-1', worktreeIdentity: 'worktree-1', branch: 'codex/goal-1',
      head: 'a'.repeat(40), statusEntries: [], stagedFingerprint: 'staged-1', dirtyFingerprint: 'dirty-1',
      baseRef: 'b'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    } });
    const service = new GoalWorkspaceService(repository, git, { now: (): Date => new Date('2026-09-23T00:30:00.000Z') });

    const result = await service.captureAdmission({
      workspaceId: 'goal-workspace-1', checkpointId: 'checkpoint-1', checkpointRevision: 7, checkpointHead: 'c'.repeat(40),
      workflowVersion: 1,
      runtime: {
        runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'generation-1', runtimeBuildVersion: '4.61.0+0123456789ab',
        runtimeBuildCommit: '0123456789abcdef0123456789abcdef01234567', runtimeBuildDirty: false,
        runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-09-23T00:00:00.000Z',
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(writes).toBe(0);
  });

  it('rebases a clean private goal branch only after exact admission, lease, checkpoint, and frozen-base checks pass', async () => {
    const repository = new MemoryWorkspaceRepository();
    const head = 'a'.repeat(40);
    const oldBase = 'b'.repeat(40);
    const newBase = 'c'.repeat(40);
    const newHead = 'd'.repeat(40);
    const lease = { leaseId: 'lease-1', ownerId: 'owner-1', generation: 3, expiresAt: '2026-09-23T01:00:00.000Z' };
    repository.workspaces.push({
      id: 'goal-workspace-1', displayName: 'Goal', rootPath: '/goal', realRootPath: '/goal', createdAt: '2026-09-23T00:00:00.000Z',
      lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
      baseRef: 'origin/main', baseRevision: oldBase, branchName: 'codex/goal-1', checkpointId: 'checkpoint-1',
      integrationState: 'pending', writerLease: lease,
    });
    const admission: WorkspaceAdmissionReceipt = {
      admissionId: 'admission-1', projectId: 'project-1', workspaceId: 'goal-workspace-1', goalId: 'goal-1',
      workspaceKind: 'git', repositoryIdentity: 'repo-1', worktreeIdentity: 'worktree-1', branchName: 'codex/goal-1',
      expectedWorkspaceHead: head, observedWorkspaceHead: head, baseRef: 'origin/main', expectedBaseSha: oldBase,
      resolvedBaseSha: oldBase, mergeBaseSha: oldBase, dirtyState: 'clean', dirtyFingerprint: 'clean-1',
      stagedFingerprint: 'staged-1', checkpointId: 'checkpoint-1', checkpointRevision: 7, writeLeaseGeneration: 3,
      runtimeDeploymentId: 'deploy-1', runtimeGeneration: 'generation-1', runtimeBuildVersion: '4.61.0+0123456789ab',
      runtimeBuildCommit: '0123456789abcdef0123456789abcdef01234567', runtimeBuildDirty: false,
      runtimeProtocolGeneration: 1, runtimeStartedAt: '2026-09-23T00:00:00.000Z', workflowVersion: 1,
      admissionGeneration: 4, createdAt: '2026-09-23T00:00:00.000Z',
    };
    const rebaseReceipts: Array<{ status: string; oldHead: string; newBaseSha: string; resultHead?: string }> = [];
    let invalidated = false;
    Object.assign(repository, {
      getAdmissionReceipt: async () => admission,
      getBaseRebaseReceipt: async () => null,
      compareAndSwapBaseRebaseReceipt: async (
        _workspaceId: string,
        _expectedRevision: number,
        _expectedAdmissionGeneration: number,
        _writeLeaseGeneration: number,
        receipt: { status: string; oldHead: string; newBaseSha: string; resultHead?: string },
      ) => { rebaseReceipts.push(receipt); return true; },
      invalidateAdmissionReceipt: async () => { invalidated = true; return true; },
    });
    const git = new FakeGitPort();
    git.refreshedBaseSha = newBase;
    Object.assign(git, {
      observeWorkspace: async () => ({ ok: true, value: {
        repositoryIdentity: 'repo-1', gitCommonDirIdentity: 'common-1', worktreeIdentity: 'worktree-1',
        branch: 'codex/goal-1', head, statusEntries: [], stagedFingerprint: 'staged-1', dirtyFingerprint: 'clean-1',
        baseRef: oldBase, baseSha: oldBase, mergeBaseSha: oldBase,
      } }),
      remoteBranchSha: async () => ({ ok: true, value: null }),
      isAncestor: async () => ({ ok: true, value: true }),
      createRecoveryRef: async () => ({ ok: true, value: undefined }),
      guardedRebase: async (_cwd: string, request: { oldHead: string; oldBaseSha: string; newBaseSha: string }) => {
        expect(request).toMatchObject({ oldHead: head, oldBaseSha: oldBase, newBaseSha: newBase });
        return { ok: true, value: { status: 'completed', newHead } };
      },
    });
    const service = new GoalWorkspaceService(repository, git, { now: (): Date => new Date('2026-09-23T00:30:00.000Z') });

    const result = await service.rebaseStaleBase({
      goalId: 'goal-1',
      expectedAdmissionGeneration: 4,
      lease: { leaseId: lease.leaseId, generation: lease.generation },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { status: 'REBASED', oldHead: head, newHead, oldBaseSha: oldBase, newBaseSha: newBase, checkpointId: 'checkpoint-1' },
    });
    expect(repository.workspaces[0]).toMatchObject({ baseRevision: newBase });
    expect(rebaseReceipts.map((receipt) => receipt.status)).toEqual(['started', 'completed']);
    expect(invalidated).toBe(true);
  });

  it('fails closed across guarded rebase denial evidence before Git mutation', async () => {
    const cases: ReadonlyArray<readonly [string, GuardedRebaseHarnessOptions, string]> = [
      ['dirty workspace', { observedStatusEntries: [{ path: 'dirty.ts', kind: 'modified' }] }, 'dirty_workspace'],
      ['pinned base', { workspacePatch: { baseRef: undefined } }, 'pinned_base'],
      ['published branch', { remoteGoalSha: 'e'.repeat(40) }, 'published_branch'],
      ['moved remote goal branch', {
        admissionPatch: { remoteGoalSha: 'e'.repeat(40) }, remoteGoalSha: 'f'.repeat(40),
      }, 'remote_goal_branch_moved'],
      ['rewritten base', { ancestry: false }, 'base_history_rewritten_or_unrelated'],
      ['expired writer lease', {
        workspacePatch: {
          writerLease: {
            leaseId: 'lease-1', ownerId: 'owner-1', generation: 3, expiresAt: '2026-09-23T00:30:00.000Z',
          },
        },
      }, 'stale_writer_lease'],
      ['stale checkpoint', { workspacePatch: { checkpointId: 'checkpoint-2' } }, 'admission_or_checkpoint_missing_or_stale'],
      ['workspace head drift', { observedHead: 'e'.repeat(40) }, 'workspace_state_changed'],
      ['admission generation mismatch', { admissionPatch: { admissionGeneration: 5 } }, 'admission_or_checkpoint_missing_or_stale'],
      ['frozen base revision drift', { workspacePatch: { baseRevision: 'e'.repeat(40) } }, 'workspace_base_revision_changed'],
    ];

    for (const [label, options, expectedReason] of cases) {
      const harness = guardedRebaseHarness(options);
      const result = await harness.service.rebaseStaleBase({
        goalId: 'goal-1',
        expectedAdmissionGeneration: 4,
        lease: { leaseId: harness.lease.leaseId, generation: harness.lease.generation },
      });
      expect(result, label).toMatchObject({ ok: true, value: { status: 'RECOVERY_REQUIRED', reason: expectedReason } });
      expect(harness.guardedRebaseCalls(), label).toBe(0);
      expect(harness.receipts, label).toHaveLength(0);
    }
  });

  it('fails closed for a prior started receipt and a started-receipt CAS race', async () => {
    const prior: WorkspaceBaseRebaseReceipt = {
      operationId: 'prior-operation', receiptRevision: 1, workspaceId: 'goal-workspace-1', goalId: 'goal-1',
      branchName: 'codex/goal-1', status: 'started', oldHead: 'a'.repeat(40), oldBaseSha: 'b'.repeat(40),
      newBaseSha: 'c'.repeat(40), checkpointId: 'checkpoint-1', checkpointRevision: 7,
      checkpointHead: 'a'.repeat(40), recoveryRef: 'refs/unified-mpc/recovery/rebase/prior-operation',
      admissionGeneration: 4, writeLeaseGeneration: 3, startedAt: '2026-09-23T00:20:00.000Z',
    };
    const priorHarness = guardedRebaseHarness({ priorReceipt: prior });
    await expect(priorHarness.service.rebaseStaleBase({
      goalId: 'goal-1', expectedAdmissionGeneration: 4,
      lease: { leaseId: priorHarness.lease.leaseId, generation: priorHarness.lease.generation },
    })).resolves.toMatchObject({
      ok: true, value: { status: 'RECOVERY_REQUIRED', reason: 'prior_rebase_incomplete', operationId: 'prior-operation' },
    });
    expect(priorHarness.guardedRebaseCalls()).toBe(0);

    const recoveryHarness = guardedRebaseHarness({
      priorReceipt: {
        ...prior, receiptRevision: 2, status: 'recovery_required',
        finishedAt: '2026-09-23T00:21:00.000Z', failureReason: 'rebase_conflict',
      },
    });
    await expect(recoveryHarness.service.rebaseStaleBase({
      goalId: 'goal-1', expectedAdmissionGeneration: 4,
      lease: { leaseId: recoveryHarness.lease.leaseId, generation: recoveryHarness.lease.generation },
    })).resolves.toMatchObject({
      ok: true, value: { status: 'RECOVERY_REQUIRED', reason: 'prior_rebase_recovery_required', operationId: 'prior-operation' },
    });
    expect(recoveryHarness.guardedRebaseCalls()).toBe(0);

    const racedHarness = guardedRebaseHarness({ failStartedReceiptCas: true });
    await expect(racedHarness.service.rebaseStaleBase({
      goalId: 'goal-1', expectedAdmissionGeneration: 4,
      lease: { leaseId: racedHarness.lease.leaseId, generation: racedHarness.lease.generation },
    })).resolves.toMatchObject({
      ok: true, value: { status: 'RECOVERY_REQUIRED', reason: 'rebase_receipt_raced' },
    });
    expect(racedHarness.guardedRebaseCalls()).toBe(0);
  });

  it('persists exact durable recovery evidence after an aborted rebase conflict', async () => {
    const harness = guardedRebaseHarness({
      rebaseResult: {
        ok: true,
        value: {
          status: 'conflict', conflictedPaths: ['conflict.txt'], abortSucceeded: true,
          headAfterAbort: 'a'.repeat(40), cleanAfterAbort: true, reason: 'rebase_conflict',
        },
      },
    });
    const result = await harness.service.rebaseStaleBase({
      goalId: 'goal-1', expectedAdmissionGeneration: 4,
      lease: { leaseId: harness.lease.leaseId, generation: harness.lease.generation },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'RECOVERY_REQUIRED', reason: 'rebase_conflict', oldHead: harness.head,
        oldBaseSha: harness.oldBase, newBaseSha: harness.newBase, checkpointId: 'checkpoint-1',
        conflictedPaths: ['conflict.txt'], abortSucceeded: true,
      },
    });
    expect(harness.receipts.map((receipt) => receipt.status)).toEqual(['started', 'recovery_required']);
    expect(harness.receipts[1]).toMatchObject({
      oldHead: harness.head, oldBaseSha: harness.oldBase, newBaseSha: harness.newBase,
      checkpointId: 'checkpoint-1', checkpointRevision: 7, checkpointHead: harness.head,
      recoveryRef: harness.receipts[0]?.recoveryRef, conflictedPaths: ['conflict.txt'],
      abortSucceeded: true, failureReason: 'rebase_conflict',
    });
    expect(harness.invalidationReasons).toEqual([]);
  });

  it('invalidates admission when guarded Git execution fails after the started receipt is durable', async () => {
    const harness = guardedRebaseHarness({
      rebaseResult: {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'guarded rebase failed', recoverable: true },
      },
    });
    const result = await harness.service.rebaseStaleBase({
      goalId: 'goal-1', expectedAdmissionGeneration: 4,
      lease: { leaseId: harness.lease.leaseId, generation: harness.lease.generation },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(harness.invalidationReasons).toEqual(['guarded_rebase_git_failure']);
    expect(harness.receipts.map((receipt) => receipt.status)).toEqual(['started', 'recovery_required']);
    expect(harness.receipts[1]).toMatchObject({ failureReason: 'guarded_rebase_git_failure' });
  });

  it('invalidates admission when a successful Git rebase cannot durably update workspace metadata', async () => {
    const harness = guardedRebaseHarness({ expireLeaseAfterRebase: true });
    const result = await harness.service.rebaseStaleBase({
      goalId: 'goal-1', expectedAdmissionGeneration: 4,
      lease: { leaseId: harness.lease.leaseId, generation: harness.lease.generation },
    });

    expect(result).toMatchObject({
      ok: true, value: { status: 'RECOVERY_REQUIRED', reason: 'workspace_metadata_update_failed' },
    });
    expect(harness.invalidationReasons).toEqual(['guarded_rebase_head_changed']);
    expect(harness.receipts.map((receipt) => receipt.status)).toEqual(['started', 'recovery_required']);
    expect(harness.receipts[1]).toMatchObject({
      resultHead: harness.newHead, failureReason: 'workspace_metadata_update_failed',
    });
  });

  it('creates a durable Goal Workspace from an explicit base revision and branch', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-parent-'));
    try {
      const worktreeRoot = path.join(parentRoot, '.unified-mpc', 'worktrees', 'goal-1');
      await mkdir(worktreeRoot, { recursive: true });
      const repository = new MemoryWorkspaceRepository();
      const parent: Workspace = {
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      };
      repository.workspaces.push(parent);
      const git = new FakeGitPort();
      const resolvedBase = 'd'.repeat(40);
      git.runResults = [
        { exitCode: 0, stdout: `${resolvedBase}\n`, stderr: '' },
        { exitCode: 0, stdout: '', stderr: '' },
      ];

      const result = await new GoalWorkspaceService(repository, git).create({
        goalId: 'goal-1',
        parentWorkspaceId: parent.id,
        branchName: 'goal/goal-1',
        baseRevision: 'abc123',
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          workspace: {
            lifecycleKind: 'goal',
            goalId: 'goal-1',
            parentWorkspaceId: 'project-1',
            goalWorkspaceKind: 'git_worktree',
            parentSource: 'committed_head',
            baseRevision: resolvedBase,
            branchName: 'goal/goal-1',
            integrationState: 'pending',
          },
          worktreePath: worktreeRoot,
        },
      });
      expect(git.commands).toEqual([
        ['rev-parse', '--verify', '--end-of-options', 'abc123^{commit}'],
        ['worktree', 'add', '-b', 'goal/goal-1', worktreeRoot, resolvedBase],
      ]);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('resumes only an existing Goal Workspace and never creates a replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-resume-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      const workspace: Workspace = {
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'abc123', branchName: 'goal/goal-1', integrationState: 'pending',
      };
      repository.workspaces.push(workspace);

      await expect(new GoalWorkspaceService(repository, new FakeGitPort()).resume('goal-1')).resolves.toEqual({ ok: true, value: workspace });
      expect(repository.workspaces).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not silently omit dirty parent changes when creating from a committed base', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-dirty-parent-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });
      const git = new FakeGitPort();
      git.statusEntries = [{ path: 'dirty.txt', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' }];

      await expect(new GoalWorkspaceService(repository, git).create({
        goalId: 'goal-1', parentWorkspaceId: 'project-1', branchName: 'goal/goal-1', baseRevision: 'abc123',
      })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(git.commands).toEqual([]);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('refuses to remove a dirty or not-integrated Goal Workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-remove-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'abc123', branchName: 'goal/goal-1', integrationState: 'pending',
      });
      const git = new FakeGitPort();
      const pending = await new GoalWorkspaceService(repository, git).remove('goal-1');
      expect(pending).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(git.removed).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records caller-verified integration and checkpoint metadata before safe removal', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-integrate-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({ id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString() });
      const git = new FakeGitPort();
      const workspaceRoot = path.join(parentRoot, '.unified-mpc', 'worktrees', 'goal-1');
      await mkdir(workspaceRoot, { recursive: true });
      repository.workspaces.push({
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: workspaceRoot, realRootPath: workspaceRoot, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'abc123', branchName: 'goal/goal-1', integrationState: 'pending',
      });
      const service = new GoalWorkspaceService(repository, git);

      await expect(service.recordCheckpoint('goal-1', 'checkpoint-1')).resolves.toMatchObject({ ok: true, value: { checkpointId: 'checkpoint-1' } });
      await expect(service.recordIntegrationState('goal-1', 'integrated')).resolves.toMatchObject({ ok: true, value: { integrationState: 'integrated' } });
      await expect(service.remove('goal-1')).resolves.toEqual({ ok: true, value: undefined });
      expect(git.removed).toEqual([workspaceRoot]);
      expect(repository.workspaces.find((workspace) => workspace.goalId === 'goal-1')?.archivedAt).toBeDefined();
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('returns bounded resume evidence for a clean goal worktree', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-status-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'abc123', branchName: 'goal/goal-1', checkpointId: 'checkpoint-1', integrationState: 'pending',
        writerLease: { leaseId: 'lease-1', ownerId: 'client-a', generation: 3, expiresAt: '2026-09-22T19:05:00.000Z' },
      });
      const git = new FakeGitPort();
      git.runResults = [
        { exitCode: 0, stdout: 'goal/goal-1\n', stderr: '' },
        { exitCode: 0, stdout: 'def456\n', stderr: '' },
      ];

      await expect(new GoalWorkspaceService(repository, git).status('goal-1')).resolves.toEqual({
        ok: true,
        value: {
          goalId: 'goal-1', workspaceId: 'goal-workspace-1', rootPath: root,
          workspaceState: 'clean', changedFileCount: 0, branchName: 'goal/goal-1',
          expectedBranchName: 'goal/goal-1', baseRevision: 'abc123', headRevision: 'def456',
          checkpointId: 'checkpoint-1', integrationState: 'pending',
          writerLease: { leaseId: 'lease-1', ownerId: 'client-a', generation: 3, expiresAt: '2026-09-22T19:05:00.000Z' },
          branchDrift: false,
        },
      });
      expect(git.commands).toEqual([
        ['branch', '--show-current'],
        ['rev-parse', '--verify', 'HEAD'],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks branch drift as a conflict without mutating the workspace registry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-branch-drift-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      const workspace: Workspace = {
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'abc123', branchName: 'goal/goal-1', integrationState: 'pending',
      };
      repository.workspaces.push(workspace);
      const git = new FakeGitPort();
      git.runResults = [
        { exitCode: 0, stdout: 'unexpected-branch\n', stderr: '' },
        { exitCode: 0, stdout: 'def456\n', stderr: '' },
      ];

      await expect(new GoalWorkspaceService(repository, git).status('goal-1')).resolves.toMatchObject({
        ok: true,
        value: {
          workspaceState: 'conflict', branchName: 'unexpected-branch', expectedBranchName: 'goal/goal-1',
          headRevision: 'def456', branchDrift: true,
        },
      });
      expect(repository.workspaces).toEqual([workspace]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preflights explicit integration against a clean target and unchanged base', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-preflight-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });
      const goalRoot = path.join(parentRoot, '.unified-mpc', 'worktrees', 'goal-1');
      await mkdir(goalRoot, { recursive: true });
      repository.workspaces.push({
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: goalRoot, realRootPath: goalRoot, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'base123', branchName: 'goal/goal-1', integrationState: 'pending',
      });
      const git = new FakeGitPort();
      git.runResults = [
        { exitCode: 0, stdout: 'goal/goal-1\n', stderr: '' },
        { exitCode: 0, stdout: 'goal123\n', stderr: '' },
        { exitCode: 0, stdout: 'main\n', stderr: '' },
        { exitCode: 0, stdout: 'target123\n', stderr: '' },
        { exitCode: 0, stdout: '', stderr: '' },
      ];

      await expect(new GoalWorkspaceService(repository, git).integrationPreflight('goal-1')).resolves.toMatchObject({
        ok: true,
        value: {
          canIntegrate: true, blockers: [], goalHeadRevision: 'goal123', baseRevision: 'base123',
          targetBranchName: 'main', targetHeadRevision: 'target123', targetWorkspaceState: 'clean',
        },
      });
      expect(git.commands.at(-1)).toEqual(['merge-base', '--is-ancestor', 'base123', 'target123']);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('blocks explicit integration when the canonical target is dirty', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-preflight-dirty-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });
      const goalRoot = path.join(parentRoot, '.unified-mpc', 'worktrees', 'goal-1');
      await mkdir(goalRoot, { recursive: true });
      repository.workspaces.push({
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: goalRoot, realRootPath: goalRoot, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'base123', branchName: 'goal/goal-1', integrationState: 'pending',
      });
      const git = new FakeGitPort();
      git.statusEntries = [{ path: 'unrelated.ts', kind: 'modified', indexStatus: ' ', worktreeStatus: 'M' }];

      await expect(new GoalWorkspaceService(repository, git).integrationPreflight('goal-1')).resolves.toMatchObject({
        ok: true,
        value: { canIntegrate: false, blockers: ['target_workspace_dirty'], targetWorkspaceState: 'dirty' },
      });
      expect(git.commands).toEqual([]);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('reports target branch drift as a guarded integration blocker', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-preflight-drift-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });
      const goalRoot = path.join(parentRoot, '.unified-mpc', 'worktrees', 'goal-1');
      await mkdir(goalRoot, { recursive: true });
      repository.workspaces.push({
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: goalRoot, realRootPath: goalRoot, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'git_worktree',
        baseRevision: 'base123', branchName: 'goal/goal-1', integrationState: 'pending',
      });
      const git = new FakeGitPort();
      git.runResults = [
        { exitCode: 0, stdout: 'goal/goal-1\n', stderr: '' },
        { exitCode: 0, stdout: 'goal123\n', stderr: '' },
        { exitCode: 0, stdout: 'main\n', stderr: '' },
        { exitCode: 0, stdout: 'target123\n', stderr: '' },
        { exitCode: 1, stdout: '', stderr: 'base is not an ancestor' },
      ];

      await expect(new GoalWorkspaceService(repository, git).integrationPreflight('goal-1')).resolves.toMatchObject({
        ok: true,
        value: { canIntegrate: false, blockers: ['target_branch_drift'], targetHeadRevision: 'target123' },
      });
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('does not reuse or remove an existing snapshot directory', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-snapshot-existing-'));
    const snapshotRoot = path.join(parentRoot, '.unified-mpc', 'snapshots', 'goal-1');
    const markerPath = path.join(snapshotRoot, 'keep.txt');
    try {
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(markerPath, 'pre-existing snapshot');
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });

      await expect(new GoalWorkspaceService(repository, new FakeGitPort()).create({
        goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'snapshot',
        parentSource: 'snapshot', baseRevision: 'snapshot-source-v1',
      })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      await expect(readFile(markerPath, 'utf8')).resolves.toBe('pre-existing snapshot');
      expect(repository.workspaces).toHaveLength(1);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('creates an explicitly requested bounded snapshot for a non-Git parent', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-snapshot-'));
    try {
      await mkdir(path.join(parentRoot, 'src'), { recursive: true });
      await writeFile(path.join(parentRoot, 'src', 'input.txt'), 'snapshot content');
      const ignoredNames = [
        'node_modules', 'build', 'coverage', 'dist', '.next', '.turbo', '.cache', 'cache',
        'vendor', 'target', 'bin', 'obj', '.venv', 'venv', '__pycache__',
      ];
      for (const name of ignoredNames) {
        const ignoredRoot = path.join(parentRoot, name);
        await mkdir(ignoredRoot, { recursive: true });
        await writeFile(path.join(ignoredRoot, 'generated.txt'), 'do not copy');
      }
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });
      const git = new FakeGitPort();

      const result = await new GoalWorkspaceService(repository, git).create({
        goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'snapshot',
        parentSource: 'snapshot', baseRevision: 'snapshot-source-v1',
      });

      const snapshotRoot = path.join(parentRoot, '.unified-mpc', 'snapshots', 'goal-1');
      expect(result).toMatchObject({
        ok: true,
        value: { worktreePath: snapshotRoot, workspace: {
          lifecycleKind: 'goal', goalId: 'goal-1', goalWorkspaceKind: 'snapshot',
          parentSource: 'snapshot', baseRevision: 'snapshot-source-v1',
        } },
      });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.workspace.branchName).toBeUndefined();
      await expect(readFile(path.join(snapshotRoot, 'src', 'input.txt'), 'utf8')).resolves.toBe('snapshot content');
      for (const name of ignoredNames) await expect(access(path.join(snapshotRoot, name))).rejects.toThrow();
      expect(git.commands).toEqual([]);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a snapshot exceeds its configured byte limit', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-snapshot-limit-'));
    try {
      await writeFile(path.join(parentRoot, 'large.txt'), '1234');
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });

      await expect(new GoalWorkspaceService(repository, new FakeGitPort(), { maxSnapshotBytes: 3 }).create({
        goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'snapshot',
        parentSource: 'snapshot', baseRevision: 'snapshot-source-v1',
      })).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect(repository.workspaces).toHaveLength(1);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('removes an integrated snapshot only from its managed snapshot root', async () => {
    const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-snapshot-remove-'));
    try {
      await writeFile(path.join(parentRoot, 'input.txt'), 'snapshot content');
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'project-1', displayName: 'Project', rootPath: parentRoot, realRootPath: parentRoot, createdAt: new Date(0).toISOString(),
      });
      const service = new GoalWorkspaceService(repository, new FakeGitPort());
      const created = await service.create({
        goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'snapshot',
        parentSource: 'snapshot', baseRevision: 'snapshot-source-v1',
      });
      if (!created.ok) throw new Error(created.error.message);

      await expect(service.recordIntegrationState('goal-1', 'integrated')).resolves.toMatchObject({ ok: true });
      await expect(service.remove('goal-1')).resolves.toEqual({ ok: true, value: undefined });
      await expect(access(created.value.worktreePath)).rejects.toThrow();
      expect(repository.workspaces.find((workspace) => workspace.goalId === 'goal-1')?.archivedAt).toBeDefined();
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it('fences Goal Workspace writer leases by owner and monotonically increasing generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-goal-lease-'));
    try {
      const repository = new MemoryWorkspaceRepository();
      repository.workspaces.push({
        id: 'goal-workspace-1', displayName: 'Goal', rootPath: root, realRootPath: root, createdAt: new Date(0).toISOString(),
        lifecycleKind: 'goal', goalId: 'goal-1', parentWorkspaceId: 'project-1', goalWorkspaceKind: 'snapshot',
        parentSource: 'snapshot', baseRevision: 'source-v1', integrationState: 'pending',
      });
      let now = new Date('2026-09-22T19:00:00.000Z');
      const service = new GoalWorkspaceService(repository, new FakeGitPort(), {
        now: (): Date => now,
        writerLeaseDurationMs: 1_000,
      });

      const first = await service.acquireWriterLease('goal-1', 'client-a');
      expect(first).toMatchObject({ ok: true, value: { ownerId: 'client-a', generation: 1 } });
      if (!first.ok) throw new Error(first.error.message);
      await expect(service.recordCheckpoint('goal-1', 'checkpoint-1')).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await expect(service.recordCheckpoint('goal-1', 'checkpoint-1', first.value)).resolves.toMatchObject({ ok: true });
      await expect(service.acquireWriterLease('goal-1', 'client-b')).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await expect(service.renewWriterLease('goal-1', first.value.leaseId, 0)).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

      now = new Date('2026-09-22T19:00:01.001Z');
      const second = await service.acquireWriterLease('goal-1', 'client-b');
      expect(second).toMatchObject({ ok: true, value: { ownerId: 'client-b', generation: 2 } });
      await expect(service.releaseWriterLease('goal-1', first.value.leaseId, first.value.generation)).resolves.toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
