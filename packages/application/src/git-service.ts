import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  err,
  isApplicationAuthorized,
  isFullBypassAuthorization,
  isPublishBranchName,
  isPublishObjectId,
  isPublishRemoteName,
  isValidPublishBinding,
  ok,
  type InvocationAuthorization,
  type PublishApprovalAuthorityPort,
  type PublishApprovalBinding,
  type PublishApprovalLookupPort,
  type PublishApprovalRecord,
  type PublishApprovalState,
  type Result,
} from '@unified-mpc/domain';
import {
  GitAdapter,
  type GitCommandResult,
  type GitDiffRequest,
  type GitDiffResult,
  type GitGuardedRebaseRequest,
  type GitGuardedRebaseResult,
  type GitLogRequest,
  type GitLogResult,
  type GitPublishPreflight,
  type GitPublishRuntimeStatus,
  type GitStatusResult,
  type GitWorkspaceSnapshot,
  type GitWorkspaceSnapshotOptions,
} from '@unified-mpc/git';
import { WorkspacePathGuard, type Workspace, type WorkspaceRepository } from '@unified-mpc/workspace';
import { isProvablyReadOnlyGitInvocation, parseGitInvocation, parseGitPushArguments, prohibitedAgentGitInvocationReason, prohibitedDefaultBranchPushReason, prohibitedGitConfigMutationReason, prohibitedGitPushConfigOverrideReason, prohibitedGitPushGlobalOptionReason, prohibitedGitSubcommandReason } from '@unified-mpc/shared';
import type { FileActor } from './file-service.js';
import { isAbsoluteFsPath, resolveWorkspaceForPath } from './workspace-locator.js';

export interface GitRunRequest {
  readonly args: readonly string[];
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly userConfirmed?: boolean;
}

export interface RefreshedAdmissionRef {
  readonly ref: string;
  readonly sha: string;
}

export interface GitPublishPreflightRequest {
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly remote: string;
  readonly branch: string;
}

/** Read-only preflight answer: transport/policy diagnostics plus the ledger state for this exact head. */
export type GitPublishPreflightView = Omit<GitPublishPreflight, 'approval'> & {
  readonly approval: PublishApprovalState;
};

export interface GitPublishBindingRequest {
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly remote: string;
  readonly branch: string;
  /** Exact full commit id the caller intends to publish. */
  readonly expectedSha: string;
}

export interface GitPublishApprovalRequest extends GitPublishBindingRequest {
  /** Required human confirmation: this call is the approval, not a preview. */
  readonly userConfirmed?: boolean;
  /** Receipt lifetime. Short by design so a stale approval cannot publish later. */
  readonly ttlSeconds?: number;
}

export interface GitPublishRequest extends GitPublishBindingRequest {
  /** The single-use receipt minted by `approvePublish` for this exact binding. */
  readonly approvalId: string;
}

/** What the host actually pushed, after the remote ref was read back. */
export interface GitPublishReceipt {
  readonly remote: string;
  readonly branch: string;
  readonly sha: string;
  /** Sanitized transport targets: scheme and host only, never userinfo or path. */
  readonly targets: readonly string[];
  readonly approvalId: string;
}

const DEFAULT_PUBLISH_APPROVAL_TTL_SECONDS = 15 * 60;
const MIN_PUBLISH_APPROVAL_TTL_SECONDS = 30;
const MAX_PUBLISH_APPROVAL_TTL_SECONDS = 15 * 60;

export interface GitServiceOptions {
  /** Host-owned approval ledger. Omitted keeps `approval: "missing"`. */
  readonly publishApprovals?: PublishApprovalLookupPort;
  /** Spend/mint side of the ledger, kept separate from the read-only lookup. */
  readonly publishApprovalAuthority?: PublishApprovalAuthorityPort;
  /** Test seam for a deterministic preflight clock. */
  readonly now?: () => number;
}

export class GitService {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly guard: WorkspacePathGuard = new WorkspacePathGuard(),
    private readonly adapter: GitAdapter = new GitAdapter(),
    private readonly options: GitServiceOptions = {},
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

  public async observeWorkspace(
    actor: FileActor,
    workspaceId: string,
    options: GitWorkspaceSnapshotOptions = {},
    signal?: AbortSignal,
  ): Promise<Result<GitWorkspaceSnapshot>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.observeWorkspace(workspace.value.realRootPath, options, signal);
  }

  public async refreshAdmissionRef(
    actor: FileActor,
    workspaceId: string,
    remote: string,
    sourceRef: string,
    signal?: AbortSignal,
  ): Promise<Result<RefreshedAdmissionRef>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    const workspaceKey = createHash('sha256').update(workspaceId).digest('hex');
    const refKey = createHash('sha256').update(sourceRef).digest('hex');
    const ref = `refs/unified-mpc/admission/workspaces/${workspaceKey}/${refKey}`;
    const refreshed = await this.adapter.refreshRemoteRef(workspace.value.realRootPath, remote, sourceRef, ref, signal);
    return refreshed.ok ? ok({ ref, sha: refreshed.value }) : refreshed;
  }

  public async remoteBranchSha(
    actor: FileActor,
    workspaceId: string,
    remote: string,
    branchName: string,
    signal?: AbortSignal,
  ): Promise<Result<string | null>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.remoteBranchSha(workspace.value.realRootPath, remote, branchName, signal);
  }

  public async publishPreflight(
    actor: FileActor,
    request: GitPublishPreflightRequest,
    signal?: AbortSignal,
  ): Promise<Result<GitPublishPreflightView>> {
    void actor;
    const workspace = await this.resolvePublishWorkspace(request.workspaceId, request.cwd);
    if (!workspace.ok) return workspace;
    const cwd = await this.resolveCwd(request.workspaceId, request.cwd);
    if (!cwd.ok) return cwd;
    const preflight = await this.adapter.publishPreflight(cwd.value, request.remote, request.branch, { signal });
    if (!preflight.ok) return preflight;
    const approval = await this.inspectPublishApproval(
      workspace.value.id,
      request.remote,
      request.branch,
      preflight.value.head,
    );
    return ok({ ...preflight.value, approval });
  }

  /**
   * Mint one single-use receipt for an exact workspace/remote/branch/commit.
   * The human confirmation is the authority: without `userConfirmed: true`
   * this refuses before it reads the repo or writes the ledger. The live head
   * must still match `expectedSha`, and a default branch is never approvable.
   */
  public async approvePublish(
    actor: FileActor,
    request: GitPublishApprovalRequest,
    signal?: AbortSignal,
  ): Promise<Result<PublishApprovalRecord>> {
    if (request.userConfirmed !== true) {
      return err(appError(
        'PERMISSION_REQUIRED',
        'Publishing requires explicit user approval of the exact workspace, remote, branch and commit',
        true,
        { reason: 'publish-approval-confirmation-required' },
      ));
    }
    const binding = this.validatePublishBinding(request);
    if (!binding.ok) return binding;
    const workspace = await this.resolvePublishWorkspace(request.workspaceId, request.cwd);
    if (!workspace.ok) return workspace;
    const cwd = await this.resolveCwd(request.workspaceId, request.cwd);
    if (!cwd.ok) return cwd;
    const ttlSeconds = request.ttlSeconds ?? DEFAULT_PUBLISH_APPROVAL_TTL_SECONDS;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_PUBLISH_APPROVAL_TTL_SECONDS
      || ttlSeconds > MAX_PUBLISH_APPROVAL_TTL_SECONDS) {
      return err(appError('INVALID_INPUT', 'Publish approval lifetime must be an integer between 30 and 900 seconds'));
    }
    const authority = this.options.publishApprovalAuthority;
    if (authority === undefined) {
      return err(appError('INTERNAL_ERROR', 'Publish approval store is not configured', false, {
        reason: 'publish-approval-store-unavailable',
      }));
    }

    const preflight = await this.adapter.publishPreflight(
      cwd.value,
      binding.value.remote,
      binding.value.branch,
      { signal },
    );
    if (!preflight.ok) return preflight;
    const runtimeDenial = publishRuntimeDenial(preflight.value.runtime);
    if (runtimeDenial !== undefined) return runtimeDenial;
    if (preflight.value.head !== binding.value.expectedSha) {
      return err(appError(
        'CONFLICT',
        'Publish approval requires the exact commit that is currently checked out',
        true,
        { reason: 'publish-head-moved' },
      ));
    }
    if (preflight.value.protectedBranch) {
      return err(appError(
        'PERMISSION_DENIED',
        'Publishing to a repository default branch is not supported',
        false,
        { reason: 'publish-protected-branch' },
      ));
    }
    if (preflight.value.defaultBranches.length === 0) {
      return err(appError(
        'CONFLICT',
        'Repository default branches could not be resolved, so a protected-branch check is not possible',
        true,
        { reason: 'publish-default-branch-unresolved' },
      ));
    }

    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      return err(appError('INTERNAL_ERROR', 'Publish approval clock is invalid', true));
    }
    const record: PublishApprovalRecord = {
      approvalId: randomUUID(),
      workspaceId: workspace.value.id,
      remote: binding.value.remote,
      branch: binding.value.branch,
      expectedSha: binding.value.expectedSha,
      approvedBy: publishApprover(actor),
      approvedAt: now,
      expiresAt: now + (ttlSeconds * 1000),
    };
    let recorded: boolean;
    try {
      recorded = await authority.record(record);
    } catch {
      return err(appError('INTERNAL_ERROR', 'Publish approval could not be recorded', true));
    }
    if (!recorded) {
      return err(appError('INTERNAL_ERROR', 'Publish approval could not be recorded', true, {
        reason: 'publish-approval-store-rejected',
      }));
    }
    return ok(record);
  }

  /**
   * Spend one receipt and publish exactly the approved commit to one branch.
   * Every precondition is re-read here; the receipt is spent immediately
   * before the adapter spawns Git. There is no force, tag, delete, `--all` or
   * caller-supplied argv, and a moved head invalidates the approval.
   */
  public async publish(
    actor: FileActor,
    request: GitPublishRequest,
    signal?: AbortSignal,
  ): Promise<Result<GitPublishReceipt>> {
    void actor;
    const binding = this.validatePublishBinding(request);
    if (!binding.ok) return binding;
    if (typeof request.approvalId !== 'string' || request.approvalId.length === 0
      || request.approvalId.length > 128) {
      return err(appError('INVALID_INPUT', 'Publish approval id is invalid'));
    }
    const authority = this.options.publishApprovalAuthority;
    if (authority === undefined) {
      return err(appError('INTERNAL_ERROR', 'Publish approval store is not configured', false, {
        reason: 'publish-approval-store-unavailable',
      }));
    }
    const workspace = await this.resolvePublishWorkspace(request.workspaceId, request.cwd);
    if (!workspace.ok) return workspace;
    const cwd = await this.resolveCwd(request.workspaceId, request.cwd);
    if (!cwd.ok) return cwd;

    const preflight = await this.adapter.publishPreflight(
      cwd.value,
      binding.value.remote,
      binding.value.branch,
      { signal },
    );
    if (!preflight.ok) return preflight;
    const runtimeDenial = publishRuntimeDenial(preflight.value.runtime);
    if (runtimeDenial !== undefined) return runtimeDenial;
    if (preflight.value.head !== binding.value.expectedSha) {
      return err(appError(
        'CONFLICT',
        'Publish requires the exact commit that is currently checked out',
        true,
        { reason: 'publish-head-moved' },
      ));
    }
    if (preflight.value.protectedBranch) {
      return err(appError(
        'PERMISSION_DENIED',
        'Publishing to a repository default branch is not supported',
        false,
        { reason: 'publish-protected-branch' },
      ));
    }
    if (preflight.value.defaultBranches.length === 0) {
      return err(appError(
        'CONFLICT',
        'Repository default branches could not be resolved, so a protected-branch check is not possible',
        true,
        { reason: 'publish-default-branch-unresolved' },
      ));
    }

    const now = this.options.now?.() ?? Date.now();
    const publishBinding: PublishApprovalBinding = {
      workspaceId: workspace.value.id,
      ...binding.value,
    };
    if (!isValidPublishBinding(publishBinding)) {
      return err(appError('INVALID_INPUT', 'Publish binding is invalid'));
    }
    let spent: boolean;
    try {
      spent = Number.isSafeInteger(now) && now >= 0
        && await authority.consume(request.approvalId, publishBinding, now);
    } catch {
      return err(appError('INTERNAL_ERROR', 'Publish approval could not be spent', true));
    }
    if (!spent) {
      return err(appError(
        'PERMISSION_REQUIRED',
        'Publish requires a live single-use approval for this exact workspace, remote, branch and commit',
        true,
        { reason: 'publish-approval-required' },
      ));
    }

    const published = await this.adapter.publish(cwd.value, {
      remote: binding.value.remote,
      branch: binding.value.branch,
      expectedSha: binding.value.expectedSha,
    }, { signal });
    if (!published.ok) return published;
    return ok({ ...published.value, approvalId: request.approvalId });
  }

  /** Shape-check a caller-supplied binding before any workspace or ledger read. */
  private validatePublishBinding(request: GitPublishBindingRequest): Result<Omit<PublishApprovalBinding, 'workspaceId'>> {
    const expectedSha = typeof request.expectedSha === 'string'
      ? request.expectedSha.toLowerCase()
      : request.expectedSha;
    if (!isPublishRemoteName(request.remote)) {
      return err(appError('INVALID_INPUT', 'Publish remote must be a configured remote name'));
    }
    if (!isPublishBranchName(request.branch)) {
      return err(appError('INVALID_INPUT', 'Publish branch is not a plain branch name'));
    }
    if (!isPublishObjectId(expectedSha)) {
      return err(appError('INVALID_INPUT', 'Publish expectedSha must be a full lowercase commit id'));
    }
    return ok({ remote: request.remote, branch: request.branch, expectedSha });
  }

  /**
   * The preflight reports the ledger state for the exact head it just resolved.
   * A missing port, a failed lookup, or a malformed clock reports `missing`:
   * diagnostics never claim an approval they could not read, and the publish
   * path must still spend a receipt in its own transaction.
   */
  private async inspectPublishApproval(
    workspaceId: string,
    remote: string,
    branch: string,
    expectedSha: string,
  ): Promise<PublishApprovalState> {
    const lookup = this.options.publishApprovals;
    if (lookup === undefined) return 'missing';
    try {
      const now = this.options.now?.() ?? Date.now();
      return await lookup.inspect({ workspaceId, remote, branch, expectedSha }, now);
    } catch {
      return 'missing';
    }
  }

  /** Resolve the workspace that owns the preflight target without repeating cwd checks. */
  private async resolvePublishWorkspace(
    workspaceId: string | undefined,
    requestedCwd: string | undefined,
  ): Promise<Result<Workspace>> {
    if (requestedCwd !== undefined && isAbsoluteFsPath(requestedCwd)) {
      return resolveWorkspaceForPath(this.workspaces, workspaceId, requestedCwd);
    }
    if (workspaceId === undefined || workspaceId.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'workspaceId is required unless cwd is an absolute path'));
    }
    return this.getWorkspace(workspaceId);
  }

  public async isAncestor(
    actor: FileActor,
    workspaceId: string,
    ancestorSha: string,
    descendantSha: string,
    signal?: AbortSignal,
  ): Promise<Result<boolean>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.isAncestor(workspace.value.realRootPath, ancestorSha, descendantSha, signal);
  }

  public async createRecoveryRef(
    actor: FileActor,
    workspaceId: string,
    recoveryRef: string,
    expectedHead: string,
    signal?: AbortSignal,
  ): Promise<Result<void>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.createRecoveryRef(workspace.value.realRootPath, recoveryRef, expectedHead, signal);
  }

  public async guardedRebase(
    actor: FileActor,
    workspaceId: string,
    request: GitGuardedRebaseRequest,
    signal?: AbortSignal,
  ): Promise<Result<GitGuardedRebaseResult>> {
    void actor;
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace.ok) return workspace;
    return this.adapter.guardedRebase(workspace.value.realRootPath, request, signal);
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
    const prohibitedConfigMutation = prohibitedGitConfigMutationReason(request.args);
    if (prohibitedConfigMutation !== undefined) return err(appError('PERMISSION_DENIED', prohibitedConfigMutation));
    const prohibitedSubcommand = prohibitedGitSubcommandReason(request.args);
    if (prohibitedSubcommand !== undefined) return err(appError('PERMISSION_DENIED', prohibitedSubcommand));
    if (isPush) {
      const prohibitedGlobalOption = prohibitedGitPushGlobalOptionReason(request.args);
      if (prohibitedGlobalOption !== undefined) return err(appError('PERMISSION_DENIED', prohibitedGlobalOption));
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
      const parsedPush = parseGitPushArguments(invocation.subcommandArgs);
      if (parsedPush.remote === undefined) return err(appError('PERMISSION_DENIED', 'Git push remote must be explicit so push side effects can be checked'));
      const pushSafetyResolver = this.adapter.validatePushSafety;
      if (typeof pushSafetyResolver !== 'function') return err(appError('PERMISSION_DENIED', 'Git push side effects could not be verified safely'));
      const pushSafety = await pushSafetyResolver.call(this.adapter, cwd.value, parsedPush.remote, { signal });
      if (!pushSafety.ok) return pushSafety;
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

/**
 * Turn a blocked preflight verdict into the same denial a publish attempt must
 * return before spending an approval. The reason travels with the error so a
 * caller can tell a policy allow from a runtime transport/credential block.
 */
function publishRuntimeDenial(runtime: GitPublishRuntimeStatus): Result<never> | undefined {
  if (runtime.ready) return undefined;
  return err(appError(
    'PERMISSION_DENIED',
    'Git publish is blocked by runtime transport or credential configuration',
    false,
    {
      reason: runtime.reason ?? 'push-runtime-blocked',
      ...(runtime.key === undefined ? {} : { key: runtime.key }),
    },
  ));
}

/** A bounded, non-secret actor label for the approval audit row. */
function publishApprover(actor: FileActor): string {
  const label = (actor.clientName.trim() || actor.clientId.trim()).slice(0, 256);
  return label.length === 0 ? 'unknown-client' : label;
}
