import { createHash } from 'node:crypto';
import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  projectGoalRuntimeEvent,
  type GoalRecord,
  type GoalRepository,
  type GoalRuntimeEvent,
  type GoalRuntimeEventRepository,
  type GoalRuntimeProjection,
  type GoalRuntimeSnapshotRecord,
  type GoalRuntimeSnapshotRepository,
  type WorkspaceAdmissionDecision,
  type WorkspaceAdmissionProjection,
  type WorkspaceAdmissionReceipt,
  appError,
  err,
  ok,
  type Result,
} from '@unified-mpc/domain';
import { classifyWorkspaceAdmission } from '@unified-mpc/domain';
import type { GoalWorkspaceAdmissionObservation, GoalWorkspaceIntegrationObservation, GoalWorkspaceTruthObservation, GoalWorkspaceTruthReader } from './goal-workspace-truth-reader.js';

const DEFAULT_BOOTSTRAP_LIMIT = 500;
const EVENT_REPLAY_PAGE_SIZE = 500;
const MAX_DURABLE_GOAL_BLOCKER_DETAIL = 2_000;
const INITIAL_ADMISSION_WORKFLOW_VERSION = 1;

export interface GoalRuntimeEventPublisher {
  ensureGoalSnapshot(goalId: string): Promise<GoalRuntimeSnapshotRecord>;
  publishGoalRuntimeEvent(event: GoalRuntimeEvent): Promise<GoalRuntimeSnapshotRecord>;
  refreshGoalWorkspaceTruth?(goalId: string): Promise<GoalRuntimeSnapshotRecord>;
}

export type GoalRuntimeAdmissionIdentity = Pick<WorkspaceAdmissionReceipt,
  'runtimeDeploymentId' | 'runtimeGeneration' | 'runtimeBuildVersion' | 'runtimeBuildCommit'
  | 'runtimeBuildDirty' | 'runtimeProtocolGeneration' | 'runtimeStartedAt'>;

export interface GoalRuntimeBootstrapResult {
  readonly workspaceId: string;
  readonly goalsScanned: number;
  readonly snapshotsReady: number;
  readonly admissionProjection?: WorkspaceAdmissionProjection;
  readonly admission?: WorkspaceAdmissionDecision & {
    readonly admissionGeneration?: number;
    readonly refreshedFromRuntimeGeneration?: boolean;
    readonly refreshedFromWriterLeaseGeneration?: boolean;
  };
}

export interface GoalRuntimeControlPlaneOptions {
  readonly workspaceTruth?: Pick<GoalWorkspaceTruthReader, 'read'> & Partial<Pick<GoalWorkspaceTruthReader, 'readIntegration'>>;
  readonly workspaceAdmission?: Pick<GoalWorkspaceTruthReader, 'readAdmission'>;
  readonly workspaceAdmissionReceipts?: {
    getAdmissionReceipt(workspaceId: string): Promise<WorkspaceAdmissionReceipt | null>;
    compareAndSwapAdmissionReceipt?(workspaceId: string, expectedGeneration: number, leaseGeneration: number, receipt: WorkspaceAdmissionReceipt): Promise<boolean>;
  };
  readonly runtimeAdmissionIdentity?: GoalRuntimeAdmissionIdentity;
  readonly now?: () => Date;
}

export class GoalRuntimeControlPlaneError extends Error {
  public constructor(
    public readonly reason: 'goal_not_found' | 'replay_window_missed' | 'projection_rejected',
    message: string,
  ) {
    super(message);
    this.name = 'GoalRuntimeControlPlaneError';
  }
}

/**
 * Parent-owned writer for authoritative Goal runtime truth.
 *
 * Durable Goal mutations remain the source for durable intent/ownership. This
 * service serializes runtime projection per Goal, replays any durable events
 * missed by a snapshot, and publishes one compact snapshot for WebUI/recovery/
 * cleanup consumers. It never infers "running" from selection, an open Goal,
 * a worktree, or lease ownership alone.
 */
export class GoalRuntimeControlPlaneService implements GoalRuntimeEventPublisher {
  private readonly goalChains = new Map<string, Promise<void>>();
  private readonly workspaceTruth: (Pick<GoalWorkspaceTruthReader, 'read'> & Partial<Pick<GoalWorkspaceTruthReader, 'readIntegration'>>) | undefined;
  private readonly workspaceAdmission: Pick<GoalWorkspaceTruthReader, 'readAdmission'> | undefined;
  private readonly workspaceAdmissionReceipts: GoalRuntimeControlPlaneOptions['workspaceAdmissionReceipts'];
  private readonly runtimeAdmissionIdentity: GoalRuntimeAdmissionIdentity | undefined;
  private readonly now: () => Date;

  public constructor(
    private readonly goals: Pick<GoalRepository, 'getById' | 'list'>,
    private readonly snapshots: GoalRuntimeSnapshotRepository,
    private readonly events: GoalRuntimeEventRepository,
    options: GoalRuntimeControlPlaneOptions = {},
  ) {
    this.workspaceTruth = options.workspaceTruth;
    this.workspaceAdmission = options.workspaceAdmission;
    this.workspaceAdmissionReceipts = options.workspaceAdmissionReceipts;
    this.runtimeAdmissionIdentity = options.runtimeAdmissionIdentity;
    this.now = options.now ?? ((): Date => new Date());
  }

  public async ensureGoalSnapshot(goalId: string): Promise<GoalRuntimeSnapshotRecord> {
    return this.withGoalLock(goalId, async () => {
      let snapshot = await this.ensureGoalSnapshotUnlocked(goalId);
      snapshot = await this.catchUpSnapshotUnlocked(snapshot);
      snapshot = await this.reconcileDurableTerminalStateUnlocked(snapshot);
      snapshot = await this.refreshWorkspaceTruthUnlocked(snapshot);
      snapshot = await this.refreshIntegrationTruthUnlocked(snapshot);
      return this.reconcileDurableBlockerTruthUnlocked(snapshot);
    });
  }

  public async publishGoalRuntimeEvent(event: GoalRuntimeEvent): Promise<GoalRuntimeSnapshotRecord> {
    return this.withGoalLock(event.goalId, async () => {
      let snapshot = await this.ensureGoalSnapshotUnlocked(event.goalId);
      snapshot = await this.catchUpSnapshotUnlocked(snapshot);

      snapshot = await this.appendAndReplayUnlocked(snapshot, event);
      return this.reconcileDurableBlockerTruthUnlocked(snapshot);
    });
  }

  public async recordSuccessfulWorkspaceMutation(binding: {
    readonly callId: string;
    readonly workspaceId: string;
    readonly goalId: string;
    readonly leaseGeneration: number;
    readonly admissionGeneration: number;
  }): Promise<void> {
    const receipts = this.workspaceAdmissionReceipts;
    const runtime = this.runtimeAdmissionIdentity;
    if (receipts?.compareAndSwapAdmissionReceipt === undefined || runtime === undefined || runtime.runtimeBuildDirty) {
      throw new Error('Workspace admission progress cannot be recorded safely');
    }
    const [receipt, observed] = await Promise.all([
      receipts.getAdmissionReceipt(binding.workspaceId),
      this.readWorkspaceAdmissionBestEffort(binding.workspaceId),
    ]);
    const now = this.now();
    const nonGit = observed?.workspaceKind === 'non_git';
    if (receipt === null || observed === null || observed.dirtyState === 'unknown'
      || observed.writerLeaseGeneration !== binding.leaseGeneration
      || observed.writerLeaseExpiresAt === undefined || Date.parse(observed.writerLeaseExpiresAt) <= now.getTime()
      || observed.goalId !== binding.goalId || observed.projectId !== receipt.projectId
      || observed.checkpointId !== receipt.checkpointId || receipt.goalId !== binding.goalId
      || receipt.workspaceId !== binding.workspaceId || receipt.workspaceKind !== observed.workspaceKind
      || receipt.writeLeaseGeneration !== binding.leaseGeneration
      || receipt.admissionGeneration !== binding.admissionGeneration || receipt.invalidatedAt !== undefined
      || (receipt.expiresAt !== undefined && Date.parse(receipt.expiresAt) <= now.getTime())
      || (nonGit
        ? observed.sourceSnapshotGeneration === undefined || observed.sourceContentFingerprint === undefined
          || receipt.expectedWorkspaceHead !== observed.sourceSnapshotGeneration
          || receipt.observedWorkspaceHead !== observed.sourceSnapshotGeneration
          || receipt.worktreeIdentity !== observed.sourceSnapshotGeneration
        : observed.workspaceKind !== 'git' || observed.workspaceHead === undefined || observed.dirtyFingerprint === undefined
          || observed.stagedFingerprint === undefined || observed.repositoryIdentity !== receipt.repositoryIdentity
          || observed.gitCommonDirIdentity !== receipt.gitCommonDirIdentity
          || observed.worktreeIdentity !== receipt.worktreeIdentity || observed.branchName !== receipt.branchName
          || observed.baseRef !== receipt.baseRef || observed.baseSha !== receipt.resolvedBaseSha
          || observed.mergeBaseSha !== receipt.mergeBaseSha || (observed.remoteGoalSha ?? undefined) !== receipt.remoteGoalSha)
      || runtimeAdmissionGeneration(runtime) !== runtimeAdmissionGeneration(receipt)) {
      throw new Error('Successful workspace mutation no longer matches its admitted source and writer proof');
    }

    const workspaceHead = nonGit ? observed.sourceSnapshotGeneration! : observed.workspaceHead!;
    const dirtyFingerprint = nonGit ? observed.sourceContentFingerprint! : observed.dirtyFingerprint!;
    const nextReceipt: WorkspaceAdmissionReceipt = {
      ...receipt,
      admissionId: createHash('sha256').update(`${receipt.admissionId}:${binding.callId}:${binding.admissionGeneration + 1}`).digest('hex'),
      expectedWorkspaceHead: workspaceHead,
      observedWorkspaceHead: workspaceHead,
      dirtyState: observed.dirtyState,
      dirtyFingerprint,
      stagedFingerprint: nonGit ? '' : observed.stagedFingerprint!,
      admissionGeneration: receipt.admissionGeneration + 1,
      createdAt: now.toISOString(),
    };
    const saved = await receipts.compareAndSwapAdmissionReceipt(
      binding.workspaceId, binding.admissionGeneration, binding.leaseGeneration, nextReceipt,
    );
    if (!saved) throw new Error('Workspace admission progress lost its generation compare-and-swap');
  }

  public async recoverStagedWorkspaceAdmission(binding: {
    readonly callId: string;
    readonly workspaceId: string;
    readonly goalId: string;
    readonly leaseGeneration: number;
    readonly admissionGeneration: number;
    readonly expectedWorkspaceHead: string;
    readonly expectedStagedFingerprint: string;
  }): Promise<number> {
    const receipts = this.workspaceAdmissionReceipts;
    const runtime = this.runtimeAdmissionIdentity;
    if (receipts?.compareAndSwapAdmissionReceipt === undefined || runtime === undefined || runtime.runtimeBuildDirty) {
      throw new Error('Staged workspace admission recovery cannot be recorded safely');
    }
    const [receipt, observed] = await Promise.all([
      receipts.getAdmissionReceipt(binding.workspaceId),
      this.readWorkspaceAdmissionBestEffort(binding.workspaceId),
    ]);
    const now = this.now();
    if (receipt === null || observed === null || observed.workspaceKind !== 'git'
      || observed.dirtyState !== 'dirty' || observed.workspaceHead === undefined
      || observed.dirtyFingerprint === undefined || observed.stagedFingerprint === undefined
      || observed.stagedFingerprint !== binding.expectedStagedFingerprint
      || observed.workspaceHead !== binding.expectedWorkspaceHead
      || receipt.expectedWorkspaceHead !== binding.expectedWorkspaceHead
      || receipt.observedWorkspaceHead !== binding.expectedWorkspaceHead
      || observed.writerLeaseGeneration !== binding.leaseGeneration
      || observed.writerLeaseExpiresAt === undefined || Date.parse(observed.writerLeaseExpiresAt) <= now.getTime()
      || observed.goalId !== binding.goalId || receipt.goalId !== binding.goalId
      || observed.projectId !== receipt.projectId || receipt.workspaceId !== binding.workspaceId
      || observed.checkpointId !== receipt.checkpointId
      || receipt.workspaceKind !== 'git'
      || receipt.admissionGeneration !== binding.admissionGeneration
      || receipt.writeLeaseGeneration > binding.leaseGeneration
      || receipt.invalidatedAt !== undefined
      || (receipt.expiresAt !== undefined && Date.parse(receipt.expiresAt) <= now.getTime())
      || observed.repositoryIdentity !== receipt.repositoryIdentity
      || observed.gitCommonDirIdentity !== receipt.gitCommonDirIdentity
      || observed.worktreeIdentity !== receipt.worktreeIdentity
      || observed.branchName !== receipt.branchName
      || observed.baseRef !== receipt.baseRef
      || observed.baseSha !== receipt.resolvedBaseSha
      || observed.mergeBaseSha !== receipt.mergeBaseSha
      || (observed.remoteGoalSha ?? undefined) !== receipt.remoteGoalSha
      || observed.stagedFingerprint === receipt.stagedFingerprint) {
      throw new Error('Staged workspace admission recovery no longer matches its exact owner, source, and prior admission proof');
    }

    const recovered: WorkspaceAdmissionReceipt = {
      ...receipt,
      ...runtime,
      admissionId: createHash('sha256')
        .update([receipt.admissionId, binding.callId, 'staged-recovery', String(binding.leaseGeneration),
          String(binding.admissionGeneration + 1), now.toISOString()].join('\0'))
        .digest('hex'),
      expectedWorkspaceHead: observed.workspaceHead,
      observedWorkspaceHead: observed.workspaceHead,
      dirtyState: observed.dirtyState,
      dirtyFingerprint: observed.dirtyFingerprint,
      stagedFingerprint: observed.stagedFingerprint,
      writeLeaseGeneration: binding.leaseGeneration,
      admissionGeneration: binding.admissionGeneration + 1,
      createdAt: now.toISOString(),
    };
    const saved = await receipts.compareAndSwapAdmissionReceipt(
      binding.workspaceId,
      binding.admissionGeneration,
      binding.leaseGeneration,
      recovered,
    );
    if (!saved) throw new Error('Staged workspace admission recovery lost its generation compare-and-swap');
    return recovered.admissionGeneration;
  }

  public async recoverUnstagedWorkspaceAdmission(binding: {
    readonly callId: string;
    readonly workspaceId: string;
    readonly goalId: string;
    readonly leaseGeneration: number;
    readonly admissionGeneration: number;
    readonly expectedWorkspaceHead: string;
    readonly expectedDirtyFingerprint: string;
    readonly expectedStagedFingerprint: string;
  }): Promise<number> {
    const receipts = this.workspaceAdmissionReceipts;
    const runtime = this.runtimeAdmissionIdentity;
    if (receipts?.compareAndSwapAdmissionReceipt === undefined || runtime === undefined || runtime.runtimeBuildDirty) {
      throw new Error('Unstaged workspace admission recovery cannot be recorded safely');
    }
    const [receipt, observed] = await Promise.all([
      receipts.getAdmissionReceipt(binding.workspaceId),
      this.readWorkspaceAdmissionBestEffort(binding.workspaceId),
    ]);
    const now = this.now();
    if (receipt === null || observed === null || observed.workspaceKind !== 'git'
      || observed.dirtyState !== 'dirty' || observed.workspaceHead === undefined
      || observed.dirtyFingerprint === undefined || observed.stagedFingerprint === undefined
      || observed.dirtyFingerprint !== binding.expectedDirtyFingerprint
      || observed.stagedFingerprint !== binding.expectedStagedFingerprint
      || observed.stagedFingerprint !== receipt.stagedFingerprint
      || observed.dirtyFingerprint === receipt.dirtyFingerprint
      || observed.workspaceHead !== binding.expectedWorkspaceHead
      || receipt.expectedWorkspaceHead !== binding.expectedWorkspaceHead
      || receipt.observedWorkspaceHead !== binding.expectedWorkspaceHead
      || observed.writerLeaseGeneration !== binding.leaseGeneration
      || observed.writerLeaseExpiresAt === undefined || Date.parse(observed.writerLeaseExpiresAt) <= now.getTime()
      || observed.goalId !== binding.goalId || receipt.goalId !== binding.goalId
      || observed.projectId !== receipt.projectId || receipt.workspaceId !== binding.workspaceId
      || observed.checkpointId !== receipt.checkpointId
      || receipt.workspaceKind !== 'git'
      || receipt.admissionGeneration !== binding.admissionGeneration
      || receipt.writeLeaseGeneration > binding.leaseGeneration
      || receipt.invalidatedAt !== undefined
      || (receipt.expiresAt !== undefined && Date.parse(receipt.expiresAt) <= now.getTime())
      || observed.repositoryIdentity !== receipt.repositoryIdentity
      || observed.gitCommonDirIdentity !== receipt.gitCommonDirIdentity
      || observed.worktreeIdentity !== receipt.worktreeIdentity
      || observed.branchName !== receipt.branchName
      || observed.baseRef !== receipt.baseRef
      || observed.baseSha !== receipt.resolvedBaseSha
      || observed.mergeBaseSha !== receipt.mergeBaseSha
      || (observed.remoteGoalSha ?? undefined) !== receipt.remoteGoalSha) {
      throw new Error('Unstaged workspace admission recovery no longer matches its exact owner, source, and prior admission proof');
    }

    const recovered: WorkspaceAdmissionReceipt = {
      ...receipt,
      ...runtime,
      admissionId: createHash('sha256')
        .update([receipt.admissionId, binding.callId, 'unstaged-recovery', String(binding.leaseGeneration),
          String(binding.admissionGeneration + 1), now.toISOString()].join('\0'))
        .digest('hex'),
      expectedWorkspaceHead: observed.workspaceHead,
      observedWorkspaceHead: observed.workspaceHead,
      dirtyState: observed.dirtyState,
      dirtyFingerprint: observed.dirtyFingerprint,
      stagedFingerprint: observed.stagedFingerprint,
      writeLeaseGeneration: binding.leaseGeneration,
      admissionGeneration: binding.admissionGeneration + 1,
      createdAt: now.toISOString(),
    };
    const saved = await receipts.compareAndSwapAdmissionReceipt(
      binding.workspaceId,
      binding.admissionGeneration,
      binding.leaseGeneration,
      recovered,
    );
    if (!saved) throw new Error('Unstaged workspace admission recovery lost its generation compare-and-swap');
    return recovered.admissionGeneration;
  }

  public async refreshGoalWorkspaceTruth(goalId: string): Promise<GoalRuntimeSnapshotRecord> {
    return this.withGoalLock(goalId, async () => {
      let snapshot = await this.ensureGoalSnapshotUnlocked(goalId);
      snapshot = await this.catchUpSnapshotUnlocked(snapshot);
      snapshot = await this.reconcileDurableTerminalStateUnlocked(snapshot);
      snapshot = await this.refreshWorkspaceTruthUnlocked(snapshot);
      snapshot = await this.refreshIntegrationTruthUnlocked(snapshot);
      return this.reconcileDurableBlockerTruthUnlocked(snapshot);
    });
  }

  public async validateWorkspaceAdmission(
    workspaceId: string,
    goalId: string,
    leaseGeneration: number,
    expectedAdmissionGeneration: number | undefined,
  ): Promise<Result<void>> {
    const observation = await this.readWorkspaceAdmissionBestEffort(workspaceId);
    const admission = await this.classifyAdmissionBestEffort(workspaceId, observation);
    if (admission?.status === 'ADMITTED'
      && expectedAdmissionGeneration !== undefined
      && admission.admissionGeneration === expectedAdmissionGeneration
      && observation?.goalId === goalId
      && observation.writerLeaseGeneration === leaseGeneration) {
      return ok(undefined);
    }
    const reason = admission?.reason ?? admission?.status ?? 'admission_unavailable';
    return err(appError(
      'WORKSPACE_ADMISSION_STALE',
      `WORKSPACE_ADMISSION_STALE: ${reason}; refresh workspace admission before retrying`,
      true,
      {
        expectedAdmissionGeneration: expectedAdmissionGeneration ?? 0,
        observedAdmissionGeneration: admission?.admissionGeneration ?? 0,
        leaseGeneration,
      },
    ));
  }

  public async bootstrapWorkspace(
    workspaceId: string,
    limit = DEFAULT_BOOTSTRAP_LIMIT,
  ): Promise<GoalRuntimeBootstrapResult> {
    const goals = await this.goals.list({ workspaceId, limit });
    const workspaceObservation = await this.readWorkspaceTruthBestEffort(workspaceId);
    const admissionObservation = await this.readWorkspaceAdmissionBestEffort(workspaceId);
    const admission = await this.classifyAdmissionBestEffort(workspaceId, admissionObservation);
    const admissionProjection = await this.projectWorkspaceAdmissionBestEffort(workspaceId, admissionObservation, admission);
    let snapshotsReady = 0;
    for (const goal of goals) {
      await this.withGoalLock(goal.id, async () => {
        let snapshot = await this.ensureGoalSnapshotUnlocked(goal.id);
        snapshot = await this.catchUpSnapshotUnlocked(snapshot);
        snapshot = await this.reconcileDurableTerminalStateUnlocked(snapshot);
        snapshot = await this.refreshWorkspaceTruthUnlocked(snapshot, workspaceObservation);
        await this.reconcileDurableBlockerTruthUnlocked(snapshot);
      });
      snapshotsReady += 1;
    }
    return {
      workspaceId,
      goalsScanned: goals.length,
      snapshotsReady,
      ...(admissionProjection === undefined ? {} : { admissionProjection }),
      ...(admission === undefined ? {} : { admission }),
    };
  }

  public async readWorkspaceAdmissionProjection(workspaceId: string): Promise<WorkspaceAdmissionProjection | undefined> {
    const observation = await this.readWorkspaceAdmissionBestEffort(workspaceId);
    const admission = await this.classifyAdmissionBestEffort(workspaceId, observation);
    return this.projectWorkspaceAdmissionBestEffort(workspaceId, observation, admission);
  }

  private async projectWorkspaceAdmissionBestEffort(
    workspaceId: string,
    observed: GoalWorkspaceAdmissionObservation | null,
    admission: GoalRuntimeBootstrapResult['admission'] | undefined,
  ): Promise<WorkspaceAdmissionProjection | undefined> {
    let receipt: WorkspaceAdmissionReceipt | null = null;
    if (this.workspaceAdmissionReceipts !== undefined) {
      try {
        receipt = await this.workspaceAdmissionReceipts.getAdmissionReceipt(workspaceId);
      } catch {
        receipt = null;
      }
    }
    const currentRuntime = this.runtimeAdmissionIdentity;
    const admittedRuntime: GoalRuntimeAdmissionIdentity | undefined = currentRuntime ?? (receipt === null ? undefined : {
      runtimeDeploymentId: receipt.runtimeDeploymentId,
      runtimeGeneration: receipt.runtimeGeneration,
      runtimeBuildVersion: receipt.runtimeBuildVersion,
      ...(receipt.runtimeBuildCommit === undefined ? {} : { runtimeBuildCommit: receipt.runtimeBuildCommit }),
      runtimeBuildDirty: receipt.runtimeBuildDirty,
      runtimeProtocolGeneration: receipt.runtimeProtocolGeneration,
      runtimeStartedAt: receipt.runtimeStartedAt,
    });
    if (observed === null && receipt === null && admittedRuntime === undefined && admission === undefined) return undefined;

    const branch = observed?.branchName ?? receipt?.branchName;
    const baseRef = observed?.baseRef ?? receipt?.baseRef;
    const goalId = observed?.goalId ?? receipt?.goalId;
    const writeLeaseGeneration = observed?.writerLeaseGeneration ?? receipt?.writeLeaseGeneration;
    const recordedBaseSha = receipt?.resolvedBaseSha;
    const currentResolvedSha = observed?.baseSha;
    const baseFreshness: WorkspaceAdmissionProjection['base']['freshness'] =
      recordedBaseSha === undefined || currentResolvedSha === undefined
        ? 'unknown'
        : recordedBaseSha === currentResolvedSha ? 'current' : 'stale';
    const status = admission?.status ?? 'RECOVERY_REQUIRED';
    const remediation: WorkspaceAdmissionProjection['admission']['remediation'] =
      status === 'ADMITTED' || status === 'EXPECTED_PROGRESS' ? 'none'
        : status === 'BASE_STALE' ? 'guarded_rebase'
          : status === 'REMOTE_GOAL_BRANCH_DRIFT' ? 'inspect_remote_goal'
            : status === 'WORKSPACE_STATE_CHANGED' ? 'refresh_workspace_admission'
              : status === 'RUNTIME_GENERATION_CHANGED' ? 'refresh_admission'
                : 'recover_workspace';

    return {
      ...(admittedRuntime === undefined ? {} : {
        runtime: {
          source: currentRuntime === undefined ? 'last_admitted' : 'current',
          deploymentId: admittedRuntime.runtimeDeploymentId,
          generation: admittedRuntime.runtimeGeneration,
          buildVersion: admittedRuntime.runtimeBuildVersion,
          ...(admittedRuntime.runtimeBuildCommit === undefined ? {} : { buildCommit: admittedRuntime.runtimeBuildCommit }),
          buildDirty: admittedRuntime.runtimeBuildDirty,
          protocolGeneration: admittedRuntime.runtimeProtocolGeneration,
          startedAt: admittedRuntime.runtimeStartedAt,
        },
      }),
      workspace: {
        id: workspaceId,
        kind: observed?.workspaceKind ?? receipt?.workspaceKind ?? 'unknown',
        ...(branch === undefined ? {} : { branch }),
        ...(receipt?.expectedWorkspaceHead === undefined ? {} : { expectedHead: receipt.expectedWorkspaceHead }),
        ...(observed?.workspaceHead === undefined ? {} : { observedHead: observed.workspaceHead }),
        dirtyState: observed?.dirtyState ?? receipt?.dirtyState ?? 'unknown',
      },
      base: {
        ...(baseRef === undefined ? {} : { ref: baseRef }),
        ...(recordedBaseSha === undefined ? {} : { recordedSha: recordedBaseSha }),
        ...(currentResolvedSha === undefined ? {} : { currentResolvedSha }),
        freshness: baseFreshness,
      },
      ownership: {
        ...(goalId === undefined ? {} : { goalId }),
        ...(writeLeaseGeneration === undefined ? {} : { writeLeaseGeneration }),
      },
      admission: {
        status,
        ...(admission?.admissionGeneration === undefined ? {} : { generation: admission.admissionGeneration }),
        ...(admission?.reason === undefined ? {} : { blocker: admission.reason }),
        remediation,
      },
    };
  }

  private async classifyAdmissionBestEffort(
    workspaceId: string,
    observed: GoalWorkspaceAdmissionObservation | null,
  ): Promise<GoalRuntimeBootstrapResult['admission'] | undefined> {
    if (this.workspaceAdmissionReceipts === undefined) return undefined;
    if (observed === null || observed.dirtyState === 'unknown') {
      return { status: 'RECOVERY_REQUIRED', reason: 'required_workspace_or_lease_proof_missing' };
    }
    if (observed.workspaceKind === 'non_git') {
      return this.classifyNonGitAdmissionBestEffort(workspaceId, observed);
    }
    if (observed.workspaceKind !== 'git' || observed.workspaceHead === undefined || observed.dirtyFingerprint === undefined
      || observed.stagedFingerprint === undefined || observed.repositoryIdentity === undefined
      || observed.gitCommonDirIdentity === undefined || observed.worktreeIdentity === undefined
      || observed.baseRef === undefined || observed.baseSha === undefined || observed.mergeBaseSha === undefined
      || observed.goalId === undefined || observed.projectId === undefined || observed.writerLeaseGeneration === undefined
      || observed.writerLeaseExpiresAt === undefined
      || Date.parse(observed.writerLeaseExpiresAt) <= this.now().getTime()) {
      return { status: 'RECOVERY_REQUIRED', reason: 'required_workspace_or_lease_proof_missing' };
    }
    if (this.runtimeAdmissionIdentity === undefined) {
      return { status: 'RECOVERY_REQUIRED', reason: 'runtime_provenance_missing' };
    }
    if (this.runtimeAdmissionIdentity.runtimeBuildDirty) {
      return { status: 'RECOVERY_REQUIRED', reason: 'runtime_build_provenance_dirty' };
    }
    let receipt: WorkspaceAdmissionReceipt | null;
    try {
      receipt = await this.workspaceAdmissionReceipts.getAdmissionReceipt(workspaceId);
    } catch {
      return { status: 'RECOVERY_REQUIRED', reason: 'admission_receipt_unavailable' };
    }
    if (receipt === null) {
      if (observed.dirtyState !== 'clean') {
        return { status: 'RECOVERY_REQUIRED', reason: 'dirty_workspace_requires_checkpoint_admission' };
      }
      const compareAndSwap = this.workspaceAdmissionReceipts.compareAndSwapAdmissionReceipt;
      if (compareAndSwap === undefined) {
        return { status: 'RECOVERY_REQUIRED', reason: 'admission_receipt_storage_unavailable' };
      }
      const currentRuntime = this.runtimeAdmissionIdentity;
      const now = this.now().toISOString();
      const initialReceipt: WorkspaceAdmissionReceipt = {
        admissionId: createHash('sha256')
          .update([workspaceId, observed.workspaceHead, String(observed.writerLeaseGeneration), currentRuntime.runtimeGeneration, now].join('\0'))
          .digest('hex'),
        projectId: observed.projectId,
        workspaceId,
        goalId: observed.goalId,
        workspaceKind: 'git',
        repositoryIdentity: observed.repositoryIdentity,
        gitCommonDirIdentity: observed.gitCommonDirIdentity,
        worktreeIdentity: observed.worktreeIdentity,
        ...(observed.branchName === undefined ? {} : { branchName: observed.branchName }),
        expectedWorkspaceHead: observed.workspaceHead,
        observedWorkspaceHead: observed.workspaceHead,
        baseRef: observed.baseRef,
        resolvedBaseSha: observed.baseSha,
        ...(observed.remoteGoalSha === undefined ? {} : { remoteGoalSha: observed.remoteGoalSha }),
        mergeBaseSha: observed.mergeBaseSha,
        dirtyState: 'clean',
        dirtyFingerprint: observed.dirtyFingerprint,
        stagedFingerprint: observed.stagedFingerprint,
        ...(observed.checkpointId === undefined ? {} : { checkpointId: observed.checkpointId }),
        writeLeaseGeneration: observed.writerLeaseGeneration,
        ...currentRuntime,
        workflowVersion: INITIAL_ADMISSION_WORKFLOW_VERSION,
        admissionGeneration: 1,
        createdAt: now,
      };
      try {
        const saved = await compareAndSwap(workspaceId, 0, observed.writerLeaseGeneration, initialReceipt);
        if (!saved) return { status: 'RECOVERY_REQUIRED', reason: 'initial_admission_capture_raced' };
      } catch {
        return { status: 'RECOVERY_REQUIRED', reason: 'initial_admission_capture_failed' };
      }
      receipt = initialReceipt;
    }
    if (receipt.invalidatedAt !== undefined || (receipt.expiresAt !== undefined && Date.parse(receipt.expiresAt) <= this.now().getTime())) {
      return { status: 'RECOVERY_REQUIRED', reason: 'admission_receipt_invalid_or_expired', admissionGeneration: receipt.admissionGeneration };
    }
    if (receipt.workspaceId !== workspaceId || receipt.workspaceKind !== observed.workspaceKind
      || receipt.projectId !== observed.projectId || receipt.goalId !== observed.goalId
      || receipt.checkpointId !== observed.checkpointId) {
      return { status: 'WORKSPACE_STATE_CHANGED', reason: 'workspace_or_checkpoint_identity_changed', admissionGeneration: receipt.admissionGeneration };
    }

    const currentRuntime = this.runtimeAdmissionIdentity;
    const currentRuntimeGeneration = currentRuntime === undefined
      ? ''
      : runtimeAdmissionGeneration(currentRuntime);
    const expectedAdmissionObservation = {
      repositoryIdentity: receipt.repositoryIdentity ?? '',
      worktreeIdentity: receipt.worktreeIdentity,
      workspaceHead: receipt.expectedWorkspaceHead,
      dirtyFingerprint: receipt.dirtyFingerprint,
      checkpointRevision: receipt.checkpointRevision ?? 0,
      checkpointHead: receipt.expectedWorkspaceHead,
      baseRef: receipt.baseRef ?? '',
      baseSha: receipt.resolvedBaseSha ?? '',
      mergeBaseSha: receipt.mergeBaseSha ?? '',
      remoteGoalSha: receipt.remoteGoalSha ?? '',
      leaseGeneration: receipt.writeLeaseGeneration,
      runtimeGeneration: runtimeAdmissionGeneration(receipt),
      workflowVersion: receipt.workflowVersion,
    };
    const observedAdmissionObservation = {
      repositoryIdentity: observed.repositoryIdentity,
      worktreeIdentity: observed.worktreeIdentity,
      workspaceHead: observed.workspaceHead,
      dirtyFingerprint: observed.dirtyFingerprint,
      checkpointRevision: receipt.checkpointRevision ?? 0,
      checkpointHead: observed.workspaceHead,
      baseRef: observed.baseRef,
      baseSha: observed.baseSha,
      mergeBaseSha: observed.mergeBaseSha,
      remoteGoalSha: observed.remoteGoalSha ?? '',
      leaseGeneration: observed.writerLeaseGeneration,
      runtimeGeneration: currentRuntimeGeneration,
      workflowVersion: receipt.workflowVersion,
    };
    const decision = classifyWorkspaceAdmission(expectedAdmissionObservation, observedAdmissionObservation);
    if (observed.branchName !== receipt.branchName) {
      return { status: 'WORKSPACE_STATE_CHANGED', reason: 'workspace_branch_changed', admissionGeneration: receipt.admissionGeneration };
    }
    if (observed.dirtyState !== receipt.dirtyState || observed.stagedFingerprint !== receipt.stagedFingerprint) {
      return { status: 'WORKSPACE_STATE_CHANGED', reason: 'workspace_dirty_state_changed', admissionGeneration: receipt.admissionGeneration };
    }
    if (decision.status === 'WORKSPACE_STATE_CHANGED'
      && observed.writerLeaseGeneration !== receipt.writeLeaseGeneration
      && this.workspaceAdmissionReceipts.compareAndSwapAdmissionReceipt !== undefined) {
      const withoutLeaseChange = classifyWorkspaceAdmission(expectedAdmissionObservation, {
        ...observedAdmissionObservation,
        leaseGeneration: receipt.writeLeaseGeneration,
      });
      // A restart may rotate the runtime identity at the same time that the
      // durable goal reacquires its writer lease. Refresh both in one CAS only
      // when all other Git, branch, content and checkpoint proof still matches.
      const runtimeAlsoChanged = withoutLeaseChange.status === 'RUNTIME_GENERATION_CHANGED'
        && currentRuntime !== undefined;
      if (withoutLeaseChange.status === 'ADMITTED' || runtimeAlsoChanged) {
        const now = this.now().toISOString();
        const refreshed: WorkspaceAdmissionReceipt = {
          ...receipt,
          ...(runtimeAlsoChanged && currentRuntime !== undefined ? currentRuntime : {}),
          admissionId: createHash('sha256')
            .update([receipt.admissionId, 'writer-lease', String(observed.writerLeaseGeneration),
              ...(runtimeAlsoChanged && currentRuntime !== undefined ? [currentRuntime.runtimeGeneration] : []),
              now].join('\0'))
            .digest('hex'),
          writeLeaseGeneration: observed.writerLeaseGeneration,
          admissionGeneration: receipt.admissionGeneration + 1,
          createdAt: now,
        };
        try {
          // The repository also checks the exact live writer lease and expiry.
          const saved = await this.workspaceAdmissionReceipts.compareAndSwapAdmissionReceipt(
            workspaceId,
            receipt.admissionGeneration,
            observed.writerLeaseGeneration,
            refreshed,
          );
          return saved
            ? {
              status: 'ADMITTED',
              admissionGeneration: refreshed.admissionGeneration,
              refreshedFromWriterLeaseGeneration: true,
              ...(runtimeAlsoChanged ? { refreshedFromRuntimeGeneration: true } : {}),
            }
            : { status: 'RECOVERY_REQUIRED', reason: 'writer_lease_admission_refresh_raced', admissionGeneration: receipt.admissionGeneration };
        } catch {
          return { status: 'RECOVERY_REQUIRED', reason: 'writer_lease_admission_refresh_failed', admissionGeneration: receipt.admissionGeneration };
        }
      }
    }
    if (decision.status !== 'RUNTIME_GENERATION_CHANGED') {
      return { ...decision, admissionGeneration: receipt.admissionGeneration };
    }
    if (currentRuntime === undefined || this.workspaceAdmissionReceipts.compareAndSwapAdmissionReceipt === undefined) {
      return { ...decision, admissionGeneration: receipt.admissionGeneration };
    }

    const refreshed: WorkspaceAdmissionReceipt = {
      ...receipt,
      admissionId: createHash('sha256').update(`${receipt.admissionId}:${currentRuntime.runtimeGeneration}:${this.now().toISOString()}`).digest('hex'),
      ...currentRuntime,
      admissionGeneration: receipt.admissionGeneration + 1,
      createdAt: this.now().toISOString(),
    };
    try {
      const saved = await this.workspaceAdmissionReceipts.compareAndSwapAdmissionReceipt(
        workspaceId,
        receipt.admissionGeneration,
        observed.writerLeaseGeneration,
        refreshed,
      );
      return saved
        ? { status: 'ADMITTED', admissionGeneration: refreshed.admissionGeneration, refreshedFromRuntimeGeneration: true }
        : { status: 'RECOVERY_REQUIRED', reason: 'admission_refresh_raced', admissionGeneration: receipt.admissionGeneration };
    } catch {
      return { status: 'RECOVERY_REQUIRED', reason: 'admission_refresh_failed', admissionGeneration: receipt.admissionGeneration };
    }
  }

  private async classifyNonGitAdmissionBestEffort(
    workspaceId: string,
    observed: GoalWorkspaceAdmissionObservation,
  ): Promise<GoalRuntimeBootstrapResult['admission']> {
    const receipts = this.workspaceAdmissionReceipts;
    if (observed.sourceSnapshotGeneration === undefined || observed.sourceContentFingerprint === undefined
      || observed.goalId === undefined || observed.projectId === undefined
      || observed.writerLeaseGeneration === undefined || observed.writerLeaseExpiresAt === undefined
      || Date.parse(observed.writerLeaseExpiresAt) <= this.now().getTime()) {
      return { status: 'RECOVERY_REQUIRED', reason: 'non_git_snapshot_or_lease_proof_missing' };
    }
    const runtime = this.runtimeAdmissionIdentity;
    if (runtime === undefined) return { status: 'RECOVERY_REQUIRED', reason: 'runtime_provenance_missing' };
    if (runtime.runtimeBuildDirty) return { status: 'RECOVERY_REQUIRED', reason: 'runtime_build_provenance_dirty' };

    let receipt: WorkspaceAdmissionReceipt | null;
    try {
      receipt = await receipts!.getAdmissionReceipt(workspaceId);
    } catch {
      return { status: 'RECOVERY_REQUIRED', reason: 'admission_receipt_unavailable' };
    }

    if (receipt === null) {
      if (receipts!.compareAndSwapAdmissionReceipt === undefined) {
        return { status: 'RECOVERY_REQUIRED', reason: 'admission_receipt_storage_unavailable' };
      }
      const now = this.now().toISOString();
      const initialReceipt: WorkspaceAdmissionReceipt = {
        admissionId: createHash('sha256')
          .update([workspaceId, observed.sourceSnapshotGeneration, observed.sourceContentFingerprint, String(observed.writerLeaseGeneration), runtime.runtimeGeneration, now].join('\\0'))
          .digest('hex'),
        projectId: observed.projectId,
        workspaceId,
        goalId: observed.goalId,
        workspaceKind: 'non_git',
        worktreeIdentity: observed.sourceSnapshotGeneration,
        expectedWorkspaceHead: observed.sourceSnapshotGeneration,
        observedWorkspaceHead: observed.sourceSnapshotGeneration,
        dirtyState: 'clean',
        dirtyFingerprint: observed.sourceContentFingerprint,
        ...(observed.checkpointId === undefined ? {} : { checkpointId: observed.checkpointId }),
        writeLeaseGeneration: observed.writerLeaseGeneration,
        ...runtime,
        workflowVersion: INITIAL_ADMISSION_WORKFLOW_VERSION,
        admissionGeneration: 1,
        createdAt: now,
      };
      try {
        if (!await receipts!.compareAndSwapAdmissionReceipt(
          workspaceId, 0, observed.writerLeaseGeneration, initialReceipt,
        )) return { status: 'RECOVERY_REQUIRED', reason: 'initial_admission_capture_raced' };
      } catch {
        return { status: 'RECOVERY_REQUIRED', reason: 'initial_admission_capture_failed' };
      }
      return { status: 'ADMITTED', admissionGeneration: initialReceipt.admissionGeneration };
    }

    if (receipt.invalidatedAt !== undefined || (receipt.expiresAt !== undefined && Date.parse(receipt.expiresAt) <= this.now().getTime())) {
      return { status: 'RECOVERY_REQUIRED', reason: 'admission_receipt_invalid_or_expired', admissionGeneration: receipt.admissionGeneration };
    }
    if (receipt.workspaceId !== workspaceId || receipt.workspaceKind !== 'non_git'
      || receipt.projectId !== observed.projectId || receipt.goalId !== observed.goalId
      || receipt.checkpointId !== observed.checkpointId) {
      return { status: 'WORKSPACE_STATE_CHANGED', reason: 'workspace_or_checkpoint_identity_changed', admissionGeneration: receipt.admissionGeneration };
    }
    if (receipt.expectedWorkspaceHead !== observed.sourceSnapshotGeneration
      || receipt.observedWorkspaceHead !== observed.sourceSnapshotGeneration
      || receipt.dirtyFingerprint !== observed.sourceContentFingerprint
      || receipt.writeLeaseGeneration !== observed.writerLeaseGeneration) {
      return { status: 'WORKSPACE_STATE_CHANGED', reason: 'non_git_snapshot_content_or_lease_changed', admissionGeneration: receipt.admissionGeneration };
    }
    if (runtimeAdmissionGeneration(receipt) === runtimeAdmissionGeneration(runtime)) {
      return { status: 'ADMITTED', admissionGeneration: receipt.admissionGeneration };
    }
    if (receipts!.compareAndSwapAdmissionReceipt === undefined) {
      return { status: 'RUNTIME_GENERATION_CHANGED', reason: 'runtime_generation_changed', admissionGeneration: receipt.admissionGeneration };
    }

    const refreshed: WorkspaceAdmissionReceipt = {
      ...receipt,
      admissionId: createHash('sha256').update(`${receipt.admissionId}:${runtime.runtimeGeneration}:${this.now().toISOString()}`).digest('hex'),
      ...runtime,
      admissionGeneration: receipt.admissionGeneration + 1,
      createdAt: this.now().toISOString(),
    };
    try {
      const saved = await receipts!.compareAndSwapAdmissionReceipt(
        workspaceId, receipt.admissionGeneration, observed.writerLeaseGeneration, refreshed,
      );
      return saved
        ? { status: 'ADMITTED', admissionGeneration: refreshed.admissionGeneration, refreshedFromRuntimeGeneration: true }
        : { status: 'RECOVERY_REQUIRED', reason: 'admission_refresh_raced', admissionGeneration: receipt.admissionGeneration };
    } catch {
      return { status: 'RECOVERY_REQUIRED', reason: 'admission_refresh_failed', admissionGeneration: receipt.admissionGeneration };
    }
  }

  private async readWorkspaceAdmissionBestEffort(workspaceId: string): Promise<GoalWorkspaceAdmissionObservation | null> {
    if (this.workspaceAdmission === undefined) return null;
    try {
      return await this.workspaceAdmission.readAdmission(workspaceId);
    } catch {
      return { workspaceId, workspaceKind: 'unknown', dirtyState: 'unknown', detail: 'workspace admission observation failed' };
    }
  }

  private async readWorkspaceTruthBestEffort(
    workspaceId: string,
  ): Promise<GoalWorkspaceTruthObservation | null> {
    if (this.workspaceTruth === undefined) return null;
    try {
      return await this.workspaceTruth.read(workspaceId);
    } catch {
      return { state: 'unavailable', detail: 'workspace truth probe failed' };
    }
  }

  private async refreshWorkspaceTruthUnlocked(
    snapshot: GoalRuntimeSnapshotRecord,
    suppliedObservation?: GoalWorkspaceTruthObservation | null,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const observation = suppliedObservation === undefined
      ? await this.readWorkspaceTruthBestEffort(snapshot.projection.workspaceId)
      : suppliedObservation;
    if (observation === null || observation.state === snapshot.projection.workspaceState) return snapshot;

    const occurredAt = this.now().toISOString();
    try {
      return await this.appendAndReplayUnlocked(snapshot, {
        eventId: workspaceRuntimeEventId(
          snapshot.projection.goalId,
          observation.state,
          snapshot.lastEventSequence,
        ),
        type: 'workspace_observed',
        workspaceId: snapshot.projection.workspaceId,
        goalId: snapshot.projection.goalId,
        workspaceState: observation.state,
        occurredAt,
        ...(observation.detail === undefined ? {} : { detail: observation.detail }),
      });
    } catch {
      // Workspace truth is observational. Failure to project/persist it must not
      // fail an already-admitted mutation or block runtime startup.
      return snapshot;
    }
  }

  private async readIntegrationTruthBestEffort(
    goalId: string,
  ): Promise<GoalWorkspaceIntegrationObservation | null> {
    if (this.workspaceTruth?.readIntegration === undefined) return null;
    try {
      return await this.workspaceTruth.readIntegration(goalId);
    } catch {
      return { state: 'unknown', detail: 'Goal Workspace integration metadata could not be read' };
    }
  }

  private async refreshIntegrationTruthUnlocked(
    snapshot: GoalRuntimeSnapshotRecord,
    suppliedObservation?: GoalWorkspaceIntegrationObservation | null,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const observation = suppliedObservation === undefined
      ? await this.readIntegrationTruthBestEffort(snapshot.projection.goalId)
      : suppliedObservation;
    if (observation === null || observation.state === snapshot.projection.integrationState) return snapshot;

    const occurredAt = this.now().toISOString();
    try {
      return await this.appendAndReplayUnlocked(snapshot, {
        eventId: integrationRuntimeEventId(
          snapshot.projection.goalId,
          observation.state,
          snapshot.lastEventSequence,
        ),
        type: 'integration_observed',
        workspaceId: snapshot.projection.workspaceId,
        goalId: snapshot.projection.goalId,
        integrationState: observation.state,
        occurredAt,
        ...(observation.detail === undefined ? {} : { detail: observation.detail }),
      });
    } catch {
      // Integration truth is observational and parent-owned by the Goal
      // Workspace service. Projection failure must not invent a replacement
      // state or block runtime startup.
      return snapshot;
    }
  }

  private async reconcileDurableBlockerTruthUnlocked(
    initial: GoalRuntimeSnapshotRecord,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const goal = await this.goals.getById(initial.projection.goalId);
    if (goal === null) {
      throw new GoalRuntimeControlPlaneError('goal_not_found', `Goal '${initial.projection.goalId}' was not found`);
    }
    if (goal.status !== 'active') return initial;

    const detail = durableGoalBlockerDetail(goal);
    const currentBlocker = initial.projection.blocker;
    if (detail === undefined) {
      if (currentBlocker?.kind !== 'goal_blocked') return initial;
    } else {
      if (currentBlocker !== undefined && currentBlocker.kind !== 'goal_blocked') return initial;
      if (currentBlocker?.kind === 'goal_blocked' && currentBlocker.detail === detail) return initial;
    }

    const occurredAt = this.now().toISOString();
    return this.appendAndReplayUnlocked(initial, {
      eventId: durableGoalBlockerRuntimeEventId(
        goal.id,
        goal.revision,
        detail === undefined ? 'clear' : 'blocked',
        initial.lastEventSequence,
      ),
      type: 'goal_blocker_observed',
      workspaceId: goal.workspaceId,
      goalId: goal.id,
      occurredAt,
      ...(detail === undefined ? {} : { blockerKind: 'goal_blocked', detail }),
    });
  }
  private async ensureGoalSnapshotUnlocked(goalId: string): Promise<GoalRuntimeSnapshotRecord> {
    const existing = await this.snapshots.getGoalRuntimeSnapshot(goalId);
    if (existing !== null) return existing;

    const goal = await this.goals.getById(goalId);
    if (goal === null) {
      throw new GoalRuntimeControlPlaneError('goal_not_found', `Goal '${goalId}' was not found`);
    }

    // If events predate snapshot materialization (or a crash occurred between
    // durable Goal mutation and projection), compact from the durable aggregate
    // at the latest known Goal-event cursor. Unknown integration/workspace facts
    // stay unknown rather than being guessed.
    const newest = await this.events.listGoalRuntimeEvents({ goalId, limit: 1 });
    const lastEventSequence = newest[0]?.sequence ?? 0;
    return this.snapshots.storeGoalRuntimeSnapshot({
      projection: projectionFromDurableGoal(goal),
      lastEventSequence,
      updatedAt: goal.updatedAt,
    });
  }

  private async reconcileDurableTerminalStateUnlocked(
    initial: GoalRuntimeSnapshotRecord,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const goal = await this.goals.getById(initial.projection.goalId);
    if (goal === null) {
      throw new GoalRuntimeControlPlaneError('goal_not_found', `Goal '${initial.projection.goalId}' was not found`);
    }
    if (goal.status === 'active') return initial;

    let snapshot = initial;
    const occurredAt = goal.terminalAt ?? goal.updatedAt;
    const executionId = snapshot.projection.activeExecutionId;
    const executionGeneration = snapshot.projection.executionGeneration;
    const discriminator = `durable-terminal:${goal.revision}`;

    if (executionId !== undefined && executionGeneration !== undefined) {
      if (goal.status === 'cancelled') {
        snapshot = await this.appendAndReplayUnlocked(snapshot, {
          eventId: durableRuntimeEventId(goal.id, 'execution_cancelled', discriminator),
          type: 'execution_cancelled',
          workspaceId: goal.workspaceId,
          goalId: goal.id,
          executionId,
          executionGeneration,
          occurredAt,
          detail: 'restart reconciliation from durable cancelled Goal',
        });
      } else if (goal.status === 'completed') {
        if (snapshot.projection.runtimeState === 'queued' || snapshot.projection.runtimeState === 'starting') {
          snapshot = await this.appendAndReplayUnlocked(snapshot, {
            eventId: durableRuntimeEventId(goal.id, 'execution_started', `${discriminator}:finish`),
            type: 'execution_started',
            workspaceId: goal.workspaceId,
            goalId: goal.id,
            executionId,
            executionGeneration,
            occurredAt,
            detail: 'restart reconciliation for durably completed Goal',
          });
        }
        snapshot = await this.appendAndReplayUnlocked(snapshot, {
          eventId: durableRuntimeEventId(goal.id, 'execution_completed', discriminator),
          type: 'execution_completed',
          workspaceId: goal.workspaceId,
          goalId: goal.id,
          executionId,
          executionGeneration,
          occurredAt,
          detail: 'restart reconciliation from durable completed Goal',
        });
      } else {
        snapshot = await this.appendAndReplayUnlocked(snapshot, {
          eventId: durableRuntimeEventId(goal.id, 'execution_failed', discriminator),
          type: 'execution_failed',
          workspaceId: goal.workspaceId,
          goalId: goal.id,
          executionId,
          executionGeneration,
          occurredAt,
          detail: `restart reconciliation from durable ${goal.status} Goal`,
        });
      }
    }

    const lifecycleType = goal.status === 'cancelled' ? 'goal_abandoned' : 'goal_completed';
    const lifecycleTarget = lifecycleType === 'goal_abandoned' ? 'abandoned' : 'completed';
    if (snapshot.projection.lifecycleState !== lifecycleTarget) {
      snapshot = await this.appendAndReplayUnlocked(snapshot, {
        eventId: durableRuntimeEventId(goal.id, lifecycleType, discriminator),
        type: lifecycleType,
        workspaceId: goal.workspaceId,
        goalId: goal.id,
        occurredAt,
        detail: `restart reconciliation from durable ${goal.status} Goal`,
      });
    }
    return snapshot;
  }

  private async appendAndReplayUnlocked(
    snapshot: GoalRuntimeSnapshotRecord,
    event: GoalRuntimeEvent,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const preview = projectGoalRuntimeEvent(snapshot.projection, event);
    if (preview.decision.disposition === 'reject') {
      throw new GoalRuntimeControlPlaneError(
        'projection_rejected',
        `Goal runtime event '${event.type}' was rejected: ${preview.decision.reason}`,
      );
    }

    const appended = await this.events.appendGoalRuntimeEvent({
      event,
      recordedAt: new Date().toISOString(),
    });
    if (appended.record.sequence <= snapshot.lastEventSequence) return snapshot;

    // Replay from the snapshot cursor instead of blindly storing the preview.
    // This preserves event order if another authoritative producer appended
    // a same-Goal event between our preflight and durable append.
    return this.catchUpSnapshotUnlocked(snapshot);
  }

  private async catchUpSnapshotUnlocked(
    initial: GoalRuntimeSnapshotRecord,
  ): Promise<GoalRuntimeSnapshotRecord> {
    // Sequence zero means this Goal has no compacted event cursor yet. Workspace
    // sequence numbers are global, so an unrelated workspace retention gap must
    // not make a brand-new Goal look stale. Replay its own retained events first.
    if (initial.lastEventSequence === 0) {
      const own = await this.events.listGoalRuntimeEvents({
        goalId: initial.projection.goalId,
        limit: EVENT_REPLAY_PAGE_SIZE,
      });
      if (own.length === 0) return initial;
      if (own.length === EVENT_REPLAY_PAGE_SIZE) {
        throw new GoalRuntimeControlPlaneError(
          'replay_window_missed',
          'Goal runtime event history exceeds the zero-cursor replay window',
        );
      }
      let projection = initial.projection;
      let lastEventSequence = 0;
      let updatedAt = initial.updatedAt;
      for (const record of [...own].reverse()) {
        const projected = projectGoalRuntimeEvent(projection, record.event);
        if (projected.decision.disposition === 'reject') {
          throw new GoalRuntimeControlPlaneError(
            'projection_rejected',
            `Durable Goal runtime event ${record.sequence} was rejected: ${projected.decision.reason}`,
          );
        }
        projection = projected.projection;
        lastEventSequence = record.sequence;
        updatedAt = record.recordedAt;
      }
      return this.snapshots.storeGoalRuntimeSnapshot({
        projection,
        lastEventSequence,
        updatedAt,
      });
    }

    let snapshot = initial;
    let scanCursor = initial.lastEventSequence;

    for (;;) {
      const page = await this.events.replayWorkspaceGoalRuntimeEvents({
        workspaceId: snapshot.projection.workspaceId,
        afterSequence: scanCursor,
        limit: EVENT_REPLAY_PAGE_SIZE,
      });
      if (page.replayWindowMissed) {
        return this.recoverAfterReplayWindowMissUnlocked(snapshot);
      }
      if (page.events.length === 0) return snapshot;

      let projection = snapshot.projection;
      let lastGoalSequence = snapshot.lastEventSequence;
      for (const record of page.events) {
        if (record.event.goalId !== projection.goalId) continue;
        const projected = projectGoalRuntimeEvent(projection, record.event);
        if (projected.decision.disposition === 'reject') {
          throw new GoalRuntimeControlPlaneError(
            'projection_rejected',
            `Durable Goal runtime event ${record.sequence} was rejected: ${projected.decision.reason}`,
          );
        }
        projection = projected.projection;
        lastGoalSequence = record.sequence;
      }

      if (lastGoalSequence > snapshot.lastEventSequence) {
        snapshot = await this.snapshots.storeGoalRuntimeSnapshot({
          projection,
          lastEventSequence: lastGoalSequence,
          updatedAt: page.events.at(-1)!.recordedAt,
        });
      }

      scanCursor = page.events.at(-1)!.sequence;
      if (page.latestSequence === undefined || scanCursor >= page.latestSequence) return snapshot;
    }
  }

  private async recoverAfterReplayWindowMissUnlocked(
    initial: GoalRuntimeSnapshotRecord,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const retained = await this.events.listGoalRuntimeEvents({
      goalId: initial.projection.goalId,
      limit: EVENT_REPLAY_PAGE_SIZE,
    });
    const newer = retained.filter((record) => record.sequence > initial.lastEventSequence);

    // Workspace retention is shared across Goals while snapshot cursors are
    // Goal-local. If only unrelated events were pruned, this Goal has not
    // missed any projection input and its existing snapshot remains valid.
    if (newer.length === 0) return initial;

    const goal = await this.goals.getById(initial.projection.goalId);
    if (goal === null) {
      throw new GoalRuntimeControlPlaneError(
        'goal_not_found',
        `Goal '${initial.projection.goalId}' was not found`,
      );
    }

    // A genuine gap means incremental replay is no longer safe. Rebuild from
    // durable Goal truth, then fold the bounded retained tail. Rejected tail
    // events may depend on pruned predecessors, so compact past them rather
    // than turning unrelated workspace retention into a startup failure.
    let projection = projectionFromDurableGoal(goal);
    for (const record of [...retained].reverse()) {
      const projected = projectGoalRuntimeEvent(projection, record.event);
      if (projected.decision.disposition === 'reject') continue;
      projection = projected.projection;
    }

    const latest = retained[0]!;
    return this.snapshots.storeGoalRuntimeSnapshot({
      projection,
      lastEventSequence: latest.sequence,
      updatedAt: latest.recordedAt,
    });
  }

  private async withGoalLock<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.goalChains.get(goalId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.catch(() => undefined).then(() => gate);
    this.goalChains.set(goalId, chain);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.goalChains.get(goalId) === chain) this.goalChains.delete(goalId);
    }
  }
}

function runtimeAdmissionGeneration(identity: Pick<WorkspaceAdmissionReceipt,
  'runtimeDeploymentId' | 'runtimeGeneration' | 'runtimeBuildVersion' | 'runtimeBuildCommit'
  | 'runtimeBuildDirty' | 'runtimeProtocolGeneration'> | WorkspaceAdmissionReceipt): string {
  return [
    identity.runtimeDeploymentId,
    identity.runtimeGeneration,
    identity.runtimeBuildVersion,
    identity.runtimeBuildCommit ?? '',
    String(identity.runtimeBuildDirty),
    String(identity.runtimeProtocolGeneration),
  ].join(':');
}

function projectionFromDurableGoal(goal: GoalRecord): GoalRuntimeProjection {
  const exactExecutionId = goal.status === 'active'
    && goal.executionId !== undefined
    && goal.executionGeneration !== undefined
    && goal.executionGeneration === goal.leaseGeneration
      ? goal.executionId
      : undefined;
  const hasExactExecution = exactExecutionId !== undefined;

  const base = {
    contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
    goalId: goal.id,
    workspaceId: goal.workspaceId,
    integrationState: 'unknown',
    workspaceState: 'unknown',
    lastActivityAt: goal.updatedAt,
    ...(goal.executionGeneration === undefined ? {} : { executionGeneration: goal.executionGeneration }),
  } as const;

  switch (goal.status) {
    case 'active':
      return {
        ...base,
        lifecycleState: 'open',
        runtimeState: hasExactExecution ? 'queued' : 'idle',
        desiredRuntimeState: hasExactExecution ? 'running' : 'idle',
        ...(exactExecutionId === undefined ? {} : { activeExecutionId: exactExecutionId }),
      };
    case 'completed':
      return {
        ...base,
        lifecycleState: 'completed',
        runtimeState: 'idle',
        desiredRuntimeState: 'idle',
      };
    case 'failed':
      return {
        ...base,
        lifecycleState: 'completed',
        runtimeState: 'failed',
        desiredRuntimeState: 'idle',
      };
    case 'blocked':
      return {
        ...base,
        lifecycleState: 'completed',
        runtimeState: 'failed',
        desiredRuntimeState: 'idle',
        blocker: {
          kind: 'unknown',
          detail: 'legacy terminal Goal status is blocked',
          observedAt: goal.updatedAt,
        },
      };
    case 'cancelled':
      return {
        ...base,
        lifecycleState: 'abandoned',
        runtimeState: 'cancelled',
        desiredRuntimeState: 'cancelled',
      };
  }
}

function durableGoalBlockerDetail(goal: GoalRecord): string | undefined {
  const blockers = goal.blockers.map((value) => value.trim()).filter((value) => value.length > 0);
  if (blockers.length === 0) return undefined;

  const prefix = `Durable Goal blockers at revision ${goal.revision}: `;
  const joined = blockers.join(' • ');
  if (prefix.length + joined.length <= MAX_DURABLE_GOAL_BLOCKER_DETAIL) return `${prefix}${joined}`;

  const available = Math.max(0, MAX_DURABLE_GOAL_BLOCKER_DETAIL - prefix.length - 1);
  return `${prefix}${joined.slice(0, available).trimEnd()}…`;
}

function durableGoalBlockerRuntimeEventId(
  goalId: string,
  goalRevision: number,
  state: 'blocked' | 'clear',
  snapshotSequence: number,
): string {
  const digest = createHash('sha256')
    .update([goalId, 'goal_blocker_observed', String(goalRevision), state, String(snapshotSequence)].join('\0'))
    .digest('hex');
  return `goal-runtime-blocker-${digest}`;
}
function durableRuntimeEventId(goalId: string, type: GoalRuntimeEvent['type'], discriminator: string): string {
  const digest = createHash('sha256')
    .update([goalId, type, discriminator].join('\0'))
    .digest('hex');
  return `goal-runtime-reconcile-${digest}`;
}

function integrationRuntimeEventId(
  goalId: string,
  state: GoalWorkspaceIntegrationObservation['state'],
  snapshotSequence: number,
): string {
  const digest = createHash('sha256')
    .update([goalId, 'integration_observed', state, String(snapshotSequence)].join('\0'))
    .digest('hex');
  return `goal-runtime-integration-${digest}`;
}

function workspaceRuntimeEventId(
  goalId: string,
  state: GoalWorkspaceTruthObservation['state'],
  snapshotSequence: number,
): string {
  const digest = createHash('sha256')
    .update([goalId, 'workspace_observed', state, String(snapshotSequence)].join('\0'))
    .digest('hex');
  return `goal-runtime-workspace-${digest}`;
}
