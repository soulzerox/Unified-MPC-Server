import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { GoalWorkspaceState, Result } from '@unified-mpc/domain';
import type { GitStatusResult } from '@unified-mpc/git';
import type { WorkspaceRepository } from '@unified-mpc/workspace';
import type { FileActor } from './file-service.js';

export interface GoalWorkspaceTruthObservation {
  readonly state: GoalWorkspaceState;
  readonly detail?: string;
}

export interface GoalWorkspaceGitStatusPort {
  status(actor: FileActor, workspaceId: string, signal?: AbortSignal): Promise<Result<GitStatusResult>>;
}

export type WorkspaceRootProbeResult = 'present' | 'missing' | 'unavailable';
export type WorkspaceRootProbe = (rootPath: string) => Promise<WorkspaceRootProbeResult>;

export interface GoalWorkspaceTruthReaderOptions {
  readonly probeRoot?: WorkspaceRootProbe;
}

/**
 * Reads only registered-workspace + filesystem + Git evidence.
 *
 * Runtime state, Goal Workspace isolation, integration state, cleanup
 * eligibility, UI selection, branch names, and leases are deliberately not
 * inferred here.
 */
export class GoalWorkspaceTruthReader {
  private readonly probeRoot: WorkspaceRootProbe;
  private readonly actor: FileActor = {
    clientId: 'goal-runtime-workspace-truth',
    clientName: 'Goal runtime workspace truth reader',
  };

  public constructor(
    private readonly workspaces: Pick<WorkspaceRepository, 'get'>,
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

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
