/** The two durable isolation forms a goal workspace may use. */
export type GoalWorkspaceKind = 'git_worktree' | 'snapshot';

/** How the goal workspace was sourced from its canonical project. */
export type GoalWorkspaceParentSource = 'committed_head' | 'named_revision' | 'checkpoint' | 'patch' | 'snapshot';

export type GoalWorkspaceResolution = 'resumable' | 'requires_explicit_source' | 'recovery_required';
export type GoalWorkspaceDirtyState = 'clean' | 'dirty' | 'missing';
export type GoalWorkspaceReason =
  | 'parent_dirty_requires_explicit_source'
  | 'base_revision_missing'
  | 'workspace_missing'
  | 'head_revision_missing'
  | 'branch_missing';

export interface ResolveGoalWorkspaceStatusInput {
  readonly goalId: string;
  readonly projectWorkspaceId: string;
  readonly workspaceKind: GoalWorkspaceKind;
  readonly rootPath: string;
  readonly parentSource?: GoalWorkspaceParentSource;
  readonly parent: {
    readonly dirty: boolean;
    readonly headRevision?: string;
  };
  readonly workspace: {
    readonly exists: boolean;
    readonly dirty: boolean;
    readonly baseRevision?: string;
    readonly headRevision?: string;
    readonly branchName?: string;
  };
}

/**
 * Resolve the bounded operational state needed before a goal can be resumed.
 * This is deliberately pure: lifecycle owners provide the filesystem/Git probe
 * and can reuse the same contract without creating another workspace registry.
 */
export interface GoalWorkspaceStatus {
  readonly goalId: string;
  readonly projectWorkspaceId: string;
  readonly workspaceKind: GoalWorkspaceKind;
  readonly rootPath: string;
  readonly resolution: GoalWorkspaceResolution;
  readonly dirtyState: GoalWorkspaceDirtyState;
  readonly parentDirty: boolean;
  readonly parentHeadRevision?: string;
  readonly baseRevision?: string;
  readonly headRevision?: string;
  readonly branchName?: string;
  readonly parentSource?: GoalWorkspaceParentSource;
  readonly reasons: readonly GoalWorkspaceReason[];
}

export function resolveGoalWorkspaceStatus(input: ResolveGoalWorkspaceStatusInput): GoalWorkspaceStatus {
  const baseRevision = nonEmpty(input.workspace.baseRevision);
  const headRevision = nonEmpty(input.workspace.headRevision);
  const branchName = nonEmpty(input.workspace.branchName);
  const parentHeadRevision = nonEmpty(input.parent.headRevision);
  const reasons: GoalWorkspaceReason[] = [];

  if (input.parent.dirty && input.parentSource === undefined) reasons.push('parent_dirty_requires_explicit_source');
  if (baseRevision === undefined) reasons.push('base_revision_missing');
  if (!input.workspace.exists) reasons.push('workspace_missing');
  if (input.workspace.exists && headRevision === undefined) reasons.push('head_revision_missing');
  if (input.workspace.exists && input.workspaceKind === 'git_worktree' && branchName === undefined) reasons.push('branch_missing');

  const recoveryRequired = reasons.some((reason) => reason === 'workspace_missing' || reason === 'head_revision_missing' || reason === 'branch_missing');
  return {
    goalId: input.goalId,
    projectWorkspaceId: input.projectWorkspaceId,
    workspaceKind: input.workspaceKind,
    rootPath: input.rootPath,
    resolution: recoveryRequired ? 'recovery_required' : reasons.length > 0 ? 'requires_explicit_source' : 'resumable',
    dirtyState: !input.workspace.exists ? 'missing' : input.workspace.dirty ? 'dirty' : 'clean',
    parentDirty: input.parent.dirty,
    ...(parentHeadRevision === undefined ? {} : { parentHeadRevision }),
    ...(baseRevision === undefined ? {} : { baseRevision }),
    ...(headRevision === undefined ? {} : { headRevision }),
    ...(branchName === undefined ? {} : { branchName }),
    ...(input.parentSource === undefined ? {} : { parentSource: input.parentSource }),
    reasons,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
