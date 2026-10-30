/**
 * Reclamation of expired publish credential leases (#297 §5).
 *
 * A lease is short-lived by construction, but a crashed publisher can leave its
 * `publish-<leaseId>` secret in the Secret Service until the TTL passes. `open`
 * already refuses an expired lease, so this sweep is not a security barrier: it
 * is the step that actually deletes the abandoned secret. It runs once on
 * runtime start and then hourly, because a long-running service must not keep an
 * abandoned secret past its TTL.
 *
 * The timer is unref'd and every failure is swallowed: a Secret Service outage
 * must not take the runtime down, and the next sweep retries the same row.
 */
export const PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/** The only capability the sweep needs; the Sqlite repository implements it. */
export interface PublishCredentialLeaseSweeper {
  sweepExpired(now: number): Promise<number>;
}

export interface PublishCredentialSweepOptions {
  readonly leases: PublishCredentialLeaseSweeper;
  readonly now?: () => number;
  readonly intervalMs?: number;
  /** Fires after every successful sweep so the host can log the reclaimed count. */
  readonly onSwept?: (count: number) => void;
  readonly onError?: (error: unknown) => void;
}

export interface PublishCredentialSweepHandle {
  /** The startup sweep. Resolves to the number of reclaimed leases and never rejects. */
  readonly ready: Promise<number>;
  stop(): void;
}

export function startPublishCredentialSweep(
  options: PublishCredentialSweepOptions,
): PublishCredentialSweepHandle {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS;
  let stopped = false;

  const sweepOnce = async (): Promise<number> => {
    if (stopped) return 0;
    try {
      const swept = await options.leases.sweepExpired(now());
      options.onSwept?.(swept);
      return swept;
    } catch (error: unknown) {
      options.onError?.(error);
      return 0;
    }
  };

  const ready = sweepOnce();
  void ready.catch(() => undefined);
  const timer = setInterval(() => {
    void sweepOnce();
  }, intervalMs);
  timer.unref?.();

  return {
    ready,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
