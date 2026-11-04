import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { DanglingRef } from './canonical-store-verify.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinReason, RevisionPinRegistry } from './revision-pin-registry.js';
import { GcLeaseHeartbeat, type GcLeaseStore } from './gc-lease.js';

/**
 * The same single-owner fence revision prune and pin take (#210 §12): removing
 * an orphan pin is destructive store evidence, so it answers to the one fence
 * every destructive canonical-store pass answers to.
 */
export interface CanonicalStoreRepairLease {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly ttlMs: number;
  /** Clock used by the lease heartbeat; defaults to the wall clock. */
  readonly clock?: () => Date;
}

export interface CanonicalStoreRepairDeps {
  readonly refs: CanonicalRefStore;
  /**
   * Must be a strict-read store for a destructive pass: a corrupt manifest row
   * has to abort the plan instead of looking like a missing row whose pin is
   * then removed. The CLI constructs it with `strictReads: true`.
   */
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly dryRun: boolean;
  /**
   * Required in practice for any non-dry-run caller; dry runs never take it.
   * An apply without a lease is refused before a single root is read.
   */
  readonly lease?: CanonicalStoreRepairLease;
  /** Clock used to acquire the lease; defaults to the wall clock. */
  readonly now?: Date;
}

/** One orphan pin removed (apply) or that a dry run would remove. */
export interface RepairedPin {
  readonly manifestId: string;
  readonly reasons: readonly RevisionPinReason[];
}

export type CanonicalStoreRepairReport =
  | {
      readonly status: 'planned' | 'applied';
      /**
       * Pins whose manifest row is missing: removed by an apply, or reported
       * as the work a dry run would do. Every reason is removed because the
       * manifest they protected no longer exists.
       */
      readonly orphanPins: readonly RepairedPin[];
      /**
       * Degraded state this verb does not touch: only the owning store can
       * re-advance a dangling ref or re-admit a Goal overlay base.
       */
      readonly danglingRefs: readonly DanglingRef[];
      readonly missingOverlayBases: readonly string[];
    }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Repair the safe half of canonical store consistency (#210 §7 `index_repair`).
 *
 * The store verify path reports three degraded states. Only one is safe to
 * remove automatically: a pin whose manifest row is genuinely missing. That
 * pin protects nothing — revision prune cannot retain an absent manifest and
 * artifact GC cannot walk it — so every reason on it is removed.
 *
 * A dangling canonical ref and a Goal overlay whose base manifest is missing
 * are reported, never deleted: dropping the ref discards the evidence of what
 * was active, and deleting the overlay destroys the Goal's dirty state. Their
 * owning admission/advancement paths must reconcile them.
 *
 * Classification finishes before the first unpin. A corrupt manifest row (the
 * strict store throws) or an unreadable ref/overlay/pin root therefore aborts
 * the whole pass with nothing removed, instead of half-repairing the store.
 * The apply runs under the U28 GC lease and renews it per removal; a pin
 * command that takes the same lease cannot land while the pass holds it.
 */
export function repairCanonicalStore(
  deps: CanonicalStoreRepairDeps & { readonly dryRun: true },
): Promise<CanonicalStoreRepairReport>;
export function repairCanonicalStore(deps: CanonicalStoreRepairDeps): Promise<CanonicalStoreRepairReport>;
export async function repairCanonicalStore(deps: CanonicalStoreRepairDeps): Promise<CanonicalStoreRepairReport> {
  const lease = deps.dryRun ? undefined : deps.lease;
  if (lease === undefined && !deps.dryRun) {
    // A caller that forgot the fence must not get a silent unfenced mutation.
    return {
      status: 'refused',
      reason: 'canonical store repair --apply requires the gc lease: refusing an unfenced destructive pass',
    };
  }

  let granted: { readonly generation: number; readonly heartbeat: GcLeaseHeartbeat } | undefined;
  if (lease !== undefined) {
    const now = deps.now ?? new Date();
    const acquired = await lease.store.acquire({ ownerId: lease.ownerId, now, ttlMs: lease.ttlMs });
    if (acquired.status === 'denied') {
      return {
        status: 'refused',
        reason: acquired.reason === 'held'
          ? `gc lease held by ${acquired.holder} until ${acquired.expiresAt}`
          : 'gc lease fence unreadable: refusing to start a destructive pass',
      };
    }
    granted = {
      generation: acquired.generation,
      heartbeat: new GcLeaseHeartbeat({
        store: lease.store,
        ownerId: lease.ownerId,
        generation: acquired.generation,
        ttlMs: lease.ttlMs,
        grantedAt: now,
        ...(lease.clock === undefined ? {} : { clock: lease.clock }),
      }),
    };
  }

  try {
    return await runPass(deps, granted?.heartbeat);
  } finally {
    if (lease !== undefined && granted !== undefined) {
      await lease.store.release({ ownerId: lease.ownerId, generation: granted.generation });
    }
  }
}

async function runPass(
  deps: CanonicalStoreRepairDeps,
  heartbeat?: GcLeaseHeartbeat,
): Promise<CanonicalStoreRepairReport> {
  // Strict root reads: a root that cannot be read must fail the plan, because a
  // skipped pin/ref/overlay hides state the operator asked us to reconcile.
  const danglingRefs: DanglingRef[] = [];
  for (const { ref, state } of await deps.refs.list({ strict: true })) {
    if ((await deps.manifests.get(state.manifestId)) === null) {
      danglingRefs.push({ ref, manifestId: state.manifestId });
    }
  }

  const missingOverlayBases: string[] = [];
  for (const goalWorkspaceId of await deps.overlays.listIds({ strict: true })) {
    const overlay = await deps.overlays.read(goalWorkspaceId, { strict: true });
    if (overlay === null) continue;
    if ((await deps.manifests.get(overlay.baseManifestId)) === null) {
      missingOverlayBases.push(goalWorkspaceId);
    }
  }

  // Classify every pin before mutating anything. A corrupt manifest row throws
  // here, so the pass aborts with no partial repair.
  const planned: RepairedPin[] = [];
  for (const manifestId of await deps.pins.pinnedManifestIds({ strict: true })) {
    if ((await deps.manifests.get(manifestId)) !== null) continue;
    const pins = await deps.pins.list(manifestId);
    planned.push({
      manifestId,
      reasons: [...new Set(pins.map((pin) => pin.reason))].sort(),
    });
  }

  const orphanPins: RepairedPin[] = [];
  if (!deps.dryRun) {
    for (const orphan of planned) {
      // Renew the fence when half the window has passed; a newer generation
      // means this pass no longer owns the store and must stop removing.
      await heartbeat?.assert();
      const removed: RevisionPinReason[] = [];
      for (const reason of orphan.reasons) {
        if (await deps.pins.unpin(orphan.manifestId, reason)) removed.push(reason);
      }
      if (removed.length > 0) orphanPins.push({ manifestId: orphan.manifestId, reasons: removed });
    }
  }

  return {
    status: deps.dryRun ? 'planned' : 'applied',
    orphanPins: deps.dryRun ? planned : orphanPins,
    danglingRefs,
    missingOverlayBases,
  };
}
