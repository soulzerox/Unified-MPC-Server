import { lstat, mkdir, readdir, readlink, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  appError,
  classifyWorkspaceSourceEvidence,
  err,
  ok,
  type Result,
  type ResultBudget,
  type WorkspaceSourceEvidenceIdentity,
} from '@unified-mpc/domain';
import {
  McpSessionManager,
  createPrivateFdAuthorizedClientFactory,
  type McpClientFactory,
  type McpServerLaunchConfig,
} from '@unified-mpc/extensions';
import { createThaiRagPrivateWorkerBootstrap } from './native-thai-rag-private-bootstrap.js';
import {
  ThaiRagIndexJobStore,
  ThaiRagWorkspaceVerificationStore,
  parseCanonicalWorkspaceId,
  resolveThaiRagProviderRoot,
  type ThaiRagWorkspaceVerificationRecord,
  THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
  THAI_RAG_CANCEL_CAPABILITY,
  THAI_RAG_EMBEDDING_COMPATIBILITY,
  THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
  THAI_RAG_PRODUCTION_BRIDGE,
  validateThaiRagHandshake,
  type ThaiRagProviderDriver,
  type ThaiRagProviderDriverHealth,
  type ThaiRagProviderDriverStartOptions,
  type ThaiRagProviderHandshake,
  type ThaiRagReindexReason,
} from '@unified-mpc/thai-rag';

const SERVER_NAME = 'thai-rag-native';
/**
 * Code indexing is FTS5-first (thai-rag-mcp #356): Unified indexes code
 * lexically and does not require an embedding backend for it, so a code pass
 * costs minutes instead of the 12 h CPU baseline it used to force. Embeddings
 * stay for chat/memory, which is a separate, small-volume pipeline.
 *
 * This policy needs the provider to answer a lexical-only publication as a
 * positive state (`evidence.semantic = "lexical_only"`, thai-rag-mcp #392);
 * `readPreEditReadiness` accepts that state as current, so `prepare_code_change`
 * no longer needs to force vectors to keep the gate open (issue #463).
 */
const CODE_INDEX_VECTORS = false;
// Publishing a full generation (CPG resolution + generation copy) can take far
// longer than a request; the provider answers as soon as the job is created,
// but the follow-up status/often-blocking calls must survive the publish.
const INDEX_CALL_TIMEOUT_MS = 3_600_000;
const INDEX_ADMISSION_WAIT_MS = 5_000;
/** Heartbeat cadence for synchronous provider calls that carry no provider job id. */
const SYNC_CALL_HEARTBEAT_MS = 60_000;

/**
 * Runs `work` while ticking `beat` on `intervalMs`, then stops ticking.
 *
 * A synchronous provider call (the bounded admission trial) carries no provider
 * job id, so the monitor has nothing to poll and the poll-driven heartbeat in
 * `waitForWorkspaceAdmissionIndex` never runs. Without this tick a multi-minute
 * trial is indistinguishable from a wedged owner and the stuck-job reaper
 * interrupts it (issue #445).
 */
export async function runWithHeartbeat<T>(
  work: Promise<T>,
  intervalMs: number,
  beat: () => unknown,
): Promise<T> {
  const timer = setInterval(() => {
    void beat();
  }, intervalMs);
  timer.unref?.();
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
const WORKSPACE_VERIFICATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const REQUIRED_TOOLS = new Set([
  'remember', 'recall', 'record_event', 'pre_edit_context', 'code_blast_radius',
  'forget', 'code_index', 'index_status', 'code_search', 'code_context',
  'health', 'version',
]);
// Memory/health operations are backed by their own provider state, not the
// code-index generation. They must stay usable while a workspace admission
// verification holds the single-indexer slot (issue #422).
const INDEX_GATE_EXEMPT_TOOLS = new Set([
  'remember', 'recall', 'forget', 'record_event', 'resolve_event', 'health', 'version',
]);

export interface NativeThaiRagWorkspace {
  readonly id: string;
  readonly rootPath?: string;
  readonly realRootPath: string;
}

export interface NativeThaiRagProviderDriverOptions {
  readonly dataRoot: string;
  readonly launchConfig: McpServerLaunchConfig;
  readonly workspacesProvider: () => Promise<readonly NativeThaiRagWorkspace[]>;
  readonly clientFactory?: McpClientFactory;
  /** Explicit native-only strict FD3 authority. Default remains legacy until security E2E cutover. */
  readonly strictWorkerAuthority?: boolean;
  /** Optional first-party host event signal per private child; a revoked signal permanently fences that child. */
  readonly strictWorkerRevocationSignalProvider?: () => AbortSignal;
  /** Optional trusted epoch source; read per child and fail closed on overflow. */
  readonly strictWorkerAuthorityGenerationProvider?: () => number;
  /** Reads the durable SQLite epoch for each private FD3 child's live RPC check. */
  readonly strictWorkerRegistryGenerationProvider?: () => number;
  /** Required for strict mode: admission-checked, host-owned workspace scopes; legacy uses workspacesProvider. */
  readonly strictWorkerAuthorizedWorkspacesProvider?: () => Promise<readonly NativeThaiRagWorkspace[]>;
  readonly callTimeoutMs?: number;
  /** Per-session timeout for the isolated admission snapshot probe (issue #422). */
  readonly snapshotProbeTimeoutMs?: number;
  readonly healthRefreshMs?: number;
  /** Poll interval for provider-owned background index jobs mirrored into the durable Unified job store. */
  readonly indexJobPollMs?: number;
  /** Consecutive index_status call timeouts tolerated by the admission monitor before the job is failed and the admission gate released (issue #407 deadline). */
  readonly indexStatusTimeoutCap?: number;
  /** Stuck-job reaper window for mirrored index jobs (issue #445 exposes it so a test can prove an embedding-phase heartbeat keeps a build alive). */
  readonly indexJobStuckTimeoutMs?: number;
  /**
   * Heartbeat cadence used while a synchronous provider call is in flight. The
   * bounded admission trial runs with `background: false`, so it has no provider
   * job id and the poll-driven heartbeat cannot fire; without this tick a long
   * trial is indistinguishable from a wedged owner (issue #445).
   */
  readonly indexJobHeartbeatMs?: number;
  /**
   * Durable source identity used to make admission verification idempotent
   * across provider restarts (issue #422). Returning null keeps the
   * conservative behaviour: the workspace is verified on every admission.
   */
  readonly workspaceSourceIdentityProvider?: (
    workspace: NativeThaiRagWorkspace,
  ) => Promise<WorkspaceSourceEvidenceIdentity | null>;
}

export class NativeThaiRagProviderDriver implements ThaiRagProviderDriver {
  private readonly sessions: McpSessionManager;
  private readonly indexSessions: McpSessionManager;
  // Isolated session for admission snapshot probes: a timed-out probe drops
  // only this child, never the warm request session or a live index session.
  private readonly probeSessions: McpSessionManager;
  private readonly snapshotProbeTimeoutMs: number;
  private readonly jobs: ThaiRagIndexJobStore;
  private readonly verifications: ThaiRagWorkspaceVerificationStore;
  private readonly healthRefreshMs: number;
  private readonly indexJobPollMs: number;
  private readonly indexStatusTimeoutCap: number;
  private ownerId: string | undefined;
  private launchConfig: McpServerLaunchConfig | undefined;
  private lastHealth: ThaiRagProviderDriverHealth | undefined;
  private lastHealthAt = 0;
  private workerQueue: Promise<unknown> = Promise.resolve();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly workspaceRootIds = new Map<string, string>();
  private readonly pendingReindexIds = new Set<string>();
  private readonly pendingReindexReasons = new Map<string, ThaiRagReindexReason>();
  private readonly queuedAdmissionWorkspaceIds = new Set<string>();
  private readonly workspaceIndexJobIds = new Map<string, string>();
  private readonly workspaceIndexMonitors = new Map<string, Promise<Result<void>>>();
  private indexingWorkspaceId: string | undefined;
  private expectedEmbeddingIndexGeneration = 1;
  private started = false;
  private lifecycleGeneration = 0;
  private shuttingDown = false;
  private stopRequested = false;
  private stopped = false;
  private activeOperations = 0;
  private idleWaiters: Array<() => void> = [];
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private stopPromise: Promise<Result<void>> | undefined;
  private cancellableIndexJobs = false;
  private readonly indexJobMonitors = new Map<string, Promise<void>>();

  public constructor(private readonly options: NativeThaiRagProviderDriverOptions) {
    if (options.strictWorkerAuthority === true && options.clientFactory !== undefined) {
      throw new Error('native_thai_rag_strict_factory_conflict');
    }
    if (options.strictWorkerAuthority === true && options.strictWorkerAuthorizedWorkspacesProvider === undefined) {
      throw new Error('native_thai_rag_strict_admission_provider_required');
    }
    // Both normal and admission/index sessions MUST use this same trusted factory
    // so every child, including reconnects, gets its own independently keyed FD3.
    const chosenFactory = options.strictWorkerAuthority === true
      ? createPrivateFdAuthorizedClientFactory({
          createBootstrap: async () => {
            if (this.ownerId === undefined || this.stopRequested || this.shuttingDown) {
              throw new Error('native_thai_rag_strict_worker_not_ready');
            }
            return createThaiRagPrivateWorkerBootstrap({
              ownerId: this.ownerId,
              authorityGeneration: this.lifecycleGeneration + (options.strictWorkerAuthorityGenerationProvider?.() ?? 1),
              workspacesProvider: options.strictWorkerAuthorizedWorkspacesProvider!,
              ...(options.strictWorkerRegistryGenerationProvider === undefined ? {} : {
                registryGenerationProvider: options.strictWorkerRegistryGenerationProvider,
              }),
              ...(options.strictWorkerRevocationSignalProvider === undefined ? {} : {
                revocationSignal: options.strictWorkerRevocationSignalProvider(),
              }),
            });
          },
        })
      : options.clientFactory;
    this.snapshotProbeTimeoutMs = Math.max(1, Math.floor(options.snapshotProbeTimeoutMs ?? 5_000));
    this.sessions = new McpSessionManager({
      ...(chosenFactory === undefined ? {} : { clientFactory: chosenFactory }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
      validateToolSchemas: false,
      preserveReadOnlyStatusSessionOnTimeout: true,
      idleTimeoutMs: 24 * 60 * 60_000,
    });
    this.indexSessions = new McpSessionManager({
      ...(chosenFactory === undefined ? {} : { clientFactory: chosenFactory }),
      callTimeoutMs: Math.max(options.callTimeoutMs ?? 60_000, INDEX_CALL_TIMEOUT_MS),
      validateToolSchemas: false,
      preserveReadOnlyStatusSessionOnTimeout: true,
      idleTimeoutMs: 24 * 60 * 60_000,
    });
    this.probeSessions = new McpSessionManager({
      ...(chosenFactory === undefined ? {} : { clientFactory: chosenFactory }),
      callTimeoutMs: this.snapshotProbeTimeoutMs,
      validateToolSchemas: false,
      // A probe child is not pinned: let it age out instead of keeping a
      // permanent extra provider child alive for the whole driver lifetime.
      idleTimeoutMs: 60_000,
    });
    this.jobs = new ThaiRagIndexJobStore(
      options.dataRoot,
      undefined,
      options.indexJobStuckTimeoutMs === undefined ? undefined : { stuckJobTimeoutMs: options.indexJobStuckTimeoutMs },
    );
    this.verifications = new ThaiRagWorkspaceVerificationStore(options.dataRoot);
    this.healthRefreshMs = options.healthRefreshMs ?? 5_000;
    this.indexJobPollMs = Math.max(10, Math.floor(options.indexJobPollMs ?? 500));
    this.indexStatusTimeoutCap = Math.max(1, Math.floor(options.indexStatusTimeoutCap ?? 30));
  }

  public start(options: ThaiRagProviderDriverStartOptions, signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    if (this.stopRequested || this.stopped) {
      return Promise.resolve(err(appError('CONFLICT', 'Native Thai-RAG provider cannot restart after stop', true)));
    }
    return this.enqueueLifecycle(() => this.startNow(options, signal));
  }

  private async startNow(options: ThaiRagProviderDriverStartOptions, signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    if (this.stopRequested) return err(appError('CONFLICT', 'Native Thai-RAG provider cannot start while stopping', true));
    this.shuttingDown = false;
    this.expectedEmbeddingIndexGeneration = options.embeddingIndexGeneration;
    this.ownerId = options.ownerId;
    await this.jobs.initialize(options.ownerId);
    const providerRoot = resolveThaiRagProviderRoot(this.options.dataRoot);
    if (!providerRoot.ok) return providerRoot;
    const refreshed = await this.refreshWorkspaceRoots();
    if (!refreshed.ok) return refreshed;
    if (this.stopRequested) return err(appError('CONFLICT', 'Native Thai-RAG provider stopped during startup', true));
    const sourcesRoot = path.join(providerRoot.value, 'sources');

    this.launchConfig = {
      ...this.options.launchConfig,
      cwd: sourcesRoot,
      env: {
        ...(this.options.launchConfig.env ?? {}),
        THAI_RAG_CACHE_DIR: path.join(options.providerRoot, 'runtime'),
      },
    };
    const described = await this.sessions.describe(SERVER_NAME, this.launchConfig, signal);
    if (!described.ok) return described;
    if (this.stopRequested) {
      await this.sessions.close().catch(() => undefined);
      return err(appError('CONFLICT', 'Native Thai-RAG provider stopped during startup', true));
    }
    const toolNames = new Set(described.value.tools.map((tool) => tool.name));
    const missing = [...REQUIRED_TOOLS].filter((tool) => !toolNames.has(tool));
    if (missing.length > 0) {
      await this.sessions.close().catch(() => undefined);
      return err(appError('CONFLICT', `Native Thai-RAG worker handshake missing capabilities: ${missing.join(', ')}`, true, { reason: 'missing-capability', missing: missing.join(',') }));
    }
    const version = await this.callWorker('version', {}, signal);
    if (!version.ok) {
      await this.sessions.close().catch(() => undefined);
      return version;
    }
    const handshake = parseProviderHandshake(version.value);
    if (!handshake.ok) {
      await this.sessions.close().catch(() => undefined);
      return handshake;
    }
    const compatible = validateThaiRagHandshake(handshake.value, {
      embeddingIndexGeneration: options.embeddingIndexGeneration,
      allowLegacyAdapter: handshake.value.legacyAdapter === THAI_RAG_PRODUCTION_BRIDGE,
      allowMissingPreprocessingVersion: true,
      ...embeddingCompatibility(handshake.value.contractVersion),
      allowedDegradedCapabilities: THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
    });
    if (!compatible.ok) {
      await this.sessions.close().catch(() => undefined);
      return compatible;
    }
    const versionSupportsCancellation = handshake.value.indexJobContractVersion === '1.1'
      && handshake.value.capabilities.includes(THAI_RAG_CANCEL_CAPABILITY);
    if (versionSupportsCancellation && !toolNames.has(THAI_RAG_CANCEL_CAPABILITY)) {
      await this.sessions.close().catch(() => undefined);
      return err(appError(
        'CONFLICT',
        'Native Thai-RAG worker attests cancellable index jobs but does not expose cancel_index',
        true,
        { reason: 'missing-capability', missing: THAI_RAG_CANCEL_CAPABILITY },
      ));
    }
    const versionSupportsLegacyAdoption = handshake.value.capabilities.includes(
      THAI_RAG_LEGACY_ADOPTION_CAPABILITY,
    );
    if (versionSupportsLegacyAdoption && !toolNames.has(THAI_RAG_LEGACY_ADOPTION_CAPABILITY)) {
      await this.sessions.close().catch(() => undefined);
      return err(appError(
        'CONFLICT',
        'Native Thai-RAG worker attests legacy index adoption but does not expose adopt_legacy_index',
        true,
        { reason: 'missing-capability', missing: THAI_RAG_LEGACY_ADOPTION_CAPABILITY },
      ));
    }
    const healthProbe = await this.callWorker('health', {}, signal);
    if (!healthProbe.ok) {
      await this.sessions.close().catch(() => undefined);
      return healthProbe;
    }
    const healthHandshake = parseProviderHandshake(healthProbe.value);
    if (!healthHandshake.ok) {
      await this.sessions.close().catch(() => undefined);
      return healthHandshake;
    }
    const healthy = validateThaiRagHandshake(healthHandshake.value, {
      embeddingIndexGeneration: options.embeddingIndexGeneration,
      allowLegacyAdapter: healthHandshake.value.legacyAdapter === THAI_RAG_PRODUCTION_BRIDGE,
      allowMissingPreprocessingVersion: true,
      ...embeddingCompatibility(healthHandshake.value.contractVersion),
      allowedDegradedCapabilities: THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
    });
    if (!healthy.ok) {
      await this.sessions.close().catch(() => undefined);
      return healthy;
    }
    this.cancellableIndexJobs = versionSupportsCancellation
      && healthHandshake.value.indexJobContractVersion === '1.1'
      && healthHandshake.value.capabilities.includes(THAI_RAG_CANCEL_CAPABILITY);
    this.sessions.pin(SERVER_NAME);
    this.started = true;
    for (const workspaceId of this.workspaceRoots.keys()) {
      this.pendingReindexIds.add(workspaceId);
      if (!this.pendingReindexReasons.has(workspaceId)) {
        this.pendingReindexReasons.set(workspaceId, 'startup_verification');
      }
    }
    const health = await this.refreshHealth(signal);
    if (!health.ok) return health;
    if (this.stopRequested) {
      await this.sessions.close().catch(() => undefined);
      return err(appError('CONFLICT', 'Native Thai-RAG provider stopped during startup', true));
    }
    return health;
  }

  public health(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    return this.withOperation(() => this.healthStarted(signal));
  }

  private async healthStarted(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    if (!this.started || this.launchConfig === undefined) {
      return err(appError('CONFLICT', 'Native Thai-RAG worker is not started', true));
    }
    const refreshed = this.indexingWorkspaceId === undefined ? await this.refreshWorkspaceRoots() : ok(undefined);
    if (!refreshed.ok) return refreshed;
    const activeJobs = await this.jobs.active(this.ownerId ?? '');
    if (activeJobs.length > 0 && this.lastHealth !== undefined) {
      return ok({ ...this.lastHealth, activeJobs: activeJobs.map((job) => job.jobId) });
    }
    if (this.lastHealth !== undefined && Date.now() - this.lastHealthAt < this.healthRefreshMs) {
      return ok(this.lastHealth);
    }
    return this.refreshHealth(signal);
  }

  public call(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>> {
    return this.withOperation(() => this.callStarted(tool, args, signal, budget));
  }

  private async callStarted(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>> {
    if (!this.started || this.launchConfig === undefined) {
      return err(appError('CONFLICT', 'Native Thai-RAG worker is not started', true));
    }
    // A UUID-shaped caller argument is not proof of workspace ownership.
    // Check Unified's authoritative live registry before any scoped dispatch,
    // including index-job reads/cancellation and the provider IPC bridge.
    // code_index can also resolve a registered workspace from workspace_path.
    const requestedId = typeof args.workspace_id === 'string' ? args.workspace_id : '';
    if (tool !== 'health' && tool !== 'version' && (tool !== 'code_index' || requestedId.length > 0)) {
      const canonical = parseCanonicalWorkspaceId(requestedId);
      if (!canonical.ok) {
        return err(appError('INVALID_INPUT', 'Native Thai-RAG requires a canonical workspace_id',
          false, { reason: 'workspace_scope_required' }));
      }
      let registered: readonly NativeThaiRagWorkspace[];
      try {
        registered = await this.options.workspacesProvider();
      } catch (error: unknown) {
        return err(appError('INTERNAL_ERROR', `Native Thai-RAG cannot verify workspace registration: ${errorMessage(error)}`, true));
      }
      if (!registered.some((workspace) => workspace.id === canonical.value)) {
        return err(appError('WORKSPACE_NOT_FOUND', `Native Thai-RAG workspace is not registered: ${canonical.value}`));
      }
    }
    if (tool === 'adopt_legacy_index') return this.adoptLegacyIndex(args, signal, budget);
    if (tool === 'index_status') {
      const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
      const workspaceValue = typeof args.workspace_id === 'string' ? args.workspace_id : '';
      const workspace = parseCanonicalWorkspaceId(workspaceValue);
      if (jobId.length === 0 || !workspace.ok) return err(appError('INVALID_INPUT', 'Thai-RAG index_status requires job_id and workspace_id'));
      const job = await this.jobs.get(jobId, this.ownerId ?? '', workspace.value);
      if (job !== null) return ok(job);
      // Issue #445: a provider-owned build has no mirror row, so the owner
      // fence has nothing to return. Mirrored ids stay fenced exactly as
      // before; an id the mirror can never hold is read from its authority.
      if (!isProviderOwnedIndexJobId(jobId)) {
        return err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`));
      }
      return this.readProviderOwnedIndexJob(jobId, workspace.value, budget);
    }
    const bypassBusyRefresh = INDEX_GATE_EXEMPT_TOOLS.has(tool)
      || (tool === 'pre_edit_context' && await this.canServeReadyWorkspaceDuringIndex(args));
    const workspaceId = typeof args.workspace_id === 'string' ? args.workspace_id : undefined;
    const refreshed = tool === 'cancel_index' || bypassBusyRefresh
      ? ok(undefined)
      : await this.refreshWorkspaceRoots(this.lifecycleGeneration, workspaceId);
    if (!refreshed.ok) {
      const details = refreshed.error.details;
      // Reusing the running job is an idempotent answer only for a plain
      // refresh: a cold-start admission runs `force: false`, so reporting it as
      // the receipt for a forced rebuild would tell the caller a rebuild was
      // enqueued when it was not (issue #460). A forced request keeps the
      // truthful CONFLICT and its blocking job id.
      if (tool === 'code_index' && args.force !== true && isRecord(details)
        && details.reason === 'workspace-indexing'
        && typeof details.jobId === 'string'
        && typeof details.workspaceId === 'string'
        && details.workspaceId === workspaceId) {
        return ok({ job_id: details.jobId, status: 'running', workspace_id: workspaceId });
      }
      return refreshed;
    }
    if (tool === 'cancel_index') return this.cancelIndex(args, budget);
    if (tool === 'code_index') return this.codeIndex(args, signal, budget);
    const normalizedArgs = tool === 'pre_edit_context' ? this.canonicalPreEditArgs(args) : ok(args);
    if (!normalizedArgs.ok) return normalizedArgs;
    return bypassBusyRefresh
      ? normalizeWorkerCallResult(tool, await this.sessions.call(SERVER_NAME, this.launchConfig, tool, normalizedArgs.value, signal, {}, budget))
      : this.callWorker(tool, normalizedArgs.value, signal, budget);
  }

  private async canServeReadyWorkspaceDuringIndex(args: Readonly<Record<string, unknown>>): Promise<boolean> {
    const workspaceId = typeof args.workspace_id === 'string' ? args.workspace_id : '';
    const knownRoot = this.workspaceRoots.get(workspaceId);
    const sourcesRoot = this.launchConfig?.cwd;
    if (knownRoot === undefined || sourcesRoot === undefined || this.pendingReindexIds.has(workspaceId)) return false;
    try {
      const current = (await this.options.workspacesProvider()).find((workspace) => workspace.id === workspaceId);
      if (current === undefined || path.resolve(current.realRootPath) !== knownRoot) return false;
      const alias = path.join(sourcesRoot, workspaceId);
      const metadata = await lstat(alias);
      return metadata.isSymbolicLink() && path.resolve(path.dirname(alias), await readlink(alias)) === knownRoot;
    } catch {
      return false;
    }
  }

  public stop(): Promise<Result<void>> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopRequested = true;
    this.stopPromise = this.enqueueLifecycle(() => this.stopNow());
    return this.stopPromise;
  }

  private async stopNow(): Promise<Result<void>> {
    this.started = false;
    this.shuttingDown = true;
    this.lifecycleGeneration += 1;
    this.queuedAdmissionWorkspaceIds.clear();
    if (this.cancellableIndexJobs) await this.cancelActiveProviderIndexJobs();
    await this.jobs.interruptRunning(this.ownerId ?? '');
    await this.waitForOperations();
    await this.workerQueue.catch(() => undefined);
    this.sessions.unpin(SERVER_NAME);
    await this.sessions.close().catch(() => undefined);
    await this.indexSessions.close().catch(() => undefined);
    await this.probeSessions.close().catch(() => undefined);
    await Promise.allSettled(this.workspaceIndexMonitors.values());
    this.stopped = true;
    return ok(undefined);
  }

  private async adoptLegacyIndex(
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    // Refresh aliases/roots without a requested workspace so a relink is
    // observed but cannot trigger admission code_index ahead of adoption.
    const refreshed = await this.refreshWorkspaceRoots(this.lifecycleGeneration);
    if (!refreshed.ok) return refreshed;
    const workspaceValue = typeof args.workspace_id === 'string' ? args.workspace_id : '';
    const workspace = this.resolveIndexWorkspace(workspaceValue);
    if (!workspace.ok) return workspace;
    const legacyEmbedding = typeof args.legacy_embedding_profile_fingerprint === 'string'
      ? args.legacy_embedding_profile_fingerprint
      : undefined;
    const legacyChunking = typeof args.legacy_chunking_fingerprint === 'string'
      ? args.legacy_chunking_fingerprint
      : undefined;
    return this.callWorker('adopt_legacy_index', {
      workspace_path: workspace.value.rootPath,
      workspace_id: workspace.value.workspaceId,
      dry_run: args.dry_run !== false,
      ...(legacyEmbedding === undefined ? {} : {
        legacy_embedding_profile_fingerprint: legacyEmbedding,
      }),
      ...(legacyChunking === undefined ? {} : {
        legacy_chunking_fingerprint: legacyChunking,
      }),
    }, signal, budget);
  }

  private async codeIndex(args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>> {
    const workspaceValue = typeof args.workspace_path === 'string' ? args.workspace_path : '';
    const workspace = this.resolveIndexWorkspace(workspaceValue);
    if (!workspace.ok) return workspace;
    if (typeof args.workspace_id === 'string' && args.workspace_id !== workspace.value.workspaceId) {
      return err(appError('PERMISSION_DENIED', 'Native Thai-RAG code_index workspace_id does not match registered workspace root'));
    }
    const force = args.force === true;
    const background = args.background === true;
    // Scoped demand-first deltas (#346 U10) are described by the caller as
    // `paths` + `max_files`. They must reach the provider verbatim: dropping
    // them silently turns a bounded 8-file delta into a full-workspace pass.
    const requestedPaths = Array.isArray(args.paths)
      ? args.paths
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
      : [];
    const maxFiles = typeof args.max_files === 'number'
      && Number.isInteger(args.max_files)
      && args.max_files > 0
      ? args.max_files
      : undefined;
    const childArgs = {
      workspace_path: workspace.value.rootPath,
      workspace_id: workspace.value.workspaceId,
      force,
      background: false,
      vectors: CODE_INDEX_VECTORS,
      ...(requestedPaths.length === 0 ? {} : { paths: requestedPaths }),
      ...(maxFiles === undefined ? {} : { max_files: maxFiles }),
    };
    if (!background) return this.callIndexWorker('code_index', childArgs, signal, budget);
    if (!this.cancellableIndexJobs) return this.legacyBackgroundCodeIndex(workspace.value.workspaceId, childArgs, force, budget);
    return this.cancellableBackgroundCodeIndex(workspace.value.workspaceId, childArgs, force, budget);
  }

  private async legacyBackgroundCodeIndex(
    workspaceId: string,
    childArgs: Readonly<Record<string, unknown>>,
    force: boolean,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    const job = await this.jobs.create(
      workspaceId,
      force,
      this.ownerId ?? '',
      force ? 'explicit_force_reindex' : 'explicit_request',
    );
    const operation = this.enqueueWorker(async () => {
      const result = await this.retryStorageBusy(async () => normalizeWorkerCallResult(
        'code_index',
        await this.indexSessions.call(SERVER_NAME, this.launchConfig!, 'code_index', childArgs, undefined, {}, budget),
      ));
      if (result.ok) await this.jobs.complete(job.jobId, result.value, this.ownerId ?? '');
      else await this.jobs.fail(job.jobId, result.error.message, this.ownerId ?? '');
      return result;
    });
    void operation.catch(async (error: unknown) => {
      await this.jobs.fail(job.jobId, errorMessage(error), this.ownerId ?? '').catch(() => undefined);
    });
    return ok({ job_id: job.jobId, status: 'running', workspace_id: workspaceId });
  }

  private async cancellableBackgroundCodeIndex(
    workspaceId: string,
    childArgs: Readonly<Record<string, unknown>>,
    force: boolean,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    const ownerId = this.ownerId ?? '';
    const job = await this.jobs.create(
      workspaceId,
      force,
      ownerId,
      force ? 'explicit_force_reindex' : 'explicit_request',
    );
    const started = await this.retryStorageBusy(
      () => this.callIndexWorker('code_index', { ...childArgs, background: true }, undefined, budget),
    );
    if (!started.ok) {
      await this.jobs.fail(job.jobId, started.error.message, ownerId);
      return started;
    }
    const providerJobId = nestedString(started.value, 'job_id');
    if (providerJobId === undefined) {
      const message = 'Native Thai-RAG background index response omitted provider job_id';
      await this.jobs.fail(job.jobId, message, ownerId);
      return err(appError('CONFLICT', message, true, { reason: 'missing-provider-job-id' }));
    }
    await this.jobs.bindProviderJob(job.jobId, providerJobId, ownerId);
    this.startIndexJobMonitor(job.jobId, providerJobId, workspaceId, ownerId);
    return ok({ job_id: job.jobId, status: 'running', workspace_id: workspaceId });
  }

  private async cancelIndex(args: Readonly<Record<string, unknown>>, budget?: ResultBudget): Promise<Result<unknown>> {
    const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
    const workspaceValue = typeof args.workspace_id === 'string' ? args.workspace_id : '';
    const workspace = parseCanonicalWorkspaceId(workspaceValue);
    if (jobId.length === 0 || !workspace.ok) {
      return err(appError('INVALID_INPUT', 'Thai-RAG cancel_index requires job_id and workspace_id'));
    }
    const ownerId = this.ownerId ?? '';
    const job = await this.jobs.get(jobId, ownerId, workspace.value);
    if (job === null) {
      // Issue #445: the provider can be running an index job this mirror never
      // recorded. Its own durable "desired work" queue drains straight into
      // `code_index` after a restart, while the previous owner's row is already
      // `interrupted`, so no mirror row exists to resolve. Owner-scoped rows
      // stay fenced, but a provider job id the store can never hold is a
      // different case: the provider is its authority, and without forwarding
      // the only way to stop a runaway build was killing the provider.
      if (!isProviderOwnedIndexJobId(jobId)) {
        return err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`));
      }
      if (!this.cancellableIndexJobs) {
        return err(appError(
          'CONFLICT',
          'Native Thai-RAG index job cannot be cancelled because the active provider uses the legacy job contract',
          true,
          { reason: 'cancellation-unavailable', jobId },
        ));
      }
      return this.cancelProviderOwnedIndexJob(jobId, workspace.value, budget);
    }
    if (job.status !== 'running' && job.status !== 'cancelling') return ok(job);
    if (!this.cancellableIndexJobs || job.providerJobId === undefined) {
      return err(appError(
        'CONFLICT',
        'Native Thai-RAG index job cannot be cancelled because the active provider uses the legacy job contract',
        true,
        { reason: 'cancellation-unavailable', jobId },
      ));
    }

    const cancelled = this.workspaceIndexJobIds.get(workspace.value) === jobId
      ? await this.callAdmissionWorker('cancel_index', { job_id: job.providerJobId, workspace_id: workspace.value })
      : await this.callWorker('cancel_index', { job_id: job.providerJobId, workspace_id: workspace.value }, undefined, budget);
    if (!cancelled.ok) {
      // Issue #445: the provider can forget a job it accepted (restart or
      // retention expiry). Cancellation can then never succeed, and returning
      // the raw CONFLICT left the mirrored row `running` forever: health kept
      // advertising a job that no longer exists, and `healthStarted` kept
      // serving its cached snapshot instead of refreshing while it did.
      // Nothing can cancel an unknown provider job, so record the truth.
      if (isLostProviderIndexJob(cancelled.error)) {
        const terminal = await this.jobs.fail(
          jobId,
          `Native Thai-RAG provider no longer knows index job ${job.providerJobId ?? jobId} (provider-job-lost); it cannot be cancelled`,
          ownerId,
        );
        return terminal === null
          ? err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`))
          : ok(terminal);
      }
      return cancelled;
    }

    const remoteStatus = nestedString(cancelled.value, 'status');
    if (remoteStatus === 'cancelled') {
      const terminal = await this.jobs.cancel(jobId, nestedValue(cancelled.value, 'result') ?? cancelled.value, ownerId);
      return terminal === null ? err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`)) : ok(terminal);
    }
    if (remoteStatus === 'done') {
      const terminal = await this.jobs.complete(jobId, nestedValue(cancelled.value, 'result') ?? cancelled.value, ownerId);
      return terminal === null ? err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`)) : ok(terminal);
    }
    if (remoteStatus === 'error') {
      const message = nestedString(cancelled.value, 'error') ?? 'Native Thai-RAG provider reported an index error while cancellation was requested';
      const terminal = await this.jobs.fail(jobId, message, ownerId);
      return terminal === null ? err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`)) : ok(terminal);
    }
    const next = await this.jobs.requestCancellation(jobId, ownerId);
    return next === null ? err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`)) : ok(next);
  }

  /**
   * Forward a cancellation for a provider job that has no mirror row (issue
   * #445). Nothing local is written: the provider owns the job, and its own
   * answer is the only truthful status. Mirror rows keep their owner fence —
   * this path is reachable only for ids the mirror can never hold.
   */
  private async cancelProviderOwnedIndexJob(
    providerJobId: string,
    workspaceId: string,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    const cancelled = await this.callWorker(
      'cancel_index',
      { job_id: providerJobId, workspace_id: workspaceId },
      undefined,
      budget,
    );
    if (!cancelled.ok) return cancelled;
    const status = nestedString(cancelled.value, 'status');
    if (status === undefined || status === 'unknown' || status === 'scope_denied') {
      const message = nestedString(cancelled.value, 'error')
        ?? `Native Thai-RAG provider does not know index job ${providerJobId}`;
      return err(appError('FILE_NOT_FOUND', message, false, {
        reason: 'provider-job-unknown',
        jobId: providerJobId,
        workspaceId,
      }));
    }
    return ok({
      jobId: providerJobId,
      workspaceId,
      providerJobId,
      status,
      source: 'provider',
    });
  }

  /**
   * Read a provider-owned index job that has no mirror row (issue #445). The
   * provider is the only authority for a build it drained from its own durable
   * queue, so its snapshot is returned as-is instead of inventing a local row.
   * A job the provider cannot resolve maps to FILE_NOT_FOUND, matching the
   * mirrored lookup contract.
   */
  private async readProviderOwnedIndexJob(
    providerJobId: string,
    workspaceId: string,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    const status = await this.callWorker(
      'index_status',
      { job_id: providerJobId, workspace_id: workspaceId },
      undefined,
      budget,
    );
    if (!status.ok) {
      if (!isLostProviderIndexJob(status.error)) return status;
      return err(appError('FILE_NOT_FOUND', status.error.message, false, {
        reason: 'provider-job-unknown',
        jobId: providerJobId,
        workspaceId,
      }));
    }
    const state = nestedString(status.value, 'status');
    if (state === undefined || state === 'unknown' || state === 'scope_denied') {
      const message = nestedString(status.value, 'error')
        ?? `Native Thai-RAG provider does not know index job ${providerJobId}`;
      return err(appError('FILE_NOT_FOUND', message, false, {
        reason: 'provider-job-unknown',
        jobId: providerJobId,
        workspaceId,
      }));
    }
    const progress = nativeIndexProgress(status.value);
    const error = nestedString(status.value, 'error');
    const result = nestedValue(status.value, 'result');
    return ok({
      jobId: providerJobId,
      workspaceId,
      providerJobId,
      status: state,
      source: 'provider',
      ...(progress === undefined ? {} : progress),
      ...(error === undefined ? {} : { error }),
      ...(result === undefined ? {} : { result }),
    });
  }

  /**
   * Re-issue the index for a mirrored job whose provider-side registry entry
   * vanished (issue #449). The provider stays the authority for the job id, so
   * the durable row keeps its identity and only the provider binding moves.
   * Returns undefined when no replacement could be bound; the caller then
   * falls back to its terminal failure path.
   */
  private async restartIndexJobAfterProviderLoss(
    jobId: string,
    workspaceId: string,
    ownerId: string,
    session: 'index' | 'admission',
  ): Promise<string | undefined> {
    const rootPath = this.workspaceRoots.get(workspaceId);
    if (rootPath === undefined) return undefined;
    const args = {
      workspace_path: path.resolve(rootPath),
      workspace_id: workspaceId,
      // A lost job is resumable: published chunk embeddings are reused, so the
      // restart continues the generation instead of rebuilding it.
      force: false,
      background: true,
      vectors: CODE_INDEX_VECTORS,
    };
    const started = await this.retryStorageBusy(() => (session === 'admission'
      ? this.callAdmissionWorker('code_index', args)
      : this.callIndexWorker('code_index', args)));
    if (!started.ok) return undefined;
    const providerJobId = nestedString(started.value, 'job_id');
    if (providerJobId === undefined) return undefined;
    const rebound = await this.jobs.bindProviderJob(jobId, providerJobId, ownerId);
    return rebound === null ? undefined : providerJobId;
  }

  private startIndexJobMonitor(jobId: string, providerJobId: string, workspaceId: string, ownerId: string): void {
    const monitor = this.monitorIndexJob(jobId, providerJobId, workspaceId, ownerId)
      .catch(async (error: unknown) => {
        if (!this.shuttingDown) await this.jobs.fail(jobId, errorMessage(error), ownerId).catch(() => undefined);
      })
      .finally(() => {
        if (this.indexJobMonitors.get(jobId) === monitor) this.indexJobMonitors.delete(jobId);
      });
    this.indexJobMonitors.set(jobId, monitor);
  }

  private async monitorIndexJob(
    jobId: string,
    providerJobId: string,
    workspaceId: string,
    ownerId: string,
    restarts = 0,
  ): Promise<void> {
    let consecutiveStatusTimeouts = 0;
    while (!this.shuttingDown) {
      await delay(this.indexJobPollMs);
      if (this.shuttingDown) return;
      const local = await this.jobs.get(jobId, ownerId, workspaceId);
      if (local === null || (local.status !== 'running' && local.status !== 'cancelling')) return;

      const status = await this.callWorker('index_status', {
        job_id: providerJobId,
        workspace_id: workspaceId,
      });
      if (this.shuttingDown) return;
      if (!status.ok) {
        // Issue #439: the worker answers index_status from the same session
        // that is busy embedding, so a heavy batch starves the read. A
        // timed-out read is not evidence that the provider-owned job failed;
        // keep the provider job, the local running row and the same
        // providerJobId, and retry with backoff until the same bounded cap the
        // admission monitor uses (issue #407) turns an unreachable provider
        // into an actionable failure.
        if (!isIndexStatusPollTimeout(status.error)) {
          // Issue #449: the provider lost its in-memory job registry entry.
          // Its contract is "re-run code_index", so restart and rebind the
          // same mirrored job instead of abandoning the generation.
          if (isLostProviderIndexJob(status.error) && restarts < PROVIDER_JOB_LOSS_RESTART_LIMIT) {
            const replacement = await this.restartIndexJobAfterProviderLoss(jobId, workspaceId, ownerId, 'index');
            if (replacement !== undefined) {
              await this.monitorIndexJob(jobId, replacement, workspaceId, ownerId, restarts + 1);
              return;
            }
          }
          await this.jobs.fail(jobId, status.error.message, ownerId);
          return;
        }
        consecutiveStatusTimeouts += 1;
        if (consecutiveStatusTimeouts >= this.indexStatusTimeoutCap) {
          const deadlineCancel = this.callWorker('cancel_index', { job_id: providerJobId, workspace_id: workspaceId });
          void deadlineCancel.catch(() => undefined);
          await this.jobs.fail(
            jobId,
            `Native Thai-RAG index_status stayed unreachable for ${this.indexStatusTimeoutCap} consecutive polls (index-status-unreachable)`,
            ownerId,
          );
          return;
        }
        await delay(Math.min(5_000, 250 * (2 ** Math.min(consecutiveStatusTimeouts, 5))));
        continue;
      }
      consecutiveStatusTimeouts = 0;
      // Issue #445: a healthy poll proves the owner is alive even while the
      // embedding phase reports no file progress; keep the reaper off it.
      await this.jobs.recordHeartbeat(jobId, ownerId);
      const progress = nativeIndexProgress(status.value);
      if (progress !== undefined) {
        await this.jobs.recordProgress(jobId, progress, ownerId);
      }
      const remoteStatus = nestedString(status.value, 'status');
      if (remoteStatus !== undefined && NON_TERMINAL_INDEX_STATUSES.has(remoteStatus)) continue;
      if (remoteStatus === 'done') {
        const result = nestedValue(status.value, 'result') ?? status.value;
        const resultStatus = nestedString(result, 'status');
        const errors = nestedValue(result, 'errors');
        const failedFiles = isRecord(errors) ? Object.keys(errors) : Array.isArray(errors) ? errors : [];
        if (resultStatus === 'cancelled') {
          await this.jobs.cancel(jobId, result, ownerId);
          return;
        }
        if (failedFiles.length > 0 || (resultStatus !== undefined
          // python contract (issue-#329): 'degraded' is the expected terminal
          // status of a completed lexical-only default build; the channel
          // state carries the vector-coverage truth. File-level `errors` are
          // still rejected above, so degraded-with-errors keeps failing.
          && !['complete', 'completed', 'ok', 'done', 'success', 'degraded'].includes(resultStatus))) {
          const reason = nestedString(result, 'error') ?? nestedString(result, 'message')
            ?? (failedFiles.length > 0 ? 'one or more indexed files failed'
              : `provider result status: ${resultStatus}`);
          await this.jobs.fail(jobId, `Native Thai-RAG background index failed: ${reason}`, ownerId);
          return;
        }
        await this.jobs.complete(jobId, result, ownerId);
        return;
      }
      if (remoteStatus === 'cancelled') {
        await this.jobs.cancel(jobId, nestedValue(status.value, 'result') ?? status.value, ownerId);
        return;
      }
      if (remoteStatus === 'error') {
        await this.jobs.fail(jobId, nestedString(status.value, 'error') ?? 'Native Thai-RAG provider background index failed', ownerId);
        return;
      }
      await this.jobs.fail(jobId, `Native Thai-RAG provider returned unknown index status: ${remoteStatus ?? 'missing'}`, ownerId);
      return;
    }
  }

  private async cancelActiveProviderIndexJobs(): Promise<void> {
    const ownerId = this.ownerId ?? '';
    const active = await this.jobs.active(ownerId);
    for (const job of active) {
      if (job.providerJobId === undefined) continue;
      const isAdmissionJob = this.workspaceIndexJobIds.get(job.workspaceId) === job.jobId;
      const cancellation = isAdmissionJob
        ? this.callAdmissionWorker('cancel_index', { job_id: job.providerJobId, workspace_id: job.workspaceId })
        : this.callWorker('cancel_index', { job_id: job.providerJobId, workspace_id: job.workspaceId });
      await cancellation.catch(() => undefined);
    }
  }

  private resolveIndexWorkspace(workspaceValue: string): Result<{ readonly workspaceId: string; readonly rootPath: string }> {
    const parsed = parseCanonicalWorkspaceId(workspaceValue);
    if (parsed.ok) {
      const rootPath = this.workspaceRoots.get(parsed.value);
      return rootPath === undefined
        ? err(appError('WORKSPACE_NOT_FOUND', `Thai-RAG workspace is not registered: ${parsed.value}`))
        : ok({ workspaceId: parsed.value, rootPath });
    }

    if (!path.isAbsolute(workspaceValue)) return parsed;
    const requestedRoot = path.resolve(workspaceValue);
    const workspaceId = this.workspaceRootIds.get(requestedRoot);
    if (workspaceId === undefined) {
      return err(appError('WORKSPACE_NOT_FOUND', `Thai-RAG workspace root is not registered: ${requestedRoot}`));
    }
    const rootPath = this.workspaceRoots.get(workspaceId);
    return rootPath === undefined
      ? err(appError('WORKSPACE_NOT_FOUND', `Thai-RAG workspace is not registered: ${workspaceId}`))
      : ok({ workspaceId, rootPath });
  }

  private refreshWorkspaceRoots(generation = this.lifecycleGeneration, requestedWorkspaceId?: string): Promise<Result<void>> {
    return this.enqueueWorker(() => this.refreshWorkspaceRootsNow(generation, requestedWorkspaceId));
  }

  private async refreshWorkspaceRootsNow(generation: number, requestedWorkspaceId?: string): Promise<Result<void>> {
    const providerRoot = resolveThaiRagProviderRoot(this.options.dataRoot);
    if (!providerRoot.ok) return providerRoot;
    let rawWorkspaces: readonly NativeThaiRagWorkspace[];
    try {
      rawWorkspaces = await this.options.workspacesProvider();
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', `Unable to refresh Native Thai-RAG workspaces: ${errorMessage(error)}`, true));
    }
    const workspaces: NativeThaiRagWorkspace[] = [];
    for (const workspace of rawWorkspaces) {
      const parsedId = parseCanonicalWorkspaceId(workspace.id);
      if (!parsedId.ok) {
        return err(appError('CONFLICT', `Native Thai-RAG workspace ID is not canonical: ${workspace.id}`, true));
      }
      workspaces.push({ ...workspace, id: parsedId.value });
    }

    if (this.indexingWorkspaceId !== undefined) {
      const activeWorkspaceId = this.indexingWorkspaceId;
      if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== activeWorkspaceId) {
        const requestedWorkspace = workspaces.find((workspace) => workspace.id === requestedWorkspaceId);
        if (requestedWorkspace === undefined) {
          return err(appError('WORKSPACE_NOT_FOUND', `Thai-RAG workspace is not registered: ${requestedWorkspaceId}`));
        }
        this.pendingReindexIds.add(requestedWorkspaceId);
        if (!this.pendingReindexReasons.has(requestedWorkspaceId)) {
          this.pendingReindexReasons.set(requestedWorkspaceId, 'startup_verification');
        }
        this.queuedAdmissionWorkspaceIds.add(requestedWorkspaceId);
        return err(appError(
          'CONFLICT',
          `Native Thai-RAG workspace ${requestedWorkspaceId} is queued behind active indexing for ${activeWorkspaceId}`,
          true,
          {
            reason: 'workspace-indexing',
            workspaceId: requestedWorkspaceId,
            blockedByWorkspaceId: activeWorkspaceId,
            queueState: 'queued',
          },
        ));
      }
      const jobId = this.workspaceIndexJobIds.get(activeWorkspaceId);
      return err(appError('CONFLICT', `Native Thai-RAG workspace indexing is still running for ${activeWorkspaceId}`, true, {
        reason: 'workspace-indexing',
        workspaceId: activeWorkspaceId,
        ...(jobId === undefined ? {} : { jobId }),
      }));
    }

    const sourcesRoot = path.join(providerRoot.value, 'sources');
    const previousWorkspaces: readonly NativeThaiRagWorkspace[] = [...this.workspaceRoots].map(([id, realRootPath]) => ({ id, realRootPath }));
    const previousRoots = new Map(this.workspaceRoots);
    const previousRootIds = new Map(this.workspaceRootIds);
    try {
      await mkdir(sourcesRoot, { recursive: true });
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', `Unable to prepare Native Thai-RAG sources: ${errorMessage(error)}`, true));
    }
    if (!this.refreshIsCurrent(generation)) return ok(undefined);
    const aliases = await syncWorkspaceSourceAliases(sourcesRoot, workspaces, () => this.refreshIsCurrent(generation));
    if (!aliases.ok) return aliases;
    if (!this.refreshIsCurrent(generation)) return this.restoreRefreshState(sourcesRoot, previousWorkspaces, previousRoots, previousRootIds);
    for (const workspaceId of aliases.value) {
      // New or repaired aliases require source verification, not a forced rebuild.
      this.pendingReindexIds.add(workspaceId);
      this.pendingReindexReasons.set(workspaceId, 'alias_created_or_repaired');
    }
    const relinked = workspaces.filter((workspace) => {
      const previousRoot = this.workspaceRoots.get(workspace.id);
      return previousRoot !== undefined && previousRoot !== path.resolve(workspace.realRootPath);
    });
    for (const workspace of relinked) {
      // The provider compares file hashes and fingerprints when a root changes.
      this.pendingReindexIds.add(workspace.id);
      this.pendingReindexReasons.set(workspace.id, 'workspace_relinked');
    }
    if (generation === this.lifecycleGeneration && this.started && this.launchConfig !== undefined) {
      const pending = new Set(this.pendingReindexIds);
      for (const workspace of workspaces.filter((entry) => pending.has(entry.id)
        && requestedWorkspaceId === entry.id)) {
        const reason = this.pendingReindexReasons.get(workspace.id) ?? 'startup_verification';
        const verification = await this.evaluateWorkspaceVerification(workspace, reason);
        if (verification.skip) {
          // The persisted verification proves this exact source identity was
          // already admitted. Drop the pending marker so a restart or another
          // child cannot re-enqueue the same no-op pass (issue #422).
          this.pendingReindexIds.delete(workspace.id);
          this.pendingReindexReasons.delete(workspace.id);
          continue;
        }
        if (!this.refreshIsCurrent(generation) || !this.started) return ok(undefined);
        return this.startWorkspaceAdmissionIndex(
          workspace,
          false, // Preserve provider-side validated incremental reuse on admission.
          reason,
          generation,
          sourcesRoot,
          workspaces,
          previousWorkspaces,
          previousRoots,
          previousRootIds,
          verification.sourceIdentity,
        );
      }
    }

    if (!this.refreshIsCurrent(generation)) return this.restoreRefreshState(sourcesRoot, previousWorkspaces, previousRoots, previousRootIds);
    const nextRoots = new Map<string, string>();
    const nextRootIds = new Map<string, string>();
    for (const workspace of workspaces) {
      const realRootPath = path.resolve(workspace.realRootPath);
      nextRoots.set(workspace.id, realRootPath);
      nextRootIds.set(realRootPath, workspace.id);
      if (workspace.rootPath !== undefined) nextRootIds.set(path.resolve(workspace.rootPath), workspace.id);
    }

    this.workspaceRoots.clear();
    this.workspaceRootIds.clear();
    for (const [id, root] of nextRoots) this.workspaceRoots.set(id, root);
    for (const [root, id] of nextRootIds) this.workspaceRootIds.set(root, id);
    if (requestedWorkspaceId !== undefined && this.queuedAdmissionWorkspaceIds.size > 0) {
      // A verified workspace releases the admission slot without starting a
      // monitor, so its finally block will never drain the queue. Continue the
      // chain here instead of leaving queued workspaces parked forever.
      queueMicrotask(() => this.scheduleNextQueuedWorkspaceAdmission(generation));
    }
    return ok(undefined);
  }

  private async evaluateWorkspaceVerification(
    workspace: NativeThaiRagWorkspace,
    reason: ThaiRagReindexReason,
  ): Promise<{ readonly skip: boolean; readonly sourceIdentity?: WorkspaceSourceEvidenceIdentity }> {
    if (reason === 'explicit_request' || reason === 'explicit_force_reindex') {
      return { skip: false };
    }
    const provider = this.options.workspaceSourceIdentityProvider;
    if (provider === undefined) return { skip: false };
    let sourceIdentity: WorkspaceSourceEvidenceIdentity | null;
    try {
      sourceIdentity = await provider(workspace);
    } catch {
      return { skip: false };
    }
    if (sourceIdentity === null) return { skip: false };
    const recorded = await this.verifications.get(workspace.id);
    if (!recorded.ok || recorded.value === null) return { skip: false, sourceIdentity };
    const verifiedAt = Date.parse(recorded.value.verifiedAt);
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt > WORKSPACE_VERIFICATION_MAX_AGE_MS) {
      return { skip: false, sourceIdentity };
    }
    if (classifyWorkspaceSourceEvidence(recorded.value.sourceIdentity, sourceIdentity) !== 'fresh') {
      return { skip: false, sourceIdentity };
    }
    // Fresh git identity alone is not proof that the provider still has a
    // usable snapshot. Pre-edit evidence resolves the provider's persisted
    // active generation, which survives provider process restarts; matching it
    // to the recorded generation proves the snapshot is still active (#422).
    return { skip: await this.workspaceSnapshotIsCurrent(recorded.value), sourceIdentity };
  }

  private async workspaceSnapshotIsCurrent(record: ThaiRagWorkspaceVerificationRecord): Promise<boolean> {
    if (record.probeFilePath === undefined || record.generationId === undefined || this.launchConfig === undefined || !this.started) {
      return false;
    }
    try {
      // The probe has its own short-timeout session, so a slow/hung probe can
      // never drop the warm request session or the dedicated index session.
      const status = await this.probeSessions.call(SERVER_NAME, this.launchConfig, 'pre_edit_context', {
        file_path: record.probeFilePath,
        workspace_id: record.workspaceId,
      }, undefined, {}, undefined, this.snapshotProbeTimeoutMs);
      const normalized = normalizeWorkerCallResult('pre_edit_context', status);
      if (!normalized.ok) return false;
      const generation = nestedString(normalized.value, 'index_generation_id');
      return generation === record.generationId;
    } catch {
      return false;
    }
  }

  private scheduleNextQueuedWorkspaceAdmission(generation: number): void {
    if (!this.refreshIsCurrent(generation) || !this.started || this.shuttingDown || this.indexingWorkspaceId !== undefined) return;
    const nextWorkspaceId = this.queuedAdmissionWorkspaceIds.values().next().value as string | undefined;
    if (nextWorkspaceId === undefined) return;
    this.queuedAdmissionWorkspaceIds.delete(nextWorkspaceId);
    void this.refreshWorkspaceRoots(generation, nextWorkspaceId).then((result) => {
      if (!result.ok && result.error.details?.queueState === 'queued'
        && this.refreshIsCurrent(generation) && this.started && !this.shuttingDown) {
        this.queuedAdmissionWorkspaceIds.add(nextWorkspaceId);
      }
    }, () => {
      if (this.refreshIsCurrent(generation) && this.started && !this.shuttingDown) {
        this.queuedAdmissionWorkspaceIds.add(nextWorkspaceId);
      }
    });
  }

  /** Keeps the durable job row alive while a synchronous provider call is in flight (issue #445). */
  private async withJobHeartbeat<T>(
    jobId: string,
    ownerId: string,
    work: Promise<T>,
  ): Promise<T> {
    return runWithHeartbeat(
      work,
      this.options.indexJobHeartbeatMs ?? SYNC_CALL_HEARTBEAT_MS,
      () => this.jobs.recordHeartbeat(jobId, ownerId).catch(() => undefined),
    );
  }

  private async startWorkspaceAdmissionIndex(
    workspace: NativeThaiRagWorkspace,
    force: boolean,
    reindexReason: ThaiRagReindexReason,
    generation: number,
    sourcesRoot: string,
    workspaces: readonly NativeThaiRagWorkspace[],
    previousWorkspaces: readonly NativeThaiRagWorkspace[],
    previousRoots: ReadonlyMap<string, string>,
    previousRootIds: ReadonlyMap<string, string>,
    sourceIdentity?: WorkspaceSourceEvidenceIdentity,
  ): Promise<Result<void>> {
    const ownerId = this.ownerId ?? '';
    const job = await this.jobs.create(workspace.id, force, ownerId, reindexReason);
    this.indexingWorkspaceId = workspace.id;
    this.workspaceIndexJobIds.set(workspace.id, job.jobId);
    const monitor = (async (): Promise<Result<void>> => {
      try {
        let indexed: Result<unknown>;
        // issue-202: trial-first — bounded foreground probe proves the
        // pipeline before full admission. Trial failure takes the same
        // fail-closed path below; pending stays set for a later retry.
        {
          const trial = await this.withJobHeartbeat(job.jobId, ownerId, this.retryStorageBusy(async () => (this.cancellableIndexJobs
            ? await this.callAdmissionWorker('code_index', {
              workspace_path: path.resolve(workspace.realRootPath),
              workspace_id: workspace.id,
              force: false,
              background: false,
              max_files: 3,
              vectors: CODE_INDEX_VECTORS,
            })
            : normalizeWorkerCallResult(
              'code_index',
              await this.indexSessions.call(SERVER_NAME, this.launchConfig!, 'code_index', {
                workspace_path: path.resolve(workspace.realRootPath),
                workspace_id: workspace.id,
                force: false,
                background: false,
                max_files: 3,
                vectors: CODE_INDEX_VECTORS,
              }),
            ))));
          if (!trial.ok) indexed = trial;
          else indexed = { ok: true as const, value: undefined };
          if (!trial.ok) {
            await this.jobs.fail(job.jobId, trial.error.message, ownerId);
            await this.restoreRefreshState(sourcesRoot, previousWorkspaces, previousRoots, previousRootIds);
            return err(appError('CONFLICT', `Native Thai-RAG reindex failed for workspace ${workspace.id}: ${trial.error.message}`, true));
          }
        }
        if (this.cancellableIndexJobs) {
          // issue-202 T8: demand-first — trial already proved the pipeline,
          // so the remainder runs as background delta (never sync full
          // force, which fails at tail and blocks the pre-edit gate).
          const started = await this.retryStorageBusy(() => this.callAdmissionWorker('code_index', {
            workspace_path: path.resolve(workspace.realRootPath),
            workspace_id: workspace.id,
            force: false,
            background: true,
            mode: 'delta',
            vectors: CODE_INDEX_VECTORS,
          }));
          if (!started.ok) {
            indexed = started;
          } else {
            const providerJobId = nestedString(started.value, 'job_id');
            if (providerJobId === undefined) {
              indexed = err(appError('CONFLICT', 'Native Thai-RAG background index response omitted provider job_id', true, {
                reason: 'missing-provider-job-id',
              }));
            } else {
              await this.jobs.bindProviderJob(job.jobId, providerJobId, ownerId);
              if (this.shuttingDown) {
                await this.callAdmissionWorker('cancel_index', {
                  job_id: providerJobId,
                  workspace_id: workspace.id,
                }).catch(() => undefined);
                indexed = err(appError('CONFLICT', 'Native Thai-RAG workspace indexing was interrupted during shutdown', true));
              } else {
                indexed = await this.waitForWorkspaceAdmissionIndex(job.jobId, providerJobId, workspace.id, ownerId);
              }
            }
          }
        } else {
          // issue-202 T8: demand-first — same treatment on the legacy
          // path: background delta instead of sync full force.
          const raw = await this.indexSessions.call(SERVER_NAME, this.launchConfig!, 'code_index', {
            workspace_path: path.resolve(workspace.realRootPath),
            workspace_id: workspace.id,
            force: false,
            background: true,
            mode: 'delta',
            vectors: CODE_INDEX_VECTORS,
          });
          indexed = normalizeWorkerCallResult('code_index', raw);
        }

        if (indexed.ok) await this.jobs.complete(job.jobId, indexed.value, ownerId);
        else await this.jobs.fail(job.jobId, indexed.error.message, ownerId);

        if (!this.refreshIsCurrent(generation) || !this.started || !indexed.ok) {
          await this.restoreRefreshState(sourcesRoot, previousWorkspaces, previousRoots, previousRootIds);
          return indexed.ok
            ? ok(undefined)
            : err(appError('CONFLICT', `Native Thai-RAG reindex failed for workspace ${workspace.id}: ${indexed.error.message}`, true));
        }
        this.workspaceRoots.clear();
        this.workspaceRootIds.clear();
        for (const entry of workspaces) {
          const realRootPath = path.resolve(entry.realRootPath);
          this.workspaceRoots.set(entry.id, realRootPath);
          this.workspaceRootIds.set(realRootPath, entry.id);
          if (entry.rootPath !== undefined) this.workspaceRootIds.set(path.resolve(entry.rootPath), entry.id);
        }
        this.pendingReindexIds.delete(workspace.id);
        this.pendingReindexReasons.delete(workspace.id);
        // A legacy 1.0 provider returns from the background-start call before
        // the pass is terminal. Recording freshness there would authorize a
        // permanent skip while the pass may still fail or be running.
        if (this.cancellableIndexJobs) {
          await this.recordWorkspaceVerification(workspace.id, sourceIdentity, job.jobId, indexed.value, ownerId);
        }
        return ok(undefined);
      } catch (error: unknown) {
        await this.jobs.fail(job.jobId, errorMessage(error), ownerId).catch(() => undefined);
        await this.restoreRefreshState(sourcesRoot, previousWorkspaces, previousRoots, previousRootIds);
        return err(appError('CONFLICT', `Native Thai-RAG reindex failed for workspace ${workspace.id}: ${errorMessage(error)}`, true));
      } finally {
        this.workspaceIndexJobIds.delete(workspace.id);
        const releasedAdmissionSlot = this.indexingWorkspaceId === workspace.id;
        if (releasedAdmissionSlot) this.indexingWorkspaceId = undefined;
        this.workspaceIndexMonitors.delete(job.jobId);
        if (releasedAdmissionSlot) this.scheduleNextQueuedWorkspaceAdmission(generation);
      }
    })();
    this.workspaceIndexMonitors.set(job.jobId, monitor);
    let timeout: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      monitor,
      new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), Math.min(this.options.callTimeoutMs ?? INDEX_ADMISSION_WAIT_MS, INDEX_ADMISSION_WAIT_MS)); }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (completed !== undefined) return completed;
    return err(appError('CONFLICT', `Native Thai-RAG indexing started for workspace ${workspace.id}; retry after the index job completes`, true, {
      reason: 'workspace-indexing',
      workspaceId: workspace.id,
      jobId: job.jobId,
    }));
  }

  private async recordWorkspaceVerification(
    workspaceId: string,
    sourceIdentity: WorkspaceSourceEvidenceIdentity | undefined,
    jobId: string,
    result: unknown,
    ownerId: string,
  ): Promise<void> {
    if (sourceIdentity === undefined) return;
    const progress = nativeIndexProgress(result);
    const localJob = await this.jobs.get(jobId, ownerId, workspaceId).catch(() => null);
    const providerJobId = localJob?.providerJobId;
    // Without a provider job id there is no way to re-prove that the snapshot
    // is still usable after a restart. Recording would authorize a skip we
    // cannot justify, so leave the workspace unverified.
    if (providerJobId === undefined) return;
    const indexedFiles = progress?.indexedFiles ?? localJob?.indexedFiles ?? 0;
    const skippedFiles = progress?.skippedFiles ?? localJob?.skippedFiles ?? 0;
    const totalFiles = Math.max(progress?.totalFiles ?? localJob?.totalFiles ?? 0, indexedFiles + skippedFiles);
    const providerStatus = nestedString(result, 'status');
    const lexicalOnly = nestedValue(result, 'lexical_only') === true;
    const outcome = providerStatus === 'degraded' || lexicalOnly
      ? 'degraded' as const
      : indexedFiles > 0 ? 'changed' as const : 'unchanged' as const;
    const sourceSnapshotId = nestedString(result, 'source_snapshot_id');
    const generationId = nestedString(result, 'generation_id');
    // A synthetic, non-existent target keeps the proof read-only: pre-edit
    // overlay refresh has nothing to refresh, so probing cannot mutate the
    // index (a dirty package.json would otherwise trigger a one-file delta).
    const probeFilePath = '.unified-mpc-verification-probe';
    try {
      await this.verifications.record({
        workspaceId,
        sourceIdentity,
        outcome,
        ...(providerStatus === undefined ? {} : { providerStatus }),
        indexedFiles,
        skippedFiles,
        totalFiles,
        ...(sourceSnapshotId === undefined ? {} : { sourceSnapshotId }),
        ...(generationId === undefined ? {} : { generationId }),
        providerJobId,
        probeFilePath,
      });
    } catch {
      // Verification persistence is an optimization: a failed write must never
      // fail an admission that already published a usable generation.
    }
  }

  private async waitForWorkspaceAdmissionIndex(
    jobId: string,
    providerJobId: string,
    workspaceId: string,
    ownerId: string,
    restarts = 0,
  ): Promise<Result<unknown>> {
    let consecutiveStatusTimeouts = 0;
    while (!this.shuttingDown) {
      await delay(this.indexJobPollMs);
      if (this.shuttingDown) break;
      const local = await this.jobs.get(jobId, ownerId, workspaceId);
      if (local === null || (local.status !== 'running' && local.status !== 'cancelling')) {
        return err(appError('CONFLICT', `Native Thai-RAG admission index job is no longer active: ${jobId}`, true));
      }

      const status = await this.callAdmissionWorker('index_status', { job_id: providerJobId, workspace_id: workspaceId });
      if (!status.ok) {
        // A timed-out read is not evidence that the provider-owned background
        // job failed. Keep the same providerJobId, dedicated stdio session, and
        // local running job instead of starting another full index generation.
        if (!isIndexStatusPollTimeout(status.error)) {
          // Issue #449: a provider-lost job (registry dropped on provider or
          // data-owner rebind) is restartable, not a dead workspace. Re-run
          // the delta on the same admission session and keep waiting.
          if (isLostProviderIndexJob(status.error) && restarts < PROVIDER_JOB_LOSS_RESTART_LIMIT) {
            const replacement = await this.restartIndexJobAfterProviderLoss(jobId, workspaceId, ownerId, 'admission');
            if (replacement !== undefined) {
              return this.waitForWorkspaceAdmissionIndex(jobId, replacement, workspaceId, ownerId, restarts + 1);
            }
          }
          return status;
        }
        consecutiveStatusTimeouts += 1;
        if (consecutiveStatusTimeouts >= this.indexStatusTimeoutCap) {
          // Issue #407: bound the read gate. A provider whose index_status
          // stays unreachable past the deadline must not hold admission reads
          // hostage: fire a non-blocking best-effort cancel, fail the local
          // job, and surface an actionable CONFLICT so the finally block in
          // the admission monitor releases the gate deterministically.
          const deadlineCancel = this.callAdmissionWorker('cancel_index', { job_id: providerJobId, workspace_id: workspaceId });
          void deadlineCancel.catch(() => undefined);
          return err(appError('CONFLICT', `Native Thai-RAG index_status stayed unreachable for ${this.indexStatusTimeoutCap} consecutive polls; workspace ${workspaceId} index job marked failed (index-status-unreachable)`, true, {
            reason: 'index-status-unreachable',
            workspaceId,
            providerJobId,
          }));
        }
        await delay(Math.min(5_000, 250 * (2 ** Math.min(consecutiveStatusTimeouts, 5))));
        continue;
      }
      consecutiveStatusTimeouts = 0;
      // Issue #445: a healthy poll proves the owner is alive even while the
      // embedding phase reports no file progress; keep the reaper off it.
      await this.jobs.recordHeartbeat(jobId, ownerId);
      const progress = nativeIndexProgress(status.value);
      if (progress !== undefined) {
        await this.jobs.recordProgress(jobId, progress, ownerId);
      }
      const remoteStatus = nestedString(status.value, 'status');
      if (remoteStatus !== undefined && NON_TERMINAL_INDEX_STATUSES.has(remoteStatus)) continue;
      if (remoteStatus === 'done') {
        const result = nestedValue(status.value, 'result') ?? status.value;
        const resultStatus = nestedString(result, 'status');
        const reportedErrors = nestedValue(result, 'errors');
        const failedPaths = isRecord(reportedErrors) ? Object.keys(reportedErrors) : [];
        if (resultStatus === 'cancelled') {
          await this.jobs.cancel(jobId, result, ownerId);
          return err(appError('CONFLICT', `Native Thai-RAG provider background index was cancelled: ${providerJobId}`, true));
        }
        if (failedPaths.length > 0 || (resultStatus !== undefined
          // python contract (issue-#329): 'degraded' is the expected terminal
          // status of a completed lexical-only default build; the channel
          // state carries the vector-coverage truth. File-level `errors` are
          // still rejected above, so degraded-with-errors keeps failing.
          && !['complete', 'completed', 'ok', 'done', 'success', 'degraded'].includes(resultStatus))) {
          const detail = nestedString(result, 'error') ?? nestedString(result, 'message')
            ?? (failedPaths.length > 0 ? `files with errors: ${failedPaths.slice(0, 3).join(', ')}`
              : `provider result status: ${resultStatus}`);
          return err(appError('CONFLICT', `Native Thai-RAG provider background index failed: ${detail}`, true));
        }
        return ok(result);
      }
      if (remoteStatus === 'cancelled') {
        await this.jobs.cancel(jobId, nestedValue(status.value, 'result') ?? status.value, ownerId);
        return err(appError('CONFLICT', `Native Thai-RAG admission index job was cancelled: ${jobId}`, true));
      }
      if (remoteStatus === 'error') {
        return err(appError('CONFLICT', nestedString(status.value, 'error') ?? 'Native Thai-RAG provider background index failed', true));
      }
      return err(appError('CONFLICT', `Native Thai-RAG provider returned unknown index status: ${remoteStatus ?? 'missing'}`, true));
    }
    return err(appError('CONFLICT', 'Native Thai-RAG workspace indexing stopped before completion', true));
  }

  private async restoreRefreshState(
    sourcesRoot: string,
    previousWorkspaces: readonly NativeThaiRagWorkspace[],
    previousRoots: ReadonlyMap<string, string>,
    previousRootIds: ReadonlyMap<string, string>,
  ): Promise<Result<void>> {
    const aliases = await syncWorkspaceSourceAliases(sourcesRoot, previousWorkspaces);
    if (!aliases.ok) {
      this.workspaceRoots.clear();
      this.workspaceRootIds.clear();
      return err(appError('CONFLICT', `Native Thai-RAG refresh could not restore aliases after shutdown: ${aliases.error.message}`, true));
    }
    this.workspaceRoots.clear();
    this.workspaceRootIds.clear();
    for (const [id, root] of previousRoots) this.workspaceRoots.set(id, root);
    for (const [root, id] of previousRootIds) this.workspaceRootIds.set(root, id);
    return ok(undefined);
  }

  private async callWorker(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    const raw = await this.enqueueWorker(() => this.sessions.call(SERVER_NAME, this.launchConfig!, tool, args, signal, {}, budget));
    return normalizeWorkerCallResult(tool, raw);
  }

  /**
   * Index calls use the dedicated index session: the provider has to wait for
   * the data owner to publish a generation, which can take minutes, and the
   * default request session timeout would abort the call long before that.
   */
  private async callIndexWorker(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    budget?: ResultBudget,
  ): Promise<Result<unknown>> {
    const raw = await this.enqueueWorker(() => this.indexSessions.call(SERVER_NAME, this.launchConfig!, tool, args, signal, {}, budget));
    return normalizeWorkerCallResult(tool, raw);
  }

  private async callAdmissionWorker(tool: string, args: Readonly<Record<string, unknown>>): Promise<Result<unknown>> {
    return normalizeWorkerCallResult(tool, await this.indexSessions.call(SERVER_NAME, this.launchConfig!, tool, args));
  }

  /**
   * Retry an index **start** that the provider rejected because another
   * session held the SQLite write lock. Only the start is retried: once the
   * provider admits the job, its own job id owns the work and a second start
   * would create a competing generation.
   */
  private async retryStorageBusy<T>(operation: () => Promise<Result<T>>, attempts = 4): Promise<Result<T>> {
    let result = await operation();
    for (let attempt = 1; attempt < attempts && !result.ok && isRetryableStorageBusy(result.error); attempt += 1) {
      await delay(Math.min(5_000, 250 * (2 ** attempt)));
      result = await operation();
    }
    return result;
  }

  private canonicalPreEditArgs(args: Readonly<Record<string, unknown>>): Result<Readonly<Record<string, unknown>>> {
    const workspaceValue = typeof args.workspace_id === 'string' ? args.workspace_id : '';
    const workspace = parseCanonicalWorkspaceId(workspaceValue);
    if (!workspace.ok) return workspace;
    const root = this.workspaceRoots.get(workspace.value);
    if (root === undefined) return err(appError('WORKSPACE_NOT_FOUND', `Thai-RAG workspace is not registered: ${workspace.value}`));
    if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
      return err(appError('INVALID_INPUT', 'Thai-RAG pre-edit file_path is required'));
    }
    const original = args.file_path.trim();
    const prefixed = `${workspace.value}/`;
    let relative = original.replaceAll('\\', '/');
    if (relative.startsWith(prefixed)) relative = relative.slice(prefixed.length);
    else if (path.isAbsolute(original)) relative = path.relative(root, path.resolve(original)).replaceAll('\\', '/');
    relative = relative.replace(/^\.\//, '');
    if (relative.length === 0 || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      return err(appError('PERMISSION_DENIED', `Thai-RAG pre-edit path escapes canonical workspace ${workspace.value}`));
    }
    return ok({ ...args, workspace_id: workspace.value, file_path: `${workspace.value}/${relative}` });
  }

  private async refreshHealth(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    const config = this.launchConfig;
    if (!this.started || config === undefined) return err(appError('CONFLICT', 'Native Thai-RAG worker is not started', true));
    const raw = normalizeWorkerCallResult('health', await this.enqueueWorker(() => this.sessions.call(SERVER_NAME, config, 'health', {}, signal)));
    if (!raw.ok) return raw;
    const handshake = parseProviderHandshake(raw.value);
    if (!handshake.ok) return handshake;
    const compatible = validateThaiRagHandshake(handshake.value, {
      embeddingIndexGeneration: this.expectedEmbeddingIndexGeneration,
      allowLegacyAdapter: handshake.value.legacyAdapter === THAI_RAG_PRODUCTION_BRIDGE,
      allowMissingPreprocessingVersion: true,
      ...embeddingCompatibility(handshake.value.contractVersion),
      allowedDegradedCapabilities: THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
    });
    if (!compatible.ok) return compatible;
    if (handshake.value.components === undefined) {
      return err(appError('CONFLICT', 'Native Thai-RAG health response omitted structured component diagnostics', true, { reason: 'missing-health-components' }));
    }
    const activeJobs = await this.jobs.active(this.ownerId ?? '');
    const health: ThaiRagProviderDriverHealth = {
      indexJobContractVersion: handshake.value.indexJobContractVersion,
      ...handshake.value.components,
      capabilities: handshake.value.capabilities,
      workspaceScopeModel: handshake.value.workspaceScopeModel,
      embedding: handshake.value.embedding,
      contractVersion: handshake.value.contractVersion,
      ...(handshake.value.compatibilityRange === undefined ? {} : { compatibilityRange: handshake.value.compatibilityRange }),
      contractFingerprint: handshake.value.contractFingerprint,
      generation: handshake.value.generation,
      ...(handshake.value.degradedReasons === undefined ? {} : { degradation: handshake.value.degradedReasons }),
      activeJobs: [...new Set([...handshake.value.components.activeJobs, ...activeJobs.map((job) => job.jobId)])],
    };
    this.lastHealth = health;
    this.lastHealthAt = Date.now();
    return ok(health);
  }

  private enqueueWorker<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.workerQueue.then(operation, operation);
    this.workerQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async withOperation<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.shuttingDown) return err(appError('CONFLICT', 'Native Thai-RAG worker is stopping', true));
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        const waiters = this.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private waitForOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private refreshIsCurrent(generation: number): boolean {
    return !this.stopRequested && generation === this.lifecycleGeneration;
  }
}

async function syncWorkspaceSourceAliases(
  sourcesRoot: string,
  workspaces: readonly NativeThaiRagWorkspace[],
  isCurrent: () => boolean = () => true,
): Promise<Result<readonly string[]>> {
  const expected = new Map(workspaces.map((workspace) => [workspace.id, path.resolve(workspace.realRootPath)]));
  const changed: Array<{ readonly alias: string; readonly previousTarget: string | null }> = [];
  const changedWorkspaceIds = new Set<string>();

  try {
    const entries = await readdir(sourcesRoot, { withFileTypes: true });
    if (!isCurrent()) return staleAliasResult(changed);
    for (const entry of entries) {
      if (!parseCanonicalWorkspaceId(entry.name).ok || expected.has(entry.name)) continue;
      const alias = path.join(sourcesRoot, entry.name);
      if (!isCurrent()) return staleAliasResult(changed);
      const metadata = await lstat(alias);
      if (!metadata.isSymbolicLink()) {
        if (!await rollbackWorkspaceAliases(changed)) return err(appError('CONFLICT', `Unable to restore Thai-RAG aliases after conflict: ${alias}`, true));
        return err(appError('CONFLICT', `Thai-RAG source alias path is occupied by a non-symlink: ${alias}`, true));
      }
      changed.push({ alias, previousTarget: await readlink(alias) });
      if (!isCurrent()) return staleAliasResult(changed);
      await unlink(alias);
    }

    for (const [workspaceId, target] of expected) {
      if (!isCurrent()) return staleAliasResult(changed);
      const alias = path.join(sourcesRoot, workspaceId);
      let existingTarget: string | null = null;
      try {
        const metadata = await lstat(alias);
        if (!metadata.isSymbolicLink()) {
          if (!await rollbackWorkspaceAliases(changed)) return err(appError('CONFLICT', `Unable to restore Thai-RAG aliases after conflict: ${alias}`, true));
          return err(appError('CONFLICT', `Thai-RAG source alias path is occupied by a non-symlink: ${alias}`, true));
        }
        existingTarget = await readlink(alias);
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }

      if (existingTarget !== null && path.resolve(path.dirname(alias), existingTarget) === target) continue;
      if (existingTarget !== null) {
        changed.push({ alias, previousTarget: existingTarget });
        if (!isCurrent()) return staleAliasResult(changed);
        await unlink(alias);
        changedWorkspaceIds.add(workspaceId);
      } else {
        changed.push({ alias, previousTarget: null });
        changedWorkspaceIds.add(workspaceId);
      }
      if (!isCurrent()) return staleAliasResult(changed);
      await symlink(target, alias, 'dir');
    }
    return ok([...changedWorkspaceIds]);
  } catch (error: unknown) {
    if (!await rollbackWorkspaceAliases(changed)) return err(appError('CONFLICT', `Unable to restore Thai-RAG aliases after refresh failure: ${errorMessage(error)}`, true));
    return err(appError('INTERNAL_ERROR', `Unable to refresh Thai-RAG workspace aliases: ${errorMessage(error)}`, true));
  }
}

async function staleAliasResult(changed: readonly { readonly alias: string; readonly previousTarget: string | null }[]): Promise<Result<readonly string[]>> {
  if (!await rollbackWorkspaceAliases(changed)) return err(appError('CONFLICT', 'Unable to restore stale Thai-RAG aliases after lifecycle invalidation', true));
  return ok([]);
}

async function rollbackWorkspaceAliases(changed: readonly { readonly alias: string; readonly previousTarget: string | null }[]): Promise<boolean> {
  let restored = true;
  for (const { alias, previousTarget } of [...changed].reverse()) {
    try {
      await rm(alias, { force: true, recursive: true });
      if (previousTarget !== null) await symlink(previousTarget, alias, 'dir');
    } catch {
      restored = false;
    }
  }
  return restored;
}

/**
 * `index_status` is read over the same worker session that runs the embedding
 * batch, so a busy index starves the poll instead of failing it. A timed-out
 * read therefore keeps the provider job (issues #407, #439); every other
 * worker error still fails the job.
 */
/**
 * Provider index statuses that mean "still in progress". The python provider
 * answers `queued` between job admission and the first runner step (#441), so a
 * monitor that accepted only `running` failed a healthy job on its first poll.
 */
const NON_TERMINAL_INDEX_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'pending',
  'running',
  'cancelling',
]);

/**
 * The provider keeps its index job registry in memory and only prunes
 * terminal rows, so a mirrored job can disappear when the provider process or
 * its data owner re-binds. Its contract for that case is "re-run code_index",
 * which makes a lost job a restart instead of a permanent workspace failure
 * (issue #449). The bound stops a provider that keeps dropping its registry
 * from restarting the generation forever.
 */
const PROVIDER_JOB_LOSS_RESTART_LIMIT = 3;

function isLostProviderIndexJob(error: {
  readonly message: string;
  readonly details?: Readonly<Record<string, string | number>>;
}): boolean {
  if (error.details?.providerReason === 'provider_restart_or_retention_expiry') return true;
  return /index job is unknown/i.test(error.message);
}

/**
 * True for a provider-side index job id (`idx_<token>`). Mirrored jobs are
 * `idx_umcp_<token>`, so the store can never hold one of these; that is what
 * makes forwarding a cancellation to the provider safe (issue #445).
 */
function isProviderOwnedIndexJobId(jobId: string): boolean {
  return /^idx_(?!umcp_)[0-9a-z]{6,}$/i.test(jobId);
}

function isIndexStatusPollTimeout(error: { readonly code: string; readonly message: string }): boolean {
  if (error.code !== 'INTERNAL_ERROR') return false;
  if (error.message.startsWith('Timed out refreshing tool catalog for ')) return true;
  return error.message.startsWith('Timed out calling ') && error.message.endsWith('/index_status');
}

function parseProviderHandshake(value: unknown): Result<ThaiRagProviderHandshake> {
  const payload = normalizeWorkerPayload(value);
  const outer = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  const data = isRecord(outer) && isRecord(outer.data) && typeof outer.data.provider_id === 'string' ? outer.data : outer;
  if (!isRecord(data)
    || typeof data.provider_id !== 'string'
    || typeof data.provider_version !== 'string'
    || typeof data.contract_version !== 'string'
    || !isRecord(data.compatibility_range)
    || typeof data.compatibility_range.min !== 'string'
    || typeof data.compatibility_range.max !== 'string'
    || typeof data.contract_fingerprint !== 'string'
    || typeof data.index_job_contract_version !== 'string'
    || !Array.isArray(data.capabilities)
    || !data.capabilities.every((capability) => typeof capability === 'string')
    || typeof data.workspace_scope_model !== 'string'
    || typeof data.state !== 'string'
    || !isRecord(data.embedding)
    || typeof data.embedding.profile !== 'string'
    || typeof data.embedding.model !== 'string'
    || typeof data.embedding.dimension !== 'number'
    || (data.embedding.preprocessing_version !== undefined && typeof data.embedding.preprocessing_version !== 'string')
    || !isRecord(data.generation)
    || typeof data.generation.contract !== 'string'
    || typeof data.generation.embedding !== 'string'
    || typeof data.generation.index !== 'string'
    || typeof data.generation.storage !== 'string'
    || typeof data.embedding_index_generation !== 'number'
     || (data.degraded_reasons !== undefined && (!Array.isArray(data.degraded_reasons) || !data.degraded_reasons.every((reason) => typeof reason === 'string')))) {
    return err(appError('CONFLICT', 'Native Thai-RAG worker returned malformed handshake metadata', true, { reason: 'malformed-handshake' }));
  }
  const components = isRecord(data.components) ? parseProviderComponents(data.components) : undefined;
  return ok({
    providerId: data.provider_id as ThaiRagProviderHandshake['providerId'],
    providerVersion: data.provider_version,
    contractVersion: data.contract_version,
    compatibilityRange: { min: data.compatibility_range.min, max: data.compatibility_range.max },
    contractFingerprint: data.contract_fingerprint,
    indexJobContractVersion: data.index_job_contract_version,
    capabilities: data.capabilities,
    workspaceScopeModel: data.workspace_scope_model,
    health: data.state,
    embedding: {
      profile: data.embedding.profile,
      model: data.embedding.model,
      dimension: data.embedding.dimension,
      ...(data.embedding.preprocessing_version === undefined ? {} : { preprocessingVersion: data.embedding.preprocessing_version }),
    },
    generation: {
      contract: data.generation.contract,
      embedding: data.generation.embedding,
      index: data.generation.index,
      storage: data.generation.storage,
    },
    ...(typeof data.workspace_id === 'string' ? { workspaceId: data.workspace_id } : {}),
    ...(typeof data.workspace_ready === 'boolean' ? { workspaceReady: data.workspace_ready } : {}),
    ...(data.degraded_reasons === undefined ? {} : { degradedReasons: data.degraded_reasons }),
     ...(components === undefined ? {} : { components }),
    embeddingIndexGeneration: data.embedding_index_generation,
    ...(typeof data.legacy_adapter === 'string' ? { legacyAdapter: data.legacy_adapter } : {}),
  });
}

function parseProviderComponents(value: Record<string, unknown>): ThaiRagProviderDriverHealth | undefined {
  if (typeof value.worker_reachable !== 'boolean'
    || typeof value.sqlite_available !== 'boolean'
    || typeof value.fts_available !== 'boolean'
    || typeof value.vector_store_available !== 'boolean'
    || typeof value.embedder_available !== 'boolean'
    || typeof value.lexical_retrieval_available !== 'boolean'
    || typeof value.semantic_retrieval_available !== 'boolean'
    || !Array.isArray(value.active_jobs)
    || !value.active_jobs.every((job) => typeof job === 'string')) return undefined;
  return {
    workerReachable: value.worker_reachable,
    sqliteAvailable: value.sqlite_available,
    ftsAvailable: value.fts_available,
    vectorStoreAvailable: value.vector_store_available,
    embedderAvailable: value.embedder_available,
    lexicalRetrievalAvailable: value.lexical_retrieval_available,
    semanticRetrievalAvailable: value.semantic_retrieval_available,
    activeJobs: value.active_jobs,
  };
}

function embeddingCompatibility(contractVersion: string): {
  readonly expectedEmbeddingProfile?: string;
  readonly expectedEmbeddingModel?: string;
  readonly expectedPreprocessingVersion?: string;
} {
  const compatibility = THAI_RAG_EMBEDDING_COMPATIBILITY[contractVersion as keyof typeof THAI_RAG_EMBEDDING_COMPATIBILITY];
  if (compatibility === undefined) return {};
  if ('preprocessingVersion' in compatibility) {
    return { expectedEmbeddingProfile: compatibility.profile, expectedEmbeddingModel: compatibility.model, expectedPreprocessingVersion: compatibility.preprocessingVersion };
  }
  return { expectedEmbeddingProfile: compatibility.profile, expectedEmbeddingModel: compatibility.model };
}

function normalizeWorkerCallResult(tool: string, result: Result<unknown>): Result<unknown> {
  if (!result.ok) return result;
  const structuredError = structuredProviderError(result.value);
  if (structuredError !== undefined) {
    return err(appError(
      mapProviderErrorCode(structuredError.code),
      `Native Thai-RAG ${tool} failed: ${structuredError.message}`,
      true,
      {
        reason: structuredError.code,
        providerStatus: structuredError.status,
        // The provider's own retry classification must survive this mapping:
        // dropping it makes a contended write look terminal to the caller.
        ...(structuredError.retryable ? { retryable: 1 } : {}),
        ...(structuredError.reason === undefined ? {} : { providerReason: structuredError.reason }),
      },
    ));
  }
  const text = toolResultText(result.value)?.trim();
  return text !== undefined && /^(?:❌\s*)?Error\b/i.test(text)
    ? err(appError('CONFLICT', `Native Thai-RAG ${tool} failed: ${text}`, true))
    : result;
}

function structuredProviderError(value: unknown): {
  readonly code: string;
  readonly message: string;
  readonly status: string;
  readonly retryable: boolean;
  readonly reason?: string;
} | undefined {
  const payload = normalizeWorkerPayload(value);
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : payload;
  if (!Array.isArray(data.errors) || data.errors.length === 0 || !isRecord(data.errors[0])) return undefined;
  const error = data.errors[0];
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return undefined;
  const details = isRecord(error.details) ? error.details : {};
  return {
    code: error.code,
    message: error.message,
    status: typeof data.status === 'string' ? data.status : 'unavailable',
    retryable: details.retryable === true,
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
  };
}

/**
 * A provider-owner SQLite write is single-writer: a code_index start that
 * arrives while another session is committing answers `database is locked`
 * and marks itself retryable. The start is idempotent until the provider
 * admits a job, so retrying is correct; failing it abandons the workspace's
 * generation and restarts the whole build (issue #445 churn).
 */
function isRetryableStorageBusy(error: { readonly details?: Readonly<Record<string, string | number>> }): boolean {
  return error.details?.providerReason === 'sqlite_busy';
}

function normalizeWorkerPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.structuredContent)) return value.structuredContent;
  if (!Array.isArray(value.content)) return value;
  const first = value.content[0];
  if (!isRecord(first) || typeof first.text !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function mapProviderErrorCode(code: string): 'INVALID_INPUT' | 'PERMISSION_DENIED' | 'FILE_NOT_FOUND' | 'CONFLICT' {
  if (code === 'workspace_scope_required' || code === 'invalid_input') return 'INVALID_INPUT';
  if (code === 'scope_denied' || code === 'permission_denied') return 'PERMISSION_DENIED';
  if (code === 'workspace_not_found' || code === 'file_not_found') return 'FILE_NOT_FOUND';
  return 'CONFLICT';
}

function toolResultText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.structuredContent) && typeof value.structuredContent.result === 'string') return value.structuredContent.result;
  if (!Array.isArray(value.content) || value.content.length === 0) return undefined;
  const first = value.content[0];
  return isRecord(first) && typeof first.text === 'string' ? first.text : undefined;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function nestedValue(value: unknown, key: string, depth = 0): unknown {
  if (depth > 5) return undefined;
  const current = depth === 0 ? normalizeWorkerPayload(value) : value;
  if (!isRecord(current)) return undefined;
  if (isRecord(current.data)) {
    const nested = nestedValue(current.data, key, depth + 1);
    if (nested !== undefined) return nested;
  }
  if (isRecord(current.structuredContent)) {
    const nested = nestedValue(current.structuredContent, key, depth + 1);
    if (nested !== undefined) return nested;
  }
  // Own properties describe the envelope; `result` is the terminal provider
  // payload. Check the current object first so an envelope status (`done`) is
  // never shadowed by a result status (`complete`).
  if (Object.hasOwn(current, key)) return current[key];
  if (isRecord(current.result)) {
    const nested = nestedValue(current.result, key, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function nativeIndexProgress(value: unknown): {
  readonly indexedFiles: number;
  readonly skippedFiles: number;
  readonly totalFiles: number;
  readonly cacheHitFiles?: number;
  readonly cacheHitChunks?: number;
  readonly cacheMissFiles?: number;
  readonly cacheMissChunks?: number;
  readonly newEmbeddedFiles?: number;
  readonly newEmbeddedChunks?: number;
  readonly cacheMissReasons?: Readonly<Record<string, number>>;
} | undefined {
  const valid = (number: unknown): number is number =>
    typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= 100_000_000;
  // The provider reports final counters as `indexed`/`skipped` inside the
  // terminal result, while progress envelopes use `indexed_files`. Accept both
  // so the durable job never records 0 for a pass that actually indexed files.
  const indexedFiles = nestedValue(value, 'indexed_files') ?? nestedValue(value, 'indexed');
  const skippedFiles = nestedValue(value, 'skipped_files') ?? nestedValue(value, 'skipped');
  const reportedTotal = nestedValue(value, 'total_files');
  if (!valid(indexedFiles) || !valid(skippedFiles)) return undefined;
  const totalFiles = valid(reportedTotal) ? reportedTotal : indexedFiles + skippedFiles;
  if (indexedFiles + skippedFiles > totalFiles) return undefined;
  const base = { indexedFiles, skippedFiles, totalFiles };

  const cacheHitFiles = nestedValue(value, 'cache_hit_files');
  const cacheHitChunks = nestedValue(value, 'cache_hit_chunks');
  const cacheMissFiles = nestedValue(value, 'cache_miss_files');
  const cacheMissChunks = nestedValue(value, 'cache_miss_chunks');
  const newEmbeddedFiles = nestedValue(value, 'new_embedded_files');
  const newEmbeddedChunks = nestedValue(value, 'new_embedded_chunks');
  const cacheMissReasonsValue = nestedValue(value, 'cache_miss_reasons');
  const cacheValues = [
    cacheHitFiles, cacheHitChunks, cacheMissFiles, cacheMissChunks,
    newEmbeddedFiles, newEmbeddedChunks,
  ];
  const hasAnyCacheMetric = cacheValues.some((entry) => entry !== undefined)
    || cacheMissReasonsValue !== undefined;
  if (!hasAnyCacheMetric) return base;
  if (cacheValues.some((entry) => !valid(entry))
    || !isRecord(cacheMissReasonsValue)) return base;
  const cacheMissReasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(cacheMissReasonsValue)) {
    if (reason.trim().length === 0 || !valid(count)) return base;
    cacheMissReasons[reason] = count;
  }
  if ((cacheHitFiles as number) + (cacheMissFiles as number) > totalFiles
    || (newEmbeddedFiles as number) > (cacheMissFiles as number)
    || (newEmbeddedChunks as number) > (cacheMissChunks as number)) return base;
  return {
    ...base,
    cacheHitFiles: cacheHitFiles as number,
    cacheHitChunks: cacheHitChunks as number,
    cacheMissFiles: cacheMissFiles as number,
    cacheMissChunks: cacheMissChunks as number,
    newEmbeddedFiles: newEmbeddedFiles as number,
    newEmbeddedChunks: newEmbeddedChunks as number,
    cacheMissReasons,
  };
}

function nestedString(value: unknown, key: string): string | undefined {
  const nested = nestedValue(value, key);
  return typeof nested === 'string' && nested.trim().length > 0 ? nested.trim() : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value && value.code === code;
}
