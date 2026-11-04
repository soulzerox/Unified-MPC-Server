import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import type { GcLeaseStore } from './gc-lease.js';

export type RevisionRetainReason =
  | 'canonical-ref'
  | 'pin'
  | 'overlay-base'
  | 'index-job';

/**
 * Single-owner guard for the destructive half (#210 §12).
 *
 * Same shape `expireGcQuarantine` uses: the store owns the record, the caller
 * supplies the identity an operator can recognise and the window one pass may
 * hold it. Reusing the U28 lease instead of a second lock is the point — every
 * destructive canonical-store pass answers to the same fence.
 */
export interface RevisionPruneLease {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly ttlMs: number;
}

export interface RevisionPruneDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  /** Manifests referenced by active/pending index jobs; caller owns that ledger. */
  readonly indexJobManifestIds: readonly string[];
  readonly dryRun: boolean;
  /**
   * Required in practice for any non-dry-run caller; dry runs never take it.
   * An apply without a lease is refused before a single root is read.
   */
  readonly lease?: RevisionPruneLease;
  /** Clock used to acquire the lease; defaults to the wall clock. */
  readonly now?: Date;
}

export interface RetainedRevision {
  readonly manifestId: string;
  readonly reason: RevisionRetainReason;
}

export interface RevisionPrunePlan {
  readonly status: 'planned';
  readonly pruneable: readonly string[];
  readonly removed: readonly string[];
  readonly retained: readonly RetainedRevision[];
}

export type RevisionPruneReport = RevisionPrunePlan | { readonly status: 'refused'; readonly reason: string };

/**
 * Prune revision manifests guarded by reachability (#210 U20).
 *
 * A manifest row is *the revision manifest*, not the artifacts it
 * references: pruning removes only unreferenced manifest JSON. Shared
 * content-addressed artifacts are never touched — physical deletion
 * stays with the artifact GC path (#145-scheduled) that re-checks
 * reachability after quarantine. Retained roots are reported with their
 * reason (canonical refs, pins, overlay bases, active index jobs) so the
 * decision is auditable. Dry-run plans without deleting; idempotent.
 *
 * With a `lease` supplied the delete pass runs under the U28 single-owner
 * fence: a held or unreadable lease refuses before any planning work, and
 * the lease is released afterwards even when a strict root read throws.
 * The roots are read inside this call, so an apply re-checks refs, pins,
 * overlay bases and the caller-supplied index-job ledger at execution time
 * rather than trusting an earlier plan. A pin that lands after this pass
 * reads the registry but before its manifest row is deleted is still
 * ignored: that bounded window is the same one `index gc expire --apply`
 * accepts, and it is documented instead of closed with a store-wide writer
 * lock. Dry runs are read-only and deliberately never take the lease.
 */
export function pruneRevisionManifests(
  deps: RevisionPruneDeps & { readonly dryRun: true },
): Promise<RevisionPrunePlan>;
export function pruneRevisionManifests(deps: RevisionPruneDeps): Promise<RevisionPruneReport>;
export async function pruneRevisionManifests(deps: RevisionPruneDeps): Promise<RevisionPruneReport> {
  const lease = deps.dryRun ? undefined : deps.lease;
  if (lease === undefined && !deps.dryRun) {
    // A caller that forgot the fence must not get a silent unfenced delete.
    return {
      status: 'refused',
      reason: 'revision prune --apply requires the gc lease: refusing an unfenced destructive pass',
    };
  }

  let granted: { readonly generation: number } | undefined;
  if (lease !== undefined) {
    const acquired = await lease.store.acquire({
      ownerId: lease.ownerId,
      now: deps.now ?? new Date(),
      ttlMs: lease.ttlMs,
    });
    if (acquired.status === 'denied') {
      return {
        status: 'refused',
        reason: acquired.reason === 'held'
          ? `gc lease held by ${acquired.holder} until ${acquired.expiresAt}`
          : 'gc lease fence unreadable: refusing to start a destructive pass',
      };
    }
    granted = { generation: acquired.generation };
  }

  try {
    return await runPass(deps);
  } finally {
    if (lease !== undefined && granted !== undefined) {
      await lease.store.release({ ownerId: lease.ownerId, generation: granted.generation });
    }
  }
}

async function runPass(deps: RevisionPruneDeps): Promise<RevisionPrunePlan> {
  const retainedBy = new Map<string, RevisionRetainReason[]>();

  const retain = (manifestId: string, reason: RevisionRetainReason): void => {
    const reasons = retainedBy.get(manifestId);
    if (reasons === undefined) retainedBy.set(manifestId, [reason]);
    else if (!reasons.includes(reason)) reasons.push(reason);
  };

  // Strict root reads: this function can delete manifest rows, so an unreadable
  // ref/pin/overlay must refuse the plan rather than look like an absent root
  // and let a still-referenced manifest be pruned.
  for (const { state } of await deps.refs.list({ strict: true })) {
    if ((await deps.manifests.get(state.manifestId)) !== null) retain(state.manifestId, 'canonical-ref');
  }
  for (const goalWorkspaceId of await deps.overlays.listIds({ strict: true })) {
    const overlay = await deps.overlays.read(goalWorkspaceId, { strict: true });
    if (overlay !== null && (await deps.manifests.get(overlay.baseManifestId)) !== null) {
      retain(overlay.baseManifestId, 'overlay-base');
    }
  }
  for (const manifestId of deps.indexJobManifestIds) {
    if ((await deps.manifests.get(manifestId)) !== null) retain(manifestId, 'index-job');
  }
  for (const manifestId of await deps.pins.pinnedManifestIds({ strict: true })) {
    if ((await deps.manifests.get(manifestId)) !== null) retain(manifestId, 'pin');
  }

  const allIds = new Set<string>();
  for (const m of await deps.manifests.listAll()) allIds.add(m.manifestId);
  const pruneable = [...allIds].filter((id) => !retainedBy.has(id)).sort();

  const removed: string[] = [];
  if (!deps.dryRun) {
    for (const manifestId of pruneable) {
      if (await deps.manifests.delete(manifestId)) removed.push(manifestId);
    }
  }

  const retained: RetainedRevision[] = [...retainedBy.entries()]
    .map(([manifestId, reasons]) => ({ manifestId, reason: reasons[0] as RevisionRetainReason }))
    .sort((a, b) => (a.manifestId < b.manifestId ? -1 : a.manifestId > b.manifestId ? 1 : 0));
  return { status: 'planned', pruneable, removed, retained };
}
