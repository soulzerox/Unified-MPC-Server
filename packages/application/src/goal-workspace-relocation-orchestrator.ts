import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type GoalRecord, type Result, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import { decideGoalWorkspaceRelocation } from '@unified-mpc/domain';
import type { GitWorkspaceSnapshot } from '@unified-mpc/git';
import type { Workspace } from '@unified-mpc/workspace';
import {
  verifyRetainedGoalWorkspaceBundle,
  type GoalWorkspaceRetentionManifest,
  type VerifyRetainedGoalWorkspaceBundleRequest,
} from './goal-workspace-retention-service.js';
import type { GoalRuntimeAdmissionIdentity } from './goal-runtime-control-plane-service.js';

/**
 * First-party adapter only. This must be a host-level exclusive operation
 * fence that ALSO verifies the actor's session and explicit owner approval.
 * It may never be implemented by trusting a boolean passed through MCP args.
 */
export interface GoalRelocationHostFence {
  withAuthorizedOwner<T>(
    identity: { goalId: string; operationId: string; clientId: string; sessionId: string },
    run: () => Promise<T>,
  ): Promise<T>;
}

/** Only server-owned runtime session data may populate the request. */
export interface GoalRelocationRuntimeRequest {
  readonly goalId: string;
  readonly operationId: string;
  readonly oldWorkspaceId: string;
  readonly newWorkspaceId: string;
  readonly actor: { readonly clientId: string; readonly sessionId: string };
  readonly leaseToken: string;
}

export interface GoalRelocationSourceCheckpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly head: string;
  readonly revision: number;
}

/** Pin is persisted separately from the retention bundle by a trusted store. */
export interface GoalRelocationCustodyPin extends VerifyRetainedGoalWorkspaceBundleRequest {
  readonly operationId: string;
}

export interface GoalRelocationTransferPort {
  prepare(request: {
    operationId: string; goalId: string; goalKey: string; fromWorkspaceId: string;
    toWorkspaceId: string; expectedRevision: number; expectedAdmissionGeneration: number;
    leaseGeneration: number; leaseTokenHash: string; ownerClientId: string; ownerSessionId: string;
    expectedOldHead: string; expectedOldBranch: string; retainedManifestSha256: string; now: string;
  }): Promise<boolean>;
  commit(request: {
    operationId: string; goalId: string; leaseTokenHash: string;
    retainedManifestSha256: string; admissionReceipt: WorkspaceAdmissionReceipt; now: string;
  }): Promise<boolean>;
}

export interface GoalRelocationOrchestratorPorts {
  readonly host: GoalRelocationHostFence;
  readonly goals: { getById(goalId: string): Promise<GoalRecord | null> };
  readonly workspaces: {
    get(workspaceId: string): Promise<Workspace | null>;
    getAdmissionReceipt(workspaceId: string): Promise<WorkspaceAdmissionReceipt | null>;
  };
  readonly git: { observeWorkspace(rootPath: string): Promise<Result<GitWorkspaceSnapshot>> };
  readonly custody: { readPinned(operationId: string): Promise<GoalRelocationCustodyPin | null> };
  readonly checkpoints: { readForSource(workspaceId: string): Promise<GoalRelocationSourceCheckpoint | null> };
  readonly transfer: GoalRelocationTransferPort;
  readonly runtimeIdentity: GoalRuntimeAdmissionIdentity;
  readonly now?: () => Date;
}

export interface GoalRelocationOrchestratorResult {
  readonly status: 'storage_committed_runtime_admission_required';
  readonly goalId: string;
  readonly workspaceId: string;
  readonly manifestSha256: string;
}

/** Return true ONLY for mixed tracked-unstaged + untracked files, in manifest path order. */
function exactDirtyManifest(
  snapshot: GitWorkspaceSnapshot,
  retained: GoalWorkspaceRetentionManifest,
): boolean {
  if (snapshot.statusEntries.length !== retained.entries.length || snapshot.statusEntries.length < 2) return false;
  const expected = [...retained.entries].sort((a, b) => a.path.localeCompare(b.path));
  const actual = [...snapshot.statusEntries].sort((a, b) => a.path.localeCompare(b.path));
  return actual.every((entry, index) => {
    const recorded = expected[index];
    return recorded !== undefined && entry.path === recorded.path
      && ((recorded.kind === 'tracked' && entry.kind === 'modified'
          && entry.indexStatus === ' ' && entry.worktreeStatus === 'M')
        || (recorded.kind === 'untracked' && entry.kind === 'untracked'
          && entry.indexStatus === '?' && entry.worktreeStatus === '?'));
  });
}

async function matchesDirtySourceBytes(sourceRoot: string, manifest: GoalWorkspaceRetentionManifest): Promise<boolean> {
  try {
    const root = await realpath(sourceRoot);
    if (root !== path.resolve(sourceRoot)) return false;
    let bytes = 0;
    for (const entry of manifest.entries) {
      const full = path.join(root, entry.path);
      const info = await lstat(full);
      if (!info.isFile() || info.size !== entry.bytes || entry.bytes > 64 * 1024 * 1024
        || (info.mode & 0o777) !== entry.mode || await realpath(full) !== full) return false;
      bytes += info.size;
      if (bytes > 64 * 1024 * 1024) return false;
      const descriptor = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await descriptor.stat();
        if (!current.isFile() || current.size !== entry.bytes) return false;
        const content = await descriptor.readFile();
        const finalStat = await descriptor.stat();
        if (finalStat.mtimeMs !== current.mtimeMs || finalStat.size !== current.size
          || createHash('sha256').update(content).digest('hex') !== entry.sha256) return false;
      } finally {
        await descriptor.close();
      }
    }
    return true;
  } catch {
    return false;
  }
}

function matchingSnapshot(original: GitWorkspaceSnapshot, latest: GitWorkspaceSnapshot): boolean {
  return original.repositoryIdentity === latest.repositoryIdentity
    && original.gitCommonDirIdentity === latest.gitCommonDirIdentity
    && original.worktreeIdentity === latest.worktreeIdentity
    && original.head === latest.head && original.branch === latest.branch
    && original.dirtyFingerprint === latest.dirtyFingerprint
    && original.stagedFingerprint === latest.stagedFingerprint
    && JSON.stringify(original.statusEntries) === JSON.stringify(latest.statusEntries);
}

/**
 * Performs guarded runtime preflight + verified storage CAS. Never creates a
 * worktree, deletes foreign changes, bypasses Host Approval or declares
 * writer admission. The external runtime must rebind its writer surface and
 * obtain a FRESH live ADMITTED observation after this returns.
 */
export class GoalWorkspaceRelocationOrchestrator {
  private readonly now: () => Date;

  public constructor(private readonly ports: GoalRelocationOrchestratorPorts) {
    this.now = ports.now ?? ((): Date => new Date());
  }

  public async transfer(request: GoalRelocationRuntimeRequest): Promise<Result<GoalRelocationOrchestratorResult>> {
    if (!request.goalId || !request.operationId || !request.oldWorkspaceId || !request.newWorkspaceId
      || request.oldWorkspaceId === request.newWorkspaceId || !request.actor.clientId
      || !request.actor.sessionId || !request.leaseToken) {
      return err(appError('INVALID_INPUT', 'Goal relocation requires an authenticated session and exact Goal/Workspace identity'));
    }
    try {
      return await this.ports.host.withAuthorizedOwner({
        goalId: request.goalId, operationId: request.operationId,
        clientId: request.actor.clientId, sessionId: request.actor.sessionId,
      }, async (): Promise<Result<GoalRelocationOrchestratorResult>> => this.transferWithinHostFence(request));
    } catch {
      return err(appError('CONFLICT', 'Goal relocation Host Approval/fence is not currently established', true));
    }
  }

  private async transferWithinHostFence(request: GoalRelocationRuntimeRequest): Promise<Result<GoalRelocationOrchestratorResult>> {
    const tokenHash = createHash('sha256').update(request.leaseToken).digest('hex');
    const { goals, workspaces, git, custody, checkpoints, transfer, runtimeIdentity } = this.ports;
    const now = this.now().toISOString();
    const [goal, old, next, pin] = await Promise.all([
      goals.getById(request.goalId), workspaces.get(request.oldWorkspaceId),
      workspaces.get(request.newWorkspaceId), custody.readPinned(request.operationId),
    ]);
    if (goal === null || goal.status !== 'active' || goal.workspaceId !== request.oldWorkspaceId
      || goal.ownerClientId !== request.actor.clientId || goal.leaseOwnerClientId !== request.actor.clientId
      || goal.leaseOwnerSessionId !== request.actor.sessionId
      || goal.leaseTokenHash !== tokenHash || goal.leaseExpiresAt === undefined
      || goal.leaseExpiresAt <= now || goal.leaseGeneration < 1
      || old === null || old.lifecycleKind !== 'goal' || old.goalId !== goal.id
      || old.parentWorkspaceId === undefined || old.branchName === undefined
      || old.writerLease?.generation !== goal.leaseGeneration
      || old.writerLease.expiresAt <= now || old.writerLease.ownerId !== request.actor.clientId + ':' + request.actor.sessionId
      || next === null || next.lifecycleKind !== 'temporary'
      || next.parentWorkspaceId !== old.parentWorkspaceId
      || next.ownerSessionId !== request.actor.sessionId || next.goalId !== undefined
      || next.writerLease !== undefined || next.realRootPath === old.realRootPath
      || pin === null || pin.operationId !== request.operationId || pin.expectedGoalId !== goal.id
      || pin.expectedWorkspaceId !== old.id || pin.expectedBranch !== old.branchName
      || runtimeIdentity.runtimeBuildDirty) {
      return err(appError('CONFLICT', 'Goal owner/lease, replacement registry, custody or runtime identity is stale', true));
    }
    const prior = await workspaces.getAdmissionReceipt(old.id);
    const checkpoint = await checkpoints.readForSource(next.id);
    if (prior === null || prior.invalidatedAt !== undefined || prior.goalId !== goal.id
      || prior.workspaceId !== old.id || prior.writeLeaseGeneration > goal.leaseGeneration
      || prior.branchName !== old.branchName
      || checkpoint === null || checkpoint.workspaceId !== next.id
      || checkpoint.revision < 1 || !/^[0-9a-f]{40,64}$/.test(checkpoint.head)) {
      return err(appError('CONFLICT', 'Goal admission receipt or replacement source checkpoint is missing', true));
    }

    const retained = await verifyRetainedGoalWorkspaceBundle(pin);
    if (!retained.ok) return retained;
    const first = await Promise.all([git.observeWorkspace(old.realRootPath), git.observeWorkspace(next.realRootPath)]);
    const oldSnap = first[0];
    const newSnap = first[1];
    if (!oldSnap.ok) return oldSnap;
    if (!newSnap.ok) return newSnap;
    const observed = oldSnap.value;
    const replacement = newSnap.value;
    if (observed.head !== prior.expectedWorkspaceHead || observed.head !== prior.observedWorkspaceHead
      || observed.head !== retained.value.head || observed.branch !== old.branchName
      || observed.repositoryIdentity !== prior.repositoryIdentity
      || observed.gitCommonDirIdentity !== prior.gitCommonDirIdentity
      || observed.worktreeIdentity !== prior.worktreeIdentity
      || replacement.head !== checkpoint.head || replacement.branch === null
      || replacement.branch === observed.branch
      || replacement.repositoryIdentity !== observed.repositoryIdentity
      || replacement.gitCommonDirIdentity !== observed.gitCommonDirIdentity
      || replacement.worktreeIdentity === observed.worktreeIdentity
      || replacement.statusEntries.length !== 0 || !exactDirtyManifest(observed, retained.value)
      || !(await matchesDirtySourceBytes(old.realRootPath, retained.value))) {
      return err(appError('CONFLICT', 'Original/clean replacement Git truth no longer agrees with retained bytes', true));
    }

    const decision = decideGoalWorkspaceRelocation({
      goalId: goal.id, workspaceGoalId: old.goalId!, workspaceId: old.id,
      expectedWorkspaceId: goal.workspaceId,
      expectedRepositoryIdentity: prior.repositoryIdentity!,
      observedRepositoryIdentity: observed.repositoryIdentity,
      expectedHead: prior.expectedWorkspaceHead, observedHead: observed.head,
      expectedBranchName: old.branchName, observedBranchName: observed.branch,
      expectedLeaseGeneration: goal.leaseGeneration, observedLeaseGeneration: old.writerLease.generation,
      leaseExpiresAt: old.writerLease.expiresAt, now,
      expectedAdmissionGeneration: prior.admissionGeneration,
      observedAdmissionGeneration: prior.admissionGeneration,
      observedChanges: retained.value.entries.map((entry) => ({ path: entry.path, kind: entry.kind, contentSha256: entry.sha256 })),
      retainedChanges: retained.value.entries.map((entry) => ({ path: entry.path, kind: entry.kind, contentSha256: entry.sha256 })),
      retentionReceiptVerified: true, originalWorkspaceRetained: true, ownerApprovedRelocation: true,
      replacement: {
        workspaceId: next.id, sameProject: true, sameRepository: true, clean: true,
        exclusive: true, goalBranchReserved: true,
      },
    });
    if (decision.status !== 'RELOCATION_ELIGIBLE') {
      return err(appError('CONFLICT', 'Goal relocation preflight failed: ' + decision.reason, true));
    }

    const prepared = await transfer.prepare({
      operationId: request.operationId, goalId: goal.id, goalKey: goal.goalKey,
      fromWorkspaceId: old.id, toWorkspaceId: next.id,
      expectedRevision: goal.revision, expectedAdmissionGeneration: prior.admissionGeneration,
      leaseGeneration: goal.leaseGeneration, leaseTokenHash: tokenHash,
      ownerClientId: request.actor.clientId, ownerSessionId: request.actor.sessionId,
      expectedOldHead: observed.head, expectedOldBranch: old.branchName,
      retainedManifestSha256: retained.value.manifestSha256, now,
    });
    if (!prepared) return err(appError('CONFLICT', 'Durable Goal relocation preparation lost CAS ownership', true));

    const [afterOld, afterNew, afterGoal, afterPin] = await Promise.all([
      git.observeWorkspace(old.realRootPath), git.observeWorkspace(next.realRootPath),
      goals.getById(goal.id), verifyRetainedGoalWorkspaceBundle(pin),
    ]);
    if (!afterOld.ok) return afterOld;
    if (!afterNew.ok) return afterNew;
    if (!afterPin.ok) return afterPin;
    if (!matchingSnapshot(observed, afterOld.value)
      || !matchingSnapshot(replacement, afterNew.value)
      || !(await matchesDirtySourceBytes(old.realRootPath, retained.value))
      || afterGoal === null || afterGoal.revision !== goal.revision
      || afterGoal.workspaceId !== old.id || afterGoal.leaseGeneration !== goal.leaseGeneration
      || afterGoal.leaseTokenHash !== tokenHash || afterGoal.leaseExpiresAt === undefined
      || afterGoal.leaseExpiresAt <= this.now().toISOString()) {
      return err(appError('CONFLICT', 'Goal or source changed after durable preparation; retain intent for explicit reconciliation', true));
    }

    const receipt: WorkspaceAdmissionReceipt = {
      admissionId: randomUUID(), projectId: old.parentWorkspaceId,
      workspaceId: next.id, goalId: goal.id, workspaceKind: 'git',
      repositoryIdentity: replacement.repositoryIdentity,
      gitCommonDirIdentity: replacement.gitCommonDirIdentity,
      worktreeIdentity: replacement.worktreeIdentity, branchName: replacement.branch!,
      expectedWorkspaceHead: checkpoint.head, observedWorkspaceHead: replacement.head,
      ...(replacement.baseRef === undefined ? {} : { baseRef: replacement.baseRef }),
      ...(replacement.baseSha === undefined ? {} : { resolvedBaseSha: replacement.baseSha }),
      ...(replacement.mergeBaseSha === undefined ? {} : { mergeBaseSha: replacement.mergeBaseSha }),
      dirtyState: 'clean', dirtyFingerprint: replacement.dirtyFingerprint,
      stagedFingerprint: replacement.stagedFingerprint,
      checkpointId: checkpoint.id, checkpointRevision: checkpoint.revision,
      writeLeaseGeneration: goal.leaseGeneration, ...runtimeIdentity,
      workflowVersion: 1, admissionGeneration: 1, createdAt: now,
    };
    const committed = await transfer.commit({
      operationId: request.operationId, goalId: goal.id, leaseTokenHash: tokenHash,
      retainedManifestSha256: retained.value.manifestSha256, admissionReceipt: receipt, now,
    });
    if (!committed) return err(appError('CONFLICT', 'Goal relocation commit failed compare-and-swap', true));
    const [actualGoal, newWorkspace, newReceipt] = await Promise.all([
      goals.getById(goal.id), workspaces.get(next.id), workspaces.getAdmissionReceipt(next.id),
    ]);
    if (actualGoal?.workspaceId !== next.id || newWorkspace?.goalId !== goal.id
      || newWorkspace.lifecycleKind !== 'goal' || newReceipt?.admissionId !== receipt.admissionId
      || newReceipt.invalidatedAt !== undefined) {
      return err(appError('CONFLICT', 'Goal relocated in storage but runtime read-back is inconsistent; explicit reconciliation required', true));
    }
    return ok({
      status: 'storage_committed_runtime_admission_required',
      goalId: goal.id, workspaceId: next.id, manifestSha256: retained.value.manifestSha256,
    });
  }
}
