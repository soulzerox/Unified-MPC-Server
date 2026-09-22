import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type GoalWorkspaceState, type Result } from '@unified-mpc/domain';
import { GitAdapter, type GitCommandResult, type GitStatusResult } from '@unified-mpc/git';
import { WorkspaceService, type Workspace, type WorkspaceRepository } from '@unified-mpc/workspace';

export interface GoalWorkspaceGitPort {
  status(cwd: string, signal?: AbortSignal): Promise<Result<GitStatusResult>>;
  run(cwd: string, args: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<Result<GitCommandResult>>;
}

export interface GoalWorkspaceCreateRequest {
  readonly goalId: string;
  readonly parentWorkspaceId: string;
  readonly branchName?: string;
  readonly baseRevision: string;
  readonly goalWorkspaceKind?: 'git_worktree' | 'snapshot';
  readonly displayName?: string;
  readonly ownerSessionId?: string;
  readonly ownerJobId?: string;
  readonly parentSource?: 'committed_head' | 'named_revision' | 'checkpoint' | 'patch' | 'snapshot';
}

export interface GoalWorkspaceServiceOptions {
  readonly maxSnapshotBytes?: number;
  readonly maxSnapshotEntries?: number;
}

export interface GoalWorkspaceCreateResult {
  readonly workspace: Workspace;
  readonly worktreePath: string;
}

/** Bounded, read-only evidence used to resume or reconcile a Goal Workspace. */
export interface GoalWorkspaceStatus {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly workspaceState: GoalWorkspaceState;
  readonly changedFileCount: number;
  readonly branchName?: string;
  readonly expectedBranchName?: string;
  readonly baseRevision?: string;
  readonly headRevision?: string;
  readonly checkpointId?: string;
  readonly integrationState?: Workspace['integrationState'];
  readonly branchDrift: boolean;
  readonly detail?: string;
}

/** Read-only guard evidence for an explicit integration attempt. */
export interface GoalWorkspaceIntegrationPreflight {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly canIntegrate: boolean;
  readonly blockers: readonly string[];
  readonly baseRevision?: string;
  readonly goalHeadRevision?: string;
  readonly targetBranchName?: string;
  readonly targetHeadRevision?: string;
  readonly targetWorkspaceState: GoalWorkspaceState;
  readonly targetChangedFileCount: number;
}

/**
 * Owns the minimal filesystem/Git boundary for primary Goal Workspaces.
 * Creation is explicit and durable; resume never silently creates a replacement.
 */
export class GoalWorkspaceService {
  private readonly workspaces: WorkspaceService;
  private readonly maxSnapshotBytes: number;
  private readonly maxSnapshotEntries: number;

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly git: GoalWorkspaceGitPort = new GitAdapter(),
    options: GoalWorkspaceServiceOptions = {},
  ) {
    this.workspaces = new WorkspaceService(repository);
    this.maxSnapshotBytes = positiveLimit(options.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES, 'maxSnapshotBytes');
    this.maxSnapshotEntries = positiveLimit(options.maxSnapshotEntries, DEFAULT_MAX_SNAPSHOT_ENTRIES, 'maxSnapshotEntries');
  }

  public async create(request: GoalWorkspaceCreateRequest): Promise<Result<GoalWorkspaceCreateResult>> {
    const inputError = validateCreateRequest(request);
    if (inputError !== null) return err(appError('INVALID_INPUT', inputError));

    const parent = await this.repository.get(request.parentWorkspaceId);
    if (parent === null) return err(appError('WORKSPACE_NOT_FOUND', 'Parent workspace was not found'));
    if (parent.lifecycleKind !== undefined && parent.lifecycleKind !== 'project') {
      return err(appError('INVALID_INPUT', 'Goal Workspace parent must be a project workspace'));
    }

    const workspaceKind = request.goalWorkspaceKind ?? 'git_worktree';
    if (workspaceKind === 'snapshot') return this.createSnapshot(parent, request);

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
      'worktree', 'add', '-b', request.branchName!, worktreePath, request.baseRevision,
    ]);
    const addError = successfulGitCommand(add, 'Goal Workspace worktree could not be created');
    if (addError !== null) return addError;

    const registered = await this.workspaces.add(request.displayName ?? `Goal ${request.goalId}`, worktreePath, {
      lifecycleKind: 'goal',
      goalId: request.goalId,
      parentWorkspaceId: request.parentWorkspaceId,
      goalWorkspaceKind: workspaceKind,
      parentSource: request.parentSource ?? 'committed_head',
      baseRevision: request.baseRevision,
      branchName: request.branchName!,
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

  private async createSnapshot(parent: Workspace, request: GoalWorkspaceCreateRequest): Promise<Result<GoalWorkspaceCreateResult>> {
    const snapshotPath = path.join(parent.realRootPath, '.unified-mpc', 'snapshots', request.goalId);
    try {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await copySnapshot(parent.realRootPath, snapshotPath, this.maxSnapshotBytes, this.maxSnapshotEntries);
      const registered = await this.workspaces.add(request.displayName ?? `Goal ${request.goalId}`, snapshotPath, {
        lifecycleKind: 'goal',
        goalId: request.goalId,
        parentWorkspaceId: request.parentWorkspaceId,
        goalWorkspaceKind: 'snapshot',
        parentSource: 'snapshot',
        baseRevision: request.baseRevision,
        integrationState: 'pending',
        ...(request.ownerSessionId === undefined ? {} : { ownerSessionId: request.ownerSessionId }),
        ...(request.ownerJobId === undefined ? {} : { ownerJobId: request.ownerJobId }),
      });
      if (!registered.ok) {
        await rm(snapshotPath, { recursive: true, force: true });
        return registered;
      }
      return ok({ workspace: registered.value, worktreePath: snapshotPath });
    } catch (error: unknown) {
      await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
      return err(appError('CONFLICT', `Goal Workspace snapshot could not be created: ${errorMessage(error)}`, true));
    }
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

  /**
   * Reads the existing workspace and its current Git identity without changing
   * registry metadata or attempting recovery. A branch mismatch is explicit
   * conflict evidence, not permission to silently rebind the goal.
   */
  public async status(goalId: string): Promise<Result<GoalWorkspaceStatus>> {
    if (!isGoalId(goalId)) return err(appError('INVALID_INPUT', 'Goal id is invalid'));
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));

    let root;
    try {
      root = await stat(workspace.realRootPath);
    } catch {
      return ok(workspaceStatus(workspace, 'missing', 0, 'Goal Workspace worktree is missing'));
    }
    if (!root.isDirectory()) return ok(workspaceStatus(workspace, 'unavailable', 0, 'Goal Workspace root is not a directory'));
    if (workspace.goalWorkspaceKind !== 'git_worktree') {
      return ok(workspaceStatus(workspace, 'unknown', 0, 'Goal Workspace is not Git-backed'));
    }

    const current = await this.git.status(workspace.realRootPath);
    if (!current.ok) return ok(workspaceStatus(workspace, 'unavailable', 0, 'Git status is unavailable'));
    const branch = await this.git.run(workspace.realRootPath, ['branch', '--show-current']);
    const branchName = successfulOutput(branch);
    if (branchName === null) return ok(workspaceStatus(workspace, 'unavailable', current.value.entries.length, 'Goal Workspace branch could not be resolved'));
    const head = await this.git.run(workspace.realRootPath, ['rev-parse', '--verify', 'HEAD']);
    const headRevision = successfulOutput(head);
    if (headRevision === null) return ok(workspaceStatus(workspace, 'unavailable', current.value.entries.length, 'Goal Workspace head could not be resolved', branchName));

    const branchDrift = workspace.branchName !== undefined && branchName !== workspace.branchName;
    return ok(workspaceStatus(
      workspace,
      branchDrift ? 'conflict' : current.value.entries.length === 0 ? 'clean' : 'dirty',
      current.value.entries.length,
      branchDrift ? 'Goal Workspace branch differs from persisted branch' : undefined,
      branchName,
      headRevision,
    ));
  }

  /**
   * Checks integration preconditions without merging, rebasing, or changing
   * either workspace. Callers must use this evidence before recording an
   * integration result.
   */
  public async integrationPreflight(goalId: string): Promise<Result<GoalWorkspaceIntegrationPreflight>> {
    if (!isGoalId(goalId)) return err(appError('INVALID_INPUT', 'Goal id is invalid'));
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (workspace.parentWorkspaceId === undefined) return err(appError('CONFLICT', 'Goal Workspace has no integration target', true));
    const parent = await this.repository.get(workspace.parentWorkspaceId);
    if (parent === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace integration target was not found'));

    const targetStatus = await this.git.status(parent.realRootPath);
    if (!targetStatus.ok) {
      return ok(integrationPreflight(workspace, 'unavailable', 0, ['target_workspace_unavailable']));
    }
    if (targetStatus.value.entries.length > 0) {
      return ok(integrationPreflight(workspace, 'dirty', targetStatus.value.entries.length, ['target_workspace_dirty']));
    }

    const goalStatus = await this.status(goalId);
    if (!goalStatus.ok) return goalStatus;
    const blockers: string[] = [];
    if (goalStatus.value.workspaceState !== 'clean') {
      blockers.push(`goal_workspace_${goalStatus.value.workspaceState}`);
    }
    if (workspace.baseRevision === undefined) blockers.push('base_revision_missing');

    const targetBranch = successfulOutput(await this.git.run(parent.realRootPath, ['branch', '--show-current']));
    const targetHead = successfulOutput(await this.git.run(parent.realRootPath, ['rev-parse', '--verify', 'HEAD']));
    if (targetBranch === null || targetHead === null) {
      blockers.push('target_git_identity_unavailable');
    } else if (workspace.baseRevision !== undefined) {
      const ancestor = await this.git.run(parent.realRootPath, ['merge-base', '--is-ancestor', workspace.baseRevision, targetHead]);
      if (!ancestor.ok || ancestor.value.exitCode !== 0) blockers.push('target_branch_drift');
    }

    return ok({
      goalId,
      workspaceId: workspace.id,
      canIntegrate: blockers.length === 0,
      blockers,
      ...(workspace.baseRevision === undefined ? {} : { baseRevision: workspace.baseRevision }),
      ...(goalStatus.value.headRevision === undefined ? {} : { goalHeadRevision: goalStatus.value.headRevision }),
      ...(targetBranch === null ? {} : { targetBranchName: targetBranch }),
      ...(targetHead === null ? {} : { targetHeadRevision: targetHead }),
      targetWorkspaceState: 'clean',
      targetChangedFileCount: 0,
    });
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
    const removed = workspace.goalWorkspaceKind === 'snapshot'
      ? await this.removeSnapshot(await this.parentRoot(workspace), workspace.realRootPath)
      : await this.removeGitWorktree(workspace);
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

  private async removeGitWorktree(workspace: Workspace): Promise<Result<void>> {
    const status = await this.git.status(workspace.realRootPath);
    if (!status.ok) return status;
    if (status.value.entries.length > 0) {
      return err(appError('CONFLICT', 'Dirty Goal Workspace cannot be removed automatically', true));
    }
    return this.removeWorktree(await this.parentRoot(workspace), workspace.realRootPath);
  }

  private async removeSnapshot(parentRoot: string, snapshotPath: string): Promise<Result<void>> {
    if (!isManagedSnapshotPath(parentRoot, snapshotPath)) {
      return err(appError('CONFLICT', 'Snapshot path is outside the managed Goal Workspace root', true));
    }
    try {
      await rm(snapshotPath, { recursive: true, force: true });
      return ok(undefined);
    } catch (error: unknown) {
      return err(appError('CONFLICT', `Goal Workspace snapshot could not be removed: ${errorMessage(error)}`, true));
    }
  }
}

function validateCreateRequest(request: GoalWorkspaceCreateRequest): string | null {
  if (!isGoalId(request.goalId)) return 'Goal id is invalid';
  if (request.parentWorkspaceId.trim().length === 0) return 'Parent workspace id is required';
  const workspaceKind = request.goalWorkspaceKind ?? 'git_worktree';
  if (workspaceKind !== 'git_worktree' && workspaceKind !== 'snapshot') return 'Goal workspace kind is invalid';
  if (workspaceKind === 'git_worktree' && (request.branchName === undefined || !isSafeBranchName(request.branchName))) {
    return 'Goal branch name is invalid';
  }
  if (workspaceKind === 'snapshot' && request.parentSource !== 'snapshot') return 'Snapshot goal workspace requires snapshot parentSource';
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

function successfulOutput(result: Result<GitCommandResult>): string | null {
  if (!result.ok || result.value.exitCode !== 0) return null;
  const output = result.value.stdout.trim();
  return output.length === 0 ? null : output;
}

function workspaceStatus(
  workspace: Workspace,
  workspaceState: GoalWorkspaceState,
  changedFileCount: number,
  detail?: string,
  branchName?: string,
  headRevision?: string,
): GoalWorkspaceStatus {
  return {
    goalId: workspace.goalId ?? '',
    workspaceId: workspace.id,
    rootPath: workspace.realRootPath,
    workspaceState,
    changedFileCount,
    ...(branchName === undefined ? {} : { branchName }),
    ...(workspace.branchName === undefined ? {} : { expectedBranchName: workspace.branchName }),
    ...(workspace.baseRevision === undefined ? {} : { baseRevision: workspace.baseRevision }),
    ...(headRevision === undefined ? {} : { headRevision }),
    ...(workspace.checkpointId === undefined ? {} : { checkpointId: workspace.checkpointId }),
    ...(workspace.integrationState === undefined ? {} : { integrationState: workspace.integrationState }),
    branchDrift: branchName !== undefined && workspace.branchName !== undefined && branchName !== workspace.branchName,
    ...(detail === undefined ? {} : { detail }),
  };
}

function integrationPreflight(
  workspace: Workspace,
  targetWorkspaceState: GoalWorkspaceState,
  targetChangedFileCount: number,
  blockers: readonly string[],
): GoalWorkspaceIntegrationPreflight {
  return {
    goalId: workspace.goalId ?? '',
    workspaceId: workspace.id,
    canIntegrate: false,
    blockers,
    ...(workspace.baseRevision === undefined ? {} : { baseRevision: workspace.baseRevision }),
    targetWorkspaceState,
    targetChangedFileCount,
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

const DEFAULT_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_ENTRIES = 20_000;
const SNAPSHOT_EXCLUDED_NAMES = new Set(['.git', '.unified-mpc', 'build', 'coverage', 'dist', 'node_modules']);

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

async function copySnapshot(sourceRoot: string, destinationRoot: string, maxBytes: number, maxEntries: number): Promise<void> {
  let bytes = 0;
  let entries = 0;

  const copyDirectory = async (source: string, destination: string): Promise<void> => {
    await mkdir(destination, { recursive: true });
    const children = await readdir(source, { withFileTypes: true });
    for (const child of children) {
      if (SNAPSHOT_EXCLUDED_NAMES.has(child.name)) continue;
      entries += 1;
      if (entries > maxEntries) throw new Error(`snapshot entry limit exceeded (${maxEntries})`);
      const sourcePath = path.join(source, child.name);
      const destinationPath = path.join(destination, child.name);
      const metadata = await lstat(sourcePath);
      if (metadata.isSymbolicLink()) throw new Error(`snapshot contains unsupported symbolic link: ${path.relative(sourceRoot, sourcePath)}`);
      if (metadata.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath);
      } else if (metadata.isFile()) {
        bytes += metadata.size;
        if (bytes > maxBytes) throw new Error(`snapshot byte limit exceeded (${maxBytes})`);
        await copyFile(sourcePath, destinationPath);
      } else {
        throw new Error(`snapshot contains unsupported filesystem entry: ${path.relative(sourceRoot, sourcePath)}`);
      }
    }
  };

  await copyDirectory(sourceRoot, destinationRoot);
}

function isManagedSnapshotPath(parentRoot: string, snapshotPath: string): boolean {
  const expectedRoot = path.resolve(parentRoot, '.unified-mpc', 'snapshots');
  const resolved = path.resolve(snapshotPath);
  return path.dirname(resolved) === expectedRoot;
}
