import { describe, expect, it } from 'vitest';
import { classifyWorkspaceSourceEvidence, decideGuardedBaseRebase } from './workspace-admission.js';

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
