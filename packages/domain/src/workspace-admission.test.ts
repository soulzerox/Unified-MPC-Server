import { describe, expect, it } from 'vitest';
import { classifyWorkspaceSourceEvidence, decideGoalWorkspaceRelocation, decideGuardedBaseRebase } from './workspace-admission.js';

const expected = {
  repositoryIdentity: 'repo-1',
  worktreeIdentity: '/managed/goals/g1',
  workspaceHead: '1111111111111111111111111111111111111111',
  dirtyFingerprint: 'clean:sha256:0',
  checkpointRevision: 4,
  checkpointHead: '1111111111111111111111111111111111111111',
  baseRef: 'refs/heads/main',
  baseSha: '2222222222222222222222222222222222222222',
  mergeBaseSha: '2222222222222222222222222222222222222222',
  remoteGoalSha: '3333333333333333333333333333333333333333',
  leaseGeneration: 7,
  runtimeGeneration: 'deploy-4',
  workflowVersion: 1,
};

describe('classifyWorkspaceAdmission', () => {
  it('admits an exact matching workspace state', async () => {
    const module = await import('./workspace-admission.js').catch(() => undefined);
    expect(module).toBeDefined();
    if (module === undefined) return;

    expect(module.classifyWorkspaceAdmission(expected, expected)).toMatchObject({ status: 'ADMITTED' });
  });

  it('recognizes HEAD and dirty changes recorded by a newer owner checkpoint as expected progress', async () => {
    const module = await import('./workspace-admission.js').catch(() => undefined);
    expect(module).toBeDefined();
    if (module === undefined) return;

    const observed = {
      ...expected,
      workspaceHead: '8888888888888888888888888888888888888888',
      dirtyFingerprint: 'clean:sha256:1',
      checkpointRevision: expected.checkpointRevision + 1,
      checkpointHead: '8888888888888888888888888888888888888888',
    };

    expect(module.classifyWorkspaceAdmission(expected, observed)).toMatchObject({
      status: 'EXPECTED_PROGRESS',
      admissionGenerationRequired: true,
    });
  });

  it('classifies a normally advanced base separately from workspace change', async () => {
    const module = await import('./workspace-admission.js').catch(() => undefined);
    expect(module).toBeDefined();
    if (module === undefined) return;

    const observed = {
      ...expected,
      baseSha: '4444444444444444444444444444444444444444',
      mergeBaseSha: expected.baseSha,
    };

    expect(module.classifyWorkspaceAdmission(expected, observed)).toMatchObject({
      status: 'BASE_STALE',
      expectedBaseSha: expected.baseSha,
      observedBaseSha: observed.baseSha,
    });
  });

  it('rejects an unexpected workspace HEAD change before considering the base', async () => {
    const module = await import('./workspace-admission.js').catch(() => undefined);
    expect(module).toBeDefined();
    if (module === undefined) return;

    const observed = {
      ...expected,
      workspaceHead: '5555555555555555555555555555555555555555',
    };

    expect(module.classifyWorkspaceAdmission(expected, observed)).toMatchObject({
      status: 'WORKSPACE_STATE_CHANGED',
      reason: 'expected_workspace_state_changed',
    });
  });

  it('requires recovery when the recorded merge base changes', async () => {
    const module = await import('./workspace-admission.js').catch(() => undefined);
    expect(module).toBeDefined();
    if (module === undefined) return;

    const observed = {
      ...expected,
      mergeBaseSha: '6666666666666666666666666666666666666666',
    };

    expect(module.classifyWorkspaceAdmission(expected, observed)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'base_history_rewritten_or_unrelated',
    });
  });

  it.each([
    ['another repository is selected', { repositoryIdentity: 'repo-2' }, { status: 'RECOVERY_REQUIRED', reason: 'workspace_identity_or_policy_changed' }],
    ['the configured base ref changes', { baseRef: 'refs/heads/release' }, { status: 'RECOVERY_REQUIRED', reason: 'workspace_identity_or_policy_changed' }],
    ['the workflow version changes', { workflowVersion: 2 }, { status: 'RECOVERY_REQUIRED', reason: 'workspace_identity_or_policy_changed' }],
    ['the remote goal branch moves', { remoteGoalSha: '7777777777777777777777777777777777777777' }, { status: 'REMOTE_GOAL_BRANCH_DRIFT', reason: 'remote_goal_ref_changed' }],
    ['only the runtime generation changes', { runtimeGeneration: 'deploy-5' }, { status: 'RUNTIME_GENERATION_CHANGED', reason: 'runtime_generation_changed' }],
    ['the write lease generation changes', { leaseGeneration: 8 }, { status: 'WORKSPACE_STATE_CHANGED', reason: 'expected_workspace_state_changed' }],
    ['the dirty fingerprint changes', { dirtyFingerprint: 'dirty:sha256:changed' }, { status: 'WORKSPACE_STATE_CHANGED', reason: 'expected_workspace_state_changed' }],
  ])('classifies when %s', async (_name, change, decision) => {
    const module = await import('./workspace-admission.js').catch(() => undefined);
    expect(module).toBeDefined();
    if (module === undefined) return;

    expect(module.classifyWorkspaceAdmission(expected, { ...expected, ...change })).toMatchObject(decision);
  });
});

describe('classifyWorkspaceSourceEvidence', () => {
  const source = {
    repositoryIdentity: 'repo-1',
    gitCommonDirIdentity: 'common-1',
    worktreeIdentity: 'worktree-1',
    branchName: 'goal/one',
    workspaceHead: 'a'.repeat(40),
    dirtyFingerprint: 'dirty-1',
    stagedFingerprint: 'staged-1',
  } as const;

  it('keeps exact matching source evidence fresh and marks HEAD or tree drift stale', () => {
    expect(classifyWorkspaceSourceEvidence(source, source)).toBe('fresh');
    expect(classifyWorkspaceSourceEvidence(source, { ...source, workspaceHead: 'b'.repeat(40) })).toBe('stale');
    expect(classifyWorkspaceSourceEvidence(source, { ...source, dirtyFingerprint: 'dirty-2' })).toBe('stale');
  });

  it('reports unknown when either source identity is unavailable', () => {
    expect(classifyWorkspaceSourceEvidence(undefined, source)).toBe('unknown');
    expect(classifyWorkspaceSourceEvidence(source, undefined)).toBe('unknown');
  });
});

const safeRebaseEvidence = {
  expectedHead: '1111111111111111111111111111111111111111',
  observedHead: '1111111111111111111111111111111111111111',
  expectedDirtyFingerprint: 'clean:sha256:0',
  observedDirtyFingerprint: 'clean:sha256:0',
  dirtyState: 'clean' as const,
  expectedBaseRef: 'origin/main',
  observedBaseRef: 'origin/main',
  oldBaseSha: '2222222222222222222222222222222222222222',
  newBaseSha: '4444444444444444444444444444444444444444',
  oldBaseIsAncestorOfNewBase: true,
  branchPublished: false,
  remoteGoalBranchMoved: false,
  pinnedBase: false,
  expectedLeaseGeneration: 3,
  observedLeaseGeneration: 3,
  leaseExpiresAt: '2026-09-23T01:00:00.000Z',
  now: '2026-09-23T00:30:00.000Z',
  checkpointId: 'checkpoint-7',
  checkpointHead: '1111111111111111111111111111111111111111',
};

describe('decideGuardedBaseRebase', () => {
  it('allows only a clean, exclusively leased private branch with a current checkpoint and fast-forwarded base', () => {
    expect(decideGuardedBaseRebase(safeRebaseEvidence)).toEqual({
      status: 'REBASE_ALLOWED',
      oldHead: safeRebaseEvidence.expectedHead,
      oldBaseSha: safeRebaseEvidence.oldBaseSha,
      newBaseSha: safeRebaseEvidence.newBaseSha,
      checkpointId: safeRebaseEvidence.checkpointId,
    });
  });

  it.each([
    ['workspace HEAD changed', { observedHead: '5555555555555555555555555555555555555555' }, 'workspace_state_changed'],
    ['dirty files exist', { dirtyState: 'dirty' as const }, 'dirty_workspace'],
    ['dirty fingerprint changed', { observedDirtyFingerprint: 'dirty:sha256:1' }, 'workspace_state_changed'],
    ['base policy changed', { observedBaseRef: 'origin/release' }, 'base_policy_changed'],
    ['base is pinned', { pinnedBase: true }, 'pinned_base'],
    ['base history is rewritten', { oldBaseIsAncestorOfNewBase: false }, 'base_history_rewritten_or_unrelated'],
    ['branch is published', { branchPublished: true }, 'published_branch'],
    ['remote goal branch moved', { remoteGoalBranchMoved: true }, 'remote_goal_branch_moved'],
    ['writer lease generation is stale', { observedLeaseGeneration: 2 }, 'stale_writer_lease'],
    ['writer lease expired', { leaseExpiresAt: '2026-09-23T00:29:59.000Z' }, 'stale_writer_lease'],
    ['checkpoint is missing', { checkpointId: undefined }, 'checkpoint_missing_or_stale'],
    ['checkpoint does not match HEAD', { checkpointHead: '6666666666666666666666666666666666666666' }, 'checkpoint_missing_or_stale'],
    ['base did not advance', { newBaseSha: safeRebaseEvidence.oldBaseSha }, 'base_not_advanced'],
  ])('requires recovery when %s', (_case, changes, reason) => {
    expect(decideGuardedBaseRebase({ ...safeRebaseEvidence, ...changes })).toEqual({
      status: 'RECOVERY_REQUIRED',
      reason,
    });
  });
});

/**
 * #11: A recoverable mixed foreign delta is NOT an admitted writer workspace.
 * The domain gate only permits a separate, owner-approved, sealed relocation
 * transaction to begin. It does not change workspace/goal records itself.
 */
describe('decideGoalWorkspaceRelocation', () => {
  const tracked = { path: '.github/workflows/release.yml', kind: 'tracked' as const, contentSha256: 'a'.repeat(64) };
  const untracked = { path: 'scripts/restart.test.mjs', kind: 'untracked' as const, contentSha256: 'b'.repeat(64) };
  const evidence = {
    goalId: 'goal-a',
    workspaceGoalId: 'goal-a',
    workspaceId: 'old-goal-workspace',
    expectedWorkspaceId: 'old-goal-workspace',
    expectedRepositoryIdentity: 'repo-a',
    observedRepositoryIdentity: 'repo-a',
    expectedHead: '1'.repeat(40),
    observedHead: '1'.repeat(40),
    expectedBranchName: 'goal/goal-a',
    observedBranchName: 'goal/goal-a',
    expectedLeaseGeneration: 7,
    observedLeaseGeneration: 7,
    leaseExpiresAt: '2026-10-09T00:00:00.000Z',
    now: '2026-10-08T16:00:00.000Z',
    expectedAdmissionGeneration: 12,
    observedAdmissionGeneration: 12,
    observedChanges: [tracked, untracked],
    retainedChanges: [tracked, untracked],
    retentionReceiptVerified: true,
    originalWorkspaceRetained: true,
    ownerApprovedRelocation: true,
    replacement: {
      workspaceId: 'replacement-goal-workspace',
      sameProject: true,
      sameRepository: true,
      clean: true,
      exclusive: true,
      goalBranchReserved: true,
    },
  };

  it('only authorizes a relocation transaction with exact retained tracked and untracked bytes', () => {
    expect(decideGoalWorkspaceRelocation(evidence)).toEqual({
      status: 'RELOCATION_ELIGIBLE',
      oldWorkspaceId: 'old-goal-workspace',
      newWorkspaceId: 'replacement-goal-workspace',
      expectedAdmissionGeneration: 12,
      leaseGeneration: 7,
      preservedPaths: ['.github/workflows/release.yml', 'scripts/restart.test.mjs'],
    });
  });

  it.each([
    ['missing owner approval', { ownerApprovedRelocation: false }, 'owner_approval_missing'],
    ['missing retention seal', { retentionReceiptVerified: false }, 'retention_unverified'],
    ['original workspace discarded', { originalWorkspaceRetained: false }, 'original_workspace_not_retained'],
    ['different goal owner', { workspaceGoalId: 'goal-b' }, 'goal_ownership_changed'],
    ['different original workspace', { workspaceId: 'wrong-workspace' }, 'workspace_identity_changed'],
    ['different repository', { observedRepositoryIdentity: 'repo-b' }, 'repository_or_branch_changed'],
    ['different branch', { observedBranchName: 'goal/goal-b' }, 'repository_or_branch_changed'],
    ['HEAD drift', { observedHead: '2'.repeat(40) }, 'workspace_head_changed'],
    ['stale writer generation', { observedLeaseGeneration: 8 }, 'writer_lease_invalid'],
    ['expired lease', { leaseExpiresAt: '2026-10-08T15:59:59.000Z' }, 'writer_lease_invalid'],
    ['CAS admission generation changed', { observedAdmissionGeneration: 13 }, 'admission_generation_changed'],
    ['retained entry missing', { retainedChanges: [tracked] }, 'retained_delta_mismatch'],
    ['retained bytes differ', { retainedChanges: [tracked, { ...untracked, contentSha256: 'c'.repeat(64) }] }, 'retained_delta_mismatch'],
    ['new workspace is dirty', { replacement: { ...evidence.replacement, clean: false } }, 'replacement_not_exclusive'],
    ['new workspace has a writer', { replacement: { ...evidence.replacement, exclusive: false } }, 'replacement_not_exclusive'],
    ['goal branch not reserved', { replacement: { ...evidence.replacement, goalBranchReserved: false } }, 'replacement_not_exclusive'],
    ['new workspace has another repository', { replacement: { ...evidence.replacement, sameRepository: false } }, 'replacement_identity_changed'],
    ['new workspace has another parent', { replacement: { ...evidence.replacement, sameProject: false } }, 'replacement_identity_changed'],
    ['replacement aliases old path', { replacement: { ...evidence.replacement, workspaceId: evidence.workspaceId } }, 'replacement_identity_changed'],
    ['duplicate dirty path', { observedChanges: [tracked, tracked, untracked] }, 'invalid_dirty_manifest'],
    ['path traversal', { observedChanges: [tracked, { ...untracked, path: '../escape' }] }, 'invalid_dirty_manifest'],
    ['invalid sha256', { observedChanges: [tracked, { ...untracked, contentSha256: 'abcdef' }] }, 'invalid_dirty_manifest'],
    ['tracked-only delta', { observedChanges: [tracked], retainedChanges: [tracked] }, 'invalid_dirty_manifest'],
    ['untracked-only delta', { observedChanges: [untracked], retainedChanges: [untracked] }, 'invalid_dirty_manifest'],
    ['null-containing path', { observedChanges: [tracked, { ...untracked, path: 'scripts/\\u0000file.test.mjs' }] }, 'invalid_dirty_manifest'],
  ])('fails closed for %s', (_name, overrides, reason) => {
    expect(decideGoalWorkspaceRelocation({ ...evidence, ...overrides })).toEqual({
      status: 'RECOVERY_REQUIRED',
      reason,
    });
  });

  it('requires nonempty independently retained dirty changes rather than admitting a clean workspace through relocation', () => {
    expect(decideGoalWorkspaceRelocation({ ...evidence, observedChanges: [], retainedChanges: [] })).toEqual({
      status: 'RECOVERY_REQUIRED',
      reason: 'invalid_dirty_manifest',
    });
  });
});
