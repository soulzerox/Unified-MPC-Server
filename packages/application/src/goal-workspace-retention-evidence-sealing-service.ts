import { createHash } from 'node:crypto';
import path from 'node:path';
import { appError, err, ok, type GoalRecord, type Result, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { GitWorkspaceSnapshot } from '@unified-mpc/git';
import type { Workspace } from '@unified-mpc/workspace';
import {
  sealMixedDirtyGoalWorkspace,
  verifyRetainedGoalWorkspaceBundle,
  type GoalWorkspaceRetentionGitPort,
} from './goal-workspace-retention-service.js';
import {
  exactDirtyManifest,
  verifyGoalWorkspaceDirtySourceBytes,
  type GoalRelocationHostFence,
} from './goal-workspace-relocation-orchestrator.js';
import type { GoalCustodyAuthenticatedRequest, GoalCustodyTrustedEvidence } from './goal-workspace-custody-attestation-service.js';

/** Only a real host runtime constructs these ports. The caller supplies NO filesystem path. */
export interface GoalRetentionEvidenceSealingPorts {
  readonly host: GoalRelocationHostFence;
  readonly goals: { getById(goalId: string): Promise<GoalRecord | null> };
  readonly workspaces: {
    get(id: string): Promise<Workspace | null>;
    getAdmissionReceipt(id: string): Promise<WorkspaceAdmissionReceipt | null>;
  };
  readonly git: {
    observeWorkspace(rootPath: string): Promise<Result<GitWorkspaceSnapshot>>;
    seal: GoalWorkspaceRetentionGitPort;
  };
  readonly evidence: {
    recordSealed(request: GoalCustodyTrustedEvidence & {
      ownerClientId: string;
      ownerSessionId: string;
      expectedRevision: number;
      expectedAdmissionGeneration: number;
      leaseGeneration: number;
      leaseTokenHash: string;
      now: string;
    }): Promise<boolean>;
    getByOperation(operationId: string): Promise<GoalCustodyTrustedEvidence | null>;
  };
  /** Trusted host data directory outside original/replacement worktrees. */
  readonly retentionRoot: string;
  readonly now?: () => Date;
}

export interface GoalRetentionEvidenceSealingResult {
  readonly status: 'sealed_evidence_requires_custody_attestation';
  readonly operationId: string;
  readonly manifestSha256: string;
}

function matchesSource(snapshot: GitWorkspaceSnapshot, receipt: WorkspaceAdmissionReceipt, head: string, branch: string): boolean {
  return snapshot.head === head && snapshot.branch === branch
    && snapshot.repositoryIdentity === receipt.repositoryIdentity
    && snapshot.gitCommonDirIdentity === receipt.gitCommonDirIdentity
    && snapshot.worktreeIdentity === receipt.worktreeIdentity
    && snapshot.dirtyFingerprint === receipt.dirtyFingerprint
    && snapshot.stagedFingerprint === receipt.stagedFingerprint;
}

/**
 * First-party retention step:
 * native exact-action Host Approval -> independently seal every mixed dirty
 * source byte -> reopen and rehash every retained byte -> reobserve Git/source
 * and owner lease -> CAS-pin metadata outside retention. No Goal is moved.
 *
 * Host authentication, the process fence, and durable SQL CAS are separate
 * guards; neither this result nor a saved SHA authorizes a Goal relocation.
 */
export class GoalWorkspaceRetentionEvidenceSealingService {
  public constructor(private readonly ports: GoalRetentionEvidenceSealingPorts) {}

  public async sealAndRecord(request: GoalCustodyAuthenticatedRequest): Promise<Result<GoalRetentionEvidenceSealingResult>> {
    if (!request.operationId || !request.goalId || !request.oldWorkspaceId || !request.newWorkspaceId
      || request.oldWorkspaceId === request.newWorkspaceId
      || !request.actor.clientId || !request.actor.sessionId || !request.leaseToken) {
      return err(appError('INVALID_INPUT', 'Exact owner, operation, original and replacement required'));
    }
    try {
      return await this.ports.host.withAuthorizedOwner({
        goalId: request.goalId, operationId: request.operationId,
        clientId: request.actor.clientId, sessionId: request.actor.sessionId,
        fromWorkspaceId: request.oldWorkspaceId, toWorkspaceId: request.newWorkspaceId,
        action: 'attest_custody',
      }, async () => this.sealWithinHostFence(request));
    } catch {
      return err(appError('PERMISSION_DENIED', 'Retention sealing requires active native Host Approval'));
    }
  }

  private async sealWithinHostFence(request: GoalCustodyAuthenticatedRequest): Promise<Result<GoalRetentionEvidenceSealingResult>> {
    const { goals, workspaces, git, evidence } = this.ports;
    const now = (this.ports.now ?? ((): Date => new Date()))().toISOString();
    const leaseTokenHash = createHash('sha256').update(request.leaseToken).digest('hex');
    const [goal, source, target] = await Promise.all([
      goals.getById(request.goalId),
      workspaces.get(request.oldWorkspaceId),
      workspaces.get(request.newWorkspaceId),
    ]);
    if (!goal || goal.status !== 'active' || goal.workspaceId !== request.oldWorkspaceId
      || goal.ownerClientId !== request.actor.clientId
      || goal.leaseOwnerClientId !== request.actor.clientId
      || goal.leaseOwnerSessionId !== request.actor.sessionId
      || goal.leaseTokenHash !== leaseTokenHash || goal.leaseGeneration < 1
      || !goal.leaseExpiresAt || goal.leaseExpiresAt <= now
      || !source || source.lifecycleKind !== 'goal' || source.goalId !== goal.id
      || !source.branchName || !source.parentWorkspaceId
      || source.writerLease?.ownerId !== request.actor.clientId + ':' + request.actor.sessionId
      || source.writerLease.generation !== goal.leaseGeneration
      || source.writerLease.expiresAt <= now
      || !target || target.lifecycleKind !== 'temporary' || target.goalId !== undefined
      || target.writerLease !== undefined || target.ownerSessionId !== request.actor.sessionId
      || target.parentWorkspaceId !== source.parentWorkspaceId
      || path.resolve(source.realRootPath) === path.resolve(target.realRootPath)) {
      return err(appError('CONFLICT', 'Original Goal owner, writer lease or clean target is stale', true));
    }
    const root = path.resolve(this.ports.retentionRoot);
    const outside = (candidate: string): boolean => {
      const workspace = path.resolve(candidate);
      const relative = path.relative(workspace, root);
      const reverse = path.relative(root, workspace);
      const contained = (value: string): boolean => value === '' || (value !== '..'
        && !value.startsWith('..' + path.sep) && !path.isAbsolute(value));
      return !contained(relative) && !contained(reverse);
    };
    if (!path.isAbsolute(this.ports.retentionRoot) || !outside(source.realRootPath)
      || !outside(target.realRootPath)) {
      return err(appError('CONFLICT', 'Host retention root overlaps an owned workspace', true));
    }
    const admission = await workspaces.getAdmissionReceipt(source.id);
    if (!admission || admission.goalId !== goal.id || admission.workspaceId !== source.id
      || admission.invalidatedAt !== undefined || admission.branchName !== source.branchName
      || admission.expectedWorkspaceHead !== admission.observedWorkspaceHead
      || admission.writeLeaseGeneration > goal.leaseGeneration) {
      return err(appError('CONFLICT', 'Original Goal admission receipt is missing or invalidated', true));
    }
    const initial = await git.observeWorkspace(source.realRootPath);
    if (!initial.ok) return initial;
    if (!matchesSource(initial.value, admission, admission.expectedWorkspaceHead, source.branchName)) {
      return err(appError('CONFLICT', 'Original Git identity drifted before retention sealing', true));
    }

    const sealed = await sealMixedDirtyGoalWorkspace({
      goalId: goal.id, workspaceId: source.id,
      sourceRoot: source.realRootPath, retentionRoot: root,
      expectedHead: admission.expectedWorkspaceHead,
      expectedBranch: source.branchName, git: git.seal,
    });
    if (!sealed.ok) return sealed;
    const pinned: GoalCustodyTrustedEvidence = {
      operationId: request.operationId, newWorkspaceId: target.id,
      retentionPath: sealed.value.retentionPath,
      expectedManifestSha256: sealed.value.manifestSha256,
      expectedGoalId: goal.id, expectedWorkspaceId: source.id,
      expectedHead: admission.expectedWorkspaceHead, expectedBranch: source.branchName,
    };
    const verified = await verifyRetainedGoalWorkspaceBundle(pinned);
    if (!verified.ok) return verified;
    if (!exactDirtyManifest(initial.value, verified.value)
      || !(await verifyGoalWorkspaceDirtySourceBytes(source.realRootPath, verified.value))) {
      return err(appError('CONFLICT', 'Original mixed dirty bytes were not safely retained', true));
    }
    const [latestGoal, latestGit, latestAdmission, latestBundle, latestSource] = await Promise.all([
      goals.getById(goal.id), git.observeWorkspace(source.realRootPath),
      workspaces.getAdmissionReceipt(source.id), verifyRetainedGoalWorkspaceBundle(pinned),
      verifyGoalWorkspaceDirtySourceBytes(source.realRootPath, verified.value),
    ]);
    if (!latestGit.ok) return latestGit;
    if (!latestBundle.ok) return latestBundle;
    if (!latestSource || !latestGoal || latestGoal.revision !== goal.revision
      || latestGoal.workspaceId !== source.id || latestGoal.leaseGeneration !== goal.leaseGeneration
      || latestGoal.leaseTokenHash !== leaseTokenHash || !latestGoal.leaseExpiresAt
      || latestGoal.leaseExpiresAt <= (this.ports.now ?? ((): Date => new Date()))().toISOString()
      || !latestAdmission || latestAdmission.admissionGeneration !== admission.admissionGeneration
      || latestAdmission.invalidatedAt !== undefined
      || !matchesSource(latestGit.value, admission, admission.expectedWorkspaceHead, source.branchName)
      || JSON.stringify(latestGit.value.statusEntries) !== JSON.stringify(initial.value.statusEntries)
      || latestBundle.value.manifestSha256 !== verified.value.manifestSha256) {
      return err(appError('CONFLICT', 'Source, retention, Goal or admission changed before durable evidence CAS', true));
    }
    const saved = await evidence.recordSealed({
      ...pinned,
      ownerClientId: request.actor.clientId, ownerSessionId: request.actor.sessionId,
      expectedRevision: goal.revision, expectedAdmissionGeneration: admission.admissionGeneration,
      leaseGeneration: goal.leaseGeneration, leaseTokenHash, now,
    });
    if (!saved) return err(appError('CONFLICT', 'Durable evidence rejected the owner lease or manifest', true));
    const readBack = await evidence.getByOperation(request.operationId);
    if (!readBack || Object.entries(pinned).some(([key, value]) =>
      readBack[key as keyof GoalCustodyTrustedEvidence] !== value)) {
      return err(appError('CONFLICT', 'Durable retention evidence read-back failed', true));
    }
    return ok({
      status: 'sealed_evidence_requires_custody_attestation',
      operationId: pinned.operationId, manifestSha256: pinned.expectedManifestSha256,
    });
  }
}
