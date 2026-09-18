import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  ok,
  type InvocationAuthorization,
  type Result,
} from '@unified-mpc/domain';
import {
  GitAdapter,
  type GitCommandResult,
  type GitDiffRequest,
  type GitDiffResult,
  type GitLogRequest,
  type GitLogResult,
  type GitStatusResult,
} from '@unified-mpc/git';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@unified-mpc/workspace';
import { isProvablyReadOnlyGitInvocation, parseGitInvocation, parseGitPushArguments, prohibitedAgentGitInvocationReason, prohibitedDefaultBranchPushReason, prohibitedGitPushConfigOverrideReason, prohibitedGitSubcommandReason } from '@unified-mpc/shared';
import type { FileActor } from './file-service.js';
import { isAbsoluteFsPath, resolveWorkspaceForPath } from './workspace-locator.js';

export interface GitRunRequest {
  readonly args: readonly string[];
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly userConfirmed?: boolean;
}

export class GitService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly guard: WorkspacePathGuard = new WorkspacePathGuard(),
    private readonly adapter: GitAdapter = new GitAdapter(),
  ) {}

  public async status(actor: FileActor, workspaceId: string, signal?: AbortSignal): Promise<Result<GitStatusResult>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.status(workspace.value.realRootPath, signal);
  }

  public async branch(actor: FileActor, workspaceId: string): Promise<Result<string | null>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.branch(workspace.value.realRootPath);
  }

  public async diff(
    actor: FileActor,
    workspaceId: string,
    request: GitDiffRequest = {},
    signal?: AbortSignal,
  ): Promise<Result<GitDiffResult>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    let pathValue: string | undefined;
    if (request.path !== undefined) {
      const resolved = await this.guard.resolveForWrite(workspace.value, request.path);
      if (!resolved.ok) return resolved;
      pathValue = resolved.value.relativePath;
    }
    return this.adapter.diff(workspace.value.realRootPath, {
      ...(pathValue === undefined ? {} : { path: pathValue }),
      ...(request.staged === undefined ? {} : { staged: request.staged }),
      ...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
    }, signal);
  }

  public async log(
    actor: FileActor,
    workspaceId: string,
    request: GitLogRequest = {},
    signal?: AbortSignal,
  ): Promise<Result<GitLogResult>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.log(workspace.value.realRootPath, request, signal);
  }

  public async run(actor: FileActor, request: GitRunRequest, signal?: AbortSignal, authorization?: InvocationAuthorization): Promise<Result<GitCommandResult>> {
    void actor;
    const invocation = parseGitInvocation(request.args);
    const isPush = invocation.subcommand === 'push';
    if (isPush && invocation.scopeChangingOption !== undefined) {
      return err(appError('PERMISSION_DENIED', `Git push cannot use scope-changing global option ${invocation.scopeChangingOption}`));
    }
    const prohibitedSubcommand = prohibitedGitSubcommandReason(request.args);
    if (prohibitedSubcommand !== undefined) return err(appError('PERMISSION_DENIED', prohibitedSubcommand));
    if (isPush) {
      const prohibitedConfigOverride = prohibitedGitPushConfigOverrideReason(request.args);
      if (prohibitedConfigOverride !== undefined) return err(appError('PERMISSION_DENIED', prohibitedConfigOverride));
      const staticReason = prohibitedDefaultBranchPushReason(invocation.subcommandArgs);
      if (staticReason !== undefined) return err(appError('PERMISSION_DENIED', staticReason));
    }
    if (!isProvablyReadOnlyGitInvocation(request.args) && !isApplicationAuthorized(authorization, request.userConfirmed === true)) {
      return err(appError('PERMISSION_REQUIRED', 'Git mutation or unclassified invocation requires explicit user confirmation'));
    }
    const cwd = await this.resolveCwd(request.workspaceId, request.cwd, authorization);
    if (!cwd.ok) return cwd;
    if (isPush) {
      const defaultBranches = await this.resolveDefaultBranches(cwd.value, invocation.subcommandArgs);
      if (!defaultBranches.ok) return defaultBranches;
      for (const defaultBranch of defaultBranches.value) {
        const prohibitedDefaultBranchPush = prohibitedDefaultBranchPushReason(invocation.subcommandArgs, defaultBranch);
        if (prohibitedDefaultBranchPush !== undefined) return err(appError('PERMISSION_DENIED', prohibitedDefaultBranchPush));
      }
    }
    if (!isFullBypassAuthorization(authorization)) {
      const prohibitedReason = prohibitedAgentGitInvocationReason(request.args);
      if (prohibitedReason !== undefined) return err(appError('PERMISSION_DENIED', prohibitedReason));
    }
    return this.adapter.run(cwd.value, request.args, request.timeoutMs, signal);
  }

  private async resolveDefaultBranches(cwd: string, pushArgs: readonly string[]): Promise<Result<readonly string[]>> {
    const parsed = parseGitPushArguments(pushArgs);
    if (parsed.invalidOption !== undefined || parsed.remote === undefined) return err(appError('PERMISSION_DENIED', 'Git push remote must be explicit so the repository default branch can be checked'));
    const branchesResolver = this.adapter.defaultBranches;
    if (typeof branchesResolver === 'function') {
      const result = await branchesResolver.call(this.adapter, cwd, parsed.remote);
      if (!result.ok || result.value.length === 0) return err(appError('PERMISSION_DENIED', 'Repository default branch could not be resolved safely'));
      return result;
    }
    const resolver = this.adapter.defaultBranch;
    if (typeof resolver !== 'function') return err(appError('PERMISSION_DENIED', 'Repository default branch could not be resolved safely'));
    const result = await resolver.call(this.adapter, cwd, parsed.remote);
    if (!result.ok || result.value === null || result.value.trim().length === 0) {
      return err(appError('PERMISSION_DENIED', 'Repository default branch could not be resolved safely'));
    }
    return ok([result.value]);
  }

  private async resolveCwd(workspaceId: string | undefined, requestedCwd: string | undefined, authorization?: InvocationAuthorization): Promise<Result<string>> {
    if (requestedCwd !== undefined && isAbsoluteFsPath(requestedCwd)) {
      const workspace = await resolveWorkspaceForPath(this.workspaces, workspaceId, requestedCwd, authorization);
      if (!workspace.ok) return workspace;
      return this.existingDirectory(requestedCwd);
    }

    if (workspaceId === undefined || workspaceId.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'workspaceId is required unless cwd is an absolute path'));
    }

    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    if (requestedCwd === undefined) return ok(workspace.value.realRootPath);

    const resolved = await this.guard.resolveForRead(workspace.value, requestedCwd, authorization);
    if (!resolved.ok) return resolved;
    return this.existingDirectory(resolved.value.realPath ?? resolved.value.absolutePath);
  }

  private async existingDirectory(directoryPath: string): Promise<Result<string>> {
    try {
      const canonical = await realpath(path.resolve(directoryPath));
      if (!(await stat(canonical)).isDirectory()) return err(appError('INVALID_INPUT', 'Git cwd must be a directory'));
      return ok(canonical);
    } catch {
      return err(appError('FILE_NOT_FOUND', 'Git cwd was not found'));
    }
  }

  private async getWorkspace(workspaceId: string): Promise<Result<Workspace>> {
    const workspace = await this.workspaces.get(workspaceId);
    return workspace === null ? err(appError('WORKSPACE_NOT_FOUND', 'Workspace was not found')) : ok(workspace);
  }
}
