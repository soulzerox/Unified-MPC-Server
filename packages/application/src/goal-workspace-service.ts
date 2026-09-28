import { copyFile, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { appError, decideGuardedBaseRebase, err, ok, type GoalWorkspaceState, type Result, type WorkspaceAdmissionReceipt, type WorkspaceBaseRebaseReceipt } from '@unified-mpc/domain';
import { GitAdapter, type GitCommandResult, type GitGuardedRebaseRequest, type GitGuardedRebaseResult, type GitStatusResult, type GitWorkspaceSnapshotOptions } from '@unified-mpc/git';
import { WorkspaceService, type Workspace, type WorkspaceRepository, type WorkspaceWriterLease } from '@unified-mpc/workspace';

export interface GoalWorkspaceGitPort {
  status(cwd: string, signal?: AbortSignal): Promise<Result<GitStatusResult>>;
  run(cwd: string, args: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<Result<GitCommandResult>>;
  refreshRemoteRef?(cwd: string, remote: string, sourceRef: string, destinationRef: string, signal?: AbortSignal): Promise<Result<string>>;
  observeWorkspace?(cwd: string, options?: GitWorkspaceSnapshotOptions, signal?: AbortSignal): Promise<Result<import('@unified-mpc/git').GitWorkspaceSnapshot>>;
  remoteBranchSha?(cwd: string, remote: string, branchName: string, signal?: AbortSignal): Promise<Result<string | null>>;
  isAncestor?(cwd: string, ancestorSha: string, descendantSha: string, signal?: AbortSignal): Promise<Result<boolean>>;
  createRecoveryRef?(cwd: string, recoveryRef: string, expectedHead: string, signal?: AbortSignal): Promise<Result<void>>;
  guardedRebase?(cwd: string, request: GitGuardedRebaseRequest, signal?: AbortSignal): Promise<Result<GitGuardedRebaseResult>>;
}

export interface GoalWorkspaceAdmissionCaptureRequest {
  readonly workspaceId: string;
  readonly checkpointId: string;
  readonly checkpointRevision: number;
  readonly checkpointHead: string;
  readonly workflowVersion: number;
  readonly runtime: Pick<WorkspaceAdmissionReceipt,
    'runtimeDeploymentId' | 'runtimeGeneration' | 'runtimeBuildVersion' | 'runtimeBuildCommit'
    | 'runtimeBuildDirty' | 'runtimeProtocolGeneration' | 'runtimeStartedAt'>;
}

export interface GoalWorkspaceCreateRequest {
  readonly goalId: string;
  readonly parentWorkspaceId: string;
  readonly branchName?: string;
  /** Omit to fetch origin/main directly; provide to explicitly pin a historical base. */
  readonly baseRevision?: string;
  readonly goalWorkspaceKind?: 'git_worktree' | 'snapshot';
  readonly displayName?: string;
  readonly ownerSessionId?: string;
  readonly ownerJobId?: string;
  readonly parentSource?: 'committed_head' | 'named_revision' | 'checkpoint' | 'patch' | 'snapshot';
}

export interface GoalWorkspaceServiceOptions {
  readonly maxSnapshotBytes?: number;
  readonly maxSnapshotEntries?: number;
  readonly now?: () => Date;
  readonly writerLeaseDurationMs?: number;
}

export interface GoalWorkspaceWriterLease extends WorkspaceWriterLease {
  readonly goalId: string;
  readonly workspaceId: string;
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
  readonly writerLease?: WorkspaceWriterLease;
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

export interface GoalWorkspaceGuardedRebaseRequest {
  readonly goalId: string;
  readonly expectedAdmissionGeneration: number;
  readonly lease: Pick<WorkspaceWriterLease, 'leaseId' | 'generation'>;
}

export type GoalWorkspaceGuardedRebaseResult =
  | {
      readonly status: 'REBASED';
      readonly operationId: string;
      readonly oldHead: string;
      readonly newHead: string;
      readonly oldBaseSha: string;
      readonly newBaseSha: string;
      readonly checkpointId: string;
      readonly recoveryRef: string;
    }
  | {
      readonly status: 'RECOVERY_REQUIRED';
      readonly reason: string;
      readonly operationId?: string;
      readonly oldHead?: string;
      readonly oldBaseSha?: string;
      readonly newBaseSha?: string;
      readonly checkpointId?: string;
      readonly recoveryRef?: string;
      readonly conflictedPaths?: readonly string[];
      readonly abortSucceeded?: boolean;
    };

/**
 * Owns the minimal filesystem/Git boundary for primary Goal Workspaces.
 * Creation is explicit and durable; resume never silently creates a replacement.
 */
export class GoalWorkspaceService {
  private readonly workspaces: WorkspaceService;
  private readonly maxSnapshotBytes: number;
  private readonly maxSnapshotEntries: number;
  private readonly now: () => Date;
  private readonly writerLeaseDurationMs: number;

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly git: GoalWorkspaceGitPort = new GitAdapter(),
    options: GoalWorkspaceServiceOptions = {},
  ) {
    this.workspaces = new WorkspaceService(repository);
    this.maxSnapshotBytes = positiveLimit(options.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES, 'maxSnapshotBytes');
    this.maxSnapshotEntries = positiveLimit(options.maxSnapshotEntries, DEFAULT_MAX_SNAPSHOT_ENTRIES, 'maxSnapshotEntries');
    this.now = options.now ?? ((): Date => new Date());
    this.writerLeaseDurationMs = positiveLimit(options.writerLeaseDurationMs, DEFAULT_WRITER_LEASE_DURATION_MS, 'writerLeaseDurationMs');
  }

  public async acquireWriterLease(goalId: string, ownerId: string): Promise<Result<GoalWorkspaceWriterLease>> {
    if (!isGoalId(goalId) || ownerId.trim().length === 0) return err(appError('INVALID_INPUT', 'Goal id and writer owner are required'));
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (this.repository.acquireGoalWriterLease === undefined) {
      return err(appError('CONFLICT', 'Goal Workspace writer lease requires durable repository support', true));
    }
    const now = this.now();
    const lease = await this.repository.acquireGoalWriterLease(
      workspace.id,
      randomUUID(),
      ownerId.trim(),
      now.toISOString(),
      new Date(now.getTime() + this.writerLeaseDurationMs).toISOString(),
    );
    if (lease === null) return err(appError('CONFLICT', 'Goal Workspace is already owned by another writer', true));
    return ok({ goalId, workspaceId: workspace.id, ...lease });
  }

  public async renewWriterLease(goalId: string, leaseId: string, generation: number): Promise<Result<GoalWorkspaceWriterLease>> {
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (this.repository.renewGoalWriterLease === undefined) {
      return err(appError('CONFLICT', 'Goal Workspace writer lease requires durable repository support', true));
    }
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.writerLeaseDurationMs).toISOString();
    const renewed = await this.repository.renewGoalWriterLease(workspace.id, leaseId, generation, now.toISOString(), expiresAt);
    if (!renewed) return err(appError('CONFLICT', 'Goal Workspace writer lease is stale or expired', true));
    return ok({ goalId, workspaceId: workspace.id, leaseId, ownerId: workspace.writerLease?.ownerId ?? '', generation, expiresAt });
  }

  public async releaseWriterLease(goalId: string, leaseId: string, generation: number): Promise<Result<void>> {
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (this.repository.releaseGoalWriterLease === undefined) {
      return err(appError('CONFLICT', 'Goal Workspace writer lease requires durable repository support', true));
    }
    const released = await this.repository.releaseGoalWriterLease(workspace.id, leaseId, generation);
    return released ? ok(undefined) : err(appError('CONFLICT', 'Goal Workspace writer lease is stale', true));
  }

  /** Persists a content-free receipt only when a caller-proven checkpoint still equals exact Git HEAD. */
  public async captureAdmission(request: GoalWorkspaceAdmissionCaptureRequest): Promise<Result<WorkspaceAdmissionReceipt>> {
    if (!Number.isSafeInteger(request.checkpointRevision) || request.checkpointRevision < 1
      || !Number.isSafeInteger(request.workflowVersion) || request.workflowVersion < 1
      || !/^[0-9a-f]{40,64}$/iu.test(request.checkpointHead)
      || request.checkpointId.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Admission requires an exact checkpoint revision, head, and workflow version'));
    }
    const workspace = await this.repository.get(request.workspaceId);
    if (workspace === null || workspace.lifecycleKind !== 'goal' || workspace.goalWorkspaceKind !== 'git_worktree'
      || workspace.goalId === undefined || workspace.parentWorkspaceId === undefined) {
      return err(appError('CONFLICT', 'Admission requires an active registered Git Goal Workspace', true));
    }
    const now = this.now();
    const lease = workspace.writerLease;
    if (lease === undefined || lease.expiresAt <= now.toISOString()) {
      return err(appError('CONFLICT', 'Admission requires a current Goal Workspace writer lease', true));
    }
    if (workspace.checkpointId !== request.checkpointId) {
      return err(appError('CONFLICT', 'Admission checkpoint is not the registered Goal Workspace checkpoint', true));
    }
    if (this.git.observeWorkspace === undefined) {
      return err(appError('CONFLICT', 'Bounded Git admission observation is unavailable', true));
    }
    const observed = await this.git.observeWorkspace(workspace.realRootPath, {
      ...(workspace.baseRevision === undefined ? {} : { baseRef: workspace.baseRevision }),
    });
    if (!observed.ok) return observed;
    const snapshot = observed.value;
    if (snapshot.head !== request.checkpointHead || snapshot.baseSha === undefined || snapshot.mergeBaseSha === undefined
      || (workspace.branchName !== undefined && snapshot.branch !== workspace.branchName)) {
      return err(appError('CONFLICT', 'Workspace HEAD, base, or branch changed since the admission checkpoint', true));
    }
    if (this.repository.getAdmissionReceipt === undefined || this.repository.compareAndSwapAdmissionReceipt === undefined) {
      return err(appError('CONFLICT', 'Durable admission receipt storage is unavailable', true));
    }
    const existing = await this.repository.getAdmissionReceipt(workspace.id);
    const admissionGeneration = (existing?.admissionGeneration ?? 0) + 1;
    const receipt: WorkspaceAdmissionReceipt = {
      admissionId: randomUUID(),
      projectId: workspace.parentWorkspaceId,
      workspaceId: workspace.id,
      goalId: workspace.goalId,
      workspaceKind: 'git',
      repositoryIdentity: snapshot.repositoryIdentity,
      gitCommonDirIdentity: snapshot.gitCommonDirIdentity,
      worktreeIdentity: snapshot.worktreeIdentity,
      ...(snapshot.branch === null ? {} : { branchName: snapshot.branch }),
      expectedWorkspaceHead: request.checkpointHead,
      observedWorkspaceHead: snapshot.head,
      ...(snapshot.baseRef === undefined ? {} : { baseRef: snapshot.baseRef }),
      ...(isCommitSha(workspace.baseRevision) ? { expectedBaseSha: workspace.baseRevision } : {}),
      resolvedBaseSha: snapshot.baseSha,
      ...(snapshot.remoteGoalRef === undefined ? {} : { remoteGoalRef: snapshot.remoteGoalRef }),
      ...(snapshot.remoteGoalSha === undefined ? {} : { remoteGoalSha: snapshot.remoteGoalSha }),
      mergeBaseSha: snapshot.mergeBaseSha,
      dirtyState: snapshot.statusEntries.length === 0 ? 'clean' : 'dirty',
      dirtyFingerprint: snapshot.dirtyFingerprint,
      stagedFingerprint: snapshot.stagedFingerprint,
      checkpointId: request.checkpointId,
      checkpointRevision: request.checkpointRevision,
      writeLeaseGeneration: lease.generation,
      ...request.runtime,
      workflowVersion: request.workflowVersion,
      admissionGeneration,
      createdAt: now.toISOString(),
    };
    const saved = await this.repository.compareAndSwapAdmissionReceipt(
      workspace.id,
      existing?.admissionGeneration ?? 0,
      lease.generation,
      receipt,
    );
    return saved
      ? ok(receipt)
      : err(appError('CONFLICT', 'Admission receipt lost its writer lease or generation compare-and-swap', true));
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

    let requestedBase = request.baseRevision;
    let movingBaseRef: string | undefined;
    if (requestedBase === undefined) {
      if (this.git.refreshRemoteRef === undefined) {
        return err(appError('INTERNAL_ERROR', 'Fresh origin/main resolution is unavailable', true));
      }
      const destinationRef = `refs/unified-mpc/admission/base-${randomUUID()}`;
      const refreshed = await this.git.refreshRemoteRef(parent.realRootPath, 'origin', 'refs/heads/main', destinationRef);
      if (!refreshed.ok) return refreshed;
      if (!isCommitSha(refreshed.value)) return err(appError('INTERNAL_ERROR', 'Fresh origin/main ref did not resolve to a commit SHA', true));
      requestedBase = refreshed.value;
      movingBaseRef = 'origin/main';
    }
    const base = await this.git.run(parent.realRootPath, [
      'rev-parse', '--verify', '--end-of-options', `${requestedBase}^{commit}`,
    ]);
    if (!base.ok) return base;
    const baseError = successfulGitCommand(base, 'Goal Workspace base revision could not be resolved');
    if (baseError !== null) return baseError;
    const resolvedBase = base.value.stdout.trim();
    if (!isCommitSha(resolvedBase)) return err(appError('INTERNAL_ERROR', 'Resolved Goal Workspace base is invalid', true));

    const worktreePath = path.join(parent.realRootPath, '.unified-mpc', 'worktrees', request.goalId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const add = await this.git.run(parent.realRootPath, [
      'worktree', 'add', '-b', request.branchName!, worktreePath, resolvedBase,
    ]);
    const addError = successfulGitCommand(add, 'Goal Workspace worktree could not be created');
    if (addError !== null) return addError;

    const registered = await this.workspaces.add(request.displayName ?? `Goal ${request.goalId}`, worktreePath, {
      lifecycleKind: 'goal',
      goalId: request.goalId,
      parentWorkspaceId: request.parentWorkspaceId,
      goalWorkspaceKind: workspaceKind,
      parentSource: request.parentSource ?? 'committed_head',
      ...(movingBaseRef === undefined ? {} : { baseRef: movingBaseRef }),
      baseRevision: resolvedBase,
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
    if (request.baseRevision === undefined) {
      return err(appError('INVALID_INPUT', 'Snapshot Goal Workspace requires an explicit base revision'));
    }
    const snapshotPath = path.join(parent.realRootPath, '.unified-mpc', 'snapshots', request.goalId);
    let ownsSnapshotPath = false;
    try {
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await mkdir(snapshotPath);
      ownsSnapshotPath = true;
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
        ownsSnapshotPath = false;
        return registered;
      }
      return ok({ workspace: registered.value, worktreePath: snapshotPath });
    } catch (error: unknown) {
      if (ownsSnapshotPath) {
        await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
      }
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
    lease?: Pick<WorkspaceWriterLease, 'leaseId' | 'generation'>,
  ): Promise<Result<Workspace>> {
    return this.updateGoalWorkspace(goalId, { integrationState }, lease);
  }

  /** Bind an existing durable checkpoint to the Goal Workspace metadata. */
  public recordCheckpoint(goalId: string, checkpointId: string, lease?: Pick<WorkspaceWriterLease, 'leaseId' | 'generation'>): Promise<Result<Workspace>> {
    return this.updateGoalWorkspace(goalId, { checkpointId }, lease);
  }

  public async rebaseStaleBase(request: GoalWorkspaceGuardedRebaseRequest): Promise<Result<GoalWorkspaceGuardedRebaseResult>> {
    if (!isGoalId(request.goalId)
      || !Number.isSafeInteger(request.expectedAdmissionGeneration) || request.expectedAdmissionGeneration < 1
      || request.lease.leaseId.trim().length === 0
      || !Number.isSafeInteger(request.lease.generation) || request.lease.generation < 1) {
      return err(appError('INVALID_INPUT', 'Guarded rebase request is invalid'));
    }
    const workspace = await this.findActiveGoal(request.goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (workspace.goalWorkspaceKind !== 'git_worktree' || workspace.branchName === undefined
      || workspace.baseRevision === undefined || !isCommitSha(workspace.baseRevision)) {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'git_workspace_or_frozen_base_missing' });
    }
    const currentLease = workspace.writerLease;
    const now = this.now().toISOString();
    if (currentLease === undefined || currentLease.leaseId !== request.lease.leaseId
      || currentLease.generation !== request.lease.generation || currentLease.expiresAt <= now) {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'stale_writer_lease' });
    }
    if (this.repository.getAdmissionReceipt === undefined
      || this.repository.getBaseRebaseReceipt === undefined
      || this.repository.compareAndSwapBaseRebaseReceipt === undefined
      || this.repository.invalidateAdmissionReceipt === undefined
      || this.git.observeWorkspace === undefined
      || this.git.refreshRemoteRef === undefined
      || this.git.remoteBranchSha === undefined
      || this.git.isAncestor === undefined
      || this.git.createRecoveryRef === undefined
      || this.git.guardedRebase === undefined) {
      return err(appError('CONFLICT', 'Guarded rebase requires durable admission, recovery receipt, and Git safety support', true));
    }

    const admission = await this.repository.getAdmissionReceipt(workspace.id);
    if (admission === null || admission.invalidatedAt !== undefined
      || admission.admissionGeneration !== request.expectedAdmissionGeneration
      || admission.workspaceId !== workspace.id || admission.goalId !== request.goalId
      || admission.branchName !== workspace.branchName
      || admission.writeLeaseGeneration !== currentLease.generation
      || admission.checkpointId === undefined || admission.checkpointRevision === undefined
      || workspace.checkpointId !== admission.checkpointId) {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'admission_or_checkpoint_missing_or_stale' });
    }

    if (workspace.baseRef === undefined) {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'pinned_base' });
    }
    const movingBase = parseMovingBaseRef(workspace.baseRef);
    if (movingBase === null) {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'base_policy_changed' });
    }
    const oldBaseSha = admission.resolvedBaseSha ?? workspace.baseRevision;
    if (!isCommitSha(oldBaseSha)) {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'old_base_missing_or_invalid' });
    }
    if (!isCommitSha(admission.expectedBaseSha ?? '')
      || admission.expectedBaseSha?.toLowerCase() !== workspace.baseRevision.toLowerCase()
      || oldBaseSha.toLowerCase() !== workspace.baseRevision.toLowerCase()) {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'workspace_base_revision_changed' });
    }

    const observed = await this.git.observeWorkspace(workspace.realRootPath, { baseRef: oldBaseSha });
    if (!observed.ok) return observed;
    const operationId = randomUUID();
    const refreshedBase = await this.git.refreshRemoteRef(
      workspace.realRootPath,
      movingBase.remote,
      `refs/heads/${movingBase.branch}`,
      `refs/unified-mpc/admission/rebase-${operationId}`,
    );
    if (!refreshedBase.ok) return refreshedBase;
    if (!isCommitSha(refreshedBase.value)) {
      return err(appError('INTERNAL_ERROR', 'Guarded rebase base refresh did not resolve to an exact commit', true));
    }
    const newBaseSha = refreshedBase.value.toLowerCase();

    const remoteGoal = await this.git.remoteBranchSha(workspace.realRootPath, movingBase.remote, workspace.branchName);
    if (!remoteGoal.ok) return remoteGoal;
    const ancestry = await this.git.isAncestor(workspace.realRootPath, oldBaseSha, newBaseSha);
    if (!ancestry.ok) return ancestry;

    const decision = decideGuardedBaseRebase({
      expectedHead: admission.expectedWorkspaceHead,
      observedHead: observed.value.head,
      expectedDirtyFingerprint: admission.dirtyFingerprint,
      observedDirtyFingerprint: observed.value.dirtyFingerprint,
      dirtyState: observed.value.statusEntries.length === 0 ? 'clean' : 'dirty',
      expectedBaseRef: admission.baseRef ?? workspace.baseRef,
      observedBaseRef: workspace.baseRef,
      oldBaseSha,
      newBaseSha,
      oldBaseIsAncestorOfNewBase: ancestry.value,
      branchPublished: remoteGoal.value !== null,
      remoteGoalBranchMoved: admission.remoteGoalSha !== undefined
        && remoteGoal.value !== admission.remoteGoalSha,
      pinnedBase: false,
      expectedLeaseGeneration: admission.writeLeaseGeneration,
      observedLeaseGeneration: currentLease.generation,
      leaseExpiresAt: currentLease.expiresAt,
      now,
      checkpointId: admission.checkpointId,
      checkpointHead: admission.expectedWorkspaceHead,
    });
    if (decision.status !== 'REBASE_ALLOWED') {
      return ok({ status: 'RECOVERY_REQUIRED', reason: decision.reason });
    }

    const latestRebase = await this.repository.getBaseRebaseReceipt(workspace.id);
    if (latestRebase?.status === 'started') {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'prior_rebase_incomplete', operationId: latestRebase.operationId });
    }
    if (latestRebase?.status === 'recovery_required') {
      return ok({ status: 'RECOVERY_REQUIRED', reason: 'prior_rebase_recovery_required', operationId: latestRebase.operationId });
    }
    const expectedReceiptRevision = latestRebase?.receiptRevision ?? 0;
    const recoveryRef = `refs/unified-mpc/recovery/rebase/${operationId}`;
    const recovery = await this.git.createRecoveryRef(workspace.realRootPath, recoveryRef, decision.oldHead);
    if (!recovery.ok) return recovery;

    const started: WorkspaceBaseRebaseReceipt = {
      operationId,
      receiptRevision: expectedReceiptRevision + 1,
      workspaceId: workspace.id,
      goalId: request.goalId,
      branchName: workspace.branchName,
      status: 'started',
      oldHead: decision.oldHead,
      oldBaseSha: decision.oldBaseSha,
      newBaseSha: decision.newBaseSha,
      checkpointId: decision.checkpointId,
      checkpointRevision: admission.checkpointRevision,
      checkpointHead: admission.expectedWorkspaceHead,
      recoveryRef,
      admissionGeneration: admission.admissionGeneration,
      writeLeaseGeneration: currentLease.generation,
      remoteGoalRef: `refs/heads/${workspace.branchName}`,
      ...(remoteGoal.value === null ? {} : { remoteGoalSha: remoteGoal.value }),
      startedAt: now,
    };
    const startedSaved = await this.repository.compareAndSwapBaseRebaseReceipt(
      workspace.id,
      expectedReceiptRevision,
      admission.admissionGeneration,
      currentLease.generation,
      started,
    );
    if (!startedSaved) {
      return ok({
        status: 'RECOVERY_REQUIRED',
        reason: 'rebase_receipt_raced',
        operationId,
        oldHead: decision.oldHead,
        oldBaseSha: decision.oldBaseSha,
        newBaseSha: decision.newBaseSha,
        checkpointId: decision.checkpointId,
        recoveryRef,
      });
    }

    const rebase = await this.git.guardedRebase(workspace.realRootPath, {
      expectedBranch: workspace.branchName,
      oldHead: decision.oldHead,
      oldBaseSha: decision.oldBaseSha,
      newBaseSha: decision.newBaseSha,
      recoveryRef,
    });
    const finishedAt = this.now().toISOString();
    if (!rebase.ok) {
      const admissionInvalidated = await this.repository.invalidateAdmissionReceipt(
        workspace.id, admission.admissionGeneration, 'guarded_rebase_git_failure', finishedAt,
      );
      const recoveryReceipt: WorkspaceBaseRebaseReceipt = {
        ...started,
        receiptRevision: started.receiptRevision + 1,
        status: 'recovery_required',
        finishedAt,
        failureReason: 'guarded_rebase_git_failure',
      };
      const recoverySaved = await this.repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, started.receiptRevision, admission.admissionGeneration, currentLease.generation, recoveryReceipt,
      );
      if (!admissionInvalidated || !recoverySaved) {
        return err(appError('CONFLICT', 'Guarded rebase failure could not be durably fenced for recovery', true));
      }
      return rebase;
    }

    if (rebase.value.status !== 'completed') {
      const restoredExactly = rebase.value.abortSucceeded
        && rebase.value.headAfterAbort === decision.oldHead
        && rebase.value.cleanAfterAbort === true;
      let admissionInvalidated = true;
      if (!restoredExactly) {
        admissionInvalidated = await this.repository.invalidateAdmissionReceipt(
          workspace.id, admission.admissionGeneration, 'guarded_rebase_recovery_required', finishedAt,
        );
      }
      const failureReason = rebase.value.status === 'conflict' ? 'rebase_conflict' : (rebase.value.reason ?? 'rebase_failed');
      const recoveryReceipt: WorkspaceBaseRebaseReceipt = {
        ...started,
        receiptRevision: started.receiptRevision + 1,
        status: 'recovery_required',
        conflictedPaths: rebase.value.conflictedPaths,
        abortSucceeded: rebase.value.abortSucceeded,
        finishedAt,
        failureReason,
      };
      const recoverySaved = await this.repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, started.receiptRevision, admission.admissionGeneration, currentLease.generation, recoveryReceipt,
      );
      if (!admissionInvalidated || !recoverySaved) {
        return err(appError('CONFLICT', 'Guarded rebase recovery state could not be durably fenced', true));
      }
      return ok({
        status: 'RECOVERY_REQUIRED',
        reason: failureReason,
        operationId,
        oldHead: decision.oldHead,
        oldBaseSha: decision.oldBaseSha,
        newBaseSha: decision.newBaseSha,
        checkpointId: decision.checkpointId,
        recoveryRef,
        conflictedPaths: rebase.value.conflictedPaths,
        abortSucceeded: rebase.value.abortSucceeded,
      });
    }

    const invalidated = await this.repository.invalidateAdmissionReceipt(
      workspace.id, admission.admissionGeneration, 'guarded_rebase_head_changed', finishedAt,
    );
    if (!invalidated) {
      const recoveryReceipt: WorkspaceBaseRebaseReceipt = {
        ...started,
        receiptRevision: started.receiptRevision + 1,
        status: 'recovery_required',
        resultHead: rebase.value.newHead,
        finishedAt,
        failureReason: 'admission_invalidation_failed',
      };
      const recoverySaved = await this.repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, started.receiptRevision, admission.admissionGeneration, currentLease.generation, recoveryReceipt,
      );
      if (!recoverySaved) {
        return err(appError('CONFLICT', 'Rebased workspace admission could not be durably fenced for recovery', true));
      }
      return ok({
        status: 'RECOVERY_REQUIRED',
        reason: 'admission_invalidation_failed',
        operationId,
        oldHead: decision.oldHead,
        oldBaseSha: decision.oldBaseSha,
        newBaseSha: decision.newBaseSha,
        checkpointId: decision.checkpointId,
        recoveryRef,
      });
    }

    const metadata = await this.updateGoalWorkspace(
      request.goalId,
      { baseRevision: decision.newBaseSha },
      request.lease,
    );
    if (!metadata.ok) {
      const recoveryReceipt: WorkspaceBaseRebaseReceipt = {
        ...started,
        receiptRevision: started.receiptRevision + 1,
        status: 'recovery_required',
        resultHead: rebase.value.newHead,
        finishedAt,
        failureReason: 'workspace_metadata_update_failed',
      };
      const recoverySaved = await this.repository.compareAndSwapBaseRebaseReceipt(
        workspace.id, started.receiptRevision, admission.admissionGeneration, currentLease.generation, recoveryReceipt,
      );
      if (!recoverySaved) {
        return err(appError('CONFLICT', 'Rebased workspace metadata failure could not be durably fenced for recovery', true));
      }
      return ok({
        status: 'RECOVERY_REQUIRED',
        reason: 'workspace_metadata_update_failed',
        operationId,
        oldHead: decision.oldHead,
        oldBaseSha: decision.oldBaseSha,
        newBaseSha: decision.newBaseSha,
        checkpointId: decision.checkpointId,
        recoveryRef,
      });
    }

    const completed: WorkspaceBaseRebaseReceipt = {
      ...started,
      receiptRevision: started.receiptRevision + 1,
      status: 'completed',
      resultHead: rebase.value.newHead,
      finishedAt,
    };
    const completedSaved = await this.repository.compareAndSwapBaseRebaseReceipt(
      workspace.id,
      started.receiptRevision,
      admission.admissionGeneration,
      currentLease.generation,
      completed,
    );
    if (!completedSaved) {
      return ok({
        status: 'RECOVERY_REQUIRED',
        reason: 'rebase_completion_receipt_raced',
        operationId,
        oldHead: decision.oldHead,
        oldBaseSha: decision.oldBaseSha,
        newBaseSha: decision.newBaseSha,
        checkpointId: decision.checkpointId,
        recoveryRef,
      });
    }

    return ok({
      status: 'REBASED',
      operationId,
      oldHead: decision.oldHead,
      newHead: rebase.value.newHead,
      oldBaseSha: decision.oldBaseSha,
      newBaseSha: decision.newBaseSha,
      checkpointId: decision.checkpointId,
      recoveryRef,
    });
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

  private async updateGoalWorkspace(
    goalId: string,
    patch: Pick<Workspace, 'checkpointId' | 'integrationState' | 'baseRevision'>,
    lease?: Pick<WorkspaceWriterLease, 'leaseId' | 'generation'>,
  ): Promise<Result<Workspace>> {
    if (!isGoalId(goalId)) return err(appError('INVALID_INPUT', 'Goal id is invalid'));
    const workspace = await this.findActiveGoal(goalId);
    if (workspace === null) return err(appError('WORKSPACE_NOT_FOUND', 'Goal Workspace was not found'));
    if (workspace.writerLease !== undefined) {
      if (workspace.writerLease.expiresAt <= this.now().toISOString()) {
        return err(appError('CONFLICT', 'Goal Workspace writer lease is expired', true));
      }
      if (lease === undefined || lease.leaseId !== workspace.writerLease.leaseId || lease.generation !== workspace.writerLease.generation) {
        return err(appError('CONFLICT', 'Goal Workspace metadata mutation requires the current writer lease', true));
      }
    } else if (lease !== undefined) {
      return err(appError('CONFLICT', 'Goal Workspace writer lease is no longer current', true));
    }
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
  if (request.baseRevision !== undefined && !isSafeRevision(request.baseRevision)) return 'Goal base revision is invalid';
  if (workspaceKind === 'snapshot' && request.baseRevision === undefined) return 'Snapshot Goal Workspace requires an explicit base revision';
  return null;
}

function parseMovingBaseRef(value: string): { readonly remote: string; readonly branch: string } | null {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  const remote = value.slice(0, slash);
  const branch = value.slice(slash + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote) || !isSafeBranchName(branch)) return null;
  return { remote, branch };
}

function isGoalId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function containsForbiddenGitRevisionCharacter(value: string, specials: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || specials.includes(character)) return true;
  }
  return false;
}

function isSafeBranchName(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('..')
    && !value.includes('//')
    && !containsForbiddenGitRevisionCharacter(value, '~^:?*[\\');
}

function isSafeRevision(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !value.startsWith('-')
    && !containsForbiddenGitRevisionCharacter(value, '');
}

function isCommitSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40,64}$/iu.test(value);
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
    ...(workspace.writerLease === undefined ? {} : { writerLease: workspace.writerLease }),
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
const DEFAULT_WRITER_LEASE_DURATION_MS = 30_000;
const SNAPSHOT_EXCLUDED_NAMES = new Set([
  '.git', '.unified-mpc', 'build', 'coverage', 'dist', 'node_modules',
  '.next', '.turbo', '.cache', 'cache', 'vendor', 'target', 'bin', 'obj', '.venv', 'venv', '__pycache__',
]);

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
