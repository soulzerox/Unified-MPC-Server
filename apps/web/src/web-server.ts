import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { renderDashboardHtml } from './dashboard-html.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
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
  readonly gateway?: GatewayService;
  readonly installer?: InstallerService;
  readonly pruner?: PrunerService;
  readonly ideSync?: IdeSyncService;
  readonly skillCatalog?: SkillCatalog;
  readonly serverCatalog?: McpConfigLoader;
}

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
  private boundPort = 0;
  private readonly gateway: GatewayService;
  private readonly installer: InstallerService;
  private readonly pruner: PrunerService;
  private readonly ideSync: IdeSyncService;
  private readonly skillCatalog: SkillCatalog;
  private readonly serverCatalog: McpConfigLoader;
  private readonly serverRegistry = new Map<string, RegisteredServer>();
  private readonly telemetryLogs: TelemetryLogEntry[] = [];

  private recordLog(level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR', msg: string): void {
    const now = new Date();
    const time = now.toTimeString().split(' ')[0] ?? '00:00:00';
    this.telemetryLogs.push({ time, level, msg });
    if (this.telemetryLogs.length > 200) {
      this.telemetryLogs.shift();
    }
  }

  public constructor(options: ControlPlaneServerOptions = {}) {
    this.configuredPort = options.port ?? 18765;
    this.gateway = options.gateway ?? new GatewayService({ localPort: this.configuredPort });
    this.installer = options.installer ?? new InstallerService();
    this.pruner = options.pruner ?? new PrunerService();
    this.ideSync = options.ideSync ?? new IdeSyncService();
    this.skillCatalog = options.skillCatalog ?? new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });
    this.serverCatalog = options.serverCatalog ?? new McpConfigLoader({ settings: DEFAULT_EXTENSIONS_SETTINGS });

    this.recordLog('INFO', 'ControlPlaneServer initialized with loopback policy guard');

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: unknown) => this.handleRequestFailure(res, error));
    });
  }

  public get port(): number {
    return this.boundPort;
  }

  public async listen(): Promise<void> {
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
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
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
    const originRequired = req.method !== 'GET' && req.method !== 'HEAD' || requestPath === '/api/chatgpt-web/connect';
    if (originRequired && origin === undefined) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin header required for mutations' }));
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

    // HARD GATING INVARIANT on /api/chatgpt-web/connect
    if (pathname === '/api/chatgpt-web/connect' && req.method === 'GET') {
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

    // Ingestion Routes
    if (pathname === '/api/skills/install' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      if (!isObject(body) || typeof body.name !== 'string' || typeof body.source !== 'string' || !Array.isArray(body.targets)) {
        sendJsonError(res, 400, 'Bad Request: skill install fields are invalid');
        return;
      }
      const result = await this.installer.installSkill(body as unknown as InstallSkillInput);
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
      const result = await this.installer.installServer(body as unknown as InstallServerInput);
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
      const result = await this.pruner.pruneSkill(body as unknown as PruneSkillInput);
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
      const input: PruneServerInput = {
        name: registered.name,
        targets: Array.isArray(body.targets) ? body.targets as NonNullable<PruneServerInput['targets']> : ['all'],
        ...(typeof body.scope === 'string' ? { scope: body.scope as NonNullable<PruneServerInput['scope']> } : {}),
        ...(typeof body.workspaceRoot === 'string' ? { workspaceRoot: body.workspaceRoot } : {}),
        ...(Array.isArray(body.purgeDataDirs) ? { purgeDataDirs: body.purgeDataDirs.filter((entry): entry is string => typeof entry === 'string') } : {}),
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

