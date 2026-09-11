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
  readonly localPort: number;
  readonly leaseToken?: string;
  readonly latencyMs?: number;
  readonly lastError?: string;
}

export interface GatewayServiceOptions {
  readonly localPort?: number;
  readonly tunnelHostname?: string;
  readonly tunnelProvider?: () => Promise<string>;
}

export class GatewayService {
  private state: BridgeState = 'STOPPED';
  private tunnelUrl: string | undefined;
  private leaseToken: string | undefined;
  private latencyMs: number | undefined;
  private lastError: string | undefined;
  private readonly localPort: number;
  private readonly tunnelHostname: string;
  private readonly tunnelProvider: (() => Promise<string>) | undefined;

  public constructor(options: GatewayServiceOptions = {}) {
    this.localPort = options.localPort ?? 18765;
    this.tunnelHostname = options.tunnelHostname ?? 'tunnel.unified-mpc.internal';
    this.tunnelProvider = options.tunnelProvider;
  }

  public status(): GatewayStatus {
    return {
      state: this.state,
      ...(this.tunnelUrl ? { tunnelUrl: this.tunnelUrl } : {}),
      localPort: this.localPort,
      ...(this.leaseToken ? { leaseToken: this.leaseToken } : {}),
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

    this.state = 'INITIALIZING';
    this.lastError = undefined;

    try {
      if (this.tunnelProvider) {
        this.tunnelUrl = await this.tunnelProvider();
      } else {
        this.tunnelUrl = `https://${randomUUID().slice(0, 8)}.${this.tunnelHostname}`;
      }
      this.latencyMs = 12; // Initial ping latency
      this.state = 'BRIDGE_HEALTHY';
      return ok({
        tunnelUrl: this.tunnelUrl,
        localPort: this.localPort,
      });
    } catch (error) {
      this.state = 'ERROR';
      this.lastError = error instanceof Error ? error.message : String(error);
      return err(appError('INTERNAL_ERROR', `Failed to initialize bridge tunnel: ${this.lastError}`));
    }
  }

  public async stop(): Promise<Result<void>> {
    this.state = 'STOPPED';
    this.tunnelUrl = undefined;
    this.leaseToken = undefined;
    this.latencyMs = undefined;
    this.lastError = undefined;
    return ok(undefined);
  }

  public async connectSession(): Promise<Result<{ readonly leaseToken: string; readonly tunnelUrl: string }>> {
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
    });
  }
}

