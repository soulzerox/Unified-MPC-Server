import { createHash } from 'node:crypto';
import path from 'node:path';
import { appError, err, ok, type GoalRecord, type Result, type WorkspaceAdmissionReceipt } from '@unified-mpc/domain';
import type { GitWorkspaceSnapshot } from '@unified-mpc/git';
import type { Workspace } from '@unified-mpc/workspace';
import {
  verifyRetainedGoalWorkspaceBundle,
  type VerifyRetainedGoalWorkspaceBundleRequest,
} from './goal-workspace-retention-service.js';
import {
  type GoalRelocationCustodyPin,
  type GoalRelocationHostFence,
  verifyGoalWorkspaceDirtySourceBytes,
  exactDirtyManifest,
} from './goal-workspace-relocation-orchestrator.js';

/** Trusted server-owned result of a previously sealed, separately pinned bundle.
 * Never accept this structure from an MCP caller or a retention manifest.
 */
export interface GoalCustodyTrustedEvidence extends VerifyRetainedGoalWorkspaceBundleRequest {
  readonly operationId: string;
  readonly newWorkspaceId: string;
}

export interface GoalCustodyAuthenticatedRequest {
  readonly operationId: string;
  readonly goalId: string;
  readonly oldWorkspaceId: string;
  readonly newWorkspaceId: string;
  /** The actor and session are resolved by the trusted host transport. */
  readonly actor: { readonly clientId: string; readonly sessionId: string };
  readonly leaseToken: string;
}

export interface GoalCustodyRecordRequest extends GoalRelocationCustodyPin {
  readonly goalId: string;
  readonly leaseTokenHash: string;
}

/** Only inject a first-party storage repository and host-owned evidence reader. */
export interface GoalWorkspaceCustodyAttestationPorts {
  readonly host: GoalRelocationHostFence;
  readonly trustedEvidence: { getByOperation(operationId: string): Promise<GoalCustodyTrustedEvidence | null> };
  readonly goals: { getById(goalId: string): Promise<GoalRecord | null> };
  readonly workspaces: {
    get(workspaceId: string): Promise<Workspace | null>;
    getAdmissionReceipt(workspaceId: string): Promise<WorkspaceAdmissionReceipt | null>;
  };
  readonly git: { observeWorkspace(rootPath: string): Promise<Result<GitWorkspaceSnapshot>> };
  readonly custody: {
    recordVerified(request: GoalCustodyRecordRequest): Promise<boolean>;
    readPinned(operationId: string): Promise<GoalRelocationCustodyPin | null>;
  };
  readonly now?: () => Date;
}

export interface GoalCustodyAttestationResult {
  readonly status: 'verified_and_pinned';
  readonly operationId: string;
  readonly manifestSha256: string;
}

/**
 * First-party, fail-closed entrypoint from a trusted Host Approval operation.
 * It creates neither a Goal nor a writer lease. A pin proves a verified copy
 * was observed, NOT permanent immutability, relocation, or live ADMITTED.
 *
 * Must be called with an exclusive, unbypassable owner/Host approval fence.
 */
export class GoalWorkspaceCustodyAttestationService {
  public constructor(private readonly ports: GoalWorkspaceCustodyAttestationPorts) {}

  public async verifyAndPin(request: GoalCustodyAuthenticatedRequest): Promise<Result<GoalCustodyAttestationResult>> {
    if (!request.operationId || !request.goalId || !request.oldWorkspaceId || !request.newWorkspaceId
      || request.oldWorkspaceId === request.newWorkspaceId
      || !request.actor.clientId || !request.actor.sessionId || !request.leaseToken) {
      return err(appError('INVALID_INPUT', 'Exact owner identity, lease, and operation are required'));
    }
    try {
      return await this.ports.host.withAuthorizedOwner({
        goalId: request.goalId, operationId: request.operationId,
        clientId: request.actor.clientId, sessionId: request.actor.sessionId,
        fromWorkspaceId: request.oldWorkspaceId, toWorkspaceId: request.newWorkspaceId,
        action: 'attest_custody',
      }, async (): Promise<Result<GoalCustodyAttestationResult>> => this.verifyWithinHostFence(request));
    } catch {
      return err(appError('PERMISSION_DENIED', 'Verified custody requires active exact-action Host Approval and owner fence'));
    }
  }

  private async verifyWithinHostFence(request: GoalCustodyAuthenticatedRequest): Promise<Result<GoalCustodyAttestationResult>> {
    const { goals, workspaces, trustedEvidence, custody, git } = this.ports;
    const now = (this.ports.now ?? ((): Date => new Date()))().toISOString();
    const tokenHash = createHash('sha256').update(request.leaseToken).digest('hex');
    const [goal, old, next, evidence] = await Promise.all([
      goals.getById(request.goalId), workspaces.get(request.oldWorkspaceId),
      workspaces.get(request.newWorkspaceId), trustedEvidence.getByOperation(request.operationId),
    ]);
    if (goal === null || goal.status !== 'active' || goal.workspaceId !== request.oldWorkspaceId
      || goal.ownerClientId !== request.actor.clientId || goal.leaseOwnerClientId !== request.actor.clientId
      || goal.leaseOwnerSessionId !== request.actor.sessionId || goal.leaseTokenHash !== tokenHash
      || goal.leaseGeneration < 1 || !goal.leaseExpiresAt || goal.leaseExpiresAt <= now
      || old === null || old.lifecycleKind !== 'goal' || old.goalId !== goal.id
      || !old.parentWorkspaceId || !old.branchName
      || old.writerLease?.generation !== goal.leaseGeneration
      || old.writerLease.ownerId !== request.actor.clientId + ':' + request.actor.sessionId
      || old.writerLease.expiresAt <= now
      || next === null || next.lifecycleKind !== 'temporary' || next.goalId !== undefined
      || next.writerLease !== undefined || next.parentWorkspaceId !== old.parentWorkspaceId
      || next.ownerSessionId !== request.actor.sessionId || next.realRootPath === old.realRootPath
      || evidence === null || evidence.operationId !== request.operationId
      || evidence.expectedGoalId !== goal.id || evidence.expectedWorkspaceId !== old.id
      || evidence.newWorkspaceId !== next.id || evidence.expectedBranch !== old.branchName
      || !path.isAbsolute(evidence.retentionPath)) {
      return err(appError('CONFLICT', 'Host-owned custody, Goal lease or Workspace registry was not verified', true));
    }

    const prior = await workspaces.getAdmissionReceipt(old.id);
    if (prior === null || prior.invalidatedAt !== undefined
      || prior.goalId !== goal.id || prior.workspaceId !== old.id
      || prior.branchName !== old.branchName || prior.writeLeaseGeneration > goal.leaseGeneration
      || !/^[a-f0-9]{40,64}$/.test(prior.expectedWorkspaceHead)
      || evidence.expectedHead !== prior.expectedWorkspaceHead
      || prior.observedWorkspaceHead !== prior.expectedWorkspaceHead) {
      return err(appError('CONFLICT', 'Original owner admission receipt is missing or stale', true));
    }

    const verified = await verifyRetainedGoalWorkspaceBundle(evidence);
    if (!verified.ok) return verified;
    const observed = await git.observeWorkspace(old.realRootPath);
    if (!observed.ok) return observed;
    const oldSnap = observed.value;
    if (oldSnap.head !== evidence.expectedHead || oldSnap.branch !== old.branchName
      || oldSnap.repositoryIdentity !== prior.repositoryIdentity
      || oldSnap.gitCommonDirIdentity !== prior.gitCommonDirIdentity
      || oldSnap.worktreeIdentity !== prior.worktreeIdentity
      || !exactDirtyManifest(oldSnap, verified.value)
      || !(await verifyGoalWorkspaceDirtySourceBytes(old.realRootPath, verified.value))) {
      return err(appError('CONFLICT', 'Source Git truth or original bytes drifted from the retained evidence', true));
    }

    // Verify again directly before pinning, so the trusted storage cannot seal
    // a stale owner/lease or a manifest mutated between checks.
    const [goalAfter, originalAfter, retainedAfter, sourceAfter] = await Promise.all([
      goals.getById(goal.id), git.observeWorkspace(old.realRootPath),
      verifyRetainedGoalWorkspaceBundle(evidence),
      verifyGoalWorkspaceDirtySourceBytes(old.realRootPath, verified.value),
    ]);
    if (!originalAfter.ok) return originalAfter;
    if (!retainedAfter.ok) return retainedAfter;
    if (!sourceAfter || goalAfter === null || goalAfter.revision !== goal.revision
      || goalAfter.workspaceId !== old.id || goalAfter.leaseGeneration !== goal.leaseGeneration
      || goalAfter.leaseTokenHash !== tokenHash || goalAfter.leaseExpiresAt === undefined
      || goalAfter.leaseExpiresAt <= (this.ports.now ?? ((): Date => new Date()))().toISOString()
      || JSON.stringify(originalAfter.value) !== JSON.stringify(oldSnap)
      || retainedAfter.value.manifestSha256 !== verified.value.manifestSha256) {
      return err(appError('CONFLICT', 'Goal or retained source changed before durable custody pin', true));
    }

    const pin: GoalCustodyRecordRequest = {
      operationId: request.operationId, goalId: goal.id, expectedGoalId: goal.id,
      expectedWorkspaceId: old.id, newWorkspaceId: next.id,
      retentionPath: evidence.retentionPath,
      expectedManifestSha256: verified.value.manifestSha256,
      expectedHead: evidence.expectedHead, expectedBranch: old.branchName,
      ownerClientId: request.actor.clientId, ownerSessionId: request.actor.sessionId,
      expectedRevision: goal.revision, expectedAdmissionGeneration: prior.admissionGeneration,
      leaseGeneration: goal.leaseGeneration, pinnedAt: now, leaseTokenHash: tokenHash,
    };
    if (!(await custody.recordVerified(pin))) {
      return err(appError('CONFLICT', 'Durable custody CAS rejected the owner or retained manifest', true));
    }
    const stored = await custody.readPinned(request.operationId);
    if (stored === null || Object.entries(pin).some(([key, value]) =>
      key !== 'leaseTokenHash' && stored[key as keyof GoalRelocationCustodyPin] !== value)) {
      return err(appError('CONFLICT', 'Custody pin read-back was inconsistent; reconciliation required', true));
    }
    return ok({
      status: 'verified_and_pinned',
      operationId: pin.operationId, manifestSha256: pin.expectedManifestSha256,
    });
  }
}
