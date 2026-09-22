import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitCommandResult, GitStatusResult } from '@unified-mpc/git';
import type { Result } from '@unified-mpc/domain';
import type { Workspace, WorkspaceRepository } from '@unified-mpc/workspace';
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
          checkpointId: 'checkpoint-1', integrationState: 'pending', branchDrift: false,
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
});
