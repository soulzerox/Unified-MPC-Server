import { describe, expect, it } from 'vitest';
import { resolveGoalWorkspaceStatus } from './goal-workspace.js';

const baseInput = {
  goalId: 'goal-1',
  projectWorkspaceId: 'project-1',
  workspaceKind: 'git_worktree' as const,
  rootPath: '/managed/goals/goal-1',
  parent: {
    dirty: false,
    headRevision: 'parent-head',
  },
  workspace: {
    exists: true,
    dirty: false,
    baseRevision: 'parent-head',
    headRevision: 'parent-head',
    branchName: 'goal/goal-1',
  },
};

describe('resolveGoalWorkspaceStatus', () => {
  it('requires an explicit parent source when the canonical parent is dirty', () => {
    const status = resolveGoalWorkspaceStatus({
      ...baseInput,
      parent: { dirty: true, headRevision: 'parent-head' },
    });

    expect(status).toMatchObject({
      resolution: 'requires_explicit_source',
      dirtyState: 'clean',
      parentDirty: true,
      baseRevision: 'parent-head',
      reasons: ['parent_dirty_requires_explicit_source'],
    });
  });

  it('resolves a clean parent from its exact committed base revision', () => {
    const status = resolveGoalWorkspaceStatus({
      ...baseInput,
      parentSource: 'committed_head',
    });

    expect(status).toMatchObject({
      resolution: 'resumable',
      dirtyState: 'clean',
      parentDirty: false,
      parentHeadRevision: 'parent-head',
      baseRevision: 'parent-head',
      headRevision: 'parent-head',
      branchName: 'goal/goal-1',
      reasons: [],
    });
  });

  it('allows a dirty parent only when the source mode is recorded explicitly', () => {
    const status = resolveGoalWorkspaceStatus({
      ...baseInput,
      parent: { dirty: true, headRevision: 'parent-head' },
      parentSource: 'committed_head',
    });

    expect(status).toMatchObject({
      resolution: 'resumable',
      parentDirty: true,
      parentSource: 'committed_head',
      baseRevision: 'parent-head',
      reasons: [],
    });
  });

  it('reports a missing goal worktree as recovery-required without losing its base identity', () => {
    const status = resolveGoalWorkspaceStatus({
      ...baseInput,
      workspace: { ...baseInput.workspace, exists: false },
    });

    expect(status).toMatchObject({
      resolution: 'recovery_required',
      dirtyState: 'missing',
      baseRevision: 'parent-head',
      reasons: ['workspace_missing'],
    });
  });

  it('requires an explicit source when no base revision was recorded', () => {
    const status = resolveGoalWorkspaceStatus({
      ...baseInput,
      workspace: { ...baseInput.workspace, baseRevision: undefined },
    });

    expect(status).toMatchObject({
      resolution: 'requires_explicit_source',
      reasons: ['base_revision_missing'],
    });
  });
});
