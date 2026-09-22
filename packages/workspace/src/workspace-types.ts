import type { WorkspaceId } from '@unified-mpc/domain';

export type WorkspaceLifecycleKind = 'project' | 'goal' | 'temporary' | 'inspection';
export type GoalWorkspaceKind = 'git_worktree' | 'snapshot';
export type GoalWorkspaceParentSource = 'committed_head' | 'named_revision' | 'checkpoint' | 'patch';
export type GoalWorkspaceIntegrationState = 'pending' | 'integrated' | 'conflict' | 'unknown';

export interface Workspace {
  readonly id: WorkspaceId;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
  readonly createdAt: string;
  /** Omitted legacy rows are conservatively treated as persistent project workspaces. */
  readonly lifecycleKind?: WorkspaceLifecycleKind;
  readonly ownerSessionId?: string | null;
  readonly ownerJobId?: string | null;
  /** Automatic cleanup only archives registry state. It never authorizes filesystem deletion. */
  readonly autoCleanup?: boolean;
  readonly expiresAt?: string | null;
  /** First observation that the persisted root was unavailable or no longer canonicalized to the same directory. */
  readonly unavailableSince?: string | null;
  /** Present only for archived workspace registrations. Archived workspaces are excluded from the runtime trust boundary. */
  readonly archivedAt?: string | null;
  /** Durable ownership and source identity for a goal-owned workspace. */
  readonly goalId?: string;
  readonly parentWorkspaceId?: WorkspaceId;
  readonly goalWorkspaceKind?: GoalWorkspaceKind;
  readonly parentSource?: GoalWorkspaceParentSource;
  readonly baseRevision?: string;
  readonly branchName?: string;
  readonly checkpointId?: string;
  readonly integrationState?: GoalWorkspaceIntegrationState;
}

export function workspaceLifecycleKind(workspace: Workspace): WorkspaceLifecycleKind {
  return workspace.lifecycleKind ?? 'project';
}

export function isProjectWorkspace(workspace: Workspace): boolean {
  return workspaceLifecycleKind(workspace) === 'project';
}

export interface ResolvedWorkspacePath {
  readonly workspaceId: WorkspaceId;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly realPath?: string;
  readonly exists: boolean;
  /** True only when a per-invocation Full Bypass resolved an explicit absolute target outside the workspace. */
  readonly outsideWorkspace?: boolean;
}

export interface CheckpointFile {
  readonly path: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface Checkpoint {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly createdAt: string;
  readonly files: readonly CheckpointFile[];
}

export interface CheckpointRepository {
  insert(checkpoint: Checkpoint): Promise<void>;
  get(id: string): Promise<Checkpoint | null>;
  list(workspaceId: WorkspaceId, limit?: number): Promise<Checkpoint[]>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
}
