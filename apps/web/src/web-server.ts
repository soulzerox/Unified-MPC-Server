import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { renderDashboardHtml } from './dashboard-html.js';
import { CloudflareTunnelReconciler, type CloudflareTunnelSetup } from './cloudflare-client.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
import type { GatewayTunnelConfiguration } from '@unified-mpc/cf-gateway';
import type { SecretStore, SqliteSettingsRepository } from '@unified-mpc/storage';
import {
  DEFAULT_POLICIES,
  DEFAULT_EXTENSIONS_SETTINGS,
  IdeSyncService,
  InstallerService,
  McpConfigLoader,
  PrunerService,
  SkillCatalog,
  type InstallSkillInput,
  type InstallServerInput,
  type PruneSkillInput,
  type PruneServerInput,
  type SyncTarget,
} from '@unified-mpc/extensions';

export interface ControlPlaneServerOptions {
  readonly port?: number;
  readonly gatewayLocalPort?: number;
  readonly workspaceRoots?: readonly string[];
  readonly gateway?: GatewayService;
  readonly installer?: InstallerService;
  readonly pruner?: PrunerService;
  readonly ideSync?: IdeSyncService;
  readonly skillCatalog?: SkillCatalog;
  readonly serverCatalog?: McpConfigLoader;
  /** Test-only override; production generates a fresh token on every startup. */
  readonly capabilityToken?: string;
  readonly settingsRepository?: Pick<SqliteSettingsRepository, 'get' | 'set' | 'delete'>;
  readonly secretStore?: SecretStore;
  readonly cloudflareReconciler?: CloudflareTunnelReconciler;
  readonly closeSettings?: () => void;
}

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
  private readonly installer: InstallerService;
  private readonly pruner: PrunerService;
  private readonly ideSync: IdeSyncService;
  private readonly skillCatalog: SkillCatalog;
  private readonly serverCatalog: McpConfigLoader;
  private readonly serverRegistry = new Map<string, RegisteredServer>();
  private readonly telemetryLogs: TelemetryLogEntry[] = [];
  private readonly capabilityToken: Buffer;
  private readonly settingsRepository: Pick<SqliteSettingsRepository, 'get' | 'set' | 'delete'> | undefined;
  private readonly secretStore: SecretStore | undefined;
  private readonly cloudflareReconciler: CloudflareTunnelReconciler;
  private readonly closeSettings: (() => void) | undefined;

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
    this.installer = options.installer ?? new InstallerService();
    this.pruner = options.pruner ?? new PrunerService();
    this.ideSync = options.ideSync ?? new IdeSyncService();
    this.skillCatalog = options.skillCatalog ?? new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });
    this.serverCatalog = options.serverCatalog ?? new McpConfigLoader({ settings: DEFAULT_EXTENSIONS_SETTINGS });
    this.capabilityToken = Buffer.from(options.capabilityToken ?? randomBytes(32).toString('hex'), 'utf8');
    this.settingsRepository = options.settingsRepository;
    this.secretStore = options.secretStore;
    this.cloudflareReconciler = options.cloudflareReconciler ?? new CloudflareTunnelReconciler();
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
    await this.loadPersistedGatewayConfiguration();
    return new Promise((resolve, reject) => {
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
  }

  public async close(): Promise<void> {
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    if (pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        gateway: this.gateway.status(),
      }));
      return;
    }

    if (pathname === '/api/logs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs: this.telemetryLogs }));
      return;
    }

    if (pathname === '/api/policies' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ policies: DEFAULT_POLICIES }));
      return;
    }

    if (pathname === '/api/servers' && req.method === 'GET') {
      const servers = await this.listRegisteredServers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ servers }));
      return;
    }

    if (pathname === '/api/skills' && req.method === 'GET') {
      const result = await this.skillCatalog.list({});
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.ok ? result.value : result));
      return;
    }

    if (pathname === '/api/policies/sync' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const parsedBody = body as { targets?: readonly SyncTarget[] } | null;
      const targets = Array.isArray(parsedBody?.targets) ? parsedBody.targets : ['all'];
      const result = await this.ideSync.sync(targets);
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
      const result = await this.gateway.start();
      this.recordLog(result.ok ? 'SUCCESS' : 'ERROR', `ChatGPT Gateway start: ${result.ok ? 'OK' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/chatgpt-gateway/stop' && req.method === 'POST') {
      const result = await this.gateway.stop();
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
      const result = await this.gateway.disconnectSession();
      this.recordLog('INFO', 'Disconnected ChatGPT Web session');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Ingestion Routes
    if (pathname === '/api/skills/install' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      if (!isObject(body) || typeof body.name !== 'string' || typeof body.source !== 'string' || !Array.isArray(body.targets)) {
        sendJsonError(res, 400, 'Bad Request: skill install fields are invalid');
        return;
      }
      const authorization = await this.authorizeWorkspaceMutation(body, body.source);
      if (!authorization.ok) {
        sendJsonError(res, authorization.status, authorization.message);
        return;
      }
      const input: InstallSkillInput = {
        ...body as unknown as InstallSkillInput,
        ...(authorization.scope === 'workspace' ? { scope: 'workspace', workspaceRoot: authorization.workspaceRoot } : {}),
      };
      const result = await this.installer.installSkill(input);
      this.recordLog(result.ok ? 'SUCCESS' : 'ERROR', `Install skill '${body.name}': ${result.ok ? 'OK' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : httpStatusForResult(result), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/servers/install' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      if (!isObject(body) || typeof body.name !== 'string' || typeof body.transport !== 'string' || !Array.isArray(body.targets)) {
        sendJsonError(res, 400, 'Bad Request: server install fields are invalid');
        return;
      }
      const authorization = await this.authorizeWorkspaceMutation(body);
      if (!authorization.ok) {
        sendJsonError(res, authorization.status, authorization.message);
        return;
      }
      const input: InstallServerInput = {
        ...body as unknown as InstallServerInput,
        ...(authorization.scope === 'workspace' ? { scope: 'workspace', workspaceRoot: authorization.workspaceRoot } : {}),
      };
      const result = await this.installer.installServer(input);
      this.recordLog(result.ok ? 'SUCCESS' : 'ERROR', `Install server '${body.name}': ${result.ok ? 'OK' : 'FAILED'}`);
      res.writeHead(result.ok ? 200 : httpStatusForResult(result), { 'Content-Type': 'application/json' });
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
      const result = await this.pruner.pruneSkill({
        ...body as unknown as PruneSkillInput,
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
        targets: Array.isArray(body.targets) ? body.targets as NonNullable<PruneServerInput['targets']> : ['all'],
        ...(authorization.scope === 'workspace' ? { scope: 'workspace', workspaceRoot: authorization.workspaceRoot } : {}),
      };
      const result = await this.pruner.pruneServer(input);
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

  private async loadPersistedGatewayConfiguration(): Promise<void> {
    if (this.settingsRepository === undefined) return;
    const configuration = await this.readGatewayConfiguration();
    if (configuration.tunnelName === undefined && configuration.tunnelToken === undefined && configuration.publicUrl === undefined) return;
    const applied = await this.gateway.applyConfiguration(configuration);
    if (!applied.ok) throw new Error(`Persisted gateway settings rejected: ${applied.error.message}`);
    await this.gateway.stop();
  }

  private async listRegisteredServers(): Promise<readonly (RegisteredServer & { readonly enabled: boolean; readonly excluded: boolean; readonly exclusionReason?: string; readonly command: string })[]> {
    const discovered = await this.serverCatalog.discover();
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
      if (source !== undefined) {
        if (typeof source !== 'string' || !(await this.isRegisteredPath(source))) {
          return { ok: false, status: 403, message: 'Skill source must resolve inside a registered workspace root' };
        }
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
    if (source !== undefined && (typeof source !== 'string' || !(await this.isRegisteredPath(source)))) {
      return { ok: false, status: 403, message: 'Skill source must resolve inside a registered workspace root' };
    }
    return { ok: true, scope: 'workspace', workspaceRoot };
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

