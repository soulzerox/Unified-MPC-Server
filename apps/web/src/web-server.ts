import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { renderDashboardHtml } from './dashboard-html.js';
import { CloudflareTunnelReconciler, type CloudflareTunnelSetup } from './cloudflare-client.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
import type { GatewayTunnelConfiguration } from '@unified-mpc/cf-gateway';
import type {
  GoalRuntimeEventReplayPage,
  GoalRuntimeSnapshotRecord,
  ListWorkspaceGoalRuntimeSnapshotsRequest,
  ReplayWorkspaceGoalRuntimeEventsRequest,
} from '@unified-mpc/domain';
import type { SecretStore, SqliteSettingsRepository } from '@unified-mpc/storage';
import { isMcpRuntimeDiagnosticsSnapshot, type McpRuntimeDiagnosticsSnapshot } from '@unified-mpc/shared';
import {
  DEFAULT_EXTENSIONS_SETTINGS,
  EXTENSIONS_SETTINGS_KEY,
  IdeSyncService,
  McpConfigLoader,
  PrunerService,
  SkillCatalog,
  configuredPolicies,
  parseExtensionsSettings,
  reconcileRuntimePolicies,
  type ExtensionsSettings,
  type PolicyEntry,
  type PruneServerInput,
  type RuntimePolicySnapshot,
  type SyncTarget,
} from '@unified-mpc/extensions';

export interface WebWorkspaceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly realRootPath: string;
}

export interface WebWorkspaceSelectionSnapshot {
  readonly primaryWorkspaceId: string;
  readonly activeWorkspaceIds: readonly string[];
}

export interface WebGoalStepSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export interface WebGoalSummary {
  readonly goalId: string;
  readonly goalKey: string;
  readonly objective: string;
  readonly status: 'active';
  readonly currentPhase: string;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly blockers: readonly string[];
  readonly nextAction: string;
  readonly steps: readonly WebGoalStepSummary[];
  readonly updatedAt: string;
}

export interface WorkspaceControlPort {
  list(): Promise<readonly WebWorkspaceSummary[]>;
  selection(): Promise<WebWorkspaceSelectionSnapshot | null>;
  activate(workspaceId: string): Promise<WebWorkspaceSelectionSnapshot>;
  deactivate(workspaceId: string): Promise<WebWorkspaceSelectionSnapshot>;
  setPrimary(workspaceId: string): Promise<WebWorkspaceSelectionSnapshot>;
  remove(workspaceId: string): Promise<WebWorkspaceSelectionSnapshot | null>;
}

export interface GoalControlPort {
  countOpen(workspaceId: string): Promise<number>;
  preferred(workspaceId: string): Promise<string | null>;
  listOpen(workspaceId: string): Promise<readonly WebGoalSummary[]>;
  continue(workspaceId: string, goalId: string): Promise<WebGoalSummary>;
}

export interface GoalRuntimeReadPort {
  listWorkspaceGoalRuntimeSnapshots(
    request: ListWorkspaceGoalRuntimeSnapshotsRequest,
  ): Promise<readonly GoalRuntimeSnapshotRecord[]>;
  replayWorkspaceGoalRuntimeEvents(
    request: ReplayWorkspaceGoalRuntimeEventsRequest,
  ): Promise<GoalRuntimeEventReplayPage>;
}

export interface WebMcpRuntimeIdentity {
  readonly product: string;
  readonly service: string;
  readonly protocol: number;
  readonly version: string;
  readonly buildVersion?: string;
  readonly buildCommit?: string;
  readonly buildShortCommit?: string;
  readonly buildTime?: string;
  readonly buildDirty?: boolean;
}

export type McpIdentityProbe = (localPort: number) => Promise<WebMcpRuntimeIdentity | null>;
export type McpRuntimeDiagnosticsProbe = (localPort: number) => Promise<McpRuntimeDiagnosticsSnapshot | null>;

export interface ControlPlaneServerOptions {
  readonly port?: number;
  readonly gatewayLocalPort?: number;
  readonly workspaceRoots?: readonly string[];
  readonly dataDir?: string;
  readonly gateway?: GatewayService;
  readonly pruner?: PrunerService;
  readonly ideSync?: IdeSyncService;
  readonly skillCatalog?: SkillCatalog;
  readonly serverCatalog?: McpConfigLoader;
  /** Test-only override; production generates a fresh token on every startup. */
  readonly capabilityToken?: string;
  readonly settingsRepository?: Pick<SqliteSettingsRepository, 'get' | 'set' | 'delete'>;
  readonly secretStore?: SecretStore;
  readonly cloudflareReconciler?: CloudflareTunnelReconciler;
  readonly workspaceControl?: WorkspaceControlPort;
  readonly goalControl?: GoalControlPort;
  readonly goalRuntimeRead?: GoalRuntimeReadPort;
  /** Test-only override for the bounded SSE event-log poll cadence. */
  readonly goalRuntimeStreamPollMs?: number;
  readonly mcpIdentityProbe?: McpIdentityProbe;
  readonly mcpRuntimeDiagnosticsProbe?: McpRuntimeDiagnosticsProbe;
  readonly closeSettings?: () => void;
}

const GOAL_RUNTIME_SNAPSHOT_LIMIT = 500;
const GOAL_RUNTIME_REPLAY_LIMIT = 100;
const DEFAULT_GOAL_RUNTIME_STREAM_POLL_MS = 500;
const GOAL_RUNTIME_STREAM_KEEPALIVE_MS = 15_000;

const SETTING_KEYS = Object.freeze({
  tunnelName: 'cloudflare_tunnel_name',
  publicUrl: 'cloudflare_public_url',
  allowedHostnames: 'mcp_allowed_hostnames',
  allowedOrigins: 'mcp_allowed_origins',
  tokenConfigured: 'cloudflare_tunnel_token_configured',
  accountId: 'cloudflare_account_id',
  zoneName: 'cloudflare_zone_name',
  originUrl: 'cloudflare_origin_url',
  remoteTunnelId: 'cloudflare_remote_tunnel_id',
  apiTokenConfigured: 'cloudflare_api_token_configured',
  gatewayDesiredState: 'cloudflare_gateway_desired_state',
  extensions: EXTENSIONS_SETTINGS_KEY,
});

interface RegisteredServer {
  readonly serverId: string;
  readonly name: string;
  readonly source: string;
}

export interface TelemetryLogEntry {
  readonly time: string;
  readonly level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR';
  readonly msg: string;
}

export class ControlPlaneServer {
  private readonly server: HttpServer;
  private readonly configuredPort: number;
  private readonly workspaceRoots: ReadonlySet<string>;
  private boundPort = 0;
  private readonly gateway: GatewayService;
  private readonly ownsGateway: boolean;
  private readonly dataDir: string;
  private readonly prunerOverride: PrunerService | undefined;
  private readonly ideSync: IdeSyncService;
  private readonly skillCatalogOverride: SkillCatalog | undefined;
  private readonly serverCatalogOverride: McpConfigLoader | undefined;
  private readonly serverRegistry = new Map<string, RegisteredServer>();
  private readonly telemetryLogs: TelemetryLogEntry[] = [];
  private readonly capabilityToken: Buffer;
  private readonly settingsRepository: Pick<SqliteSettingsRepository, 'get' | 'set' | 'delete'> | undefined;
  private readonly secretStore: SecretStore | undefined;
  private readonly cloudflareReconciler: CloudflareTunnelReconciler;
  private readonly workspaceControl: WorkspaceControlPort | undefined;
  private readonly goalControl: GoalControlPort | undefined;
  private readonly goalRuntimeRead: GoalRuntimeReadPort | undefined;
  private readonly goalRuntimeStreamPollMs: number;
  private readonly goalRuntimeStreamClosers = new Set<() => void>();
  private readonly mcpIdentityProbe: McpIdentityProbe;
  private readonly mcpRuntimeDiagnosticsProbe: McpRuntimeDiagnosticsProbe;
  private readonly closeSettings: (() => void) | undefined;
  private gatewayRestoreGeneration = 0;
  private closing = false;

  private recordLog(level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR', msg: string): void {
    const now = new Date();
    const time = now.toTimeString().split(' ')[0] ?? '00:00:00';
    this.telemetryLogs.push({ time, level, msg });
    if (this.telemetryLogs.length > 200) {
      this.telemetryLogs.shift();
    }
  }

  public constructor(options: ControlPlaneServerOptions = {}) {
    this.configuredPort = options.port ?? configuredPort('UNIFIED_MPC_WEB_PORT', 3000);
    this.workspaceRoots = new Set((options.workspaceRoots ?? [process.cwd()]).map((root) => path.resolve(root.trim())).filter((root) => root.length > 0));
    this.ownsGateway = options.gateway === undefined;
    this.gateway = options.gateway ?? new GatewayService({ localPort: options.gatewayLocalPort ?? configuredPort('UNIFIED_MPC_PORT', 18765) });
    this.dataDir = options.dataDir?.trim() || path.join(os.homedir(), '.local', 'share', 'unified-mpc');
    this.prunerOverride = options.pruner;
    this.ideSync = options.ideSync ?? new IdeSyncService();
    this.skillCatalogOverride = options.skillCatalog;
    this.serverCatalogOverride = options.serverCatalog;
    this.capabilityToken = Buffer.from(options.capabilityToken ?? randomBytes(32).toString('hex'), 'utf8');
    this.settingsRepository = options.settingsRepository;
    this.secretStore = options.secretStore;
    this.cloudflareReconciler = options.cloudflareReconciler ?? new CloudflareTunnelReconciler();
    this.workspaceControl = options.workspaceControl;
    this.goalControl = options.goalControl;
    this.goalRuntimeRead = options.goalRuntimeRead;
    if (options.goalRuntimeStreamPollMs !== undefined
      && (!Number.isInteger(options.goalRuntimeStreamPollMs) || options.goalRuntimeStreamPollMs <= 0)) {
      throw new Error('Goal runtime SSE poll interval must be a positive integer');
    }
    this.goalRuntimeStreamPollMs = options.goalRuntimeStreamPollMs ?? DEFAULT_GOAL_RUNTIME_STREAM_POLL_MS;
    this.mcpIdentityProbe = options.mcpIdentityProbe ?? probeMcpRuntimeIdentity;
    this.mcpRuntimeDiagnosticsProbe = options.mcpRuntimeDiagnosticsProbe ?? probeMcpRuntimeDiagnostics;
    this.closeSettings = options.closeSettings;

    this.recordLog('INFO', 'ControlPlaneServer initialized with loopback policy guard');

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: unknown) => this.handleRequestFailure(res, error));
    });
  }

  public get port(): number {
    return this.boundPort;
  }

  public async listen(): Promise<void> {
    this.closing = false;
    await new Promise<void>((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.configuredPort, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.boundPort = addr.port;
          this.recordLog('INFO', `ControlPlaneServer listening on http://127.0.0.1:${this.boundPort}`);
        }
        resolve();
      });
    });

    const generation = ++this.gatewayRestoreGeneration;
    void this.loadPersistedGatewayConfiguration(generation).catch((error: unknown) => {
      if (!this.isGatewayRestoreActive(generation)) return;
      this.recordLog('ERROR', `Persisted ChatGPT Gateway restore failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
  }

  public async close(): Promise<void> {
    this.closing = true;
    this.gatewayRestoreGeneration += 1;
    for (const closeStream of [...this.goalRuntimeStreamClosers]) closeStream();
    this.goalRuntimeStreamClosers.clear();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    if (this.ownsGateway) await this.gateway.stop();
    this.closeSettings?.();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (!isLoopbackHost(host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Host not allowed: loopback only' }));
      return;
    }

    // Browser Origin is required for mutations; Host remains primary loopback boundary.
    const origin = req.headers.origin;
    const requestPath = new URL(req.url ?? '/', `http://127.0.0.1:${this.boundPort}`).pathname;
    const originRequired = req.method !== 'GET' && req.method !== 'HEAD' || requestPath === '/api/chatgpt-web/connect' || requestPath === '/api/chatgpt-web/disconnect';
    if (originRequired && origin === undefined) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin header required for mutations' }));
      return;
    }
    const mutation = (req.method !== 'GET' && req.method !== 'HEAD') || requestPath === '/api/chatgpt-web/connect' || requestPath === '/api/chatgpt-web/disconnect';
    if (mutation && !this.hasCapability(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Capability authorization required' }));
      return;
    }
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (
          (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
          (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Origin not allowed: loopback only' }));
          return;
        }
      } catch {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid origin header' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.boundPort}`);
    const pathname = url.pathname;

    // 2. Static Dashboard HTML
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `unified_mpc_capability=${encodeURIComponent(this.capabilityToken.toString('utf8'))}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end(renderDashboardHtml());
      return;
    }

    // 3. API Routes
    if (pathname === '/_unified-mpc/ready' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ready', service: 'web', port: this.boundPort }));
      return;
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      const gateway = this.gateway.status();
      const mcpIdentity = await this.mcpIdentityProbe(gateway.localPort);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        status: 'healthy',
        gateway,
        mcpIdentity,
      }));
      return;
    }

    if (pathname === '/api/runtime-diagnostics' && req.method === 'GET') {
      const gateway = this.gateway.status();
      const diagnostics = await this.mcpRuntimeDiagnosticsProbe(gateway.localPort);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      if (diagnostics === null) {
        res.statusCode = 503;
        res.end(JSON.stringify({
          available: false,
          scope: 'control-plane-process',
          error: 'MCP runtime diagnostics unavailable',
        }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({
        available: true,
        scope: 'control-plane-process',
        diagnostics,
      }));
      return;
    }

    if (pathname === '/api/workspaces' && req.method === 'GET') {
      const registeredWorkspaces = await this.workspaceControl?.list() ?? [];
      const selection = this.workspaceControl === undefined ? null : await this.workspaceControl.selection();
      const workspaces = await Promise.all(registeredWorkspaces.map(async (workspace) => ({
        ...workspace,
        openGoalCount: this.goalControl === undefined ? 0 : await this.goalControl.countOpen(workspace.id),
        preferredGoalId: this.goalControl === undefined ? null : await this.goalControl.preferred(workspace.id),
      })));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ workspaces, selection }));
      return;
    }

    const workspaceGoalsRoute = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals$/);
    if (workspaceGoalsRoute !== null && req.method === 'GET') {
      const workspaceId = decodeURIComponent(workspaceGoalsRoute[1]!);
      const registered = await this.workspaceControl?.list() ?? [];
      if (!registered.some((workspace) => workspace.id === workspaceId)) {
        sendJsonError(res, 404, 'Workspace is not a registered project');
        return;
      }
      const goals = this.goalControl === undefined ? [] : await this.goalControl.listOpen(workspaceId);
      const preferredGoalId = this.goalControl === undefined ? null : await this.goalControl.preferred(workspaceId);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ goals, preferredGoalId }));
      return;
    }

    const workspaceGoalRuntimeEventsRoute = pathname.match(/^\/api\/workspaces\/([^/]+)\/goal-runtime\/events$/);
    if (workspaceGoalRuntimeEventsRoute !== null && req.method === 'GET') {
      if (this.goalRuntimeRead === undefined) {
        sendJsonError(res, 503, 'Goal runtime projection service is unavailable');
        return;
      }
      const workspaceId = decodeURIComponent(workspaceGoalRuntimeEventsRoute[1]!);
      if (!(await this.isRegisteredWorkspace(workspaceId))) {
        sendJsonError(res, 404, 'Workspace is not a registered project');
        return;
      }
      const cursor = parseGoalRuntimeEventCursor(req.headers['last-event-id']);
      if (!cursor.ok) {
        sendJsonError(res, 400, cursor.error);
        return;
      }
      await this.openGoalRuntimeEventStream(res, workspaceId, cursor.value);
      return;
    }

    const workspaceGoalRuntimeRoute = pathname.match(/^\/api\/workspaces\/([^/]+)\/goal-runtime$/);
    if (workspaceGoalRuntimeRoute !== null && req.method === 'GET') {
      if (this.goalRuntimeRead === undefined) {
        sendJsonError(res, 503, 'Goal runtime projection service is unavailable');
        return;
      }
      const workspaceId = decodeURIComponent(workspaceGoalRuntimeRoute[1]!);
      if (!(await this.isRegisteredWorkspace(workspaceId))) {
        sendJsonError(res, 404, 'Workspace is not a registered project');
        return;
      }
      const [snapshots, bounds] = await Promise.all([
        this.goalRuntimeRead.listWorkspaceGoalRuntimeSnapshots({
          workspaceId,
          limit: GOAL_RUNTIME_SNAPSHOT_LIMIT,
        }),
        this.goalRuntimeRead.replayWorkspaceGoalRuntimeEvents({
          workspaceId,
          limit: 1,
        }),
      ]);
      const cursor = goalRuntimeSnapshotCursor(snapshots, bounds);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        workspaceId,
        snapshots,
        cursor,
        latestSequence: bounds.latestSequence ?? null,
        oldestAvailableSequence: bounds.oldestAvailableSequence ?? null,
      }));
      return;
    }

    const workspaceGoalContinueRoute = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals\/([^/]+)\/continue$/);
    if (workspaceGoalContinueRoute !== null && req.method === 'PUT') {
      if (this.workspaceControl === undefined || this.goalControl === undefined) {
        sendJsonError(res, 503, 'Workspace goal service is unavailable');
        return;
      }
      const workspaceId = decodeURIComponent(workspaceGoalContinueRoute[1]!);
      const goalId = decodeURIComponent(workspaceGoalContinueRoute[2]!);
      try {
        const registered = await this.workspaceControl.list();
        if (!registered.some((workspace) => workspace.id === workspaceId)) throw new Error('Workspace is not a registered project');
        const goal = await this.goalControl.continue(workspaceId, goalId);
        const selection = await this.workspaceControl.selection();
        this.recordLog('SUCCESS', `Preferred workspace goal selected: ${workspaceId} ${goal.goalKey}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ goal, preferredGoalId: goal.goalId, selection }));
      } catch (error) {
        sendJsonError(res, 400, error instanceof Error ? error.message : 'Goal continuation selection failed');
      }
      return;
    }

    const workspaceRemovalRoute = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
    if (workspaceRemovalRoute !== null && req.method === 'DELETE') {
      if (this.workspaceControl === undefined) {
        sendJsonError(res, 503, 'Workspace selection service is unavailable');
        return;
      }
      const workspaceId = decodeURIComponent(workspaceRemovalRoute[1]!);
      try {
        const selection = await this.workspaceControl.remove(workspaceId);
        this.recordLog('SUCCESS', `Workspace registration removed: ${workspaceId}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ selection }));
      } catch (error) {
        sendJsonError(res, 400, error instanceof Error ? error.message : 'Workspace removal failed');
      }
      return;
    }

    const workspaceRoute = pathname.match(/^\/api\/workspaces\/([^/]+)\/(active|primary)$/);
    if (workspaceRoute !== null) {
      if (this.workspaceControl === undefined) {
        sendJsonError(res, 503, 'Workspace selection service is unavailable');
        return;
      }
      const workspaceId = decodeURIComponent(workspaceRoute[1]!);
      const action = workspaceRoute[2]!;
      try {
        let selection: WebWorkspaceSelectionSnapshot;
        if (action === 'active' && req.method === 'PUT') {
          selection = await this.workspaceControl.activate(workspaceId);
        } else if (action === 'active' && req.method === 'DELETE') {
          selection = await this.workspaceControl.deactivate(workspaceId);
        } else if (action === 'primary' && req.method === 'PUT') {
          selection = await this.workspaceControl.setPrimary(workspaceId);
        } else {
          res.writeHead(405, { 'Content-Type': 'application/json', Allow: action === 'active' ? 'PUT, DELETE' : 'PUT' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        this.recordLog('SUCCESS', `Workspace selection updated: ${workspaceId} ${action}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ selection }));
      } catch (error) {
        sendJsonError(res, 400, error instanceof Error ? error.message : 'Workspace selection failed');
      }
      return;
    }

    if (pathname === '/api/logs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs: this.telemetryLogs }));
      return;
    }

    if (pathname === '/api/policies' && req.method === 'GET') {
      const snapshot = await this.policySnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
      return;
    }

    if (pathname === '/api/policies' && req.method === 'POST') {
      if (this.settingsRepository === undefined) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Persistent settings are unavailable' }));
        return;
      }
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const policies = parsePolicyEntries(body);
      if (!policies.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: policies.error }));
        return;
      }
      this.persistPolicies(policies.value);
      const snapshot = await this.policySnapshot();
      this.recordLog('SUCCESS', `Saved ${policies.value.length} runtime policies in user-selected priority order`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
      return;
    }

    if (pathname === '/api/servers' && req.method === 'GET') {
      const servers = await this.listRegisteredServers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ servers }));
      return;
    }

    if (pathname === '/api/skills' && req.method === 'GET') {
      const result = await this.currentSkillCatalog().list({});
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.ok ? result.value : result));
      return;
    }

    if (pathname === '/api/policies/sync' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const parsedBody = body as { targets?: readonly SyncTarget[] } | null;
      const targets = Array.isArray(parsedBody?.targets) ? parsedBody.targets : ['all'];
      const settings = this.extensionsSettings();
      const workspaceRoot = this.workspaceRoots.values().next().value as string | undefined;
      const syncService = this.settingsRepository === undefined
        ? this.ideSync
        : new IdeSyncService({
            settings,
            policies: configuredPolicies(settings),
            ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
          });
      const result = await syncService.sync(targets);
      this.recordLog(result.ok ? 'SUCCESS' : 'ERROR', `Policy sync for targets [${targets.join(', ')}]: ${result.ok ? 'OK' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // ChatGPT Gateway Routes
    if (pathname === '/api/chatgpt-gateway/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.gateway.status()));
      return;
    }

    if (pathname === '/api/chatgpt-gateway/start' && req.method === 'POST') {
      this.cancelPersistedGatewayRestore();
      const result = await this.gateway.start();
      if (result.ok) this.settingsRepository?.set(SETTING_KEYS.gatewayDesiredState, 'RUNNING');
      this.recordLog(result.ok ? 'SUCCESS' : 'ERROR', `ChatGPT Gateway start: ${result.ok ? 'OK' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/chatgpt-gateway/stop' && req.method === 'POST') {
      this.cancelPersistedGatewayRestore();
      const result = await this.gateway.stop();
      this.settingsRepository?.set(SETTING_KEYS.gatewayDesiredState, 'STOPPED');
      this.recordLog('INFO', 'ChatGPT Gateway stopped');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      if (this.settingsRepository === undefined) {
        sendJsonError(res, 503, 'Settings persistence is unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ settings: await this.publicSettings() }));
      return;
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      await this.updateSettings(req, res);
      return;
    }

    if (pathname === '/api/cloudflare/reconcile' && req.method === 'POST') {
      await this.reconcileCloudflare(req, res);
      return;
    }

    if (pathname === '/api/cloudflare/status' && req.method === 'GET') {
      if (this.settingsRepository === undefined) {
        sendJsonError(res, 503, 'Settings persistence is unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ settings: await this.publicSettings(), gateway: this.gateway.status() }));
      return;
    }

    // HARD GATING INVARIANT on /api/chatgpt-web/connect
    if (pathname === '/api/chatgpt-web/connect' && req.method === 'POST') {
      if (!this.gateway.canConnectSession()) {
        const current = this.gateway.status();
        this.recordLog('WARN', `Connect blocked by hard gate: state is ${current.state}`);
        res.writeHead(412, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Bridge must be in BRIDGE_HEALTHY state before connecting ChatGPT Web',
          state: current.state,
        }));
        return;
      }

      this.cancelPersistedGatewayRestore();
      const sessionResult = await this.gateway.connectSession();
      if (!sessionResult.ok) {
        this.recordLog('ERROR', `Connect session failed: ${sessionResult.error.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessionResult.error));
        return;
      }

      this.recordLog('SUCCESS', 'Connected ChatGPT Web session');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionResult.value));
      return;
    }

    if (pathname === '/api/chatgpt-web/disconnect' && req.method === 'POST') {
      this.cancelPersistedGatewayRestore();
      const result = await this.gateway.disconnectSession();
      this.recordLog('INFO', 'Disconnected ChatGPT Web session');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Pruning Routes
    if (pathname === '/api/skills/prune' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      if (!isObject(body) || typeof body.name !== 'string') {
        sendJsonError(res, 400, 'Bad Request: skill prune fields are invalid');
        return;
      }
      const authorization = await this.authorizeWorkspaceMutation(body);
      if (!authorization.ok) {
        sendJsonError(res, authorization.status, authorization.message);
        return;
      }
      const result = await this.currentPruner().pruneSkill({
        name: body.name,
        targets: ['unified-mpc'],
        ...(authorization.scope === 'workspace' ? { scope: 'workspace', workspaceRoot: authorization.workspaceRoot } : {}),
      });
      this.recordLog(result.ok ? 'SUCCESS' : 'ERROR', `Prune skill '${body.name}': ${result.ok ? 'OK' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : httpStatusForResult(result), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/servers/prune' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      if (!isObject(body) || typeof body.serverId !== 'string') {
        sendJsonError(res, 403, 'Server ownership proof required');
        return;
      }
      const registered = this.serverRegistry.get(body.serverId);
      if (registered === undefined) {
        sendJsonError(res, 403, 'Unknown or expired server ID');
        return;
      }
      if (body.purgeDataDirs !== undefined) {
        sendJsonError(res, 403, 'Caller-supplied purgeDataDirs are not allowed');
        return;
      }
      const authorization = await this.authorizeWorkspaceMutation(body);
      if (!authorization.ok) {
        sendJsonError(res, authorization.status, authorization.message);
        return;
      }
      const input: PruneServerInput = {
        name: registered.name,
        targets: ['unified-mpc'],
        ...(authorization.scope === 'workspace' ? { scope: 'workspace', workspaceRoot: authorization.workspaceRoot } : {}),
      };
      const result = await this.currentPruner().pruneServer(input);
      this.recordLog(result.ok ? 'SUCCESS' : 'ERROR', `Prune server '${registered.name}': ${result.ok ? 'OK' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : httpStatusForResult(result), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  private hasCapability(req: IncomingMessage): boolean {
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)unified_mpc_capability=([^;]+)/)?.[1];
    const presented = req.headers['x-unified-mpc-capability'] ?? cookie;
    if (typeof presented !== 'string') return false;
    let decoded: string;
    try { decoded = decodeURIComponent(presented); } catch { return false; }
    const candidate = Buffer.from(decoded, 'utf8');
    return candidate.length === this.capabilityToken.length && timingSafeEqual(candidate, this.capabilityToken);
  }

  private async publicSettings(): Promise<Record<string, unknown>> {
    const settings = this.settingsRepository!;
    return {
      tunnelName: settings.get(SETTING_KEYS.tunnelName),
      publicUrl: settings.get(SETTING_KEYS.publicUrl),
      allowedHostnames: splitList(settings.get(SETTING_KEYS.allowedHostnames)),
      allowedOrigins: splitList(settings.get(SETTING_KEYS.allowedOrigins)),
      tunnelTokenConfigured: settings.get(SETTING_KEYS.tokenConfigured) === 'true',
      accountId: settings.get(SETTING_KEYS.accountId),
      zoneName: settings.get(SETTING_KEYS.zoneName),
      originUrl: settings.get(SETTING_KEYS.originUrl),
      remoteTunnelId: settings.get(SETTING_KEYS.remoteTunnelId),
      cloudflareApiTokenConfigured: settings.get(SETTING_KEYS.apiTokenConfigured) === 'true',
    };
  }

  private async reconcileCloudflare(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.settingsRepository === undefined || this.secretStore === undefined) {
      sendJsonError(res, 503, 'Settings persistence and secure secret storage are required');
      return;
    }
    const body = await parseRequestBody(req, res);
    if (body === undefined || !isObject(body)) return;
    const previousConfiguration = this.gateway.configuration();
    const previousGatewayState = this.gateway.status().state;
    // Failure rollback covers runtime/credential identity only; user-entered desired
    // values persist so the settings form stays prefilled across failed attempts.
    const previousSettings = new Map<string, string | null>([
      [SETTING_KEYS.remoteTunnelId, this.settingsRepository.get(SETTING_KEYS.remoteTunnelId)],
      [SETTING_KEYS.apiTokenConfigured, this.settingsRepository.get(SETTING_KEYS.apiTokenConfigured)],
      [SETTING_KEYS.tokenConfigured, this.settingsRepository.get(SETTING_KEYS.tokenConfigured)],
      [SETTING_KEYS.gatewayDesiredState, this.settingsRepository.get(SETTING_KEYS.gatewayDesiredState)],
    ]);
    let previousApiToken: string | null = null;
    let previousTunnelToken: string | null = null;
    let secretSnapshotReady = false;
    let runtimeChanged = false;
    try {
      previousApiToken = await this.secretStore.get('cloudflare_api_token');
      previousTunnelToken = await this.secretStore.get('cloudflare_tunnel_token');
      secretSnapshotReady = true;
      const providedApiToken = readOptionalString(body.apiToken, 'apiToken');
      const apiToken = providedApiToken !== undefined && providedApiToken.length > 0 ? providedApiToken : await this.secretStore.get('cloudflare_api_token');
      const setup: CloudflareTunnelSetup = {
        accountId: readRequiredString(body.accountId, 'accountId'),
        zoneName: readRequiredString(body.zoneName, 'zoneName'),
        tunnelName: readRequiredString(body.tunnelName, 'tunnelName'),
        publicUrl: readRequiredString(body.publicUrl, 'publicUrl'),
        originUrl: readRequiredString(body.originUrl, 'originUrl'),
      };
      const allowlists = {
        hostnames: serializeList(body.allowedHostnames, 'allowedHostnames'),
        origins: serializeList(body.allowedOrigins, 'allowedOrigins'),
      };
      if (apiToken === undefined || apiToken === null || apiToken.length === 0) throw new Error('Cloudflare API token is required — enter a new token or keep the previously saved one');

      this.cancelPersistedGatewayRestore();

      // Persist the user-entered desired configuration before contacting Cloudflare so a
      // failed attempt never forces re-typing the whole form. Secrets and runtime
      // identity are still rolled back on failure.
      this.settingsRepository.set(SETTING_KEYS.accountId, setup.accountId.trim());
      this.settingsRepository.set(SETTING_KEYS.zoneName, setup.zoneName.trim());
      this.settingsRepository.set(SETTING_KEYS.tunnelName, setup.tunnelName.trim());
      this.settingsRepository.set(SETTING_KEYS.publicUrl, setup.publicUrl.trim());
      this.settingsRepository.set(SETTING_KEYS.originUrl, setup.originUrl.trim());
      this.settingsRepository.set(SETTING_KEYS.allowedHostnames, allowlists.hostnames);
      this.settingsRepository.set(SETTING_KEYS.allowedOrigins, allowlists.origins);

      const result = await this.cloudflareReconciler.reconcile(apiToken, setup);
      const applied = await this.gateway.applyConfiguration({ publicUrl: setup.publicUrl, tunnelToken: result.tunnelToken });
      if (!applied.ok) throw new Error(applied.error.message);
      runtimeChanged = true;
      this.settingsRepository.set(SETTING_KEYS.accountId, setup.accountId.trim());
      this.settingsRepository.set(SETTING_KEYS.zoneName, setup.zoneName.trim());
      this.settingsRepository.set(SETTING_KEYS.tunnelName, setup.tunnelName.trim());
      this.settingsRepository.set(SETTING_KEYS.publicUrl, setup.publicUrl.trim());
      this.settingsRepository.set(SETTING_KEYS.originUrl, setup.originUrl.trim());
      this.settingsRepository.set(SETTING_KEYS.allowedHostnames, allowlists.hostnames);
      this.settingsRepository.set(SETTING_KEYS.allowedOrigins, allowlists.origins);
      this.settingsRepository.set(SETTING_KEYS.remoteTunnelId, result.tunnelId);
      if (providedApiToken !== undefined && providedApiToken.length > 0) await this.secretStore.set('cloudflare_api_token', apiToken);
      await this.secretStore.set('cloudflare_tunnel_token', result.tunnelToken);
      this.settingsRepository.set(SETTING_KEYS.apiTokenConfigured, 'true');
      this.settingsRepository.set(SETTING_KEYS.tokenConfigured, 'true');

      // Persist allowlists before probe; MCP reads them dynamically during gateway.start().
      const started = await this.gateway.start();
      if (!started.ok) throw new Error(started.error.message);
      this.settingsRepository.set(SETTING_KEYS.gatewayDesiredState, 'RUNNING');

      this.recordLog('SUCCESS', 'Cloudflare tunnel reconciled and gateway healthy');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, settings: await this.publicSettings(), gateway: this.gateway.status() }));
    } catch (error) {
      if (runtimeChanged) {
        await this.gateway.stop().catch(() => undefined);
        await this.gateway.applyConfiguration(previousConfiguration).catch(() => undefined);
        if ((previousGatewayState === 'BRIDGE_HEALTHY' || previousGatewayState === 'SESSION_CONNECTED') && previousConfiguration.publicUrl !== undefined && (previousConfiguration.tunnelName !== undefined || previousConfiguration.tunnelToken !== undefined)) {
          await this.gateway.start().catch(() => undefined);
        }
      }
      for (const [key, value] of previousSettings) writeOptional(this.settingsRepository, key, value ?? undefined);
      if (secretSnapshotReady) {
        await restoreSecret(this.secretStore, 'cloudflare_api_token', previousApiToken);
        await restoreSecret(this.secretStore, 'cloudflare_tunnel_token', previousTunnelToken);
      }
      this.recordLog('ERROR', 'Cloudflare tunnel reconcile failed');
      sendJsonError(res, 400, error instanceof Error ? error.message : 'Cloudflare tunnel reconcile failed');
    }
  }

  private async updateSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.settingsRepository === undefined) {
      sendJsonError(res, 503, 'Settings persistence is unavailable');
      return;
    }
    const body = await parseRequestBody(req, res);
    if (body === undefined || !isObject(body)) return;
    const current = await this.readGatewayConfiguration();
    const currentSettings = await this.publicSettings();
    const previousStored = new Map<string, string | null>([
      [SETTING_KEYS.tunnelName, this.settingsRepository.get(SETTING_KEYS.tunnelName)],
      [SETTING_KEYS.publicUrl, this.settingsRepository.get(SETTING_KEYS.publicUrl)],
      [SETTING_KEYS.allowedHostnames, this.settingsRepository.get(SETTING_KEYS.allowedHostnames)],
      [SETTING_KEYS.allowedOrigins, this.settingsRepository.get(SETTING_KEYS.allowedOrigins)],
      [SETTING_KEYS.tokenConfigured, this.settingsRepository.get(SETTING_KEYS.tokenConfigured)],
    ]);
    let next: { readonly tunnelName?: string; readonly publicUrl?: string; readonly tunnelToken?: string };
    try {
      const tunnelName = readOptionalString(body.tunnelName, 'tunnelName');
      const publicUrl = readOptionalString(body.publicUrl, 'publicUrl');
      const tunnelToken = body.tunnelToken === undefined ? undefined : readOptionalString(body.tunnelToken, 'tunnelToken');
      next = {
        ...(tunnelName === undefined ? {} : { tunnelName }),
        ...(publicUrl === undefined ? {} : { publicUrl }),
        ...(tunnelToken === undefined ? {} : { tunnelToken }),
      };
    } catch (error) {
      sendJsonError(res, 400, error instanceof Error ? error.message : 'Settings are invalid');
      return;
    }
    const configuration: GatewayTunnelConfiguration = {
      ...(next.tunnelName === undefined ? (current.tunnelName === undefined ? {} : { tunnelName: current.tunnelName }) : next.tunnelName === '' ? {} : { tunnelName: next.tunnelName }),
      ...(next.publicUrl === undefined ? (current.publicUrl === undefined ? {} : { publicUrl: current.publicUrl }) : next.publicUrl === '' ? {} : { publicUrl: next.publicUrl }),
      ...(next.tunnelToken === undefined ? (current.tunnelToken === undefined ? {} : { tunnelToken: current.tunnelToken }) : next.tunnelToken === '' ? {} : { tunnelToken: next.tunnelToken }),
    };
    if (next.tunnelToken !== undefined && next.tunnelToken !== '' && this.secretStore === undefined) {
      sendJsonError(res, 503, 'Secure secret storage is unavailable');
      return;
    }
    let allowedHostnames: string | undefined;
    let allowedOrigins: string | undefined;
    try {
      if (body.allowedHostnames !== undefined) allowedHostnames = serializeList(body.allowedHostnames, 'allowedHostnames');
      if (body.allowedOrigins !== undefined) allowedOrigins = serializeList(body.allowedOrigins, 'allowedOrigins');
    } catch (error) {
      sendJsonError(res, 400, error instanceof Error ? error.message : 'Allowlist settings are invalid');
      return;
    }
    this.cancelPersistedGatewayRestore();
    const applied = await this.gateway.applyConfiguration(configuration);
    if (!applied.ok) {
      res.writeHead(applied.error.code === 'INVALID_INPUT' ? 400 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(applied));
      return;
    }
    try {
      const settings = this.settingsRepository;
      writeOptional(settings, SETTING_KEYS.tunnelName, configuration.tunnelName);
      writeOptional(settings, SETTING_KEYS.publicUrl, configuration.publicUrl);
      if (allowedHostnames !== undefined) settings.set(SETTING_KEYS.allowedHostnames, allowedHostnames);
      if (allowedOrigins !== undefined) settings.set(SETTING_KEYS.allowedOrigins, allowedOrigins);
      if (next.tunnelToken !== undefined) {
        if (this.secretStore === undefined) throw new Error('Secure secret storage is unavailable');
        if (next.tunnelToken === '') await this.secretStore.delete('cloudflare_tunnel_token');
        else await this.secretStore.set('cloudflare_tunnel_token', next.tunnelToken);
        settings.set(SETTING_KEYS.tokenConfigured, next.tunnelToken === '' ? 'false' : 'true');
      }
    } catch (error) {
      await this.gateway.applyConfiguration(current);
      for (const [key, value] of previousStored) writeOptional(this.settingsRepository, key, value ?? undefined);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Settings persistence failed' }));
      return;
    }
    this.recordLog('SUCCESS', 'Runtime settings applied');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, settings: await this.publicSettings(), previous: currentSettings }));
  }

  private extensionsSettings(): ExtensionsSettings {
    if (this.settingsRepository === undefined) return DEFAULT_EXTENSIONS_SETTINGS;
    return parseExtensionsSettings(this.settingsRepository.get(SETTING_KEYS.extensions));
  }

  private currentSkillCatalog(): SkillCatalog {
    return this.skillCatalogOverride ?? new SkillCatalog({
      settings: this.extensionsSettings(),
      managedRoot: path.join(this.dataDir, 'extensions', 'skills'),
    });
  }

  private currentServerCatalog(): McpConfigLoader {
    return this.serverCatalogOverride ?? new McpConfigLoader({
      settings: this.extensionsSettings(),
      dataDir: this.dataDir,
    });
  }

  private currentPruner(): PrunerService {
    return this.prunerOverride ?? new PrunerService({ dataDir: this.dataDir });
  }

  private async policySnapshot(): Promise<RuntimePolicySnapshot> {
    const settings = this.extensionsSettings();
    const [servers, skillsResult] = await Promise.all([
      this.currentServerCatalog().discover(),
      this.currentSkillCatalog().list({}),
    ]);
    return reconcileRuntimePolicies(settings, servers, skillsResult.ok ? skillsResult.value.skills : []);
  }

  private persistPolicies(policies: readonly PolicyEntry[]): void {
    if (this.settingsRepository === undefined) throw new Error('Persistent settings are unavailable');
    const current = this.extensionsSettings();
    const mandatoryMcpServers = [...new Set(policies
      .filter((policy) => policy.resourceType === 'server' && policy.mandatory)
      .map((policy) => policy.resourceId))];
    const updated: ExtensionsSettings = {
      ...current,
      policies,
      mandatoryMcpServers,
    };
    this.settingsRepository.set(SETTING_KEYS.extensions, JSON.stringify(updated));
  }

  private async readGatewayConfiguration(): Promise<GatewayTunnelConfiguration & { readonly tunnelToken?: string }> {
    const settings = this.settingsRepository!;
    const configured = settings.get(SETTING_KEYS.tokenConfigured) === 'true';
    const token = configured ? await this.secretStore?.get('cloudflare_tunnel_token') : null;
    return {
      ...(token ? {} : settings.get(SETTING_KEYS.tunnelName) ? { tunnelName: settings.get(SETTING_KEYS.tunnelName)! } : {}),
      ...(settings.get(SETTING_KEYS.publicUrl) ? { publicUrl: settings.get(SETTING_KEYS.publicUrl)! } : {}),
      ...(token ? { tunnelToken: token } : {}),
    };
  }

  private async isRegisteredWorkspace(workspaceId: string): Promise<boolean> {
    const registered = await this.workspaceControl?.list() ?? [];
    return registered.some((workspace) => workspace.id === workspaceId);
  }

  private async openGoalRuntimeEventStream(
    res: ServerResponse,
    workspaceId: string,
    requestedCursor: number | undefined,
  ): Promise<void> {
    const runtime = this.goalRuntimeRead;
    if (runtime === undefined) throw new Error('Goal runtime projection service is unavailable');

    let closed = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let keepaliveTimer: NodeJS.Timeout | null = null;

    const dispose = (): void => {
      if (closed) return;
      closed = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
      this.goalRuntimeStreamClosers.delete(closeStream);
    };
    const closeStream = (): void => {
      dispose();
      if (!res.writableEnded) res.end();
    };
    this.goalRuntimeStreamClosers.add(closeStream);
    res.once('close', dispose);

    const initialPage = await runtime.replayWorkspaceGoalRuntimeEvents({
      workspaceId,
      ...(requestedCursor === undefined ? {} : { afterSequence: requestedCursor }),
      limit: GOAL_RUNTIME_REPLAY_LIMIT,
    });
    if (closed || res.writableEnded || res.destroyed) return;

    const initialWindowMissed = requestedCursor !== undefined && (
      initialPage.replayWindowMissed
      || (initialPage.latestSequence !== undefined && requestedCursor > initialPage.latestSequence)
    );
    const needsSnapshot = requestedCursor === undefined
      || initialWindowMissed
      || initialPage.latestSequence === undefined;
    const initialSnapshots = needsSnapshot
      ? await runtime.listWorkspaceGoalRuntimeSnapshots({
          workspaceId,
          limit: GOAL_RUNTIME_SNAPSHOT_LIMIT,
        })
      : undefined;
    if (closed || res.writableEnded || res.destroyed) return;

    let cursor = needsSnapshot
      ? goalRuntimeSnapshotCursor(initialSnapshots ?? [], initialPage)
      : requestedCursor!;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (!res.write('retry: 1000\n\n')) await waitForGoalRuntimeSseDrain(res);

    if (initialSnapshots !== undefined) {
      if (!writeGoalRuntimeSseEvent(res, 'goal-runtime-snapshot', cursor, {
        workspaceId,
        snapshots: initialSnapshots,
        cursor,
        replayWindowMissed: initialWindowMissed,
      })) {
        await waitForGoalRuntimeSseDrain(res);
      }
    } else {
      for (const record of initialPage.events) {
        if (!writeGoalRuntimeSseEvent(res, 'goal-runtime-event', record.sequence, record)) {
          await waitForGoalRuntimeSseDrain(res);
        }
        cursor = record.sequence;
      }
    }

    const schedule = (delayMs: number): void => {
      if (closed) return;
      pollTimer = setTimeout(() => {
        void pump();
      }, delayMs);
      pollTimer.unref?.();
    };

    const pump = async (): Promise<void> => {
      if (closed) return;
      try {
        const page = await runtime.replayWorkspaceGoalRuntimeEvents({
          workspaceId,
          afterSequence: cursor,
          limit: GOAL_RUNTIME_REPLAY_LIMIT,
        });
        if (closed || res.writableEnded || res.destroyed) return;

        const replayWindowMissed = page.replayWindowMissed
          || (page.latestSequence !== undefined && cursor > page.latestSequence);
        if (replayWindowMissed) {
          const snapshots = await runtime.listWorkspaceGoalRuntimeSnapshots({
            workspaceId,
            limit: GOAL_RUNTIME_SNAPSHOT_LIMIT,
          });
          if (closed || res.writableEnded || res.destroyed) return;

          cursor = goalRuntimeSnapshotCursor(snapshots, page);
          if (!writeGoalRuntimeSseEvent(res, 'goal-runtime-snapshot', cursor, {
            workspaceId,
            snapshots,
            cursor,
            replayWindowMissed: true,
          })) {
            await waitForGoalRuntimeSseDrain(res);
          }
          const hasMoreAfterSnapshot = page.latestSequence !== undefined && cursor < page.latestSequence;
          schedule(hasMoreAfterSnapshot ? 0 : this.goalRuntimeStreamPollMs);
          return;
        }

        for (const record of page.events) {
          if (!writeGoalRuntimeSseEvent(res, 'goal-runtime-event', record.sequence, record)) {
            await waitForGoalRuntimeSseDrain(res);
          }
          cursor = record.sequence;
        }
        const hasMore = page.latestSequence !== undefined && cursor < page.latestSequence;
        schedule(hasMore ? 0 : this.goalRuntimeStreamPollMs);
      } catch {
        if (closed || res.writableEnded || res.destroyed) return;
        this.recordLog('WARN', `Goal runtime event stream read failed for workspace ${workspaceId}`);
        if (!res.writableEnded && !res.destroyed) {
          writeGoalRuntimeSseEvent(res, 'goal-runtime-stream-error', undefined, {
            error: 'Goal runtime stream unavailable; reconnect for an authoritative snapshot',
          });
        }
        closeStream();
      }
    };

    if (closed || res.writableEnded || res.destroyed) return;

    keepaliveTimer = setInterval(() => {
      if (!closed && !res.writableEnded && !res.destroyed && !res.writableNeedDrain) {
        res.write(': keepalive\n\n');
      }
    }, GOAL_RUNTIME_STREAM_KEEPALIVE_MS);
    keepaliveTimer.unref?.();

    const hasMoreInitialEvents = initialPage.latestSequence !== undefined
      && cursor < initialPage.latestSequence;
    schedule(hasMoreInitialEvents ? 0 : this.goalRuntimeStreamPollMs);
  }

  private cancelPersistedGatewayRestore(): void {
    this.gatewayRestoreGeneration += 1;
  }

  private isGatewayRestoreActive(generation: number): boolean {
    return !this.closing && this.server.listening && generation === this.gatewayRestoreGeneration;
  }

  private async loadPersistedGatewayConfiguration(generation: number): Promise<void> {
    if (this.settingsRepository === undefined || !this.isGatewayRestoreActive(generation)) return;
    const configuration = await this.readGatewayConfiguration();
    if (!this.isGatewayRestoreActive(generation)) return;
    if (configuration.tunnelName === undefined && configuration.tunnelToken === undefined && configuration.publicUrl === undefined) return;
    const applied = await this.gateway.applyConfiguration(configuration);
    if (!this.isGatewayRestoreActive(generation)) return;
    if (!applied.ok) throw new Error(`Persisted gateway settings rejected: ${applied.error.message}`);
    if (this.settingsRepository.get(SETTING_KEYS.gatewayDesiredState) === 'STOPPED') {
      this.recordLog('INFO', 'Persisted ChatGPT Gateway desired state is STOPPED');
      return;
    }

    let retryDelayMs = 1_000;
    const restore = async (): Promise<void> => {
      if (!this.isGatewayRestoreActive(generation)) return;
      const started = await this.gateway.start();
      if (!this.isGatewayRestoreActive(generation)) return;
      if (started.ok) {
        this.settingsRepository?.set(SETTING_KEYS.gatewayDesiredState, 'RUNNING');
        const connected = await this.gateway.connectSession();
        if (!this.isGatewayRestoreActive(generation)) return;
        if (!connected.ok) {
          this.recordLog('ERROR', `Persisted ChatGPT Web auto-connect failed: ${connected.error.message}`);
          return;
        }
        this.recordLog('SUCCESS', 'Persisted ChatGPT Gateway and ChatGPT Web session restored automatically');
        return;
      }
      this.recordLog('ERROR', `Persisted ChatGPT Gateway auto-start failed: ${started.error.message}`);
      const retry = setTimeout(() => {
        if (this.isGatewayRestoreActive(generation)) void restore();
      }, retryDelayMs);
      retry.unref?.();
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    };
    await restore();
  }

  private async listRegisteredServers(): Promise<readonly (RegisteredServer & { readonly enabled: boolean; readonly excluded: boolean; readonly exclusionReason?: string; readonly command: string })[]> {
    const discovered = await this.currentServerCatalog().discover();
    const activeKeys = new Set<string>();
    const servers = discovered.map((server) => {
      const key = `${server.source}\0${server.name}`;
      activeKeys.add(key);
      let registered = [...this.serverRegistry.values()].find((entry) => `${entry.source}\0${entry.name}` === key);
      if (registered === undefined) {
        registered = { serverId: `server_${randomUUID().replaceAll('-', '')}`, name: server.name, source: server.source };
        this.serverRegistry.set(registered.serverId, registered);
      }
      return {
        ...registered,
        enabled: server.enabled,
        excluded: server.excluded,
        ...(server.exclusionReason === undefined ? {} : { exclusionReason: server.exclusionReason }),
        command: server.config.command,
      };
    });
    for (const [id, registered] of this.serverRegistry) {
      if (!activeKeys.has(`${registered.source}\0${registered.name}`)) this.serverRegistry.delete(id);
    }
    return servers;
  }

  private handleRequestFailure(res: ServerResponse, error: unknown): void {
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    sendJsonError(res, 500, error instanceof Error ? error.message : 'Internal server error');
  }

  private async authorizeWorkspaceMutation(body: Record<string, unknown>, source?: unknown): Promise<
    | { readonly ok: true; readonly scope: 'global' }
    | { readonly ok: true; readonly scope: 'workspace'; readonly workspaceRoot: string }
    | { readonly ok: false; readonly status: 400 | 403; readonly message: string }
  > {
    const scope = body.scope ?? 'global';
    if (scope !== 'global' && scope !== 'workspace') {
      return { ok: false, status: 400, message: 'Invalid mutation scope' };
    }
    if (scope === 'global') {
      if (body.workspaceRoot !== undefined) {
        return { ok: false, status: 403, message: 'workspaceRoot is allowed only for registered workspace mutations' };
      }
      if (source !== undefined && !(await this.isAllowedSkillSource(source))) {
        return { ok: false, status: 403, message: 'Skill source must be an HTTPS Git URL or resolve inside a registered workspace root' };
      }
      return { ok: true, scope: 'global' };
    }
    if (typeof body.workspaceRoot !== 'string' || body.workspaceRoot.trim().length === 0) {
      return { ok: false, status: 403, message: 'Registered workspaceRoot required for workspace mutations' };
    }
    const workspaceRoot = path.resolve(body.workspaceRoot.trim());
    if (!this.workspaceRoots.has(workspaceRoot)) {
      return { ok: false, status: 403, message: 'workspaceRoot is not registered with control plane' };
    }
    if (source !== undefined && !(await this.isAllowedSkillSource(source))) {
      return { ok: false, status: 403, message: 'Skill source must be an HTTPS Git URL or resolve inside a registered workspace root' };
    }
    return { ok: true, scope: 'workspace', workspaceRoot };
  }

  private async isAllowedSkillSource(candidate: unknown): Promise<boolean> {
    if (typeof candidate !== 'string') return false;
    try {
      const remote = new URL(candidate.trim());
      if (remote.protocol === 'https:' && remote.username.length === 0 && remote.password.length === 0 && remote.hostname.length > 0) {
        return true;
      }
    } catch {
      // Local paths are validated below.
    }
    return this.isRegisteredPath(candidate);
  }

  private async isRegisteredPath(candidate: string): Promise<boolean> {
    try {
      const resolved = path.resolve(candidate.trim());
      const canonical = await realpath(resolved);
      return [...this.workspaceRoots].some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`));
    } catch {
      return false;
    }
  }
}

function parseGoalRuntimeEventCursor(
  value: string | string[] | undefined,
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly error: string } {
  if (value === undefined || value === '') return { ok: true, value: undefined };
  if (Array.isArray(value)) return { ok: false, error: 'Last-Event-ID must be one non-negative integer' };
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return { ok: false, error: 'Last-Event-ID must be a non-negative integer' };
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, error: 'Last-Event-ID must be a safe non-negative integer' };
  }
  return { ok: true, value: parsed };
}

function goalRuntimeSnapshotCursor(
  snapshots: readonly GoalRuntimeSnapshotRecord[],
  page: Pick<GoalRuntimeEventReplayPage, 'oldestAvailableSequence' | 'latestSequence'>,
): number {
  const latest = page.latestSequence;
  if (latest === undefined) return 0;

  const retainedFloor = page.oldestAvailableSequence === undefined
    ? 0
    : Math.max(0, page.oldestAvailableSequence - 1);
  if (snapshots.length === 0) return Math.min(retainedFloor, latest);

  const snapshotFloor = snapshots.reduce(
    (minimum, snapshot) => Math.min(minimum, snapshot.lastEventSequence),
    latest,
  );
  return Math.min(latest, Math.max(retainedFloor, snapshotFloor));
}

function writeGoalRuntimeSseEvent(
  res: ServerResponse,
  event: string,
  id: number | undefined,
  data: unknown,
): boolean {
  if (res.writableEnded || res.destroyed) return true;
  const frame = [
    ...(id === undefined ? [] : [`id: ${id}\n`]),
    `event: ${event}\n`,
    `data: ${JSON.stringify(data)}\n\n`,
  ].join('');
  return res.write(frame);
}

async function waitForGoalRuntimeSseDrain(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed || !res.writableNeedDrain) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      res.off('drain', finish);
      res.off('close', finish);
      res.off('error', finish);
      resolve();
    };
    res.once('drain', finish);
    res.once('close', finish);
    res.once('error', finish);
  });
}

function isLoopbackHost(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.username.length === 0
      && parsed.password.length === 0
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePolicyEntries(body: unknown):
  | { readonly ok: true; readonly value: readonly PolicyEntry[] }
  | { readonly ok: false; readonly error: string } {
  if (!isObject(body) || !Array.isArray(body.policies)) return { ok: false, error: 'policies must be an array' };
  if (body.policies.length > 100) return { ok: false, error: 'policies must contain at most 100 entries' };

  const seenIds = new Set<string>();
  const policies: PolicyEntry[] = [];
  for (const [index, raw] of body.policies.entries()) {
    if (!isObject(raw)) return { ok: false, error: `policies[${index}] must be an object` };
    let id: string;
    let resourceId: string;
    let enforcement: string;
    let directive: string;
    try {
      id = readRequiredString(raw.id, `policies[${index}].id`);
      resourceId = readRequiredString(raw.resourceId, `policies[${index}].resourceId`);
      enforcement = readRequiredString(raw.enforcement, `policies[${index}].enforcement`);
      directive = readRequiredString(raw.directive, `policies[${index}].directive`);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : `policies[${index}] is invalid` };
    }
    if (id.length > 128) return { ok: false, error: `policies[${index}].id is too long` };
    if (resourceId.length > 512) return { ok: false, error: `policies[${index}].resourceId is too long` };
    if (enforcement.length > 128) return { ok: false, error: `policies[${index}].enforcement is too long` };
    if (directive.length > 4096) return { ok: false, error: `policies[${index}].directive is too long` };
    if (raw.resourceType !== 'server' && raw.resourceType !== 'skill' && raw.resourceType !== 'capability') {
      return { ok: false, error: `policies[${index}].resourceType must be server, skill, or capability` };
    }
    if (typeof raw.mandatory !== 'boolean') return { ok: false, error: `policies[${index}].mandatory must be boolean` };
    const idKey = id.toLowerCase();
    if (seenIds.has(idKey)) return { ok: false, error: `Duplicate policy id: ${id}` };
    seenIds.add(idKey);

    let requiredTools: readonly string[] | undefined;
    if (raw.requiredTools !== undefined) {
      if (!Array.isArray(raw.requiredTools) || raw.requiredTools.some((tool) => typeof tool !== 'string' || tool.trim().length === 0)) {
        return { ok: false, error: `policies[${index}].requiredTools must be a string array` };
      }
      requiredTools = [...new Set(raw.requiredTools.map((tool) => (tool as string).trim()))];
    }
    let requiredCapabilities: readonly string[] | undefined;
    if (raw.requiredCapabilities !== undefined) {
      if (!Array.isArray(raw.requiredCapabilities) || raw.requiredCapabilities.some((capability) => typeof capability !== 'string' || capability.trim().length === 0)) {
        return { ok: false, error: `policies[${index}].requiredCapabilities must be a string array` };
      }
      requiredCapabilities = [...new Set(raw.requiredCapabilities.map((capability) => (capability as string).trim()))];
    }
    let readOnlyTools: readonly string[] | undefined;
    if (raw.readOnlyTools !== undefined) {
      if (!Array.isArray(raw.readOnlyTools) || raw.readOnlyTools.some((tool) => typeof tool !== 'string' || tool.trim().length === 0)) {
        return { ok: false, error: `policies[${index}].readOnlyTools must be a string array` };
      }
      readOnlyTools = [...new Set(raw.readOnlyTools.map((tool) => (tool as string).trim()))];
    }
    policies.push({
      id,
      resourceId,
      resourceType: raw.resourceType,
      mandatory: raw.mandatory,
      enforcement,
      directive,
      ...(requiredTools === undefined ? {} : { requiredTools }),
      ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }),
      ...(readOnlyTools === undefined ? {} : { readOnlyTools }),
    });
  }
  return { ok: true, value: policies };
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function splitList(value: string | null): readonly string[] {
  return value === null ? [] : value.split(',').map((item) => item.trim()).filter(Boolean);
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value.trim();
}

function readRequiredString(value: unknown, field: string): string {
  const result = readOptionalString(value, field);
  if (result === undefined || result.length === 0) throw new Error(`${field} is required`);
  return result;
}

function serializeList(value: unknown, field: string): string {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) throw new Error(`${field} must be a non-empty string list`);
  const normalized = [...new Set(value.map((item) => (item as string).trim()))];
  if (normalized.some((item) => item === '*' || item.includes('*'))) throw new Error(`${field} must not contain wildcards`);
  return normalized.join(',');
}

function writeOptional(settings: Pick<SqliteSettingsRepository, 'set' | 'delete'>, key: string, value: string | undefined): void {
  if (value === undefined) settings.delete(key);
  else settings.set(key, value);
}

async function restoreSecret(secretStore: SecretStore, key: string, value: string | null): Promise<void> {
  if (value === null) await secretStore.delete(key).catch(() => undefined);
  else await secretStore.set(key, value).catch(() => undefined);
}

function httpStatusForResult(result: { readonly ok: boolean; readonly error?: { readonly code: string } }): number {
  if (result.ok) return 200;
  switch (result.error?.code) {
    case 'UNSUPPORTED_TARGET': return 422;
    case 'PERMISSION_DENIED': return 403;
    case 'WORKSPACE_NOT_FOUND': return 404;
    default: return 400;
  }
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB limit

function configuredPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return fallback;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : fallback;
}

async function parseRequestBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readJsonBody(req);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'PAYLOAD_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large: body exceeds 1MB limit' }));
      return undefined;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Request: malformed JSON' }));
    return undefined;
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    let exceeded = false;

    req.on('data', (chunk: Buffer | string) => {
      if (exceeded) return;
      size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      if (exceeded) return;
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('MALFORMED_JSON'));
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}


async function probeMcpRuntimeDiagnostics(localPort: number): Promise<McpRuntimeDiagnosticsSnapshot | null> {
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65_535) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${localPort}/_unified-mpc/runtime-diagnostics`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return isMcpRuntimeDiagnosticsSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

async function probeMcpRuntimeIdentity(localPort: number): Promise<WebMcpRuntimeIdentity | null> {
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65_535) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${localPort}/_unified-mpc/identity`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    return isWebMcpRuntimeIdentity(value) ? value : null;
  } catch {
    return null;
  }
}

function isWebMcpRuntimeIdentity(value: unknown): value is WebMcpRuntimeIdentity {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.product !== 'string'
    || typeof candidate.service !== 'string'
    || typeof candidate.protocol !== 'number'
    || typeof candidate.version !== 'string') return false;
  for (const key of ['buildVersion', 'buildCommit', 'buildShortCommit', 'buildTime'] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'string') return false;
  }
  return candidate.buildDirty === undefined || typeof candidate.buildDirty === 'boolean';
}
