import {
  PosixProcessRecoveryProbe,
  type PersistedPosixProcessIdentity,
  type PosixProcessRecoveryObservation,
} from '@unified-mpc/process';
import type {
  ManagedResourceBinding,
  SqliteManagedResourceBindingRepository,
} from '@unified-mpc/storage';
import type {
  ResourceAdmissionController,
  ResourceAdmissionLease,
} from '@unified-mpc/workspace';

const DEFAULT_POLL_INTERVAL_MS = 250;

export interface ManagedResourceRecoveryProbe {
  inspect(expected: PersistedPosixProcessIdentity): Promise<PosixProcessRecoveryObservation>;
}

export interface ManagedResourceRecoveryServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly pollIntervalMs?: number;
  readonly probe?: ManagedResourceRecoveryProbe;
  readonly now?: () => Date;
}

export interface ManagedResourceRecoverySummary {
  readonly inspected: number;
  readonly restored: number;
  readonly released: number;
  readonly terminationUnverified: number;
}

/**
 * Reconciles durable managed-process resource ownership after Unified restarts.
 *
 * The durable binding repository is authoritative for whether an external
 * process may still own resource debt. POSIX identity is verified without
 * signalling the process. Ambiguous state always restores debt fail-closed.
 */
export class ManagedResourceRecoveryService {
  private readonly platform: NodeJS.Platform;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly probe: ManagedResourceRecoveryProbe | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  public constructor(
    private readonly repository: Pick<
      SqliteManagedResourceBindingRepository,
      'listUnreleased' | 'markTerminationUnverified' | 'markReleased'
    >,
    private readonly controller: ResourceAdmissionController,
    options: ManagedResourceRecoveryServiceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
    this.now = options.now ?? (() => new Date());
    this.probe = options.probe ?? (
      isPosixRecoveryPlatform(this.platform)
        ? new PosixProcessRecoveryProbe({ platform: this.platform })
        : undefined
    );
  }

  public async start(): Promise<ManagedResourceRecoverySummary> {
    const summary = await this.reconcileOnce();
    this.schedulePoll();
    return summary;
  }

  public close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  public async reconcileOnce(): Promise<ManagedResourceRecoverySummary> {
    const bindings = this.repository.listUnreleased();
    let restored = 0;
    let released = 0;
    let terminationUnverified = 0;

    for (const binding of bindings) {
      const lease = toLease(binding);

      if (!isPosixRecoveryPlatform(this.platform) || this.probe === undefined) {
        this.markTerminationUnverified(binding);
        this.restoreOrThrow(lease);
        restored += 1;
        terminationUnverified += 1;
        continue;
      }

      const observation = await this.inspect(binding);
      if (observation.state === 'verified_gone' || observation.state === 'identity_mismatch') {
        this.repository.markReleased(binding.operationId, this.now().toISOString());
        this.controller.release(lease);
        released += 1;
        continue;
      }

      if (observation.state === 'termination_unverified') {
        this.markTerminationUnverified(binding);
        terminationUnverified += 1;
      }

      this.restoreOrThrow(lease);
      restored += 1;
    }

    return {
      inspected: bindings.length,
      restored,
      released,
      terminationUnverified,
    };
  }

  private async inspect(binding: ManagedResourceBinding): Promise<PosixProcessRecoveryObservation> {
    try {
      return await this.probe!.inspect({
        pid: binding.pid,
        startedAt: binding.processStartedAt,
      });
    } catch {
      return {
        state: 'termination_unverified',
        pid: binding.pid,
        reason: 'probe_failed',
      };
    }
  }

  private markTerminationUnverified(binding: ManagedResourceBinding): void {
    if (binding.state === 'termination_unverified') return;
    this.repository.markTerminationUnverified(binding.operationId, this.now().toISOString());
  }

  private restoreOrThrow(lease: ResourceAdmissionLease): void {
    if (this.controller.restore(lease)) return;
    throw new Error(
      `Managed resource debt conflict for operation '${lease.operationId}' during restart reconciliation`,
    );
  }

  private schedulePoll(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcileOnce().catch(() => undefined).finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }
}

function toLease(binding: ManagedResourceBinding): ResourceAdmissionLease {
  return {
    operationId: binding.operationId,
    workspaceId: binding.workspaceId,
    sessionId: binding.sessionId,
    resourceClass: binding.resourceClass,
    cost: binding.cost,
  };
}

function isPosixRecoveryPlatform(platform: NodeJS.Platform): platform is 'linux' | 'darwin' {
  return platform === 'linux' || platform === 'darwin';
}

function normalizePollInterval(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_POLL_INTERVAL_MS;
}
