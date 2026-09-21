import { createPosixProcessIdentityProbe, type PosixProcessIdentityProbe } from './posix-process-identity.js';

export interface PersistedPosixProcessIdentity {
  readonly pid: number;
  readonly startedAt: string;
}

export type PosixProcessRecoveryObservation =
  | { readonly state: 'verified_live'; readonly pid: number; readonly startedAt: string }
  | { readonly state: 'verified_gone'; readonly pid: number }
  | { readonly state: 'identity_mismatch'; readonly pid: number; readonly expectedStartedAt: string; readonly observedStartedAt: string }
  | { readonly state: 'termination_unverified'; readonly pid: number; readonly reason: 'invalid_identity' | 'root_without_group' | 'orphan_group' | 'identity_unavailable' | 'probe_failed' };

export interface PosixProcessRecoveryProbeOptions {
  readonly platform?: NodeJS.Platform;
  readonly processIsAlive?: (pid: number) => boolean;
  readonly processGroupIsAlive?: (pid: number) => boolean;
  readonly processStartedAt?: PosixProcessIdentityProbe;
}

/**
 * Reconcile a persisted detached POSIX process identity without sending signals.
 *
 * This deliberately distinguishes a verified-gone process from ambiguous
 * liveness. Callers restoring durable ownership/resource accounting must fail
 * closed on termination_unverified and must never treat PID reuse as the
 * original managed process.
 */
export class PosixProcessRecoveryProbe {
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly processGroupIsAlive: (pid: number) => boolean;
  private readonly processStartedAt: PosixProcessIdentityProbe;

  public constructor(options: PosixProcessRecoveryProbeOptions = {}) {
    const platform = options.platform ?? process.platform;
    if (platform !== 'darwin' && platform !== 'linux') throw new Error('POSIX process recovery requires macOS or Linux');
    this.processIsAlive = options.processIsAlive ?? isProcessAlive;
    this.processGroupIsAlive = options.processGroupIsAlive ?? isProcessGroupAlive;
    this.processStartedAt = options.processStartedAt ?? createPosixProcessIdentityProbe(platform);
  }

  public async inspect(expected: PersistedPosixProcessIdentity): Promise<PosixProcessRecoveryObservation> {
    if (!isValidPid(expected.pid) || !isIsoTimestamp(expected.startedAt)) {
      return { state: 'termination_unverified', pid: expected.pid, reason: 'invalid_identity' };
    }

    let rootAlive: boolean;
    let groupAlive: boolean;
    try {
      rootAlive = this.processIsAlive(expected.pid);
      groupAlive = this.processGroupIsAlive(expected.pid);
    } catch {
      return { state: 'termination_unverified', pid: expected.pid, reason: 'probe_failed' };
    }

    if (!rootAlive && !groupAlive) return { state: 'verified_gone', pid: expected.pid };
    if (!rootAlive && groupAlive) return { state: 'termination_unverified', pid: expected.pid, reason: 'orphan_group' };
    if (rootAlive && !groupAlive) return { state: 'termination_unverified', pid: expected.pid, reason: 'root_without_group' };

    let observedStartedAt: string | null;
    try {
      observedStartedAt = await this.processStartedAt(expected.pid);
    } catch {
      return { state: 'termination_unverified', pid: expected.pid, reason: 'probe_failed' };
    }

    if (observedStartedAt === null) {
      try {
        if (!this.processIsAlive(expected.pid) && !this.processGroupIsAlive(expected.pid)) {
          return { state: 'verified_gone', pid: expected.pid };
        }
      } catch {
        return { state: 'termination_unverified', pid: expected.pid, reason: 'probe_failed' };
      }
      return { state: 'termination_unverified', pid: expected.pid, reason: 'identity_unavailable' };
    }

    if (observedStartedAt !== expected.startedAt) {
      return {
        state: 'identity_mismatch',
        pid: expected.pid,
        expectedStartedAt: expected.startedAt,
        observedStartedAt,
      };
    }

    return { state: 'verified_live', pid: expected.pid, startedAt: observedStartedAt };
  }
}

function isValidPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function isIsoTimestamp(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}
