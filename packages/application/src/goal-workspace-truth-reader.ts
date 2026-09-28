import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GoalWorkspaceState, Result } from '@unified-mpc/domain';
import type { GitStatusResult, GitWorkspaceSnapshot, GitWorkspaceSnapshotOptions } from '@unified-mpc/git';
import type { WorkspaceRepository } from '@unified-mpc/workspace';
import type { FileActor } from './file-service.js';

export interface GoalWorkspaceTruthObservation {
  readonly state: GoalWorkspaceState;
  readonly detail?: string;
}

export interface GoalWorkspaceIntegrationObservation {
  readonly state: 'pending' | 'integrated' | 'conflict' | 'unknown';
  readonly detail?: string;
}

export interface GoalWorkspaceGitStatusPort {
  status(actor: FileActor, workspaceId: string, signal?: AbortSignal): Promise<Result<GitStatusResult>>;
  refreshAdmissionRef?(
    actor: FileActor,
    workspaceId: string,
    remote: string,
    sourceRef: string,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly ref: string; readonly sha: string }>>;
  observeWorkspace?(
    actor: FileActor,
    workspaceId: string,
    options?: GitWorkspaceSnapshotOptions,
    signal?: AbortSignal,
  ): Promise<Result<GitWorkspaceSnapshot>>;
}

export interface GoalWorkspaceAdmissionObservation {
  readonly workspaceId: string;
  readonly workspaceKind: 'git' | 'non_git' | 'unknown';
  readonly dirtyState: 'clean' | 'dirty' | 'unknown';
  readonly goalId?: string;
  readonly projectId?: string;
  readonly checkpointId?: string;
  readonly writerLeaseGeneration?: number;
  readonly writerLeaseExpiresAt?: string;
  readonly configuredBaseRevision?: string;
  readonly repositoryIdentity?: string;
  readonly gitCommonDirIdentity?: string;
  readonly worktreeIdentity?: string;
  readonly branchName?: string;
  readonly workspaceHead?: string;
  readonly dirtyFingerprint?: string;
  readonly stagedFingerprint?: string;
  readonly sourceSnapshotGeneration?: string;
  readonly sourceContentFingerprint?: string;
  readonly baseRef?: string;
  readonly resolvedBaseRef?: string;
  readonly baseSha?: string;
  readonly mergeBaseSha?: string;
  readonly remoteGoalSha?: string;
  readonly detail?: string;
}

export type WorkspaceRootProbeResult = 'present' | 'missing' | 'unavailable';
export type WorkspaceRootProbe = (rootPath: string) => Promise<WorkspaceRootProbeResult>;

export interface GoalWorkspaceTruthReaderOptions {
  readonly probeRoot?: WorkspaceRootProbe;
}

/**
 * Reads registered-workspace + filesystem + Git evidence, plus explicit
 * caller-verified integration metadata persisted by the Goal Workspace owner.
 *
 * Runtime state, cleanup eligibility, UI selection, branch names, leases, and
 * integration outcomes are never inferred from surrounding repository state.
 */
export class GoalWorkspaceTruthReader {
  private readonly probeRoot: WorkspaceRootProbe;
  private readonly actor: FileActor = {
    clientId: 'goal-runtime-workspace-truth',
    clientName: 'Goal runtime workspace truth reader',
  };

  public constructor(
    private readonly workspaces: Pick<WorkspaceRepository, 'get'> & Partial<Pick<WorkspaceRepository, 'list' | 'listAll'>>,
    private readonly git: GoalWorkspaceGitStatusPort,
    options: GoalWorkspaceTruthReaderOptions = {},
  ) {
    this.probeRoot = options.probeRoot ?? probeWorkspaceRoot;
  }

  public async read(workspaceId: string): Promise<GoalWorkspaceTruthObservation> {
    let workspace;
    try {
      workspace = await this.workspaces.get(workspaceId);
    } catch {
      return { state: 'unavailable', detail: 'workspace registration could not be read' };
    }

    if (workspace === null) {
      return { state: 'missing', detail: 'registered workspace is missing' };
    }

    const rootState = await this.safeProbeRoot(workspace.realRootPath);
    if (rootState === 'missing') {
      return { state: 'missing', detail: 'registered workspace root is missing' };
    }
    if (rootState === 'unavailable') {
      return { state: 'unavailable', detail: 'registered workspace root is not readable' };
    }

    let status;
    try {
      status = await this.git.status(this.actor, workspaceId);
    } catch {
      return { state: 'unavailable', detail: 'Git status probe failed' };
    }

    if (status.ok) {
      return status.value.entries.length === 0
        ? { state: 'clean', detail: 'Git workspace is clean' }
        : { state: 'dirty', detail: 'Git workspace has uncommitted changes' };
    }

    if (status.error.code === 'GIT_NOT_REPOSITORY') {
      return { state: 'unknown', detail: 'workspace is not a Git repository' };
    }
    if (status.error.code === 'WORKSPACE_NOT_FOUND' || status.error.code === 'FILE_NOT_FOUND') {
      return { state: 'missing', detail: 'registered workspace disappeared during probe' };
    }
    return { state: 'unavailable', detail: 'Git status is unavailable' };
  }

  /**
   * Reads only caller-verified integration metadata persisted by the Goal
   * Workspace owner (#11). This never infers integration from Git/PR/runtime
   * state and returns unknown when active ownership is absent or ambiguous.
   */
  public async readIntegration(goalId: string): Promise<GoalWorkspaceIntegrationObservation> {
    const list = this.workspaces.listAll ?? this.workspaces.list;
    if (list === undefined) {
      return { state: 'unknown', detail: 'Goal Workspace integration metadata is unavailable' };
    }

    let workspaces;
    try {
      workspaces = await list.call(this.workspaces);
    } catch {
      return { state: 'unknown', detail: 'Goal Workspace integration metadata could not be read' };
    }

    const active = workspaces.filter((workspace) =>
      workspace.archivedAt == null
      && workspace.lifecycleKind === 'goal'
      && workspace.goalId === goalId);

    if (active.length === 0) {
      return { state: 'unknown', detail: 'No active Goal Workspace integration metadata exists' };
    }
    if (active.length !== 1) {
      return { state: 'unknown', detail: 'Active Goal Workspace integration ownership is ambiguous' };
    }

    const state = active[0]?.integrationState ?? 'unknown';
    return {
      state,
      detail: `Goal Workspace integration metadata is ${state}`,
    };
  }

  /** Reads bounded Git admission evidence without treating a snapshot's parent repo as its own. */
  public async readAdmission(workspaceId: string): Promise<GoalWorkspaceAdmissionObservation> {
    let workspace;
    try {
      workspace = await this.workspaces.get(workspaceId);
    } catch {
      return { workspaceId, workspaceKind: 'unknown', dirtyState: 'unknown', detail: 'workspace registration could not be read' };
    }
    if (workspace === null) {
      return { workspaceId, workspaceKind: 'unknown', dirtyState: 'unknown', detail: 'registered workspace is missing' };
    }
    if (workspace.goalWorkspaceKind === 'snapshot') {
      const sourceContentFingerprint = await snapshotContentFingerprint(workspace.realRootPath);
      if (sourceContentFingerprint === undefined) {
        return {
          workspaceId,
          workspaceKind: 'non_git',
          dirtyState: 'unknown',
          ...(workspace.goalId === undefined ? {} : { goalId: workspace.goalId }),
          ...(workspace.parentWorkspaceId === undefined ? {} : { projectId: workspace.parentWorkspaceId }),
          ...(workspace.checkpointId === undefined ? {} : { checkpointId: workspace.checkpointId }),
          ...(workspace.writerLease === undefined ? {} : { writerLeaseGeneration: workspace.writerLease.generation, writerLeaseExpiresAt: workspace.writerLease.expiresAt }),
          detail: 'bounded snapshot content fingerprint is unavailable',
        };
      }
      return {
        workspaceId,
        workspaceKind: 'non_git',
        dirtyState: 'clean',
        ...(workspace.goalId === undefined ? {} : { goalId: workspace.goalId }),
        ...(workspace.parentWorkspaceId === undefined ? {} : { projectId: workspace.parentWorkspaceId }),
        ...(workspace.checkpointId === undefined ? {} : { checkpointId: workspace.checkpointId }),
        ...(workspace.writerLease === undefined ? {} : { writerLeaseGeneration: workspace.writerLease.generation, writerLeaseExpiresAt: workspace.writerLease.expiresAt }),
        ...(workspace.baseRevision === undefined ? {} : { configuredBaseRevision: workspace.baseRevision }),
        sourceSnapshotGeneration: `${workspace.createdAt}:${workspace.baseRevision ?? ''}`,
        sourceContentFingerprint,
        detail: 'snapshot Goal Workspace content fingerprint is current',
      };
    }
    if (await this.safeProbeRoot(workspace.realRootPath) !== 'present') {
      return { workspaceId, workspaceKind: 'unknown', dirtyState: 'unknown', detail: 'registered workspace root is unavailable' };
    }
    if (this.git.observeWorkspace === undefined) {
      return { workspaceId, workspaceKind: 'unknown', dirtyState: 'unknown', detail: 'bounded Git observation is unavailable' };
    }
    let resolvedBaseRef: string | undefined;
    if (workspace.baseRef !== undefined) {
      const movingBase = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/main$/.exec(workspace.baseRef);
      if (movingBase?.[1] === undefined || this.git.refreshAdmissionRef === undefined) {
        return { workspaceId, workspaceKind: 'git', dirtyState: 'unknown', detail: 'moving base ref cannot be refreshed safely' };
      }
      let refreshed;
      try {
        refreshed = await this.git.refreshAdmissionRef(this.actor, workspaceId, movingBase[1], 'refs/heads/main');
      } catch {
        return { workspaceId, workspaceKind: 'git', dirtyState: 'unknown', detail: 'moving base ref refresh failed' };
      }
      if (!refreshed.ok) return { workspaceId, workspaceKind: 'git', dirtyState: 'unknown', detail: 'moving base ref refresh failed' };
      resolvedBaseRef = refreshed.value.ref;
    }
    let observed;
    try {
      observed = await this.git.observeWorkspace(this.actor, workspaceId, {
        ...(workspace.baseRef === undefined
          ? (workspace.baseRevision === undefined ? {} : { baseRef: workspace.baseRevision })
          : { baseRef: workspace.baseRef, resolvedBaseRef: resolvedBaseRef! }),
      });
    } catch {
      return { workspaceId, workspaceKind: 'unknown', dirtyState: 'unknown', detail: 'bounded Git observation failed' };
    }
    if (!observed.ok) {
      if (observed.error.code === 'GIT_NOT_REPOSITORY') {
        return { workspaceId, workspaceKind: 'non_git', dirtyState: 'unknown', detail: 'workspace is not a Git repository' };
      }
      return { workspaceId, workspaceKind: 'git', dirtyState: 'unknown', detail: 'bounded Git observation is unavailable' };
    }
    const snapshot = observed.value;
    return {
      workspaceId,
      workspaceKind: 'git',
      dirtyState: snapshot.statusEntries.length === 0 ? 'clean' : 'dirty',
      ...(workspace.goalId === undefined ? {} : { goalId: workspace.goalId }),
      ...(workspace.parentWorkspaceId === undefined ? {} : { projectId: workspace.parentWorkspaceId }),
      ...(workspace.checkpointId === undefined ? {} : { checkpointId: workspace.checkpointId }),
      ...(workspace.writerLease === undefined ? {} : { writerLeaseGeneration: workspace.writerLease.generation, writerLeaseExpiresAt: workspace.writerLease.expiresAt }),
      ...(workspace.baseRevision === undefined ? {} : { configuredBaseRevision: workspace.baseRevision }),
      repositoryIdentity: snapshot.repositoryIdentity,
      gitCommonDirIdentity: snapshot.gitCommonDirIdentity,
      worktreeIdentity: snapshot.worktreeIdentity,
      ...(snapshot.branch === null ? {} : { branchName: snapshot.branch }),
      workspaceHead: snapshot.head,
      dirtyFingerprint: snapshot.dirtyFingerprint,
      stagedFingerprint: snapshot.stagedFingerprint,
      ...(snapshot.baseRef === undefined ? {} : { baseRef: snapshot.baseRef }),
      ...(snapshot.resolvedBaseRef === undefined ? {} : { resolvedBaseRef: snapshot.resolvedBaseRef }),
      ...(snapshot.baseSha === undefined ? {} : { baseSha: snapshot.baseSha }),
      ...(snapshot.mergeBaseSha === undefined ? {} : { mergeBaseSha: snapshot.mergeBaseSha }),
      ...(snapshot.remoteGoalSha === undefined ? {} : { remoteGoalSha: snapshot.remoteGoalSha }),
    };
  }

  private async safeProbeRoot(rootPath: string): Promise<WorkspaceRootProbeResult> {
    try {
      return await this.probeRoot(rootPath);
    } catch (error: unknown) {
      return isMissingPathError(error) ? 'missing' : 'unavailable';
    }
  }
}

export async function probeWorkspaceRoot(rootPath: string): Promise<WorkspaceRootProbeResult> {
  try {
    const metadata = await stat(rootPath);
    if (!metadata.isDirectory()) return 'unavailable';
    await access(rootPath, constants.R_OK);
    return 'present';
  } catch (error: unknown) {
    return isMissingPathError(error) ? 'missing' : 'unavailable';
  }
}

const SNAPSHOT_CONTENT_MAX_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_CONTENT_MAX_ENTRIES = 20_000;
const SNAPSHOT_CONTENT_EXCLUDED_NAMES = new Set([
  '.git', '.unified-mpc', 'build', 'coverage', 'dist', 'node_modules',
  '.next', '.turbo', '.cache', 'cache', 'vendor', 'target', 'bin', 'obj', '.venv', 'venv', '__pycache__',
]);

async function snapshotContentFingerprint(rootPath: string): Promise<string | undefined> {
  const hash = createHash('sha256');
  let bytes = 0;
  let entriesSeen = 0;
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const directoryBefore = await lstat(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) throw new Error('unsupported snapshot directory');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (SNAPSHOT_CONTENT_EXCLUDED_NAMES.has(entry.name)) continue;
      entriesSeen += 1;
      if (entriesSeen > SNAPSHOT_CONTENT_MAX_ENTRIES) throw new Error('snapshot entry limit exceeded');
      const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) throw new Error('snapshot contains an unsupported symbolic link');
      if (metadata.isDirectory()) {
        hash.update(`directory\\0${relativePath}\\0`);
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile()) throw new Error('snapshot contains an unsupported filesystem entry');
      bytes += metadata.size;
      if (bytes > SNAPSHOT_CONTENT_MAX_BYTES) throw new Error('snapshot byte limit exceeded');
      const content = await readFile(absolutePath);
      const afterRead = await lstat(absolutePath);
      if (!afterRead.isFile() || afterRead.size !== metadata.size || afterRead.mtimeMs !== metadata.mtimeMs) {
        throw new Error('snapshot changed during fingerprinting');
      }
      hash.update(`file\\0${relativePath}\\0${metadata.size}\\0`);
      hash.update(content);
    }
    const directoryAfter = await lstat(directory);
    if (directoryAfter.mtimeMs !== directoryBefore.mtimeMs) throw new Error('snapshot changed during fingerprinting');
  };

  try {
    await visit(rootPath, '');
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
