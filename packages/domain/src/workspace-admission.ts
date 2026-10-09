export interface WorkspaceSourceEvidenceIdentity {
  readonly repositoryIdentity: string;
  readonly gitCommonDirIdentity: string;
  readonly worktreeIdentity: string;
  readonly branchName?: string;
  readonly workspaceHead: string;
  readonly dirtyFingerprint: string;
  readonly stagedFingerprint: string;
}

export type WorkspaceEvidenceFreshness = 'fresh' | 'stale' | 'unknown' | 'not_reusable';
export type WorkspaceBaseFreshness = 'current' | 'stale' | 'unknown';
export type WorkspaceAdmissionRemediation =
  | 'none'
  | 'refresh_admission'
  | 'refresh_workspace_admission'
  | 'guarded_rebase'
  | 'recover_workspace'
  | 'inspect_remote_goal';

export interface WorkspaceAdmissionProjection {
  readonly runtime?: {
    readonly source: 'current' | 'last_admitted';
    readonly deploymentId: string;
    readonly generation: string;
    readonly buildVersion: string;
    readonly buildCommit?: string;
    readonly buildDirty: boolean;
    readonly protocolGeneration: number;
    readonly startedAt: string;
  };
  readonly workspace: {
    readonly id: string;
    readonly kind: 'git' | 'non_git' | 'unknown';
    readonly branch?: string;
    readonly expectedHead?: string;
    readonly observedHead?: string;
    readonly dirtyState: 'clean' | 'dirty' | 'unknown';
  };
  readonly base: {
    readonly ref?: string;
    readonly recordedSha?: string;
    readonly currentResolvedSha?: string;
    readonly freshness: WorkspaceBaseFreshness;
  };
  readonly ownership: {
    readonly goalId?: string;
    readonly writeLeaseGeneration?: number;
  };
  readonly admission: {
    readonly status: WorkspaceAdmissionStatus;
    readonly generation?: number;
    readonly blocker?: string;
    readonly remediation: WorkspaceAdmissionRemediation;
  };
}

export function classifyWorkspaceSourceEvidence(
  expected: WorkspaceSourceEvidenceIdentity | undefined,
  observed: WorkspaceSourceEvidenceIdentity | undefined,
): WorkspaceEvidenceFreshness {
  if (expected === undefined || observed === undefined) return 'unknown';
  return expected.repositoryIdentity === observed.repositoryIdentity
    && expected.gitCommonDirIdentity === observed.gitCommonDirIdentity
    && expected.worktreeIdentity === observed.worktreeIdentity
    && (expected.branchName ?? null) === (observed.branchName ?? null)
    && expected.workspaceHead === observed.workspaceHead
    && expected.dirtyFingerprint === observed.dirtyFingerprint
    && expected.stagedFingerprint === observed.stagedFingerprint
    ? 'fresh'
    : 'stale';
}

export interface WorkspaceAdmissionObservation {
  readonly repositoryIdentity: string;
  readonly worktreeIdentity: string;
  readonly branchName?: string;
  readonly workspaceHead: string;
  readonly dirtyFingerprint: string;
  readonly checkpointRevision: number;
  readonly checkpointHead: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly remoteGoalSha: string;
  readonly leaseGeneration: number;
  readonly runtimeGeneration: string;
  readonly workflowVersion: number;
}

export interface WorkspaceAdmissionReceipt {
  readonly admissionId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly goalId?: string;
  readonly workspaceKind: 'git' | 'non_git';
  readonly repositoryIdentity?: string;
  readonly gitCommonDirIdentity?: string;
  /** SHA-256 of canonical Git common-dir filesystem device and inode at admission. */
  readonly gitCommonDirFilesystemIdentity?: string;
  readonly worktreeIdentity: string;
  readonly branchName?: string;
  readonly expectedWorkspaceHead: string;
  readonly observedWorkspaceHead: string;
  readonly baseRef?: string;
  readonly expectedBaseSha?: string;
  readonly resolvedBaseSha?: string;
  readonly remoteGoalRef?: string;
  readonly remoteGoalSha?: string;
  readonly mergeBaseSha?: string;
  readonly dirtyState: 'clean' | 'dirty' | 'unknown';
  readonly dirtyFingerprint: string;
  readonly stagedFingerprint?: string;
  readonly untrackedFingerprint?: string;
  readonly checkpointId?: string;
  readonly checkpointRevision?: number;
  readonly writeLeaseGeneration: number;
  readonly runtimeDeploymentId: string;
  readonly runtimeGeneration: string;
  readonly runtimeBuildVersion: string;
  readonly runtimeBuildCommit?: string;
  readonly runtimeBuildDirty: boolean;
  readonly runtimeProtocolGeneration: number;
  readonly runtimeStartedAt: string;
  readonly workflowVersion: number;
  readonly admissionGeneration: number;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly invalidatedAt?: string;
  readonly invalidationReason?: string;
}

export type WorkspaceBaseRebaseStatus = 'started' | 'completed' | 'recovery_required';

export interface WorkspaceBaseRebaseReceipt {
  readonly operationId: string;
  readonly receiptRevision: number;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly branchName: string;
  readonly status: WorkspaceBaseRebaseStatus;
  readonly oldHead: string;
  readonly oldBaseSha: string;
  readonly newBaseSha: string;
  readonly checkpointId: string;
  readonly checkpointRevision: number;
  readonly checkpointHead: string;
  readonly recoveryRef: string;
  readonly admissionGeneration: number;
  readonly writeLeaseGeneration: number;
  readonly remoteGoalRef?: string;
  readonly remoteGoalSha?: string;
  readonly resultHead?: string;
  readonly conflictedPaths?: readonly string[];
  readonly abortSucceeded?: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly failureReason?: string;
}

export type WorkspaceAdmissionStatus =
  | 'ADMITTED'
  | 'EXPECTED_PROGRESS'
  | 'WORKSPACE_STATE_CHANGED'
  | 'BASE_STALE'
  | 'RECOVERY_REQUIRED'
  | 'REMOTE_GOAL_BRANCH_DRIFT'
  | 'RUNTIME_GENERATION_CHANGED';

export interface WorkspaceAdmissionDecision {
  readonly status: WorkspaceAdmissionStatus;
  readonly expectedBaseSha?: string;
  readonly observedBaseSha?: string;
  readonly reason?: string;
  readonly admissionGenerationRequired?: boolean;
}

export interface GuardedBaseRebaseEvidence {
  readonly expectedHead: string;
  readonly observedHead: string;
  readonly expectedDirtyFingerprint: string;
  readonly observedDirtyFingerprint: string;
  readonly dirtyState: 'clean' | 'dirty' | 'unknown';
  readonly expectedBaseRef: string;
  readonly observedBaseRef: string;
  readonly oldBaseSha: string;
  readonly newBaseSha: string;
  readonly oldBaseIsAncestorOfNewBase: boolean;
  readonly branchPublished: boolean;
  readonly remoteGoalBranchMoved: boolean;
  readonly pinnedBase: boolean;
  readonly expectedLeaseGeneration: number;
  readonly observedLeaseGeneration: number;
  readonly leaseExpiresAt: string;
  readonly now: string;
  readonly checkpointId?: string;
  readonly checkpointHead?: string;
}

export type GuardedBaseRebaseDecision =
  | { readonly status: 'REBASE_ALLOWED'; readonly oldHead: string; readonly oldBaseSha: string; readonly newBaseSha: string; readonly checkpointId: string }
  | { readonly status: 'RECOVERY_REQUIRED'; readonly reason: string };

export function decideGuardedBaseRebase(evidence: GuardedBaseRebaseEvidence): GuardedBaseRebaseDecision {
  if (evidence.expectedHead !== evidence.observedHead
    || evidence.expectedDirtyFingerprint !== evidence.observedDirtyFingerprint) {
    return { status: 'RECOVERY_REQUIRED', reason: 'workspace_state_changed' };
  }
  if (evidence.dirtyState !== 'clean') return { status: 'RECOVERY_REQUIRED', reason: 'dirty_workspace' };
  if (evidence.pinnedBase) return { status: 'RECOVERY_REQUIRED', reason: 'pinned_base' };
  if (evidence.expectedBaseRef !== evidence.observedBaseRef) return { status: 'RECOVERY_REQUIRED', reason: 'base_policy_changed' };
  if (evidence.oldBaseSha === evidence.newBaseSha) return { status: 'RECOVERY_REQUIRED', reason: 'base_not_advanced' };
  if (!evidence.oldBaseIsAncestorOfNewBase) return { status: 'RECOVERY_REQUIRED', reason: 'base_history_rewritten_or_unrelated' };
  if (evidence.remoteGoalBranchMoved) return { status: 'RECOVERY_REQUIRED', reason: 'remote_goal_branch_moved' };
  if (evidence.branchPublished) return { status: 'RECOVERY_REQUIRED', reason: 'published_branch' };
  if (evidence.expectedLeaseGeneration !== evidence.observedLeaseGeneration
    || !Number.isFinite(Date.parse(evidence.leaseExpiresAt))
    || !Number.isFinite(Date.parse(evidence.now))
    || Date.parse(evidence.leaseExpiresAt) <= Date.parse(evidence.now)) {
    return { status: 'RECOVERY_REQUIRED', reason: 'stale_writer_lease' };
  }
  if (evidence.checkpointId === undefined || evidence.checkpointId.length === 0
    || evidence.checkpointHead !== evidence.observedHead) {
    return { status: 'RECOVERY_REQUIRED', reason: 'checkpoint_missing_or_stale' };
  }
  return {
    status: 'REBASE_ALLOWED',
    oldHead: evidence.observedHead,
    oldBaseSha: evidence.oldBaseSha,
    newBaseSha: evidence.newBaseSha,
    checkpointId: evidence.checkpointId,
  };
}

export function classifyWorkspaceAdmission(
  expected: WorkspaceAdmissionObservation,
  observed: WorkspaceAdmissionObservation,
): WorkspaceAdmissionDecision {
  if (expected.repositoryIdentity !== observed.repositoryIdentity
    || expected.worktreeIdentity !== observed.worktreeIdentity
    || expected.baseRef !== observed.baseRef
    || expected.workflowVersion !== observed.workflowVersion) {
    return { status: 'RECOVERY_REQUIRED', reason: 'workspace_identity_or_policy_changed' };
  }
  if (expected.checkpointRevision !== observed.checkpointRevision
    && observed.checkpointRevision > expected.checkpointRevision
    && observed.checkpointHead === observed.workspaceHead
    && expected.leaseGeneration === observed.leaseGeneration
    && expected.baseSha === observed.baseSha
    && expected.mergeBaseSha === observed.mergeBaseSha
    && expected.remoteGoalSha === observed.remoteGoalSha
    && expected.runtimeGeneration === observed.runtimeGeneration) {
    return { status: 'EXPECTED_PROGRESS', reason: 'owner_checkpoint_advanced', admissionGenerationRequired: true };
  }
  if (expected.workspaceHead !== observed.workspaceHead
    || expected.dirtyFingerprint !== observed.dirtyFingerprint
    || expected.checkpointRevision !== observed.checkpointRevision
    || expected.checkpointHead !== observed.checkpointHead
    || expected.leaseGeneration !== observed.leaseGeneration) {
    return { status: 'WORKSPACE_STATE_CHANGED', reason: 'expected_workspace_state_changed' };
  }
  if (expected.mergeBaseSha !== observed.mergeBaseSha) {
    return { status: 'RECOVERY_REQUIRED', reason: 'base_history_rewritten_or_unrelated' };
  }
  if (expected.baseSha !== observed.baseSha && expected.mergeBaseSha === observed.mergeBaseSha) {
    return {
      status: 'BASE_STALE',
      expectedBaseSha: expected.baseSha,
      observedBaseSha: observed.baseSha,
      reason: 'configured_base_advanced',
    };
  }
  if (expected.remoteGoalSha !== observed.remoteGoalSha) {
    return { status: 'REMOTE_GOAL_BRANCH_DRIFT', reason: 'remote_goal_ref_changed' };
  }
  if (expected.runtimeGeneration !== observed.runtimeGeneration) {
    return { status: 'RUNTIME_GENERATION_CHANGED', reason: 'runtime_generation_changed' };
  }
  return { status: 'ADMITTED' };
}
