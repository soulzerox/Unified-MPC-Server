import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appError, err, ok, type Result } from '@unified-mpc/domain';

export type BridgeState =
  | 'STOPPED'
  | 'INITIALIZING'
  | 'BRIDGE_HEALTHY'
  | 'SESSION_CONNECTED'
  | 'ERROR';

export type GatewaySessionState = 'not_leased' | 'leased';
export type ConnectorRegistrationState = 'unverified' | 'stale';
export type ConnectorRegistrationReason = 'host_projection_unavailable' | 'backend_restart';
export type ConnectorRecoveryAction = 'none' | 'reconnect_chatgpt_session';

export interface ConnectorRegistrationStatus {
  readonly state: ConnectorRegistrationState;
  readonly action: ConnectorRecoveryAction;
  readonly reason?: ConnectorRegistrationReason;
}

export interface GatewayStatus {
  readonly state: BridgeState;
  readonly sessionState: GatewaySessionState;
  readonly connectorRegistration: ConnectorRegistrationStatus;
  readonly endToEndState: 'unverified' | 'healthy';
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
  readonly healthMonitorIntervalMs?: number;
  readonly healthFailureThreshold?: number;
  readonly reconnectBaseDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly reconnectJitterRatio?: number;
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
  private readonly sessionLeaseTtlMs: number | undefined;
  private readonly healthMonitorIntervalMs: number;
  private readonly healthFailureThreshold: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectJitterRatio: number;
  private tunnelProvider: () => Promise<TunnelHandle>;
  private readonly tunnelProviderFactory: (configuration: GatewayTunnelConfiguration) => () => Promise<TunnelHandle>;
  private readonly healthProbe: (url: string, timeoutMs: number) => Promise<number>;
  private readonly mcpPath: string;
  private configurationValue: GatewayTunnelConfiguration;
  private tunnel: TunnelHandle | undefined;
  private startGeneration = 0;
  private sessionLeaseTimer: ReturnType<typeof setTimeout> | undefined;
  private healthMonitorTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private desiredRunning = false;
  private desiredSessionConnected = false;
  private consecutiveHealthFailures = 0;
  private reconnectAttempt = 0;
  private connectorRegistration: ConnectorRegistrationStatus = { state: 'unverified', action: 'none' };
  private connectorRecoveryRequired = false;

  public constructor(options: GatewayServiceOptions = {}) {
    this.localPort = options.localPort ?? 18765;
    this.healthPath = options.healthPath ?? DEFAULT_HEALTH_PATH;
    this.mcpPath = '/mcp';
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthAttempts = options.healthAttempts ?? 5;
    this.healthRetryDelayMs = options.healthRetryDelayMs ?? 250;
    this.tunnelStartupTimeoutMs = options.tunnelStartupTimeoutMs ?? 10_000;
    this.sessionLeaseTtlMs = options.sessionLeaseTtlMs;
    this.healthMonitorIntervalMs = options.healthMonitorIntervalMs ?? 10_000;
    this.healthFailureThreshold = options.healthFailureThreshold ?? 3;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.reconnectJitterRatio = options.reconnectJitterRatio ?? 0.2;
    if (this.sessionLeaseTtlMs !== undefined && (!Number.isInteger(this.sessionLeaseTtlMs) || this.sessionLeaseTtlMs <= 0)) throw new Error('Session lease TTL must be positive');
    if (!Number.isInteger(this.healthMonitorIntervalMs) || this.healthMonitorIntervalMs <= 0) throw new Error('Health monitor interval must be positive');
    if (!Number.isInteger(this.healthFailureThreshold) || this.healthFailureThreshold <= 0) throw new Error('Health failure threshold must be positive');
    if (!Number.isInteger(this.reconnectBaseDelayMs) || this.reconnectBaseDelayMs <= 0) throw new Error('Reconnect base delay must be positive');
    if (!Number.isInteger(this.reconnectMaxDelayMs) || this.reconnectMaxDelayMs < this.reconnectBaseDelayMs) throw new Error('Reconnect max delay must be greater than or equal to reconnect base delay');
    if (!Number.isFinite(this.reconnectJitterRatio) || this.reconnectJitterRatio < 0 || this.reconnectJitterRatio > 1) throw new Error('Reconnect jitter ratio must be between 0 and 1');
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
      sessionState: this.leaseToken === undefined ? 'not_leased' : 'leased',
      connectorRegistration: { ...this.connectorRegistration },
      endToEndState: 'unverified',
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
    const wasSessionConnected = this.state === 'SESSION_CONNECTED' || this.desiredSessionConnected;
    const wasRunning = this.state === 'BRIDGE_HEALTHY' || this.state === 'SESSION_CONNECTED';
    await this.stop();
    this.connectorRecoveryRequired = wasSessionConnected;
    this.configurationValue = next;
    this.tunnelProvider = this.tunnelProviderFactory(next);
    if (!wasRunning) return ok(undefined);
    const started = await this.start();
    if (started.ok) {
      if (wasSessionConnected) {
        const connected = await this.connectSession();
        if (!connected.ok) return err(appError('CONFLICT', `Gateway reconfigured but ChatGPT Web session could not be restored: ${connected.error.message}`));
      }
      return ok(undefined);
    }
    this.configurationValue = previous;
    this.tunnelProvider = previousProvider;
    if (wasRunning) {
      const restored = await this.start();
      if (restored.ok && wasSessionConnected) await this.connectSession();
    } else {
      this.state = 'STOPPED';
      this.tunnelUrl = undefined;
      this.latencyMs = undefined;
      this.lastError = undefined;
    }
    return err(appError('CONFLICT', `Gateway configuration rejected; previous configuration restored: ${started.error.message}`));
  }

  public async start(): Promise<Result<{ readonly tunnelUrl: string; readonly localPort: number }>> {
    this.desiredRunning = true;
    this.clearReconnectTimer();
    if (this.state === 'BRIDGE_HEALTHY' || this.state === 'SESSION_CONNECTED') {
      this.scheduleHealthMonitor();
      return ok({
        tunnelUrl: this.tunnelUrl!,
        localPort: this.localPort,
      });
    }

    this.clearHealthMonitorTimer();
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
      this.lastError = undefined;
      this.consecutiveHealthFailures = 0;
      this.reconnectAttempt = 0;
      this.scheduleHealthMonitor();
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
    this.desiredRunning = false;
    this.desiredSessionConnected = false;
    this.startGeneration += 1;
    this.clearHealthMonitorTimer();
    this.clearReconnectTimer();
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    if (tunnel !== undefined) await tunnel.stop();
    this.state = 'STOPPED';
    this.tunnelUrl = undefined;
    this.leaseToken = undefined;
    this.clearSessionLeaseTimer();
    this.consecutiveHealthFailures = 0;
    this.reconnectAttempt = 0;
    this.latencyMs = undefined;
    this.lastError = undefined;
    this.connectorRecoveryRequired = false;
    this.connectorRegistration = { state: 'unverified', action: 'none' };
    return ok(undefined);
  }

  public async connectSession(): Promise<Result<{ readonly leaseToken: string; readonly tunnelUrl: string; readonly mcpUrl: string; readonly connectorRegistration: ConnectorRegistrationStatus }>> {
    if (!this.canConnectSession()) {
      return err(
        appError(
          'PERMISSION_DENIED',
          `Cannot connect session in state '${this.state}'. Bridge must be in BRIDGE_HEALTHY state before connecting ChatGPT Web.`,
        ),
      );
    }

    this.desiredSessionConnected = true;
    this.connectorRegistration = this.connectorRecoveryRequired
      ? { state: 'stale', reason: 'backend_restart', action: 'reconnect_chatgpt_session' }
      : { state: 'unverified', reason: 'host_projection_unavailable', action: 'reconnect_chatgpt_session' };
    this.leaseToken = `lease_${randomUUID().replaceAll('-', '')}`;
    this.state = 'SESSION_CONNECTED';
    this.clearSessionLeaseTimer();
    if (this.sessionLeaseTtlMs !== undefined) {
      this.sessionLeaseTimer = setTimeout(() => { void this.disconnectSession(); }, this.sessionLeaseTtlMs);
      this.sessionLeaseTimer.unref?.();
    }
    this.scheduleHealthMonitor();

    return ok({
      leaseToken: this.leaseToken,
      tunnelUrl: this.tunnelUrl!,
      mcpUrl: new URL(this.mcpPath, this.tunnelUrl!).toString(),
      connectorRegistration: { ...this.connectorRegistration },
    });
  }

  public async disconnectSession(): Promise<Result<void>> {
    this.desiredSessionConnected = false;
    this.clearSessionLeaseTimer();
    this.leaseToken = undefined;
    this.connectorRecoveryRequired = false;
    this.connectorRegistration = { state: 'unverified', action: 'none' };
    if (this.state === 'SESSION_CONNECTED') this.state = this.tunnelUrl === undefined ? 'STOPPED' : 'BRIDGE_HEALTHY';
    this.scheduleHealthMonitor();
    return ok(undefined);
  }

  private scheduleHealthMonitor(): void {
    this.clearHealthMonitorTimer();
    if (!this.desiredRunning || this.tunnelUrl === undefined || (this.state !== 'BRIDGE_HEALTHY' && this.state !== 'SESSION_CONNECTED')) return;
    this.healthMonitorTimer = setTimeout(() => { void this.runHealthMonitor(); }, this.healthMonitorIntervalMs);
    this.healthMonitorTimer.unref?.();
  }

  private async runHealthMonitor(): Promise<void> {
    this.healthMonitorTimer = undefined;
    if (!this.desiredRunning || this.tunnelUrl === undefined || (this.state !== 'BRIDGE_HEALTHY' && this.state !== 'SESSION_CONNECTED')) return;
    let statusCode = 0;
    try {
      statusCode = await this.healthProbe(new URL(this.healthPath, this.tunnelUrl).toString(), this.healthTimeoutMs);
    } catch {
      statusCode = 0;
    }
    if (!this.desiredRunning || this.tunnelUrl === undefined || (this.state !== 'BRIDGE_HEALTHY' && this.state !== 'SESSION_CONNECTED')) return;
    if (statusCode >= 200 && statusCode < 300) {
      this.consecutiveHealthFailures = 0;
      this.scheduleHealthMonitor();
      return;
    }
    this.consecutiveHealthFailures += 1;
    if (this.consecutiveHealthFailures < this.healthFailureThreshold) {
      this.scheduleHealthMonitor();
      return;
    }
    await this.beginRecovery(`Bridge health monitor failed with HTTP ${statusCode}`);
  }

  private async beginRecovery(message: string): Promise<void> {
    this.clearHealthMonitorTimer();
    this.clearSessionLeaseTimer();
    this.leaseToken = undefined;
    this.connectorRecoveryRequired = this.desiredSessionConnected;
    this.connectorRegistration = this.desiredSessionConnected
      ? { state: 'stale', reason: 'backend_restart', action: 'reconnect_chatgpt_session' }
      : { state: 'unverified', action: 'none' };
    this.lastError = message;
    this.state = 'ERROR';
    const tunnel = this.tunnel;
    this.tunnel = undefined;
    this.tunnelUrl = undefined;
    if (tunnel !== undefined) await tunnel.stop().catch(() => undefined);
    if (!this.desiredRunning) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.desiredRunning || this.reconnectTimer !== undefined) return;
    const exponent = Math.min(this.reconnectAttempt, 16);
    const baseDelay = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * (2 ** exponent));
    const jitterWindow = baseDelay * this.reconnectJitterRatio;
    const delay = Math.max(0, Math.round(baseDelay + ((Math.random() * 2 - 1) * jitterWindow)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.desiredRunning) return;
    const started = await this.start();
    if (!started.ok) {
      if (this.desiredRunning) this.scheduleReconnect();
      return;
    }
    if (this.desiredSessionConnected && this.desiredRunning && this.state === 'BRIDGE_HEALTHY') {
      const connected = await this.connectSession();
      if (!connected.ok && this.desiredRunning) {
        this.lastError = connected.error.message;
        this.scheduleReconnect();
      }
    }
  }

  private clearSessionLeaseTimer(): void {
    if (this.sessionLeaseTimer !== undefined) clearTimeout(this.sessionLeaseTimer);
    this.sessionLeaseTimer = undefined;
  }

  private clearHealthMonitorTimer(): void {
    if (this.healthMonitorTimer !== undefined) clearTimeout(this.healthMonitorTimer);
    this.healthMonitorTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
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

