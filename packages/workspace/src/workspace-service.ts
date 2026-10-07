import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  appError,
  err,
  ok,
  type GoalRuntimeProjection,
  type Result,
  type WorkspaceAdmissionReceipt,
  type WorkspaceBaseRebaseReceipt,
  type WorkspaceId,
} from '@unified-mpc/domain';
import { workspaceLifecycleKind, type GoalWorkspaceIntegrationState, type GoalWorkspaceKind, type GoalWorkspaceParentSource, type Workspace, type WorkspaceLifecycleKind, type WorkspaceWriterLease } from './workspace-types.js';
import { isPosixMountRoot, resolveHostPath } from './filesystem-root.js';

export interface WorkspaceRepository {
  list(): Promise<Workspace[]>;
  get(id: WorkspaceId): Promise<Workspace | null>;
  insert(workspace: Workspace): Promise<void>;
  insertIfAvailable?(workspace: Workspace): Promise<boolean>;
  delete(id: WorkspaceId): Promise<void>;
  listAll?(): Promise<Workspace[]>;
  getAny?(id: WorkspaceId): Promise<Workspace | null>;
  archive?(id: WorkspaceId, archivedAt?: string): Promise<void>;
  archiveMany?(ids: readonly WorkspaceId[], archivedAt?: string): Promise<void>;
  restore?(id: WorkspaceId, workspace?: Workspace): Promise<void>;
  setUnavailableSince?(id: WorkspaceId, unavailableSince: string | null): Promise<void>;
  acquireGoalWriterLease?(id: WorkspaceId, leaseId: string, ownerId: string, now: string, expiresAt: string): Promise<WorkspaceWriterLease | null>;
  renewGoalWriterLease?(id: WorkspaceId, leaseId: string, generation: number, now: string, expiresAt: string): Promise<boolean>;
  releaseGoalWriterLease?(id: WorkspaceId, leaseId: string, generation: number): Promise<boolean>;
  synchronizeGoalWriterLease?(
    id: WorkspaceId,
    goalId: string,
    leaseId: string,
    ownerId: string,
    generation: number,
    expiresAt: string,
    now: string,
  ): Promise<WorkspaceWriterLease | null>;
  getAdmissionReceipt?(workspaceId: WorkspaceId): Promise<WorkspaceAdmissionReceipt | null>;
  compareAndSwapAdmissionReceipt?(
    workspaceId: WorkspaceId,
    expectedAdmissionGeneration: number,
    writeLeaseGeneration: number,
    receipt: WorkspaceAdmissionReceipt,
  ): Promise<boolean>;
  invalidateAdmissionReceipt?(workspaceId: WorkspaceId, expectedAdmissionGeneration: number, reason: string, invalidatedAt: string): Promise<boolean>;
  getBaseRebaseReceipt?(workspaceId: WorkspaceId): Promise<WorkspaceBaseRebaseReceipt | null>;
  compareAndSwapBaseRebaseReceipt?(
    workspaceId: WorkspaceId,
    expectedReceiptRevision: number,
    expectedAdmissionGeneration: number,
    writeLeaseGeneration: number,
    receipt: WorkspaceBaseRebaseReceipt,
  ): Promise<boolean>;
}

export interface WorkspaceRegistrationOptions {
  readonly lifecycleKind?: WorkspaceLifecycleKind;
  readonly ownerSessionId?: string;
  readonly ownerJobId?: string;
  readonly autoCleanup?: boolean;
  readonly expiresAt?: string;
  readonly goalId?: string;
  readonly parentWorkspaceId?: WorkspaceId;
  readonly goalWorkspaceKind?: GoalWorkspaceKind;
  readonly parentSource?: GoalWorkspaceParentSource;
  readonly baseRef?: string;
  readonly baseRevision?: string;
  readonly branchName?: string;
  readonly checkpointId?: string;
  readonly integrationState?: GoalWorkspaceIntegrationState;
}

export type WorkspaceDurableReferenceState = 'clear' | 'present' | 'unknown';

export const DEFAULT_GOAL_WORKSPACE_RETENTION_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_GOAL_WORKSPACE_RETENTION_GRACE_MS = 365 * 24 * 60 * 60 * 1_000;

export type WorkspaceCleanupDisposition = 'blocked' | 'retention_pending' | 'retention_candidate';

export type WorkspaceCleanupBlockerReason =
  | 'protected_workspace'
  | 'workspace_unavailable'
  | 'goal_identity_missing'
  | 'goal_workspace_identity_incomplete'
  | 'goal_runtime_unknown'
  | 'goal_runtime_scope_mismatch'
  | 'goal_lifecycle_not_retention_ready'
  | 'goal_runtime_not_idle'
  | 'goal_integration_not_integrated'
  | 'goal_workspace_not_clean'
  | 'goal_retention_anchor_invalid'
  | 'active_writer_lease'
  | 'durable_references_unknown'
  | 'durable_references_present';

export interface WorkspaceLifecycleCleanupEvaluation {
  readonly workspaceId: WorkspaceId;
  readonly goalId?: string;
  readonly disposition: WorkspaceCleanupDisposition;
  readonly blockers: readonly WorkspaceCleanupBlockerReason[];
  readonly workspaceAvailable: boolean;
  readonly writerLeaseActive: boolean;
  readonly durableReferenceState: WorkspaceDurableReferenceState;
  readonly retentionStartedAt?: string;
  readonly retentionEligibleAt?: string;
  readonly retentionRemainingMs?: number;
}

export interface WorkspaceCleanupEvaluationOptions {
  readonly protectedWorkspaceIds?: readonly WorkspaceId[];
  /** Conservative retention grace after the last authoritative Goal runtime activity. */
  readonly goalRetentionGraceMs?: number;
  /** Authoritative #82 projection keyed by durable Goal identity. Missing truth fails cleanup classification closed. */
  readonly goalRuntimeProjections?: ReadonlyMap<string, GoalRuntimeProjection>;
  /**
   * Authoritative durable-reference truth from the #170-family journal/reference owner.
   * Until that contract is supplied, Goal cleanup classification remains blocked.
   */
  readonly goalDurableReferenceStates?: ReadonlyMap<string, WorkspaceDurableReferenceState>;
}

export interface WorkspaceLifecycleReconcileOptions extends WorkspaceCleanupEvaluationOptions {
  readonly endedOwnerSessionIds?: readonly string[];
  readonly endedOwnerJobIds?: readonly string[];
}

export interface WorkspaceLifecycleReconciliation {
  readonly inspected: number;
  readonly archivedWorkspaceIds: readonly WorkspaceId[];
  readonly unavailableWorkspaceIds: readonly WorkspaceId[];
  readonly skippedProtectedWorkspaceIds: readonly WorkspaceId[];
  /** Read-only #80 classification. This receipt never authorizes archival or filesystem deletion. */
  readonly goalCleanupEvaluations: readonly WorkspaceLifecycleCleanupEvaluation[];
}

export interface WorkspaceServiceOptions {
  /** Test/fixture override; production composition uses the real host. */
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
}

export class WorkspaceService {
  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly options: WorkspaceServiceOptions = {},
  ) {}

  public async add(
    displayName: string,
    rootPath: string,
    registration: WorkspaceRegistrationOptions = {},
  ): Promise<Result<Workspace>> {
    if (displayName.trim().length === 0 || rootPath.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Workspace name and root path are required'));
    }

    const lifecycleKind = registration.lifecycleKind ?? 'project';
    if ((lifecycleKind === 'project' || lifecycleKind === 'goal') && registration.autoCleanup === true) {
      return err(appError('INVALID_INPUT', 'Automatic cleanup is only allowed for temporary or inspection workspaces'));
    }
    if (lifecycleKind === 'goal') {
      if (registration.goalId?.trim() === undefined || registration.goalId.trim().length === 0) {
        return err(appError('INVALID_INPUT', 'Goal workspace requires goalId'));
      }
      if (registration.parentWorkspaceId?.trim() === undefined || registration.parentWorkspaceId.trim().length === 0) {
        return err(appError('INVALID_INPUT', 'Goal workspace requires parentWorkspaceId'));
      }
      if (registration.goalWorkspaceKind === undefined || registration.baseRevision?.trim() === undefined || registration.baseRevision.trim().length === 0) {
        return err(appError('INVALID_INPUT', 'Goal workspace requires kind and baseRevision'));
      }
      if (registration.goalWorkspaceKind === 'git_worktree'
        && (registration.branchName?.trim() === undefined || registration.branchName.trim().length === 0)) {
        return err(appError('INVALID_INPUT', 'Git goal workspace requires branchName'));
      }
    }
    if (registration.expiresAt !== undefined && !Number.isFinite(Date.parse(registration.expiresAt))) {
      return err(appError('INVALID_INPUT', 'Workspace expiry must be a valid ISO-compatible timestamp'));
    }

    const platform = this.options.platform ?? process.platform;
    const absoluteRootPath = resolveHostPath(rootPath, platform);
    if (absoluteRootPath === null) {
      return err(appError('INVALID_INPUT', 'Workspace root uses a foreign host path syntax'));
    }
    if (isPosixMountRoot(absoluteRootPath, platform)) {
      return err(appError('INVALID_INPUT', 'A POSIX filesystem mount root cannot be registered as a project'));
    }
    let rootStats;
    try {
      rootStats = await stat(absoluteRootPath);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root was not found'));
    }
    if (!rootStats.isDirectory()) {
      return err(appError('INVALID_INPUT', 'Workspace root must be a directory'));
    }

    let canonicalRootPath: string;
    try {
      canonicalRootPath = await realpath(absoluteRootPath);
    } catch {
      return err(appError('WORKSPACE_NOT_FOUND', 'Workspace root could not be canonicalized'));
    }

    const registrations = await (this.repository.listAll?.() ?? this.repository.list());
    if (registrations.some((workspace) => workspace.archivedAt === undefined
      && samePath(workspace.realRootPath, canonicalRootPath, platform))) {
      return err(appError('CONFLICT', 'Workspace root is already registered', true));
    }

    const archived = registrations.filter((workspace) => workspace.archivedAt !== undefined
      && workspace.archivedAt !== null
      && samePath(workspace.realRootPath, canonicalRootPath, platform));
    if (archived.length > 1) {
      return err(appError('CONFLICT', 'Multiple archived workspace identities match this canonical path; relink requires explicit recovery', true));
    }
    if (archived.length === 1) {
      if (this.repository.restore === undefined) {
        return err(appError('CONFLICT', 'Workspace identity is archived and cannot be relinked by this repository', true));
      }
      const archivedWorkspace = archived[0]!;
      const restored: Workspace = {
        id: archivedWorkspace.id,
        displayName: displayName.trim(),
        rootPath: absoluteRootPath,
        realRootPath: canonicalRootPath,
        createdAt: archivedWorkspace.createdAt,
        ...(lifecycleKind === 'project' ? {} : { lifecycleKind }),
        ...(registration.ownerSessionId === undefined ? {} : { ownerSessionId: registration.ownerSessionId }),
        ...(registration.ownerJobId === undefined ? {} : { ownerJobId: registration.ownerJobId }),
        ...(registration.autoCleanup === true ? { autoCleanup: true } : {}),
        ...(registration.expiresAt === undefined ? {} : { expiresAt: registration.expiresAt }),
        ...goalMetadata(lifecycleKind, registration),
      };
      try {
        await this.repository.restore(archived[0]!.id, restored);
      } catch (error: unknown) {
        return err(appError('CONFLICT', `Workspace identity could not be restored: ${errorMessage(error)}`, true));
      }
      return ok(restored);
    }

    const workspace: Workspace = {
      id: randomUUID(),
      displayName: displayName.trim(),
      rootPath: absoluteRootPath,
      realRootPath: canonicalRootPath,
      createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      ...(lifecycleKind === 'project' ? {} : { lifecycleKind }),
      ...(registration.ownerSessionId === undefined ? {} : { ownerSessionId: registration.ownerSessionId }),
      ...(registration.ownerJobId === undefined ? {} : { ownerJobId: registration.ownerJobId }),
      ...(registration.autoCleanup === true ? { autoCleanup: true } : {}),
      ...(registration.expiresAt === undefined ? {} : { expiresAt: registration.expiresAt }),
      ...goalMetadata(lifecycleKind, registration),
    };
    try {
      const inserted = this.repository.insertIfAvailable === undefined
        ? (await this.repository.insert(workspace), true)
        : await this.repository.insertIfAvailable(workspace);
      if (!inserted) return err(appError('CONFLICT', 'Workspace root is already registered', true));
    } catch (error: unknown) {
      return err(appError('CONFLICT', `Workspace could not be registered: ${errorMessage(error)}`, true));
    }
    return ok(workspace);
  }

  public list(): Promise<Workspace[]> {
    return this.repository.list();
  }

  public get(id: WorkspaceId): Promise<Workspace | null> {
    return this.repository.get(id);
  }

  /** Remove a registration while retaining its durable identity for relinking. */
  public async unregister(id: WorkspaceId): Promise<Result<void>> {
    if (this.repository.archive === undefined) {
      return err(appError('CONFLICT', 'Workspace registration cannot be removed without durable archival support', true));
    }
    try {
      await this.repository.archive(id);
    } catch (error: unknown) {
      return err(appError('CONFLICT', `Workspace registration could not be archived: ${errorMessage(error)}`, true));
    }
    return ok(undefined);
  }

  public async unregisterMany(ids: readonly WorkspaceId[]): Promise<Result<void>> {
    if (this.repository.archiveMany !== undefined) {
      try {
        await this.repository.archiveMany(ids);
      } catch (error: unknown) {
        return err(appError('CONFLICT', `Workspace registrations could not be archived: ${errorMessage(error)}`, true));
      }
      return ok(undefined);
    }
    for (const id of ids) {
      const result = await this.unregister(id);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }

  /**
   * Read-only lifecycle evaluation for Goal Workspaces.
   *
   * This method never archives registrations, mutates unavailable markers, removes
   * Git worktrees, or authorizes physical cleanup. Unknown durable-reference truth
   * remains an explicit fail-closed blocker.
   */
  public async evaluateGoalWorkspaceCleanup(
    options: WorkspaceCleanupEvaluationOptions = {},
  ): Promise<Result<readonly WorkspaceLifecycleCleanupEvaluation[]>> {
    const retentionGraceMs = resolveGoalRetentionGraceMs(options.goalRetentionGraceMs);
    if (retentionGraceMs === null) {
      return err(appError('INVALID_INPUT', 'Goal Workspace retention grace must be safe integer milliseconds between 0 and 365 days'));
    }
    const protectedIds = new Set(options.protectedWorkspaceIds ?? []);
    const now = this.options.now?.() ?? new Date();
    const workspaces = await this.repository.list();
    const evaluations: WorkspaceLifecycleCleanupEvaluation[] = [];

    for (const workspace of workspaces) {
      if (workspaceLifecycleKind(workspace) !== 'goal') continue;
      const available = await this.isWorkspaceAvailable(workspace);
      evaluations.push(classifyGoalWorkspaceCleanup(
        workspace,
        available,
        protectedIds.has(workspace.id),
        options.goalRuntimeProjections?.get(workspace.goalId ?? ''),
        options.goalDurableReferenceStates?.get(workspace.goalId ?? '') ?? 'unknown',
        now,
        retentionGraceMs,
      ));
    }

    return ok(evaluations);
  }

  public async reconcileLifecycle(
    options: WorkspaceLifecycleReconcileOptions = {},
  ): Promise<Result<WorkspaceLifecycleReconciliation>> {
    const retentionGraceMs = resolveGoalRetentionGraceMs(options.goalRetentionGraceMs);
    if (retentionGraceMs === null) {
      return err(appError('INVALID_INPUT', 'Goal Workspace retention grace must be safe integer milliseconds between 0 and 365 days'));
    }
    const protectedIds = new Set(options.protectedWorkspaceIds ?? []);
    const endedSessions = new Set(options.endedOwnerSessionIds ?? []);
    const endedJobs = new Set(options.endedOwnerJobIds ?? []);
    const now = this.options.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const workspaces = await this.repository.list();
    const archivedWorkspaceIds: WorkspaceId[] = [];
    const unavailableWorkspaceIds: WorkspaceId[] = [];
    const skippedProtectedWorkspaceIds: WorkspaceId[] = [];
    const goalCleanupEvaluations: WorkspaceLifecycleCleanupEvaluation[] = [];

    for (const workspace of workspaces) {
      const available = await this.isWorkspaceAvailable(workspace);
      const lifecycleKind = workspaceLifecycleKind(workspace);
      if (lifecycleKind === 'goal') {
        goalCleanupEvaluations.push(classifyGoalWorkspaceCleanup(
          workspace,
          available,
          protectedIds.has(workspace.id),
          options.goalRuntimeProjections?.get(workspace.goalId ?? ''),
          options.goalDurableReferenceStates?.get(workspace.goalId ?? '') ?? 'unknown',
          now,
          retentionGraceMs,
        ));
      }
      const expired = workspace.expiresAt !== undefined
        && workspace.expiresAt !== null
        && Number.isFinite(Date.parse(workspace.expiresAt))
        && Date.parse(workspace.expiresAt) <= now.getTime();
      const ownerEnded = (workspace.ownerSessionId !== undefined
          && workspace.ownerSessionId !== null
          && endedSessions.has(workspace.ownerSessionId))
        || (workspace.ownerJobId !== undefined
          && workspace.ownerJobId !== null
          && endedJobs.has(workspace.ownerJobId));
      const autoCleanupEligible = (lifecycleKind === 'temporary' || lifecycleKind === 'inspection')
        && workspace.autoCleanup === true
        && (!available || expired || ownerEnded);

      if (autoCleanupEligible && protectedIds.has(workspace.id)) {
        skippedProtectedWorkspaceIds.push(workspace.id);
      } else if (autoCleanupEligible) {
        if (this.repository.archive === undefined) {
          return err(appError('CONFLICT', 'Workspace lifecycle cleanup requires durable archival support', true));
        }
        await this.repository.archive(workspace.id, nowIso);
        archivedWorkspaceIds.push(workspace.id);
        continue;
      }

      if (!available) {
        unavailableWorkspaceIds.push(workspace.id);
        if ((workspace.unavailableSince === undefined || workspace.unavailableSince === null)
          && this.repository.setUnavailableSince !== undefined) {
          await this.repository.setUnavailableSince(workspace.id, nowIso);
        }
      } else if (workspace.unavailableSince !== undefined
        && workspace.unavailableSince !== null
        && this.repository.setUnavailableSince !== undefined) {
        await this.repository.setUnavailableSince(workspace.id, null);
      }
    }

    return ok({
      inspected: workspaces.length,
      archivedWorkspaceIds,
      unavailableWorkspaceIds,
      skippedProtectedWorkspaceIds,
      goalCleanupEvaluations,
    });
  }

  public delete(id: WorkspaceId): Promise<void> {
    return this.repository.delete(id);
  }

  private async isWorkspaceAvailable(workspace: Workspace): Promise<boolean> {
    const platform = this.options.platform ?? process.platform;
    try {
      const [stats, canonicalRootPath] = await Promise.all([
        stat(workspace.rootPath),
        realpath(workspace.rootPath),
      ]);
      return stats.isDirectory() && samePath(canonicalRootPath, workspace.realRootPath, platform);
    } catch {
      return false;
    }
  }
}

function classifyGoalWorkspaceCleanup(
  workspace: Workspace,
  workspaceAvailable: boolean,
  protectedWorkspace: boolean,
  projection: GoalRuntimeProjection | undefined,
  durableReferenceState: WorkspaceDurableReferenceState,
  now: Date,
  retentionGraceMs: number,
): WorkspaceLifecycleCleanupEvaluation {
  const blockers: WorkspaceCleanupBlockerReason[] = [];
  const goalId = workspace.goalId?.trim();
  const writerLeaseActive = workspace.writerLease !== undefined
    && ((): boolean => {
      const expiresAt = Date.parse(workspace.writerLease.expiresAt);
      return !Number.isFinite(expiresAt) || expiresAt > now.getTime();
    })();
  let retentionStartedMs: number | undefined;

  if (protectedWorkspace) blockers.push('protected_workspace');
  if (!workspaceAvailable) blockers.push('workspace_unavailable');
  if (goalId === undefined || goalId.length === 0) blockers.push('goal_identity_missing');
  const managedIdentityComplete = workspace.parentWorkspaceId?.trim()
    && workspace.goalWorkspaceKind !== undefined
    && workspace.baseRevision?.trim()
    && (workspace.goalWorkspaceKind !== 'git_worktree' || Boolean(workspace.branchName?.trim()));
  if (!managedIdentityComplete) blockers.push('goal_workspace_identity_incomplete');

  const validProjection = goalId !== undefined
    && goalId.length > 0
    && projection?.goalId === goalId
    ? projection
    : undefined;
  if (projection !== undefined && validProjection === undefined) {
    blockers.push('goal_runtime_scope_mismatch');
  } else if (validProjection === undefined) {
    blockers.push('goal_runtime_unknown');
  } else {
    if (workspace.parentWorkspaceId !== undefined && validProjection.workspaceId !== workspace.parentWorkspaceId) {
      blockers.push('goal_runtime_scope_mismatch');
    }
    if (
      validProjection.lifecycleState !== 'completed'
      && validProjection.lifecycleState !== 'archived'
      && validProjection.lifecycleState !== 'cleaned'
    ) {
      blockers.push('goal_lifecycle_not_retention_ready');
    }
    if (validProjection.runtimeState !== 'idle') blockers.push('goal_runtime_not_idle');
    if (validProjection.integrationState !== 'integrated') blockers.push('goal_integration_not_integrated');
    if (validProjection.workspaceState !== 'clean') blockers.push('goal_workspace_not_clean');

    const parsedRetentionStart = Date.parse(validProjection.lastActivityAt);
    if (!Number.isFinite(parsedRetentionStart)) {
      blockers.push('goal_retention_anchor_invalid');
    } else {
      retentionStartedMs = parsedRetentionStart;
    }
  }

  if (writerLeaseActive) blockers.push('active_writer_lease');
  if (durableReferenceState === 'unknown') blockers.push('durable_references_unknown');
  if (durableReferenceState === 'present') blockers.push('durable_references_present');

  let disposition: WorkspaceCleanupDisposition = 'blocked';
  let retentionStartedAt: string | undefined;
  let retentionEligibleAt: string | undefined;
  let retentionRemainingMs: number | undefined;
  if (blockers.length === 0 && retentionStartedMs !== undefined) {
    const eligibleMs = retentionStartedMs + retentionGraceMs;
    const eligibleDate = new Date(eligibleMs);
    if (!Number.isFinite(eligibleDate.getTime())) {
      blockers.push('goal_retention_anchor_invalid');
    } else {
      retentionStartedAt = new Date(retentionStartedMs).toISOString();
      retentionEligibleAt = eligibleDate.toISOString();
      retentionRemainingMs = Math.max(0, eligibleMs - now.getTime());
      disposition = retentionRemainingMs === 0 ? 'retention_candidate' : 'retention_pending';
    }
  }

  return {
    workspaceId: workspace.id,
    ...(goalId === undefined || goalId.length === 0 ? {} : { goalId }),
    disposition,
    blockers,
    workspaceAvailable,
    writerLeaseActive,
    durableReferenceState,
    ...(retentionStartedAt === undefined ? {} : { retentionStartedAt }),
    ...(retentionEligibleAt === undefined ? {} : { retentionEligibleAt }),
    ...(retentionRemainingMs === undefined ? {} : { retentionRemainingMs }),
  };
}

function resolveGoalRetentionGraceMs(value: number | undefined): number | null {
  const resolved = value ?? DEFAULT_GOAL_WORKSPACE_RETENTION_GRACE_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > MAX_GOAL_WORKSPACE_RETENTION_GRACE_MS) {
    return null;
  }
  return resolved;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const resolved = resolveHostPath(value, platform) ?? value.trim();
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function goalMetadata(
  lifecycleKind: WorkspaceLifecycleKind,
  registration: WorkspaceRegistrationOptions,
): Pick<Workspace, 'goalId' | 'parentWorkspaceId' | 'goalWorkspaceKind' | 'parentSource' | 'baseRef' | 'baseRevision' | 'branchName' | 'checkpointId' | 'integrationState'> {
  if (lifecycleKind !== 'goal') return {};
  return {
    ...(registration.goalId === undefined ? {} : { goalId: registration.goalId }),
    ...(registration.parentWorkspaceId === undefined ? {} : { parentWorkspaceId: registration.parentWorkspaceId }),
    ...(registration.goalWorkspaceKind === undefined ? {} : { goalWorkspaceKind: registration.goalWorkspaceKind }),
    ...(registration.parentSource === undefined ? {} : { parentSource: registration.parentSource }),
    ...(registration.baseRef === undefined ? {} : { baseRef: registration.baseRef }),
    ...(registration.baseRevision === undefined ? {} : { baseRevision: registration.baseRevision }),
    ...(registration.branchName === undefined ? {} : { branchName: registration.branchName }),
    ...(registration.checkpointId === undefined ? {} : { checkpointId: registration.checkpointId }),
    ...(registration.integrationState === undefined ? {} : { integrationState: registration.integrationState }),
  };
}
