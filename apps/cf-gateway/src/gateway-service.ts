import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@unified-mpc/domain';

export type BridgeState =
  | 'STOPPED'
  | 'INITIALIZING'
  | 'BRIDGE_HEALTHY'
  | 'SESSION_CONNECTED'
  | 'ERROR';

export interface GatewayStatus {
  readonly state: BridgeState;
  readonly tunnelUrl?: string;
  readonly mcpUrl?: string;
  readonly localPort: number;
  readonly latencyMs?: number;
  readonly lastError?: string;
}

export interface TunnelHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export interface GatewayServiceOptions {
  readonly localPort?: number;
  readonly tunnelName?: string;
  readonly tunnelToken?: string;
  readonly publicUrl?: string;
  readonly healthPath?: string;
  readonly healthTimeoutMs?: number;
  readonly healthAttempts?: number;
  readonly healthRetryDelayMs?: number;
  readonly tunnelStartupTimeoutMs?: number;
  readonly tunnelProvider?: () => Promise<TunnelHandle>;
  readonly healthProbe?: (url: string, timeoutMs: number) => Promise<number>;
}

const DEFAULT_HEALTH_PATH = '/_unified-mpc/identity';
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

export class GatewayService {
  private state: BridgeState = 'STOPPED';
  private tunnelUrl: string | undefined;
  private leaseToken: string | undefined;
  private latencyMs: number | undefined;
  private lastError: string | undefined;
  private readonly localPort: number;
  private readonly healthPath: string;
  private readonly healthTimeoutMs: number;
  private readonly healthAttempts: number;
  private readonly healthRetryDelayMs: number;
  private readonly tunnelStartupTimeoutMs: number;
  private readonly tunnelProvider: () => Promise<TunnelHandle>;
  private readonly healthProbe: (url: string, timeoutMs: number) => Promise<number>;
  private readonly mcpPath: string;
  private readonly tunnelName: string | undefined;
  private readonly tunnelToken: string | undefined;
  private readonly publicUrl: string | undefined;
  private tunnel: TunnelHandle | undefined;
  private startGeneration = 0;

  public constructor(options: GatewayServiceOptions = {}) {
    this.localPort = options.localPort ?? 18765;
    this.healthPath = options.healthPath ?? DEFAULT_HEALTH_PATH;
    this.mcpPath = '/mcp';
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthAttempts = options.healthAttempts ?? 5;
    this.healthRetryDelayMs = options.healthRetryDelayMs ?? 250;
    this.tunnelStartupTimeoutMs = options.tunnelStartupTimeoutMs ?? 10_000;
    this.tunnelName = options.tunnelName?.trim() || process.env.UNIFIED_MPC_CLOUDFLARE_TUNNEL_NAME?.trim() || undefined;
    this.tunnelToken = options.tunnelToken?.trim() || process.env.UNIFIED_MPC_CLOUDFLARE_TUNNEL_TOKEN?.trim() || undefined;
    this.publicUrl = options.publicUrl?.trim() || process.env.UNIFIED_MPC_CLOUDFLARE_PUBLIC_URL?.trim() || undefined;
    this.tunnelProvider = options.tunnelProvider ?? createCloudflaredTunnelProvider(this.localPort, this.tunnelName, this.tunnelToken, this.publicUrl, this.tunnelStartupTimeoutMs);
    this.healthProbe = options.healthProbe ?? probeHttpEndpoint;
  }

  public status(): GatewayStatus {
    return {
      state: this.state,
      ...(this.tunnelUrl ? { tunnelUrl: this.tunnelUrl } : {}),
      ...(this.tunnelUrl ? { mcpUrl: new URL(this.mcpPath, this.tunnelUrl).toString() } : {}),
      localPort: this.localPort,
      ...(this.latencyMs !== undefined ? { latencyMs: this.latencyMs } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  public canConnectSession(): boolean {
    return this.state === 'BRIDGE_HEALTHY';
  }

  public async start(): Promise<Result<{ readonly tunnelUrl: string; readonly localPort: number }>> {
    if (this.state === 'BRIDGE_HEALTHY' || this.state === 'SESSION_CONNECTED') {
      return ok({
        tunnelUrl: this.tunnelUrl!,
        localPort: this.localPort,
      });
    }

    const generation = ++this.startGeneration;
    this.state = 'INITIALIZING';
    this.lastError = undefined;

    let tunnel: TunnelHandle | undefined;
    try {
      tunnel = await this.tunnelProvider();
      if (generation !== this.startGeneration || this.state !== 'INITIALIZING') {
        await tunnel.stop();
        return err(appError('CONFLICT', 'Gateway start was superseded by a newer lifecycle operation'));
      }
      validateTunnelUrl(tunnel.url);
      const startedAt = performance.now();
      const statusCode = await probeWithRetry(
        this.healthProbe,
        new URL(this.healthPath, tunnel.url).toString(),
        this.healthTimeoutMs,
        this.healthAttempts,
        this.healthRetryDelayMs,
      );
      this.latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Bridge health probe returned HTTP ${statusCode}`);
      }
      if (generation !== this.startGeneration || this.state !== 'INITIALIZING') {
        await tunnel.stop();
        return err(appError('CONFLICT', 'Gateway start was superseded by a newer lifecycle operation'));
      }
      this.tunnel = tunnel;
      this.tunnelUrl = tunnel.url;
      this.state = 'BRIDGE_HEALTHY';
      return ok({
        tunnelUrl: tunnel.url,
        localPort: this.localPort,
      });
    } catch (error) {
      if (tunnel !== undefined && this.tunnel !== tunnel) await tunnel.stop().catch(() => undefined);
      if (generation !== this.startGeneration || this.state !== 'INITIALIZING') {
        return err(appError('CONFLICT', 'Gateway start was superseded by a newer lifecycle operation'));
      }
      this.state = 'ERROR';
      this.lastError = error instanceof Error ? error.message : String(error);
      return err(appError('INTERNAL_ERROR', `Failed to initialize bridge tunnel: ${this.lastError}`));
    }
  }

  public async stop(): Promise<Result<void>> {
    this.startGeneration += 1;
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    if (tunnel !== undefined) await tunnel.stop();
    this.state = 'STOPPED';
    this.tunnelUrl = undefined;
    this.leaseToken = undefined;
    this.latencyMs = undefined;
    this.lastError = undefined;
    return ok(undefined);
  }

  public async connectSession(): Promise<Result<{ readonly leaseToken: string; readonly tunnelUrl: string; readonly mcpUrl: string }>> {
    if (!this.canConnectSession()) {
      return err(
        appError(
          'PERMISSION_DENIED',
          `Cannot connect session in state '${this.state}'. Bridge must be in BRIDGE_HEALTHY state before connecting ChatGPT Web.`,
        ),
      );
    }

    this.leaseToken = `lease_${randomUUID().replaceAll('-', '')}`;
    this.state = 'SESSION_CONNECTED';

    return ok({
      leaseToken: this.leaseToken,
      tunnelUrl: this.tunnelUrl!,
      mcpUrl: new URL(this.mcpPath, this.tunnelUrl!).toString(),
    });
  }
}

export function createCloudflaredTunnelProvider(localPort: number, tunnelName?: string, tunnelToken?: string, publicUrl?: string, startupTimeoutMs = 10_000): () => Promise<TunnelHandle> {
  return () => new Promise<TunnelHandle>((resolve, reject) => {
    const named = tunnelName !== undefined || tunnelToken !== undefined;
    if (named !== (publicUrl !== undefined)) {
      reject(new Error('Cloudflare named tunnel requires exactly one public URL'));
      return;
    }
    if (tunnelName !== undefined && tunnelToken !== undefined) {
      reject(new Error('Cloudflare tunnel name and token are mutually exclusive'));
      return;
    }
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
      reject(new Error('Cloudflare tunnel startup timeout must be positive'));
      return;
    }
    if (publicUrl !== undefined) validateTunnelUrl(publicUrl);
    const command = process.env.UNIFIED_MPC_CLOUDFLARED_BIN?.trim() || 'cloudflared';
    const args = tunnelToken !== undefined
      ? ['tunnel', '--no-autoupdate', 'run', '--token', tunnelToken]
      : tunnelName !== undefined
        ? ['tunnel', '--no-autoupdate', 'run', tunnelName]
        : ['tunnel', '--no-autoupdate', '--http-host-header', '127.0.0.1', '--url', `http://127.0.0.1:${localPort}`];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let output = '';
    const startupTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stopChild(child);
      reject(new Error('cloudflared did not provide a tunnel URL before startup timeout'));
    }, startupTimeoutMs);
    if (publicUrl !== undefined && (tunnelName !== undefined || tunnelToken !== undefined)) {
      settled = true;
      clearTimeout(startupTimer);
      resolve({ url: publicUrl, stop: () => stopChild(child) });
    }
    const findUrl = (chunk: Buffer | string): void => {
      output += chunk.toString();
      const match = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
      if (match === null || settled) return;
      settled = true;
      clearTimeout(startupTimer);
      resolve({ url: match[0].replace(/[),.;]+$/, ''), stop: () => stopChild(child) });
    };
    child.stdout.on('data', findUrl);
    child.stderr.on('data', findUrl);
    child.once('error', (error) => {
      if (!settled) { settled = true; clearTimeout(startupTimer); reject(error); }
    });
    child.once('exit', (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        reject(new Error(`cloudflared exited before tunnel URL was available (${signal ?? code ?? 'unknown'})`));
      }
    });
  });
}

async function probeWithRetry(
  probe: (url: string, timeoutMs: number) => Promise<number>,
  url: string,
  timeoutMs: number,
  attempts: number,
  retryDelayMs: number,
): Promise<number> {
  let statusCode = 0;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      statusCode = await probe(url, timeoutMs);
    } catch {
      statusCode = 0;
    }
    if (statusCode >= 200 && statusCode < 300) return statusCode;
    if (attempt + 1 < Math.max(1, attempts)) await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return statusCode;
}

async function probeHttpEndpoint(url: string, timeoutMs: number): Promise<number> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  return response.status;
}

function validateTunnelUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Tunnel provider returned an invalid URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Tunnel provider must return an HTTPS URL without credentials or query data');
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

