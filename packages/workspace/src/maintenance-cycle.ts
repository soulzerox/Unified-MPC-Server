import type { PhysicalSpaceEvidence } from './compaction-gate.js';
import { compactionGate } from './compaction-gate.js';
import { GcLeaseStore } from './gc-lease.js';
import type { CanonicalStoreVerifyReport } from './canonical-store-verify.js';
import type { GcCycleReport } from './gc-cycle.js';
import type { ResourceAdmissionClass } from './resource-admission.js';
import { ResourceAdmissionController } from './resource-admission.js';

/**
 * One bounded maintenance cycle (#210 §3, §5-§7).
 *
 * Decides whether physical compaction may run, then runs GC quarantine plus
 * post-maintenance integrity under a single existing owner fence and one
 * admission-controller lease. Nothing here creates a second lock or a
 * duplicate scheduler; it consumes #145's ResourceAdmissionController and
 * #210 §12's GcLeaseStore.
 *
 * Fail-closed: headroom/fence/admission problems refuse before anything is
 * mutated; every taken fence and lease is released in a finally, even when
 * GC or verification throws.
 *
 * The caller wires real dependencies: `physical`/`diskFreeBytes` come from
 * `SqliteDatabase.physicalMetrics` (@unified-mpc/storage, #373), `runGcQuarantine`
 * runs `runGcCycle` (#210 U22/#373) under this cycle's fence, and `verifyStore`
 * runs `verifyCanonicalStore` plus manifest→artifact/vector/FTS/CPG ownership checks.
 */
export interface MaintenanceCycleDeps {
  readonly physical: PhysicalSpaceEvidence;
  /** Free bytes on the database filesystem, or null when not measurable. */
  readonly diskFreeBytes: number | null;
  /** Long-lived readers/transactions currently holding the database. */
  readonly activeReaderCount: number;
  readonly ownerId: string;
  /** Workspace attributed to the background maintenance job. */
  readonly workspaceId: string;
  readonly now: Date;
  readonly ttlMs: number;
  readonly leaseStore: GcLeaseStore;
  readonly controller: ResourceAdmissionController;
  readonly resourceClass: ResourceAdmissionClass;
  readonly admissionCost: number;
  /** Runs GC quarantine while this cycle's fence is held. */
  readonly runGcQuarantine: () => Promise<GcCycleReport>;
  /** Post-maintenance integrity verification (manifest↔artifact↔vector↔FTS↔CPG). */
  readonly verifyStore: () => Promise<CanonicalStoreVerifyReport>;
}

export type MaintenanceCycleReport =
  | {
    readonly status: 'refused';
    readonly reason:
      | 'headroom-unknown'
      | 'headroom-insufficient'
      | 'fence-acquire-failed'
      | 'admission-rejected'
      | 'gc-refused'
      | 'verify-degraded';
    readonly tookFence: boolean;
    readonly tookAdmission: boolean;
  }
  | {
    readonly status: 'skipped';
    readonly reason: 'below-threshold' | 'reader-pressure';
    readonly tookFence: boolean;
    readonly tookAdmission: boolean;
  }
  | {
    readonly status: 'completed';
    readonly gc: GcCycleReport;
    readonly verification: CanonicalStoreVerifyReport;
    readonly tookFence: boolean;
    readonly tookAdmission: boolean;
  };

export interface MaintenanceCycleOptions {
  /** Temporary-copy multiplier over database size. Default 2. */
  readonly headroomMultiplier?: number;
  /** Extra free bytes required beyond the copy. Default 64 MiB. */
  readonly headroomMarginBytes?: number;
}

const DEFAULT_HEADROOM_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * Run one bounded maintenance cycle.
 *
 * Pre-flight headroom is checked before any lock. The fence and admission
 * lease are taken only when needed, and both are released exactly once in a
 * single finally that runs even when GC or verification throws.
 */
export async function runMaintenanceCycle(
  deps: MaintenanceCycleDeps,
  options: MaintenanceCycleOptions = {},
): Promise<MaintenanceCycleReport> {
  const {
    physical,
    diskFreeBytes,
    ownerId,
    workspaceId,
    now,
    ttlMs,
    leaseStore,
    controller,
    resourceClass,
    admissionCost,
    runGcQuarantine,
    verifyStore,
  } = deps;
  const headroomMarginBytes = options.headroomMarginBytes ?? DEFAULT_HEADROOM_MARGIN_BYTES;
  const headroomMultiplier = options.headroomMultiplier ?? 2;

  // Cheap pre-flight before any lock: headroom must be measurable and sufficient.
  if (diskFreeBytes === null || !Number.isFinite(diskFreeBytes) || physical.databaseBytes < 0) {
    return { status: 'refused', reason: 'headroom-unknown', tookFence: false, tookAdmission: false };
  }
  const requiredFreeBytes = physical.databaseBytes * headroomMultiplier + headroomMarginBytes;
  if (diskFreeBytes < requiredFreeBytes) {
    return { status: 'refused', reason: 'headroom-insufficient', tookFence: false, tookAdmission: false };
  }

  // Single-owner fence for the whole cycle (#210 §12).
  const fence = await leaseStore.acquire({ ownerId, now, ttlMs });
  if (fence.status !== 'granted') {
    return { status: 'refused', reason: 'fence-acquire-failed', tookFence: false, tookAdmission: false };
  }

  let tookAdmission = false;
  let admission: ReturnType<typeof controller.tryAcquire> | undefined;

  try {
    const gate = compactionGate({
      physical,
      diskFreeBytes,
      activeReaderCount: deps.activeReaderCount,
      owner: {
        ownerId: fence.ownerId,
        generation: fence.generation,
        token: fence.token,
        acquiredAt: now.toISOString(),
        expiresAt: fence.expiresAt,
      },
      now,
      headroomMultiplier,
      headroomMarginBytes,
    });

    if (gate.status === 'skip') {
      return { status: 'skipped', reason: gate.reason, tookFence: true, tookAdmission: false };
    }
    if (gate.status === 'refuse') {
      // A fence was just granted and headroom passed pre-flight with identical
      // inputs, so gate refusals here are only the fence-expiry/headroom
      // branches — mapped into this cycle's refused vocabulary.
      const reason =
        gate.reason === 'headroom-unknown' || gate.reason === 'headroom-insufficient'
          ? gate.reason
          : 'fence-acquire-failed';
      return { status: 'refused', reason, tookFence: true, tookAdmission: false };
    }

    // One bounded admission-controller lease (#145 scheduling).
    const acquired = controller.tryAcquire({
      operationId: `maintenance-${ownerId}-${now.getTime()}`,
      workspaceId,
      resourceClass,
      cost: admissionCost,
    });
    if (!acquired.admitted) {
      return { status: 'refused', reason: 'admission-rejected', tookFence: true, tookAdmission: false };
    }
    tookAdmission = true;
    admission = acquired;

    try {
      const gc = await runGcQuarantine();
      if (gc.status === 'refused') {
        return { status: 'refused', reason: 'gc-refused', tookFence: true, tookAdmission: true };
      }

      const verification = await verifyStore();
      if (verification.status === 'degraded') {
        return {
          status: 'refused',
          reason: 'verify-degraded',
          tookFence: true,
          tookAdmission: true,
        };
      }

      return {
        status: 'completed',
        gc,
        verification,
        tookFence: true,
        tookAdmission: true,
      };
    } finally {
      if (tookAdmission && admission !== undefined) controller.release(admission.lease);
    }
  } finally {
    await leaseStore.release({ ownerId, generation: fence.generation });
  }
}
