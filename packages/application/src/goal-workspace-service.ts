import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { GitAdapter, type GitCommandResult, type GitStatusResult } from '@unified-mpc/git';
import { WorkspaceService, type Workspace, type WorkspaceRepository } from '@unified-mpc/workspace';

export interface GoalWorkspaceGitPort {
  status(cwd: string, signal?: AbortSignal): Promise<Result<GitStatusResult>>;
  run(cwd: string, args: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<Result<GitCommandResult>>;
}

export interface GoalWorkspaceCreateRequest {
  readonly goalId: string;
  readonly parentWorkspaceId: string;
  readonly branchName: string;
  readonly baseRevision: string;
  readonly displayName?: string;
  readonly ownerSessionId?: string;
  readonly ownerJobId?: string;
  readonly parentSource?: 'committed_head' | 'named_revision' | 'checkpoint' | 'patch';
}

export interface GoalWorkspaceCreateResult {
  readonly workspace: Workspace;
  readonly worktreePath: string;
}

/**
 * Owns the minimal filesystem/Git boundary for primary Goal Workspaces.
 * Creation is explicit and durable; resume never silently creates a replacement.
 */
export class GoalWorkspaceService {
  private readonly workspaces: WorkspaceService;

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly git: GoalWorkspaceGitPort = new GitAdapter(),
  ) {
    this.workspaces = new WorkspaceService(repository);
  }

  public async create(request: GoalWorkspaceCreateRequest): Promise<Result<GoalWorkspaceCreateResult>> {
    const inputError = validateCreateRequest(request);
    if (inputError !== null) return err(appError('INVALID_INPUT', inputError));

    const parent = await this.repository.get(request.parentWorkspaceId);
    if (parent === null) return err(appError('WORKSPACE_NOT_FOUND', 'Parent workspace was not found'));
    if (parent.lifecycleKind !== undefined && parent.lifecycleKind !== 'project') {
      return err(appError('INVALID_INPUT', 'Goal Workspace parent must be a project workspace'));
    }

    const status = await this.git.status(parent.realRootPath);
    if (!status.ok) return status;
    if (status.value.entries.length > 0) {
      return err(appError('CONFLICT', 'Parent workspace is dirty; provide an explicit checkpoint or patch source', true));
    }

    const base = await this.git.run(parent.realRootPath, [
      'rev-parse', '--verify', '--end-of-options', `${request.baseRevision}^{commit}`,
    ]);
    const baseError = successfulGitCommand(base, 'Goal Workspace base revision could not be resolved');
    if (baseError !== null) return baseError;

    const worktreePath = path.join(parent.realRootPath, '.unified-mpc', 'worktrees', request.goalId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const add = await this.git.run(parent.realRootPath, [
      'worktree', 'add', '-b', request.branchName, worktreePath, request.baseRevision,
    ]);
    const addError = successfulGitCommand(add, 'Goal Workspace worktree could not be created');
    if (addError !== null) return addError;

    const registered = await this.workspaces.add(request.displayName ?? `Goal ${request.goalId}`, worktreePath, {
      lifecycleKind: 'goal',
      goalId: request.goalId,
      parentWorkspaceId: request.parentWorkspaceId,
      goalWorkspaceKind: 'git_worktree',
      parentSource: request.parentSource ?? 'committed_head',
      baseRevision: request.baseRevision,
      branchName: request.branchName,
      integrationState: 'pending',
      ...(request.ownerSessionId === undefined ? {} : { ownerSessionId: request.ownerSessionId }),
      ...(request.ownerJobId === undefined ? {} : { ownerJobId: request.ownerJobId }),
    });
    if (!registered.ok) {
      await this.removeWorktree(parent.realRootPath, worktreePath);
      return registered;
    }
    return ok({ workspace: registered.value, worktreePath });
  }

  public async resume(goalId: string): Promise<Result<Workspace>> {
    if (!isGoalId(goalId)) return err(appError('INVALID_INPUT', 'Goal id is invalid'));
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    try {
      if (!(await stat(workspace.realRootPath)).isDirectory()) {
        return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace worktree is missing'));
      }
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace worktree is missing'));
    }
    return ok(workspace);
  }

  /** Record caller-verified integration evidence without performing a merge implicitly. */
  public recordIntegrationState(
    goalId: string,
    integrationState: NonNullable<Workspace['integrationState']>,
  ): Promise<Result<Workspace>> {
    return this.updateGoalWorkspace(goalId, { integrationState });
  }

  /** Bind an existing durable checkpoint to the Goal Workspace metadata. */
  public recordCheckpoint(goalId: string, checkpointId: string): Promise<Result<Workspace>> {
    return this.updateGoalWorkspace(goalId, { checkpointId });
  }

  public async remove(goalId: string): Promise<Result<void>> {
    if (!isGoalId(goalId)) return err(appError('INVALID_INPUT', 'Goal id is invalid'));
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (workspace.integrationState !== 'integrated') {
      return err(appError('CONFLICT', 'Goal Workspace must be integrated before removal', true));
    }
    const status = await this.git.status(workspace.realRootPath);
    if (!status.ok) return status;
    if (status.value.entries.length > 0) {
      return err(appError('CONFLICT', 'Dirty Goal Workspace cannot be removed automatically', true));
    }
    const removed = await this.removeWorktree(await this.parentRoot(workspace), workspace.realRootPath);
    if (!removed.ok) return removed;
    if (this.repository.archive === undefined) {
      return err(appError('CONFLICT', 'Goal Workspace removal requires durable archival support', true));
    }
    try {
      await this.repository.archive(workspace.id);
    } catch (error: unknown) {
      return err(appError('CONFLICT', `Goal Workspace registration could not be archived: ${errorMessage(error)}`, true));
    }
    return ok(undefined);
  }

  private async findActiveGoal(goalId: string): Promise<Workspace | null> {
    const workspaces = await (this.repository.listAll?.() ?? this.repository.list());
    return workspaces.find((workspace) => workspace.archivedAt == null && workspace.lifecycleKind === 'goal' && workspace.goalId === goalId) ?? null;
  }

  private async parentRoot(workspace: Workspace): Promise<string> {
    if (workspace.parentWorkspaceId === undefined) return workspace.realRootPath;
    const parent = await this.repository.get(workspace.parentWorkspaceId);
    return parent?.realRootPath ?? workspace.realRootPath;
  }

  private async updateGoalWorkspace(goalId: string, patch: Pick<Workspace, 'checkpointId' | 'integrationState'>): Promise<Result<Workspace>> {
    if (!isGoalId(goalId)) return err(appError('INVALID_INPUT', 'Goal id is invalid'));
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (this.repository.restore === undefined) {
      return err(appError('CONFLICT', 'Goal Workspace metadata updates require durable restore support', true));
    }
    const updated = { ...workspace, ...patch };
    try {
      await this.repository.restore(workspace.id, updated);
    } catch (error: unknown) {
      return err(appError('CONFLICT', `Goal Workspace metadata could not be updated: ${errorMessage(error)}`, true));
    }
    return ok(updated);
  }

  private async removeWorktree(parentRoot: string, worktreePath: string): Promise<Result<void>> {
    const result = await this.git.run(parentRoot, ['worktree', 'remove', worktreePath]);
    const error = successfulGitCommand(result, 'Goal Workspace worktree could not be removed');
    return error ?? ok(undefined);
  }
}

function validateCreateRequest(request: GoalWorkspaceCreateRequest): string | null {
  if (!isGoalId(request.goalId)) return 'Goal id is invalid';
  if (request.parentWorkspaceId.trim().length === 0) return 'Parent workspace id is required';
  if (!isSafeBranchName(request.branchName)) return 'Goal branch name is invalid';
  if (!isSafeRevision(request.baseRevision)) return 'Goal base revision is invalid';
  return null;
}

function isGoalId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isSafeBranchName(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('..')
    && !value.includes('//')
    && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value);
}

function isSafeRevision(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !value.startsWith('-')
    && !/[\u0000-\u0020\u007f]/.test(value);
}

function successfulGitCommand(result: Result<GitCommandResult>, message: string): Result<never> | null {
  if (!result.ok) return result;
  return result.value.exitCode === 0 ? null : err(appError('CONFLICT', message, true));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
