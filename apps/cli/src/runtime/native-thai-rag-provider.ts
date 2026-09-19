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
  type ThaiRagProviderDriver,
  type ThaiRagProviderDriverHealth,
  type ThaiRagProviderDriverStartOptions,
} from '@unified-mpc/thai-rag';

const SERVER_NAME = 'thai-rag-native';
const REQUIRED_TOOLS = new Set([
  'remember', 'recall', 'pre_edit_context', 'code_blast_radius',
  'forget', 'code_index', 'index_status', 'code_search', 'code_context',
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
  private launchConfig: McpServerLaunchConfig | undefined;
  private lastHealth: ThaiRagProviderDriverHealth | undefined;
  private lastHealthAt = 0;
  private workerQueue: Promise<unknown> = Promise.resolve();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly workspaceRootIds = new Map<string, string>();
  private readonly pendingReindexIds = new Set<string>();
  private started = false;
  private lifecycleGeneration = 0;
  private backgroundRefresh: Promise<Result<void>> | undefined;

  public constructor(private readonly options: NativeThaiRagProviderDriverOptions) {
    this.sessions = new McpSessionManager({
      ...(options.clientFactory === undefined ? {} : { clientFactory: options.clientFactory }),
      ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
      idleTimeoutMs: 24 * 60 * 60_000,
    });
    this.jobs = new ThaiRagIndexJobStore(options.dataRoot);
    this.healthRefreshMs = options.healthRefreshMs ?? 5_000;
  }

  public async start(options: ThaiRagProviderDriverStartOptions, signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    await this.jobs.initialize();
    const providerRoot = resolveThaiRagProviderRoot(this.options.dataRoot);
    if (!providerRoot.ok) return providerRoot;
    const refreshed = await this.refreshWorkspaceRoots();
    if (!refreshed.ok) return refreshed;
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
    const toolNames = new Set(described.value.tools.map((tool) => tool.name));
    const missing = [...REQUIRED_TOOLS].filter((tool) => !toolNames.has(tool));
    if (missing.length > 0) {
      await this.sessions.close().catch(() => undefined);
      return err(appError('CONFLICT', `Native Thai-RAG worker is missing required tools: ${missing.join(', ')}`, true));
    }
    const codeIndexTool = described.value.tools.find((tool) => tool.name === 'code_index');
    if (codeIndexTool === undefined || !toolAcceptsWorkspaceNamespace(codeIndexTool.inputSchema)) {
      await this.sessions.close().catch(() => undefined);
      return err(appError('CONFLICT', 'Native Thai-RAG worker code_index does not support the explicit workspace namespace contract', true));
    }
    const forgetTool = described.value.tools.find((tool) => tool.name === 'forget');
    if (forgetTool === undefined || !toolAcceptsProperty(forgetTool.inputSchema, 'category')) {
      await this.sessions.close().catch(() => undefined);
      return err(appError('CONFLICT', 'Native Thai-RAG worker forget does not support the workspace category contract', true));
    }
    this.sessions.pin(SERVER_NAME);
    this.started = true;
    for (const workspaceId of this.workspaceRoots.keys()) this.pendingReindexIds.add(workspaceId);
    const health = await this.refreshHealth(signal);
    if (!health.ok) return health;
    const generation = this.lifecycleGeneration;
    this.backgroundRefresh = this.refreshWorkspaceRoots(generation);
    return health;
  }

  public async health(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    if (!this.started || this.launchConfig === undefined) {
      return err(appError('CONFLICT', 'Native Thai-RAG worker is not started', true));
    }
    const refreshed = await this.refreshWorkspaceRoots();
    if (!refreshed.ok) return refreshed;
    const activeJobs = await this.jobs.active();
    if (activeJobs.length > 0 && this.lastHealth !== undefined) {
      return ok({ ...this.lastHealth, activeJobs: activeJobs.map((job) => job.jobId) });
    }
    if (this.lastHealth !== undefined && Date.now() - this.lastHealthAt < this.healthRefreshMs) {
      return ok(this.lastHealth);
    }
    return this.refreshHealth(signal);
  }

  public async call(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>> {
    if (!this.started || this.launchConfig === undefined) {
      return err(appError('CONFLICT', 'Native Thai-RAG worker is not started', true));
    }
    const refreshed = await this.refreshWorkspaceRoots();
    if (!refreshed.ok) return refreshed;
    if (tool === 'index_status' && typeof args.job_id === 'string' && args.job_id.startsWith('idx_umcp_')) {
      const job = await this.jobs.get(args.job_id);
      return job === null
        ? err(appError('FILE_NOT_FOUND', `Native Thai-RAG index job was not found: ${args.job_id}`))
        : ok(job);
    }
    if (tool === 'code_index') return this.codeIndex(args, signal, budget);
    const normalizedArgs = tool === 'pre_edit_context' ? this.canonicalPreEditArgs(args) : ok(args);
    if (!normalizedArgs.ok) return normalizedArgs;
    return this.callWorker(tool, normalizedArgs.value, signal, budget);
  }

  public async stop(): Promise<Result<void>> {
    this.started = false;
    const generation = ++this.lifecycleGeneration;
    await this.jobs.interruptRunning();
    const backgroundRefresh = this.backgroundRefresh;
    if (backgroundRefresh !== undefined) await backgroundRefresh.catch(() => undefined);
    if (generation === this.lifecycleGeneration) this.backgroundRefresh = undefined;
    this.sessions.unpin(SERVER_NAME);
    await this.sessions.close().catch(() => undefined);
    return ok(undefined);
  }

  private async codeIndex(args: Readonly<Record<string, unknown>>, signal?: AbortSignal, budget?: ResultBudget): Promise<Result<unknown>> {
    const workspaceValue = typeof args.workspace_path === 'string' ? args.workspace_path : '';
    const workspace = this.resolveIndexWorkspace(workspaceValue);
    if (!workspace.ok) return workspace;
    const force = args.force === true;
    const background = args.background === true;
    const childArgs = {
      workspace_path: workspace.value.rootPath,
      workspace: workspace.value.workspaceId,
      force,
      background: false,
    };
    if (!background) return this.callWorker('code_index', childArgs, signal, budget);

    const job = await this.jobs.create(workspace.value.workspaceId, force);
    const operation = this.enqueueWorker(async () => {
      const raw = await this.sessions.call(SERVER_NAME, this.launchConfig!, 'code_index', childArgs, undefined, {}, budget);
      const result = normalizeWorkerCallResult('code_index', raw);
      if (result.ok) await this.jobs.complete(job.jobId, result.value);
      else await this.jobs.fail(job.jobId, result.error.message);
      return result;
    });
    void operation.catch(async (error: unknown) => {
      await this.jobs.fail(job.jobId, errorMessage(error)).catch(() => undefined);
    });
    return ok({ job_id: job.jobId, status: 'running', workspace: workspace.value.workspaceId });
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
    try {
      await mkdir(sourcesRoot, { recursive: true });
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', `Unable to prepare Native Thai-RAG sources: ${errorMessage(error)}`, true));
    }
    const aliases = await syncWorkspaceSourceAliases(sourcesRoot, workspaces);
    if (!aliases.ok) return aliases;
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
            workspace: workspace.id,
            force: true,
            background: false,
            }),
          );
        if (generation !== this.lifecycleGeneration || !this.started) return ok(undefined);
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

    if (generation !== this.lifecycleGeneration) return ok(undefined);
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
    const workspaceValue = typeof args.workspace === 'string' ? args.workspace : '';
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
    return ok({ ...args, workspace: workspace.value, file_path: `${workspace.value}/${relative}` });
  }

  private async refreshHealth(signal?: AbortSignal): Promise<Result<ThaiRagProviderDriverHealth>> {
    const config = this.launchConfig;
    if (!this.started || config === undefined) return err(appError('CONFLICT', 'Native Thai-RAG worker is not started', true));
    const storageProbe = await this.enqueueWorker(() => this.sessions.call(SERVER_NAME, config, 'code_blast_radius', {
      symbol_name: '__unified_mpc_health_probe__',
      workspace: '',
      max_depth: 1,
    }, signal));
    const storageAvailable = storageProbe.ok && !toolResultIsError(storageProbe.value);

    let semanticAvailable = false;
    if (storageAvailable) {
      const semanticProbe = await this.enqueueWorker(() => this.sessions.call(SERVER_NAME, config, 'code_search', {
        query: '__unified_mpc_health_probe__',
        top_k: 1,
      }, signal));
      semanticAvailable = semanticProbe.ok && !toolResultIsError(semanticProbe.value);
    }
    const activeJobs = await this.jobs.active();
    const health: ThaiRagProviderDriverHealth = {
      workerReachable: true,
      sqliteAvailable: storageAvailable,
      ftsAvailable: storageAvailable,
      vectorStoreAvailable: storageAvailable,
      embedderAvailable: semanticAvailable,
      lexicalRetrievalAvailable: storageAvailable,
      semanticRetrievalAvailable: semanticAvailable,
      activeJobs: activeJobs.map((job) => job.jobId),
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
}

async function syncWorkspaceSourceAliases(
  sourcesRoot: string,
  workspaces: readonly NativeThaiRagWorkspace[],
): Promise<Result<readonly string[]>> {
  const expected = new Map(workspaces.map((workspace) => [workspace.id, path.resolve(workspace.realRootPath)]));
  const changed: Array<{ readonly alias: string; readonly previousTarget: string | null }> = [];
  const changedWorkspaceIds = new Set<string>();

  try {
    const entries = await readdir(sourcesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!parseCanonicalWorkspaceId(entry.name).ok || expected.has(entry.name)) continue;
      const alias = path.join(sourcesRoot, entry.name);
      const metadata = await lstat(alias);
      if (!metadata.isSymbolicLink()) {
        await rollbackWorkspaceAliases(changed);
        return err(appError('CONFLICT', `Thai-RAG source alias path is occupied by a non-symlink: ${alias}`, true));
      }
      changed.push({ alias, previousTarget: await readlink(alias) });
      await unlink(alias);
    }

    for (const [workspaceId, target] of expected) {
      const alias = path.join(sourcesRoot, workspaceId);
      let existingTarget: string | null = null;
      try {
        const metadata = await lstat(alias);
        if (!metadata.isSymbolicLink()) {
          await rollbackWorkspaceAliases(changed);
          return err(appError('CONFLICT', `Thai-RAG source alias path is occupied by a non-symlink: ${alias}`, true));
        }
        existingTarget = await readlink(alias);
      } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) throw error;
      }

      if (existingTarget !== null && path.resolve(path.dirname(alias), existingTarget) === target) continue;
      if (existingTarget !== null) {
        changed.push({ alias, previousTarget: existingTarget });
        await unlink(alias);
        changedWorkspaceIds.add(workspaceId);
      } else {
        changed.push({ alias, previousTarget: null });
        changedWorkspaceIds.add(workspaceId);
      }
      await symlink(target, alias, 'dir');
    }
    return ok([...changedWorkspaceIds]);
  } catch (error: unknown) {
    await rollbackWorkspaceAliases(changed);
    return err(appError('INTERNAL_ERROR', `Unable to refresh Thai-RAG workspace aliases: ${errorMessage(error)}`, true));
  }
}

async function rollbackWorkspaceAliases(changed: readonly { readonly alias: string; readonly previousTarget: string | null }[]): Promise<void> {
  await Promise.all([...changed].reverse().map(async ({ alias, previousTarget }) => {
    await rm(alias, { force: true, recursive: true }).catch(() => undefined);
    if (previousTarget !== null) await symlink(previousTarget, alias, 'dir').catch(() => undefined);
  }));
}

function normalizeWorkerCallResult(tool: string, result: Result<unknown>): Result<unknown> {
  if (!result.ok) return result;
  const text = toolResultText(result.value)?.trim();
  return text !== undefined && /^(?:❌\s*)?Error\b/i.test(text)
    ? err(appError('CONFLICT', `Native Thai-RAG ${tool} failed: ${text}`, true))
    : result;
}

function toolResultIsError(value: unknown): boolean {
  const text = toolResultText(value)?.trim();
  return text !== undefined && /^(?:❌\s*)?Error\b/i.test(text);
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

function toolAcceptsWorkspaceNamespace(inputSchema: unknown): boolean {
  return toolAcceptsProperty(inputSchema, 'workspace');
}

function toolAcceptsProperty(inputSchema: unknown, property: string): boolean {
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) return false;
  return Object.prototype.hasOwnProperty.call(inputSchema.properties, property);
}
