import { lstat, mkdir, readdir, readlink, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result, type ResultBudget } from '@unified-mpc/domain';
import {
  McpSessionManager,
  type McpClientFactory,
  type McpServerLaunchConfig,
} from '@unified-mpc/extensions';
import {
  ThaiRagIndexJobStore,
  parseCanonicalWorkspaceId,
  resolveThaiRagProviderRoot,
  THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
  THAI_RAG_CONFORMANCE_FIXTURE,
  THAI_RAG_EMBEDDING_COMPATIBILITY,
  THAI_RAG_PRODUCTION_BRIDGE,
  validateThaiRagHandshake,
  type ThaiRagProviderDriver,
  type ThaiRagProviderDriverHealth,
  type ThaiRagProviderDriverStartOptions,
  type ThaiRagProviderHandshake,
} from '@unified-mpc/thai-rag';

const SERVER_NAME = 'thai-rag-native';
const REQUIRED_TOOLS = new Set([
  'remember', 'recall', 'record_event', 'pre_edit_context', 'code_blast_radius',
  'forget', 'code_index', 'index_status', 'code_search', 'code_context',
  'health', 'version',
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
  readonly callTimeoutMs?: number;
  readonly healthRefreshMs?: number;
}

export class NativeThaiRagProviderDriver implements ThaiRagProviderDriver {
  private readonly sessions: McpSessionManager;
  private readonly jobs: ThaiRagIndexJobStore;
  private readonly healthRefreshMs: number;
  private ownerId: string | undefined;
  private launchConfig: McpServerLaunchConfig | undefined;
  private lastHealth: ThaiRagProviderDriverHealth | undefined;
  private lastHealthAt = 0;
  private workerQueue: Promise<unknown> = Promise.resolve();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly workspaceRootIds = new Map<string, string>();
  private readonly pendingReindexIds = new Set<string>();
  private expectedEmbeddingIndexGeneration = 1;
  private started = false;
  private lifecycleGeneration = 0;
  private backgroundRefresh: Promise<Result<void>> | undefined;
  private shuttingDown = false;
  private stopRequested = false;
  private stopped = false;
  private activeOperations = 0;
  private idleWaiters: Array<() => void> = [];
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private stopPromise: Promise<Result<void>> | undefined;

  public constructor(private readonly options: NativeThaiRagProviderDriverOptions) {
    this.sessions = new McpSessionManager({
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
      idleTimeoutMs: 24 * 60 * 60_000,
    });
    this.jobs = new ThaiRagIndexJobStore(options.dataRoot);
    this.healthRefreshMs = options.healthRefreshMs ?? 5_000;
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
    const contractDrift = described.value.tools.flatMap((tool) => {
      const operation = THAI_RAG_CONFORMANCE_FIXTURE.operations[tool.name as keyof typeof THAI_RAG_CONFORMANCE_FIXTURE.operations];
      if (operation === undefined) return [];
      return validateToolSchema(tool.name, isRecord(tool.inputSchema) ? tool.inputSchema : {}, operation);
    });
    if (missing.length > 0 || contractDrift.length > 0) {
      await this.sessions.close().catch(() => undefined);
      const reason = missing.length > 0 ? 'missing-capability' : 'contract-drift';
      return err(appError('CONFLICT', `Native Thai-RAG worker handshake ${reason}: ${[...missing, ...contractDrift].join(', ')}`, true, { reason, missing: missing.join(','), scopeDrift: contractDrift.join(','), contractDrift: contractDrift.join(',') }));
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
      ...embeddingCompatibility(handshake.value.contractVersion),
      allowedDegradedCapabilities: THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
    });
    if (!compatible.ok) {
      await this.sessions.close().catch(() => undefined);
      return compatible;
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
      ...embeddingCompatibility(healthHandshake.value.contractVersion),
      allowedDegradedCapabilities: THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
    });
    if (!healthy.ok) {
      await this.sessions.close().catch(() => undefined);
      return healthy;
    }
    this.sessions.pin(SERVER_NAME);
    this.started = true;
    for (const workspaceId of this.workspaceRoots.keys()) this.pendingReindexIds.add(workspaceId);
    const health = await this.refreshHealth(signal);
    if (!health.ok) return health;
    if (this.stopRequested) {
      await this.sessions.close().catch(() => undefined);
      return err(appError('CONFLICT', 'Native Thai-RAG provider stopped during startup', true));
    }
    const generation = this.lifecycleGeneration;
    this.backgroundRefresh = this.refreshWorkspaceRoots(generation).then((result) => result, () => ok(undefined));
    return health;
  }

  public health(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    return this.withOperation(() => this.healthStarted(signal));
  }

  private async healthStarted(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    if (!this.started || this.launchConfig === undefined) {
      return err(appError('CONFLICT', 'Native Thai-RAG worker is not started', true));
    }
    const refreshed = await this.refreshWorkspaceRoots();
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
    const refreshed = await this.refreshWorkspaceRoots();
    if (!refreshed.ok) return refreshed;
    if (tool === 'index_status') {
      const jobId = typeof args.job_id === 'string' ? args.job_id : '';
      const workspaceValue = typeof args.workspace_id === 'string' ? args.workspace_id : '';
      const workspace = parseCanonicalWorkspaceId(workspaceValue);
      if (jobId.trim().length === 0 || !workspace.ok) return err(appError('INVALID_INPUT', 'Thai-RAG index_status requires job_id and workspace_id'));
      const job = await this.jobs.get(jobId, this.ownerId ?? '', workspace.value);
      return job === null
        ? err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${jobId}`))
        : ok(job);
    }
    if (tool === 'code_index') return this.codeIndex(args, signal, budget);
    const normalizedArgs = tool === 'pre_edit_context' ? this.canonicalPreEditArgs(args) : ok(args);
    if (!normalizedArgs.ok) return normalizedArgs;
    return this.callWorker(tool, normalizedArgs.value, signal, budget);
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
    const generation = ++this.lifecycleGeneration;
    await this.jobs.interruptRunning(this.ownerId ?? '');
    await this.waitForOperations();
    await this.workerQueue.catch(() => undefined);
    const backgroundRefresh = this.backgroundRefresh;
    const refreshResult = backgroundRefresh === undefined
      ? ok(undefined)
      : await backgroundRefresh.catch((error: unknown) => err(appError('CONFLICT', `Native Thai-RAG background refresh failed during shutdown: ${errorMessage(error)}`, true)));
    if (generation === this.lifecycleGeneration) this.backgroundRefresh = undefined;
    this.sessions.unpin(SERVER_NAME);
    await this.sessions.close().catch(() => undefined);
    this.stopped = true;
    return refreshResult;
  }

  private async codeIndex(args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>> {
    const workspaceValue = typeof args.workspace_path === 'string' ? args.workspace_path : '';
    const workspace = this.resolveIndexWorkspace(workspaceValue);
    if (!workspace.ok) return workspace;
    const force = args.force === true;
    const background = args.background === true;
    const childArgs = {
      workspace_path: workspace.value.rootPath,
      workspace_id: workspace.value.workspaceId,
      force,
      background: false,
    };
    if (!background) return this.callWorker('code_index', childArgs, signal, budget);

      const job = await this.jobs.create(workspace.value.workspaceId, force, this.ownerId ?? '');

    const operation = this.enqueueWorker(async () => {
      const raw = await this.sessions.call(SERVER_NAME, this.launchConfig!, 'code_index', childArgs, undefined, {}, budget);
      const result = normalizeWorkerCallResult('code_index', raw);
      if (result.ok) await this.jobs.complete(job.jobId, result.value, this.ownerId ?? '');
      else await this.jobs.fail(job.jobId, result.error.message, this.ownerId ?? '');
      return result;
    });
    void operation.catch(async (error: unknown) => {
      await this.jobs.fail(job.jobId, errorMessage(error), this.ownerId ?? '').catch(() => undefined);
    });
    return ok({ job_id: job.jobId, status: 'running', workspace_id: workspace.value.workspaceId });
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

  private refreshWorkspaceRoots(generation = this.lifecycleGeneration): Promise<Result<void>> {
    return this.enqueueWorker(() => this.refreshWorkspaceRootsNow(generation));
  }

  private async refreshWorkspaceRootsNow(generation: number): Promise<Result<void>> {
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
    for (const workspaceId of aliases.value) this.pendingReindexIds.add(workspaceId);
    const relinked = workspaces.filter((workspace) => {
      const previousRoot = this.workspaceRoots.get(workspace.id);
      return previousRoot !== undefined && previousRoot !== path.resolve(workspace.realRootPath);
    });
    for (const workspace of relinked) this.pendingReindexIds.add(workspace.id);
    if (generation === this.lifecycleGeneration && this.started && this.launchConfig !== undefined) {
      const pending = new Set(this.pendingReindexIds);
      for (const workspace of workspaces.filter((entry) => pending.has(entry.id))) {
        const indexed = normalizeWorkerCallResult(
          'code_index',
          await this.sessions.call(SERVER_NAME, this.launchConfig, 'code_index', {
            workspace_path: path.resolve(workspace.realRootPath),
            workspace_id: workspace.id,
            force: true,
            background: false,
          }),
        );

        if (!this.refreshIsCurrent(generation) || !this.started) {
          return this.restoreRefreshState(sourcesRoot, previousWorkspaces, previousRoots, previousRootIds);
        }
        if (!indexed.ok) {
          for (const workspaceId of pending) this.pendingReindexIds.add(workspaceId);
           const rolledBack = await syncWorkspaceSourceAliases(sourcesRoot, previousWorkspaces);
          if (!rolledBack.ok) {
            this.workspaceRoots.clear();
            this.workspaceRootIds.clear();
            return err(appError('CONFLICT', `Native Thai-RAG refresh failed and could not restore its previous state: ${rolledBack.error.message}`, true));
          }
          return err(appError('CONFLICT', `Native Thai-RAG reindex failed for workspace ${workspace.id}: ${indexed.error.message}`, true));
        }
        this.pendingReindexIds.delete(workspace.id);
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
    return ok(undefined);
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
      ...embeddingCompatibility(handshake.value.contractVersion),
      allowedDegradedCapabilities: THAI_RAG_ALLOWED_DEGRADED_CAPABILITIES,
    });
    if (!compatible.ok) return compatible;
    if (handshake.value.components === undefined) {
      return err(appError('CONFLICT', 'Native Thai-RAG health response omitted structured component diagnostics', true, { reason: 'missing-health-components' }));
    }
    const activeJobs = await this.jobs.active(this.ownerId ?? '');
    const health: ThaiRagProviderDriverHealth = {
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

function parseProviderHandshake(value: unknown): Result<ThaiRagProviderHandshake> {
  const outer = isRecord(value) && isRecord(value.structuredContent) && isRecord(value.structuredContent.data)
    ? value.structuredContent.data
    : isRecord(value) && isRecord(value.data) ? value.data : value;
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

function validateToolSchema(
  name: string,
  value: Record<string, unknown>,
  operation: { readonly scope: string; readonly required?: readonly string[] },
): string[] {
  const properties = isRecord(value.properties) ? value.properties : undefined;
  const required = Array.isArray(value.required) && value.required.every((field) => typeof field === 'string') ? value.required : undefined;
  if (operation.scope !== 'workspace_id') return [];
  if (properties === undefined || required === undefined) return [name];
  if (!isRecord(properties.workspace_id) || !required.includes('workspace_id')) return [name];
  return (operation.required ?? []).filter((field) => !isRecord(properties[field]) || !required.includes(field)).map(() => name);
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
      { reason: structuredError.code, providerStatus: structuredError.status },
    ));
  }
  const text = toolResultText(result.value)?.trim();
  return text !== undefined && /^(?:❌\s*)?Error\b/i.test(text)
    ? err(appError('CONFLICT', `Native Thai-RAG ${tool} failed: ${text}`, true))
    : result;
}

function structuredProviderError(value: unknown): { readonly code: string; readonly message: string; readonly status: string } | undefined {
  if (!isRecord(value) || !isRecord(value.structuredContent) || !isRecord(value.structuredContent.data)) return undefined;
  const data = value.structuredContent.data;
  if (!Array.isArray(data.errors) || data.errors.length === 0 || !isRecord(data.errors[0])) return undefined;
  const error = data.errors[0];
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return undefined;
  return {
    code: error.code,
    message: error.message,
    status: typeof data.status === 'string' ? data.status : 'unavailable',
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value && value.code === code;
}
