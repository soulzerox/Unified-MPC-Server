import type { HeavyJobLiveEntry } from '@unified-mpc/workspace';

/**
 * A queue owner proves liveness by refreshing `heartbeat_at`. Six missed beats
 * at the default cadence are treated as a dead owner, matching the bounded
 * grace used by the exact-head verification attempt ledger.
 */
export const DEFAULT_HEAVY_JOB_HEARTBEAT_STALE_AFTER_MS = 90_000;

/**
 * Queued work that nobody re-claimed is retired after this window. Heavy jobs
 * are expensive; an unbounded backlog of orphaned intent would permanently
 * consume the bounded queue.
 */
export const DEFAULT_HEAVY_JOB_QUEUED_RETENTION_MS = 60 * 60_000;

export interface HeavyJobQueueRecoveryStorePort {
  listLive(): readonly HeavyJobLiveEntry[];
  recover(
    operationId: string,
    action: 'orphan' | 'interrupt' | 'expire',
    input: { readonly at: string; readonly detail?: string },
  ): boolean;
}

export interface HeavyJobQueueRecoveryOptions {
  /** The owner id of this process; its rows are left alone. */
  readonly currentOwnerId?: string;
  readonly now?: () => Date;
  readonly heartbeatStaleAfterMs?: number;
  readonly queuedRetentionMs?: number;
}

export interface HeavyJobQueueRecoverySummary {
  readonly inspected: number;
  /** Running work whose owner stopped beating is now truthfully `interrupted`. */
  readonly interrupted: number;
  /** Queued work from a dead owner is now adoptable by an identical re-submit. */
  readonly orphaned: number;
  /** Queued work that outlived the retention window was retired before start. */
  readonly expired: number;
  readonly retained: number;
}

/**
 * Reconciles durable heavy-job queue state after a restart (#145 U5).
 *
 * Running work is never revived: an owner that stopped heartbeating cannot
 * prove a verdict, so the row becomes `interrupted` instead of pretending the
 * job is still running. Queued intent survives as an orphaned row that the
 * next identical claim may adopt, or expires after a bounded window.
 */
export class HeavyJobQueueRecoveryService {
  private readonly currentOwnerId: string | undefined;
  private readonly now: () => Date;
  private readonly heartbeatStaleAfterMs: number;
  private readonly queuedRetentionMs: number;

  public constructor(
    private readonly store: HeavyJobQueueRecoveryStorePort,
    options: HeavyJobQueueRecoveryOptions = {},
  ) {
    this.currentOwnerId = options.currentOwnerId;
    this.now = options.now ?? ((): Date => new Date());
    this.heartbeatStaleAfterMs = positiveInteger(
      options.heartbeatStaleAfterMs,
      DEFAULT_HEAVY_JOB_HEARTBEAT_STALE_AFTER_MS,
      'heartbeatStaleAfterMs',
    );
    this.queuedRetentionMs = positiveInteger(
      options.queuedRetentionMs,
      DEFAULT_HEAVY_JOB_QUEUED_RETENTION_MS,
      'queuedRetentionMs',
    );
  }

  public reconcileOnce(): HeavyJobQueueRecoverySummary {
    const now = this.now();
    const nowIso = now.toISOString();
    const staleCutoff = now.getTime() - this.heartbeatStaleAfterMs;
    const retentionCutoff = now.getTime() - this.queuedRetentionMs;
    const rows = this.store.listLive();

    let interrupted = 0;
    let orphaned = 0;
    let expired = 0;
    let retained = 0;

    for (const row of rows) {
      if (row.ownerId !== undefined && row.ownerId === this.currentOwnerId) {
        retained += 1;
        continue;
      }

      const heartbeat = Date.parse(row.heartbeatAt);
      const ownerLive = Number.isFinite(heartbeat) && heartbeat > staleCutoff;
      if (row.ownerId !== undefined && ownerLive) {
        retained += 1;
        continue;
      }

      // A dead (or already orphaned) owner cannot be trusted to finish this
      // work. Running rows are closed truthfully; queued rows keep their
      // intent only while they are still fresh enough to be re-claimed.
      if (row.state === 'running') {
        if (this.store.recover(row.operationId, 'interrupt', {
          at: nowIso,
          detail: `Heavy-job owner '${row.ownerId ?? 'unknown'}' stopped heartbeating before settlement`,
        })) interrupted += 1;
        else retained += 1;
        continue;
      }

      const requestedAt = Date.parse(row.requestedAt);
      if (!Number.isFinite(requestedAt) || requestedAt <= retentionCutoff) {
        if (this.store.recover(row.operationId, 'expire', {
          at: nowIso,
          detail: 'Queued heavy work expired before any owner claimed it',
        })) expired += 1;
        else retained += 1;
        continue;
      }

      if (row.ownerId === undefined) {
        retained += 1;
        continue;
      }
      if (this.store.recover(row.operationId, 'orphan', { at: nowIso })) orphaned += 1;
      else retained += 1;
    }

    return { inspected: rows.length, interrupted, orphaned, expired, retained };
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}
