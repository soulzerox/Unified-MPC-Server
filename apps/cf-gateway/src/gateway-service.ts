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
  readonly sessionLeaseTtlMs?: number;
  readonly tunnelProvider?: () => Promise<TunnelHandle>;
  readonly tunnelProviderFactory?: (configuration: GatewayTunnelConfiguration) => () => Promise<TunnelHandle>;
  readonly healthProbe?: (url: string, timeoutMs: number) => Promise<number>;
}

export interface GatewayTunnelConfiguration {
  readonly tunnelName?: string;
  readonly tunnelToken?: string;
  readonly publicUrl?: string;
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
  private readonly sessionLeaseTtlMs: number;
  private tunnelProvider: () => Promise<TunnelHandle>;
  private readonly tunnelProviderFactory: (configuration: GatewayTunnelConfiguration) => () => Promise<TunnelHandle>;
  private readonly healthProbe: (url: string, timeoutMs: number) => Promise<number>;
  private readonly mcpPath: string;
  private configurationValue: GatewayTunnelConfiguration;
  private tunnel: TunnelHandle | undefined;
  private startGeneration = 0;
  private sessionLeaseTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: GatewayServiceOptions = {}) {
    this.localPort = options.localPort ?? 18765;
    this.healthPath = options.healthPath ?? DEFAULT_HEALTH_PATH;
    this.mcpPath = '/mcp';
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthAttempts = options.healthAttempts ?? 5;
    this.healthRetryDelayMs = options.healthRetryDelayMs ?? 250;
    this.tunnelStartupTimeoutMs = options.tunnelStartupTimeoutMs ?? 10_000;
    this.sessionLeaseTtlMs = options.sessionLeaseTtlMs ?? 15 * 60_000;
    if (!Number.isInteger(this.sessionLeaseTtlMs) || this.sessionLeaseTtlMs <= 0) throw new Error('Session lease TTL must be positive');
    this.configurationValue = normalizeConfiguration({
      ...(options.tunnelName === undefined ? {} : { tunnelName: options.tunnelName }),
      ...(options.tunnelToken === undefined ? {} : { tunnelToken: options.tunnelToken }),
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
    this.tunnelProviderFactory = options.tunnelProviderFactory
      ?? (options.tunnelProvider === undefined
        ? (configuration): (() => Promise<TunnelHandle>) => createCloudflaredTunnelProvider(this.localPort, configuration.tunnelName, configuration.tunnelToken, configuration.publicUrl, this.tunnelStartupTimeoutMs)
        : (): (() => Promise<TunnelHandle>) => options.tunnelProvider!);
    this.tunnelProvider = options.tunnelProvider ?? this.tunnelProviderFactory(this.configurationValue);
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

  public configuration(): GatewayTunnelConfiguration {
    return { ...this.configurationValue };
  }

  public async applyConfiguration(configuration: GatewayTunnelConfiguration): Promise<Result<void>> {
    let next: GatewayTunnelConfiguration;
    try {
      next = normalizeConfiguration(configuration);
    } catch (error) {
      return err(appError('INVALID_INPUT', error instanceof Error ? error.message : String(error)));
    }
    const previous = this.configurationValue;
    const previousProvider = this.tunnelProvider;
    const wasRunning = this.state === 'BRIDGE_HEALTHY' || this.state === 'SESSION_CONNECTED';
    await this.stop();
    this.configurationValue = next;
    this.tunnelProvider = this.tunnelProviderFactory(next);
    if (!wasRunning) return ok(undefined);
    const started = await this.start();
    if (started.ok) return ok(undefined);
    this.configurationValue = previous;
    this.tunnelProvider = previousProvider;
    if (wasRunning) await this.start();
    else {
      this.state = 'STOPPED';
      this.tunnelUrl = undefined;
      this.latencyMs = undefined;
      this.lastError = undefined;
    }
    return err(appError('CONFLICT', `Gateway configuration rejected; previous configuration restored: ${started.error.message}`));
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
    this.clearSessionLeaseTimer();
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
    this.clearSessionLeaseTimer();
    this.sessionLeaseTimer = setTimeout(() => { void this.disconnectSession(); }, this.sessionLeaseTtlMs);

    return ok({
      leaseToken: this.leaseToken,
      tunnelUrl: this.tunnelUrl!,
      mcpUrl: new URL(this.mcpPath, this.tunnelUrl!).toString(),
    });
  }

  public async disconnectSession(): Promise<Result<void>> {
    this.clearSessionLeaseTimer();
    this.leaseToken = undefined;
    if (this.state === 'SESSION_CONNECTED') this.state = this.tunnelUrl === undefined ? 'STOPPED' : 'BRIDGE_HEALTHY';
    return ok(undefined);
  }

  private clearSessionLeaseTimer(): void {
    if (this.sessionLeaseTimer !== undefined) clearTimeout(this.sessionLeaseTimer);
    this.sessionLeaseTimer = undefined;
  }
}

function normalizeConfiguration(configuration: GatewayTunnelConfiguration): GatewayTunnelConfiguration {
  const tunnelName = configuration.tunnelName?.trim() || undefined;
  const tunnelToken = configuration.tunnelToken?.trim() || undefined;
  const publicUrl = configuration.publicUrl?.trim() || undefined;
  if (tunnelName !== undefined && tunnelToken !== undefined) throw new Error('Cloudflare tunnel name and token are mutually exclusive');
  if ((tunnelName !== undefined || tunnelToken !== undefined) !== (publicUrl !== undefined)) {
    throw new Error('Cloudflare named tunnel requires exactly one public URL');
  }
  if (publicUrl !== undefined) validateTunnelUrl(publicUrl);
  return {
    ...(tunnelName === undefined ? {} : { tunnelName }),
    ...(tunnelToken === undefined ? {} : { tunnelToken }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
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
      ? ['tunnel', '--no-autoupdate', 'run']
      : tunnelName !== undefined
        ? ['tunnel', '--no-autoupdate', 'run', tunnelName]
        : ['tunnel', '--no-autoupdate', '--http-host-header', '127.0.0.1', '--url', `http://127.0.0.1:${localPort}`];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(tunnelToken === undefined ? {} : { env: { ...process.env, TUNNEL_TOKEN: tunnelToken } }),
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

