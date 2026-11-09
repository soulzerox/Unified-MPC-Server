import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import { GcLeaseHeartbeat, type GcLeaseStore } from './gc-lease.js';

export type RevisionRetainReason =
  | 'canonical-ref'
  | 'pin'
  | 'overlay-base'
  | 'index-job'
  | 'provider-generation';

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
  /** Clock used by the lease heartbeat; defaults to the wall clock. */
  readonly clock?: () => Date;
}

export interface RevisionPruneDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  /** Manifests referenced by active/pending index jobs; caller owns that ledger. */
  readonly indexJobManifestIds: readonly string[];
  /**
   * Manifests an active Thai-RAG provider generation was built from (#210
   * bullet 4); caller owns that ledger. Omitted means no provider-generation
   * retention is wired, not that none exists.
   */
  readonly providerGenerationManifestIds?: readonly string[];
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
 * reason (canonical refs, pins, overlay bases, active index jobs, active
 * provider generations) so the decision is auditable. Dry-run plans without
 * deleting; idempotent.
 *
 * With a `lease` supplied the delete pass runs under the U28 single-owner
 * fence: a held or unreadable lease refuses before any planning work, the
 * window is renewed at each delete so a long pass cannot silently lose it, and
 * the lease is released afterwards even when a strict root read throws.
 * The roots are read inside this call, so an apply re-checks refs, pins,
 * overlay bases and manifest rows at execution time rather than trusting an
 * earlier plan; the caller-supplied index-job ledger is a snapshot taken
 * immediately before the pass, not re-read inside the fence. A pin that lands
 * while this pass holds the lease is refused by the pin's own fence, and a pin
 * that lands before the pass takes the lease is visible to the registry
 * snapshot. Apart from the lease's inherited double-grant race, the
 * snapshot/delete window is not open to a new pin. Dry runs are read-only and
 * deliberately never take the lease.
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

  let granted: { readonly generation: number; readonly heartbeat: GcLeaseHeartbeat } | undefined;
  if (lease !== undefined) {
    const now = deps.now ?? new Date();
    const acquired = await lease.store.acquire({
      ownerId: lease.ownerId,
      now,
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
  deps: RevisionPruneDeps,
  heartbeat?: GcLeaseHeartbeat,
): Promise<RevisionPrunePlan> {
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
  for (const manifestId of deps.providerGenerationManifestIds ?? []) {
    if ((await deps.manifests.get(manifestId)) !== null) retain(manifestId, 'provider-generation');
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
      // Renew at each delete when half the window has passed, and stop if the
      // fence moved to a newer generation while this pass was planning.
      await heartbeat?.assert();
      if (await deps.manifests.delete(manifestId)) removed.push(manifestId);
    }
  }

  const retained: RetainedRevision[] = [...retainedBy.entries()]
    .map(([manifestId, reasons]) => ({ manifestId, reason: reasons[0] as RevisionRetainReason }))
    .sort((a, b) => (a.manifestId < b.manifestId ? -1 : a.manifestId > b.manifestId ? 1 : 0));
  return { status: 'planned', pruneable, removed, retained };
}
