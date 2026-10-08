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


/**
 * An independently verified content seal for a single preserved dirty file.
 * A caller must derive observedChanges from Git/filesystem state and
 * retainedChanges from an immutable retention store, never from a client claim.
 */
export interface GoalWorkspaceRetainedEntry {
  readonly path: string;
  readonly kind: 'tracked' | 'untracked';
  readonly contentSha256: string;
}

/**
 * Preflight for a *separate* owner-authorized Goal Workspace relocation.
 *
 * This deliberately does not grant admission, move a worktree, reset dirty
 * content, or change an ownership receipt. A service that consumes an eligible
 * result still needs a durable sealed snapshot, exclusive branch/Goal CAS, and
 * atomic registry handoff before accepting writes.
 *
 * All boolean proofs here must be supplied by trusted first-party verifiers,
 * not arbitrary MCP input flags.
 */
export interface GoalWorkspaceRelocationEvidence {
  readonly goalId: string;
  readonly workspaceGoalId: string;
  readonly workspaceId: string;
  readonly expectedWorkspaceId: string;
  readonly expectedRepositoryIdentity: string;
  readonly observedRepositoryIdentity: string;
  readonly expectedHead: string;
  readonly observedHead: string;
  readonly expectedBranchName: string;
  readonly observedBranchName: string;
  readonly expectedLeaseGeneration: number;
  readonly observedLeaseGeneration: number;
  readonly leaseExpiresAt: string;
  readonly now: string;
  readonly expectedAdmissionGeneration: number;
  readonly observedAdmissionGeneration: number;
  readonly observedChanges: readonly GoalWorkspaceRetainedEntry[];
  readonly retainedChanges: readonly GoalWorkspaceRetainedEntry[];
  readonly retentionReceiptVerified: boolean;
  readonly originalWorkspaceRetained: boolean;
  readonly ownerApprovedRelocation: boolean;
  readonly replacement: {
    readonly workspaceId: string;
    readonly sameProject: boolean;
    readonly sameRepository: boolean;
    readonly clean: boolean;
    readonly exclusive: boolean;
    readonly goalBranchReserved: boolean;
  };
}

export type GoalWorkspaceRelocationDecision =
  | {
    readonly status: 'RECOVERY_REQUIRED';
    readonly reason:
      | 'owner_approval_missing'
      | 'retention_unverified'
      | 'original_workspace_not_retained'
      | 'goal_ownership_changed'
      | 'workspace_identity_changed'
      | 'repository_or_branch_changed'
      | 'workspace_head_changed'
      | 'writer_lease_invalid'
      | 'admission_generation_changed'
      | 'invalid_dirty_manifest'
      | 'retained_delta_mismatch'
      | 'replacement_not_exclusive'
      | 'replacement_identity_changed';
  }
  | {
    readonly status: 'RELOCATION_ELIGIBLE';
    readonly oldWorkspaceId: string;
    readonly newWorkspaceId: string;
    readonly expectedAdmissionGeneration: number;
    readonly leaseGeneration: number;
    readonly preservedPaths: readonly string[];
  };

function validRetainedEntry(entry: GoalWorkspaceRetainedEntry): boolean {
  const path = entry.path;
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096
    || path.startsWith('/') || path.includes('\\') || path.includes(String.fromCharCode(0))
    || path.includes('//') || path.split('/').some((part) => part === '.' || part === '..')
    || /^[A-Za-z]:/.test(path)
    || (entry.kind !== 'tracked' && entry.kind !== 'untracked')
    || !/^[0-9a-f]{64}$/.test(entry.contentSha256)) return false;
  return true;
}

function validRetainedManifest(entries: readonly GoalWorkspaceRetainedEntry[]): boolean {
  if (entries.length === 0 || entries.length > 1000) return false;
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!validRetainedEntry(entry) || paths.has(entry.path)) return false;
    paths.add(entry.path);
  }
  return true;
}

/**
 * Fail-closed authorization *preflight* for preserving a mixed foreign delta.
 * Even RELOCATION_ELIGIBLE only allows an atomic relocation attempt, not
 * permission to adopt foreign files or write to either workspace.
 */
export function decideGoalWorkspaceRelocation(evidence: GoalWorkspaceRelocationEvidence): GoalWorkspaceRelocationDecision {
  const blocked = (reason: Extract<GoalWorkspaceRelocationDecision, { status: 'RECOVERY_REQUIRED' }>['reason']):
    GoalWorkspaceRelocationDecision => ({ status: 'RECOVERY_REQUIRED', reason });
  if (!evidence.ownerApprovedRelocation) return blocked('owner_approval_missing');
  if (!evidence.retentionReceiptVerified) return blocked('retention_unverified');
  if (!evidence.originalWorkspaceRetained) return blocked('original_workspace_not_retained');
  if (!evidence.goalId || evidence.workspaceGoalId !== evidence.goalId) return blocked('goal_ownership_changed');
  if (!evidence.workspaceId || evidence.workspaceId !== evidence.expectedWorkspaceId) return blocked('workspace_identity_changed');
  if (!evidence.expectedRepositoryIdentity
    || evidence.expectedRepositoryIdentity !== evidence.observedRepositoryIdentity
    || !evidence.expectedBranchName || evidence.expectedBranchName !== evidence.observedBranchName) {
    return blocked('repository_or_branch_changed');
  }
  if (!/^[0-9a-f]{40,64}$/.test(evidence.expectedHead)
    || evidence.observedHead !== evidence.expectedHead) return blocked('workspace_head_changed');
  const expiresAt = Date.parse(evidence.leaseExpiresAt);
  const now = Date.parse(evidence.now);
  if (!Number.isSafeInteger(evidence.expectedLeaseGeneration) || evidence.expectedLeaseGeneration < 1
    || evidence.observedLeaseGeneration !== evidence.expectedLeaseGeneration
    || !Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) {
    return blocked('writer_lease_invalid');
  }
  if (!Number.isSafeInteger(evidence.expectedAdmissionGeneration) || evidence.expectedAdmissionGeneration < 1
    || evidence.observedAdmissionGeneration !== evidence.expectedAdmissionGeneration) {
    return blocked('admission_generation_changed');
  }
  if (!validRetainedManifest(evidence.observedChanges)
    || !validRetainedManifest(evidence.retainedChanges)
    || !evidence.observedChanges.some((entry) => entry.kind === 'tracked')
    || !evidence.observedChanges.some((entry) => entry.kind === 'untracked')) {
    return blocked('invalid_dirty_manifest');
  }
  const expected = [...evidence.observedChanges].sort((a, b) => a.path.localeCompare(b.path));
  const preserved = [...evidence.retainedChanges].sort((a, b) => a.path.localeCompare(b.path));
  if (expected.length !== preserved.length
    || expected.some((entry, index) => entry.path !== preserved[index]?.path
      || entry.kind !== preserved[index]?.kind || entry.contentSha256 !== preserved[index]?.contentSha256)) {
    return blocked('retained_delta_mismatch');
  }
  if (!evidence.replacement.workspaceId
    || evidence.replacement.workspaceId === evidence.workspaceId
    || !evidence.replacement.sameProject || !evidence.replacement.sameRepository) {
    return blocked('replacement_identity_changed');
  }
  if (!evidence.replacement.clean || !evidence.replacement.exclusive
    || !evidence.replacement.goalBranchReserved) return blocked('replacement_not_exclusive');
  return {
    status: 'RELOCATION_ELIGIBLE',
    oldWorkspaceId: evidence.workspaceId,
    newWorkspaceId: evidence.replacement.workspaceId,
    expectedAdmissionGeneration: evidence.expectedAdmissionGeneration,
    leaseGeneration: evidence.expectedLeaseGeneration,
    preservedPaths: expected.map((entry) => entry.path),
  };
}
