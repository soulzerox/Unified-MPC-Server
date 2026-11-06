import type { PhysicalSpaceEvidence } from './compaction-gate.js';
import { compactionGate } from './compaction-gate.js';
import { GcLeaseHeartbeat, GcLeaseLostError, GcLeaseStore } from './gc-lease.js';
import type { CanonicalStoreVerifyReport } from './canonical-store-verify.js';
import type { GcCycleReport } from './gc-cycle.js';
import type { ResourceAdmissionClass } from './resource-admission.js';
import { ResourceAdmissionController } from './resource-admission.js';

/**
 * One bounded maintenance cycle (#210 §3, §5-§7).
 *
 * Decides whether physical compaction may run, then runs GC quarantine,
 * physical compaction and post-maintenance integrity under a single existing
 * owner fence and one admission-controller lease. Nothing here creates a
 * second lock or a duplicate scheduler; it consumes #145's
 * ResourceAdmissionController and #210 §12's GcLeaseStore.
 *
 * Fail-closed: headroom/fence/admission problems refuse before anything is
 * mutated; every taken fence and lease is released in a finally, even when
 * GC, compaction or verification throws.
 *
 * The GC pass receives the live fence and renews it at its destructive
 * boundary. It must not acquire a second lease: the record is held for the
 * whole cycle, so a re-acquire would self-deny, while skipping the renewal
 * would let a long pass outlive the window.
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
  /**
   * Runs GC quarantine while this cycle's fence is held. It receives the live
   * fence so the pass can renew and assert that same record at its own
   * destructive boundary: re-acquiring it would self-deny, and skipping the
   * renewal would let a long pass outlive the window.
   */
  readonly runGcQuarantine: (fence: MaintenanceCycleFence) => Promise<GcCycleReport>;
  /**
   * Physically compacts the store after a successful GC pass. Omitted by
   * embedders that only want the safety decision and GC; the report then says
   * `not-requested` instead of claiming a compaction happened.
   */
  readonly compactStore?: () => Promise<MaintenanceCompactionReport>;
  /** Post-maintenance integrity verification (manifest↔artifact↔vector↔FTS↔CPG). */
  readonly verifyStore: () => Promise<CanonicalStoreVerifyReport>;
  /** Injectable clock for the fence heartbeat; defaults to the wall clock. */
  readonly clock?: () => Date;
}

/** What the cycle did with physical SQLite compaction. */
export type MaintenanceCompactionReport =
  | { readonly status: 'not-requested' }
  | { readonly status: 'planned'; readonly reason: 'pressure-justified' }
  | {
    readonly status: 'skipped';
    readonly reason: 'reader-pressure';
    readonly detail: string;
  }
  | {
    readonly status: 'compacted';
    readonly beforeBytes: number;
    readonly afterBytes: number;
    readonly reclaimedBytes: number;
    readonly beforeFreelistBytes: number;
    readonly afterFreelistBytes: number;
    /** A reader blocked the final WAL truncate; reclamation may be partial. */
    readonly checkpointBusy: boolean;
    readonly checkpointTruncated: boolean;
    readonly walBytesAfter: number;
  };

/** The fence this cycle acquired, handed to the GC pass it owns. */
export interface MaintenanceCycleFence {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly generation: number;
  readonly ttlMs: number;
  /** Grant time; the GC pass renews this record against it. */
  readonly grantedAt: Date;
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
      | 'compaction-failed'
      | 'verify-degraded';
    /**
     * Why the refusal happened, from the component that made the decision:
     * the headroom numbers, the fence holder and expiry, the admission
     * controller's reason, the GC planner's reason, or the degraded counts.
     * The token alone cannot tell an operator what to fix.
     */
    readonly detail: string;
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
    readonly compaction: MaintenanceCompactionReport;
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
    compactStore,
    verifyStore,
    clock,
  } = deps;
  const headroomMarginBytes = options.headroomMarginBytes ?? DEFAULT_HEADROOM_MARGIN_BYTES;
  const headroomMultiplier = options.headroomMultiplier ?? 2;

  // Cheap pre-flight before any lock: headroom must be measurable and sufficient.
  if (diskFreeBytes === null || !Number.isFinite(diskFreeBytes) || physical.databaseBytes < 0) {
    return {
      status: 'refused',
      reason: 'headroom-unknown',
      detail: `databaseBytes ${physical.databaseBytes} diskFreeBytes ${diskFreeBytes === null ? 'unknown' : String(diskFreeBytes)}`,
      tookFence: false,
      tookAdmission: false,
    };
  }
  const requiredFreeBytes = physical.databaseBytes * headroomMultiplier + headroomMarginBytes;
  if (diskFreeBytes < requiredFreeBytes) {
    return {
      status: 'refused',
      reason: 'headroom-insufficient',
      detail: `required ${requiredFreeBytes} bytes free ${diskFreeBytes}`,
      tookFence: false,
      tookAdmission: false,
    };
  }

  // Single-owner fence for the whole cycle (#210 §12).
  const fence = await leaseStore.acquire({ ownerId, now, ttlMs });
  if (fence.status !== 'granted') {
    return {
      status: 'refused',
      reason: 'fence-acquire-failed',
      detail: fence.reason === 'held'
        ? `held by ${fence.holder} until ${fence.expiresAt}`
        : 'fence record is unreadable',
      tookFence: false,
      tookAdmission: false,
    };
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
      const detail = gate.reason === 'headroom-insufficient'
        ? `required ${requiredFreeBytes} bytes free ${diskFreeBytes}`
        : gate.reason === 'headroom-unknown'
          ? `databaseBytes ${physical.databaseBytes} diskFreeBytes unknown`
          : `fence ${gate.reason}`;
      return { status: 'refused', reason, detail, tookFence: true, tookAdmission: false };
    }

    // One bounded admission-controller lease (#145 scheduling).
    const acquired = controller.tryAcquire({
      operationId: `maintenance-${ownerId}-${now.getTime()}`,
      workspaceId,
      resourceClass,
      cost: admissionCost,
    });
    if (!acquired.admitted) {
      return {
        status: 'refused',
        reason: 'admission-rejected',
        detail: `admission denied: ${acquired.reason}`,
        tookFence: true,
        tookAdmission: false,
      };
    }
    tookAdmission = true;
    admission = acquired;

    try {
      const gc = await runGcQuarantine({
        store: leaseStore,
        ownerId,
        generation: fence.generation,
        ttlMs,
        grantedAt: now,
      });
      if (gc.status === 'refused') {
        return {
          status: 'refused',
          reason: 'gc-refused',
          detail: gc.reason.length > 0 ? gc.reason : 'gc planner refused without a reason',
          tookFence: true,
          tookAdmission: true,
        };
      }

      const heartbeat = compactStore === undefined
        ? undefined
        : new GcLeaseHeartbeat({
          store: leaseStore,
          ownerId,
          generation: fence.generation,
          ttlMs,
          grantedAt: now,
          ...(clock === undefined ? {} : { clock }),
        });

      let compaction: MaintenanceCompactionReport = { status: 'not-requested' };
      if (compactStore !== undefined) {
        // GC renewed at its own destructive boundary. Compaction is the next
        // one, so assert the same record again before touching the database.
        await heartbeat?.assert();
        try {
          compaction = await compactStore();
        } catch (error) {
          if (error instanceof GcLeaseLostError) throw error;
          const detail = error instanceof Error ? error.message : String(error);
          // Verify before refusing: a compaction failure might also have
          // damaged the store, and the degraded counts are the stronger
          // diagnosis than the thrown message alone. A verification that
          // throws (strict manifest reads fail on a corrupt manifest) must not
          // replace the compaction failure that led here, so keep both
          // messages and stay fail-closed.
          let verification: CanonicalStoreVerifyReport;
          try {
            verification = await verifyStore();
          } catch (verifyError) {
            const verifyDetail = verifyError instanceof Error ? verifyError.message : String(verifyError);
            return {
              status: 'refused',
              reason: 'compaction-failed',
              detail: `${detail}; verification threw: ${verifyDetail}`,
              tookFence: true,
              tookAdmission: true,
            };
          }
          if (verification.status === 'degraded') {
            return {
              status: 'refused',
              reason: 'verify-degraded',
              detail: `${degradedDetail(verification)}; compaction failed: ${detail}`,
              tookFence: true,
              tookAdmission: true,
            };
          }
          return {
            status: 'refused',
            reason: 'compaction-failed',
            detail,
            tookFence: true,
            tookAdmission: true,
          };
        }
      }

      const verification = await verifyStore();
      if (verification.status === 'degraded') {
        return {
          status: 'refused',
          reason: 'verify-degraded',
          detail: degradedDetail(verification),
          tookFence: true,
          tookAdmission: true,
        };
      }

      return {
        status: 'completed',
        gc,
        compaction,
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

function degradedDetail(report: CanonicalStoreVerifyReport): string {
  return `dangling refs ${report.danglingRefs.length} missing overlays ${report.missingOverlays.length} orphaned pins ${report.orphanedPins.length}`;
}
