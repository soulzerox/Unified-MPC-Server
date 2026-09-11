import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { renderDashboardHtml } from './dashboard-html.js';
import { GatewayService } from '@unified-mpc/cf-gateway';
import {
  DEFAULT_POLICIES,
  DEFAULT_EXTENSIONS_SETTINGS,
  IdeSyncService,
  InstallerService,
  PrunerService,
  SkillCatalog,
} from '@unified-mpc/extensions';

export interface ControlPlaneServerOptions {
  readonly port?: number;
  readonly gateway?: GatewayService;
  readonly installer?: InstallerService;
  readonly pruner?: PrunerService;
  readonly ideSync?: IdeSyncService;
  readonly skillCatalog?: SkillCatalog;
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

  public constructor(options: ControlPlaneServerOptions = {}) {
    this.configuredPort = options.port ?? 18765;
    this.gateway = options.gateway ?? new GatewayService({ localPort: this.configuredPort });
    this.installer = options.installer ?? new InstallerService();
    this.pruner = options.pruner ?? new PrunerService();
    this.ideSync = options.ideSync ?? new IdeSyncService();
    this.skillCatalog = options.skillCatalog ?? new SkillCatalog({ settings: DEFAULT_EXTENSIONS_SETTINGS });

    this.server = createServer((req, res) => this.handleRequest(req, res));
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
    // 1. Origin Policy Guard
    const origin = req.headers.origin;
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

    if (pathname === '/api/policies' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ policies: DEFAULT_POLICIES }));
      return;
    }

    if (pathname === '/api/policies/sync' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const targets = Array.isArray(body?.targets) ? body.targets : ['all'];
      const result = await this.ideSync.sync(targets);
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
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/chatgpt-gateway/stop' && req.method === 'POST') {
      const result = await this.gateway.stop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // HARD GATING INVARIANT on /api/chatgpt-web/connect
    if (pathname === '/api/chatgpt-web/connect' && req.method === 'GET') {
      if (!this.gateway.canConnectSession()) {
        const current = this.gateway.status();
        res.writeHead(412, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Bridge must be in BRIDGE_HEALTHY state before connecting ChatGPT Web',
          state: current.state,
        }));
        return;
      }

      const sessionResult = await this.gateway.connectSession();
      if (!sessionResult.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sessionResult.error));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionResult.value));
      return;
    }

    // Ingestion Routes
    if (pathname === '/api/skills/install' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const result = await this.installer.installSkill(body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/servers/install' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const result = await this.installer.installServer(body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Pruning Routes
    if (pathname === '/api/skills/prune' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const result = await this.pruner.pruneSkill(body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/servers/prune' && req.method === 'POST') {
      const body = await parseRequestBody(req, res);
      if (body === undefined) return;
      const result = await this.pruner.pruneServer(body);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB limit

async function parseRequestBody(req: IncomingMessage, res: ServerResponse): Promise<any | undefined> {
  try {
    return await readJsonBody(req);
  } catch (err: any) {
    if (err?.message === 'PAYLOAD_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload Too Large: body exceeds 1MB limit' }));
      return undefined;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad Request: malformed JSON' }));
    return undefined;
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<any> {
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
        resolve({});
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

