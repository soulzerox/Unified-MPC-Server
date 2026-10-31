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
  fingerprintPublishCredentialHosts,
  isPublishRemoteName,
  isValidPublishBinding,
  ok,
  type InvocationAuthorization,
  type PublishApprovalAuthorityPort,
  type PublishApprovalBinding,
  type PublishApprovalLookupPort,
  type PublishApprovalRecord,
  type PublishApprovalState,
  type PublishCredentialLease,
  type PublishCredentialMaterial,
  type PublishCredentialPort,
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
import type { PublishAuditInput, PublishAuditSink } from '@unified-mpc/audit';
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

/** A receipt read for the publish path; `consumedAt` is present when the ledger exposes it. */
type PublishReceipt = PublishApprovalRecord & { readonly consumedAt?: number | null };

export interface GitServiceOptionsBase {
  /** Host-owned approval ledger. Omitted keeps `approval: "missing"`. */
  readonly publishApprovals?: PublishApprovalLookupPort;
  /** Spend/mint side of the ledger, kept separate from the read-only lookup. */
  readonly publishApprovalAuthority?: PublishApprovalAuthorityPort;
  /** Test seam for a deterministic preflight clock. */
  readonly now?: () => number;
}

/**
 * A credential store is only useful with somewhere to record the spend: a
 * service that holds leases but no sink would spend a leased secret and leave
 * no row, so `publishCredentials` and `publishAudit` are required together
 * (#297 S2d). Credential-free services keep the sink optional.
 */
export type GitServiceOptions = GitServiceOptionsBase & (
  | {
    /** Omitted keeps every publish credential-free, exactly like S1. */
    readonly publishCredentials?: undefined;
    /**
     * Audit sink for credential-bound publishes. The input carries lease and
     * receipt metadata only; the secret never enters this port.
     */
    readonly publishAudit?: PublishAuditSink;
  }
  | {
    /**
     * Host-owned credential leases (#297 S2c): no lease is opened, no helper
     * is installed and the adapter's guard decides when omitted.
     */
    readonly publishCredentials: PublishCredentialPort;
    /**
     * Audit sink for credential-bound publishes (#297 S2d). Required with a
     * credential store so a spend can always name its lease and outcome.
     */
    readonly publishAudit: PublishAuditSink;
  }
);

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
    const credential = await this.openPublishCredential(workspace.value.id, request.remote, this.publishNow());
    if (!credential.ok) return credential;
    const preflight = await this.adapter.publishPreflight(cwd.value, request.remote, request.branch, {
      signal,
      ...(credential.value === null ? {} : { credential: { approvalId: 'diagnostic', material: credential.value } }),
    });
    if (!preflight.ok) return preflight;
    const approval = await this.inspectPublishApproval(
      workspace.value.id,
      request.remote,
      request.branch,
      preflight.value.head,
    );
    // #297 S2c: a helper-configured HTTP(S) target that the guard blocks is
    // exactly the case a live lease resolves. Name the missing step instead of
    // repeating the guard's configuration verdict, and leave every other
    // runtime block untouched.
    const runtime = credential.value === null && !preflight.value.runtime.ready
      && preflight.value.runtime.reason === 'push-credential-helper'
      ? { ...preflight.value.runtime, reason: 'publish-credential-required' }
      : preflight.value.runtime;
    return ok({ ...preflight.value, runtime, approval });
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
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      return err(appError('INTERNAL_ERROR', 'Publish approval clock is invalid', true));
    }

    // A lease that already exists binds this receipt to one host set and one
    // short expiry (#297 §5). Without a lease the receipt stays credential-free
    // and S1 behaviour is unchanged.
    const credential = await this.openPublishCredential(workspace.value.id, binding.value.remote, now);
    if (!credential.ok) return credential;

    const preflight = await this.adapter.publishPreflight(
      cwd.value,
      binding.value.remote,
      binding.value.branch,
      {
        signal,
        ...(credential.value === null ? {} : { credential: { approvalId: 'diagnostic', material: credential.value } }),
      },
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

    let credentialBinding: { readonly pushUrlFingerprint: string; readonly leaseId: string } | undefined;
    if (credential.value !== null) {
      const fingerprint = await this.adapter.publishTargetFingerprint(
        cwd.value,
        binding.value.remote,
        signal,
      );
      if (!fingerprint.ok) return fingerprint;
      const granted = fingerprintPublishCredentialHosts(credential.value.lease.hosts);
      if (granted === null || granted !== fingerprint.value) {
        return err(appError(
          'PERMISSION_DENIED',
          'Publish target changed after the credential lease was granted',
          false,
          { reason: 'publish-target-changed' },
        ));
      }
      credentialBinding = {
        pushUrlFingerprint: fingerprint.value,
        leaseId: credential.value.lease.leaseId,
      };
    }
    const record: PublishApprovalRecord = {
      approvalId: randomUUID(),
      workspaceId: workspace.value.id,
      remote: binding.value.remote,
      branch: binding.value.branch,
      expectedSha: binding.value.expectedSha,
      approvedBy: publishApprover(actor),
      approvedAt: now,
      // The receipt can never outlive the secret it may spend.
      expiresAt: credential.value === null
        ? now + (ttlSeconds * 1000)
        : Math.min(now + (ttlSeconds * 1000), credential.value.lease.expiresAt),
      ...(credentialBinding === undefined ? {} : credentialBinding),
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

    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      return err(appError('INTERNAL_ERROR', 'Publish approval clock is invalid', true));
    }

    // The receipt the human approved may be credential-bound (#297 §6). The
    // host binding is checked first: `.git/config` is agent-writable, so a
    // redirect after approval must fail with `publish-target-changed` before
    // any credential or remote contact, and without spending the receipt.
    const receipt = await this.readPublishReceipt(request.approvalId);
    const bound = receipt !== null
      && receipt.leaseId !== undefined
      && receipt.pushUrlFingerprint !== undefined;
    if (bound && receipt.consumedAt !== undefined && receipt.consumedAt !== null) {
      return err(appError(
        'PERMISSION_DENIED',
        'Publish requires the live credential lease this approval was bound to',
        false,
        { reason: 'publish-credential-unavailable' },
      ));
    }
    if (bound) {
      const fingerprint = await this.adapter.publishTargetFingerprint(
        cwd.value,
        binding.value.remote,
        signal,
      );
      if (!fingerprint.ok) return fingerprint;
      if (fingerprint.value !== receipt.pushUrlFingerprint) {
        return err(appError(
          'PERMISSION_DENIED',
          'Publish target changed after the approval was minted',
          false,
          { reason: 'publish-target-changed' },
        ));
      }
    }
    const credential = await this.openPublishCredential(workspace.value.id, binding.value.remote, now);
    if (!credential.ok) return credential;
    if (bound && (credential.value === null || credential.value.lease.leaseId !== receipt.leaseId)) {
      return err(appError(
        'PERMISSION_DENIED',
        'Publish requires the live credential lease this approval was bound to',
        false,
        { reason: 'publish-credential-unavailable' },
      ));
    }

    const preflight = await this.adapter.publishPreflight(
      cwd.value,
      binding.value.remote,
      binding.value.branch,
      {
        signal,
        ...(credential.value === null ? {} : { credential: { approvalId: 'diagnostic', material: credential.value } }),
      },
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

    // The receipt is bound to the fingerprint checked before the credential was
    // opened, so the spend below is exactly the lease the human approved. An
    // unbound receipt never delivers a credential, even when one is live.
    let spend: PublishCredentialMaterial | null = null;
    if (bound) {
      spend = credential.value;
    }

    const publishBinding: PublishApprovalBinding = {
      workspaceId: workspace.value.id,
      ...binding.value,
    };
    if (!isValidPublishBinding(publishBinding)) {
      return err(appError('INVALID_INPUT', 'Publish binding is invalid'));
    }
    let spent: boolean;
    try {
      spent = await authority.consume(request.approvalId, publishBinding, now);
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

    const publishRequest = {
      remote: binding.value.remote,
      branch: binding.value.branch,
      expectedSha: binding.value.expectedSha,
    };
    if (spend === null) {
      const published = await this.adapter.publish(cwd.value, publishRequest, { signal });
      if (!published.ok) return published;
      return ok({ ...published.value, approvalId: request.approvalId });
    }

    // Lease-for-the-spawn (#297 §5): the secret lives for one push plus its
    // verification, and the lease is revoked on success, failure, timeout and
    // abort. A failed revoke is bounded by the lease TTL and the expiry sweep,
    // so it must not turn a completed push into a reported failure.
    const auditStartedAt = this.publishNow();
    const auditBase = {
      actorId: actor.clientId,
      actorName: actor.clientName,
      workspaceId: workspace.value.id,
      action: 'publish_credential_use' as const,
      remote: binding.value.remote,
      leaseId: spend.lease.leaseId,
      approvalId: request.approvalId,
      branch: binding.value.branch,
      expectedSha: binding.value.expectedSha,
      hosts: spend.lease.hosts,
      username: spend.lease.username,
      ...(receipt?.pushUrlFingerprint === undefined ? {} : { pushUrlFingerprint: receipt.pushUrlFingerprint }),
    };
    let resultCode = 'SUCCESS';
    let reason: string | undefined;
    try {
      const published = await this.adapter.publish(cwd.value, publishRequest, {
        signal,
        credential: { approvalId: request.approvalId, material: spend },
      });
      if (!published.ok) {
        resultCode = published.error.code;
        reason = typeof published.error.details?.reason === 'string'
          ? published.error.details.reason
          : published.error.code;
        return published;
      }
      return ok({ ...published.value, approvalId: request.approvalId });
    } catch (error: unknown) {
      resultCode = 'INTERNAL_ERROR';
      reason = 'publish-unexpected-error';
      throw error;
    } finally {
      let leaseRevokeFailed = false;
      try {
        const revoked = await this.options.publishCredentials?.revoke(spend.lease.leaseId, this.publishNow());
        // `revoke` reports failure as an error result, not a throw, so an
        // unchecked await would drop a failed release silently and let the
        // row claim a clean spend.
        if (revoked !== undefined && !revoked.ok) leaseRevokeFailed = true;
      } catch {
        // Reclamation falls back to the TTL sweep; the push result stands.
        leaseRevokeFailed = true;
      }
      // The audit row is written after the spend so it can name the exact
      // lease and outcome. It never carries the secret and never changes the
      // publish result.
      await this.recordPublishAudit({
        ...auditBase,
        resultCode,
        ...(reason === undefined ? {} : { reason }),
        ...(leaseRevokeFailed ? { leaseRevokeFailed: true } : {}),
        durationMs: Math.max(0, this.publishNow() - auditStartedAt),
      });
    }
  }

  /**
   * The live lease for one workspace and remote, opened for a diagnostic read.
   * A missing port answers null, so a service without a credential store is
   * exactly S1. A lease row whose secret is already gone also answers null: a
   * credential-bound receipt then refuses with `publish-credential-unavailable`.
   */
  private async openPublishCredential(
    workspaceId: string,
    remote: string,
    now: number,
  ): Promise<Result<PublishCredentialMaterial | null>> {
    const port = this.options.publishCredentials;
    if (port === undefined) return ok(null);
    let lease: PublishCredentialLease | null;
    try {
      const found = await port.findLive(workspaceId, remote, now);
      if (!found.ok) return found;
      lease = found.value;
    } catch {
      return err(appError('INTERNAL_ERROR', 'The publish credential lease could not be read', true, {
        reason: 'publish-credential-store-unavailable',
      }));
    }
    if (lease === null) return ok(null);
    try {
      return await port.open(lease.leaseId, now);
    } catch {
      return err(appError('INTERNAL_ERROR', 'The publish credential lease could not be opened', true, {
        reason: 'publish-credential-store-unavailable',
      }));
    }
  }

  /**
   * The stored receipt, when the ledger can answer. A ledger without the
   * optional read, a failed read or an unknown id answers null: the receipt is
   * then treated as credential-free and still has to be spent.
   */
  private async readPublishReceipt(approvalId: string): Promise<PublishReceipt | null> {
    const read = this.options.publishApprovals?.read;
    if (typeof read !== 'function') return null;
    try {
      return await read.call(this.options.publishApprovals, approvalId);
    } catch {
      return null;
    }
  }

  /** A clock for cleanup paths that must not fail after the push completed. */
  private publishNow(): number {
    const now = this.options.now?.() ?? Date.now();
    return Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  }

  /**
   * Best-effort audit write. A failed audit insert must never turn a completed
   * push into a reported failure; the caller's result stands.
   */
  private async recordPublishAudit(input: PublishAuditInput): Promise<void> {
    const audit = this.options.publishAudit;
    if (audit === undefined) return;
    try {
      await audit.recordPublish(input);
    } catch {
      // The next audit write can still succeed; the publish result stands.
    }
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
