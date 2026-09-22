import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitCommandResult, GitStatusResult } from '@unified-mpc/git';
import type { Result } from '@unified-mpc/domain';
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
    const { writerLease: _writerLease, ...withoutLease } = current;
    this.workspaces[this.workspaces.indexOf(current)] = withoutLease;
    return true;
  }
}

class FakeGitPort implements GoalWorkspaceGitPort {
  public readonly commands: string[][] = [];
  public readonly removed: string[] = [];
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
}

describe('GoalWorkspaceService', () => {
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
      git.runResults = [
        { exitCode: 0, stdout: 'abc123\n', stderr: '' },
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
            baseRevision: 'abc123',
            branchName: 'goal/goal-1',
            integrationState: 'pending',
          },
          worktreePath: worktreeRoot,
        },
      });
      expect(git.commands).toEqual([
        ['rev-parse', '--verify', '--end-of-options', 'abc123^{commit}'],
        ['worktree', 'add', '-b', 'goal/goal-1', worktreeRoot, 'abc123'],
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
      await mkdir(path.join(parentRoot, 'node_modules', 'ignored'), { recursive: true });
      await writeFile(path.join(parentRoot, 'src', 'input.txt'), 'snapshot content');
      await writeFile(path.join(parentRoot, 'node_modules', 'ignored', 'generated.txt'), 'do not copy');
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
      await expect(access(path.join(snapshotRoot, 'node_modules'))).rejects.toThrow();
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
        now: () => now,
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
