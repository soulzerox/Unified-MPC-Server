import type { GcLeaseState } from './gc-lease.js';

/**
 * The physical-space evidence the gate consumes. Structurally satisfied by
 * `SqlitePhysicalMetrics` (#210 §2, `@unified-mpc/storage`) so the gate needs
 * no dependency on the storage package and stays testable in isolation.
 */
export interface PhysicalSpaceEvidence {
  readonly databaseBytes: number;
  readonly freelistBytes: number;
  readonly freelistRatio: number;
  readonly compactionRecommended: boolean;
  readonly checkpointBusy: boolean;
}

export interface CompactionGateInput {
  readonly physical: PhysicalSpaceEvidence;
  /** Free bytes on the database's filesystem, or null when not measurable. */
  readonly diskFreeBytes: number | null;
  /** Long-lived readers/transactions currently holding the database. */
  readonly activeReaderCount: number;
  /**
   * The *existing* maintenance owner fence (#145 scheduling / #62 data-root
   * owner). This gate never acquires or renews it — no second lock.
   */
  readonly owner: GcLeaseState | null;
  readonly now: Date;
  /** Temporary-copy multiplier over database size. Default 2. */
  readonly headroomMultiplier?: number;
  /** Extra free bytes required beyond the copy. Default 64 MiB. */
  readonly headroomMarginBytes?: number;
}

export type CompactionVerdict =
  | { readonly status: 'enqueue'; readonly reason: 'pressure-justified' }
  | { readonly status: 'skip'; readonly reason: 'below-threshold' | 'reader-pressure' }
  | {
    readonly status: 'refuse';
    readonly reason: 'no-owner-fence' | 'owner-fence-expired' | 'headroom-unknown' | 'headroom-insufficient';
  };

const DEFAULT_HEADROOM_MULTIPLIER = 2;
const DEFAULT_HEADROOM_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * Decide whether physical SQLite compaction may be enqueued (#210 §3, §5-§7).
 *
 * Row deletion and revision prune are not compaction, so nothing here reacts to
 * a prune: the decision needs measured freelist/space pressure, a quiescent
 * database, enough disk headroom for the temporary copy, and the already-live
 * owner fence. Returns a verdict only — it never compacts, vacuums, truncates
 * the WAL, acquires a lease, or enqueues work itself; the caller routes an
 * `enqueue` verdict through the existing #145 scheduler under that fence.
 *
 * Refusals fail closed: an unfenced, unmeasurable, or headroom-starved store is
 * never "probably fine".
 */
export function compactionGate(input: CompactionGateInput): CompactionVerdict {
  const {
    owner,
    now,
    physical,
    diskFreeBytes,
    activeReaderCount,
    headroomMultiplier = DEFAULT_HEADROOM_MULTIPLIER,
    headroomMarginBytes = DEFAULT_HEADROOM_MARGIN_BYTES,
  } = input;

  if (owner === null || owner.releasedAt !== undefined) {
    return { status: 'refuse', reason: 'no-owner-fence' };
  }
  const expiry = Date.parse(owner.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    return { status: 'refuse', reason: 'owner-fence-expired' };
  }

  if (diskFreeBytes === null || !Number.isFinite(diskFreeBytes) || physical.databaseBytes < 0) {
    return { status: 'refuse', reason: 'headroom-unknown' };
  }
  const requiredFreeBytes = physical.databaseBytes * headroomMultiplier + headroomMarginBytes;
  if (diskFreeBytes < requiredFreeBytes) {
    return { status: 'refuse', reason: 'headroom-insufficient' };
  }

  if (physical.checkpointBusy || activeReaderCount > 0) {
    return { status: 'skip', reason: 'reader-pressure' };
  }
  if (!physical.compactionRecommended) {
    return { status: 'skip', reason: 'below-threshold' };
  }

  return { status: 'enqueue', reason: 'pressure-justified' };
}
