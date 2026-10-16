import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';

export type RevisionRetainReason =
  | 'canonical-ref'
  | 'pin'
  | 'overlay-base'
  | 'index-job';

export interface RevisionPruneDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  /** Manifests referenced by active/pending index jobs; caller owns that ledger. */
  readonly indexJobManifestIds: readonly string[];
  readonly dryRun: boolean;
}

export interface RetainedRevision {
  readonly manifestId: string;
  readonly reason: RevisionRetainReason;
}

export interface RevisionPruneReport {
  readonly status: 'planned';
  readonly pruneable: readonly string[];
  readonly removed: readonly string[];
  readonly retained: readonly RetainedRevision[];
}

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
 */
export async function pruneRevisionManifests(deps: RevisionPruneDeps): Promise<RevisionPruneReport> {
  const retainedBy = new Map<string, RevisionRetainReason[]>();

  const retain = (manifestId: string, reason: RevisionRetainReason): void => {
    const reasons = retainedBy.get(manifestId);
    if (reasons === undefined) retainedBy.set(manifestId, [reason]);
    else if (!reasons.includes(reason)) reasons.push(reason);
  };

  for (const { state } of await deps.refs.list()) {
    if ((await deps.manifests.get(state.manifestId)) !== null) retain(state.manifestId, 'canonical-ref');
  }
  for (const goalWorkspaceId of await deps.overlays.listIds()) {
    const overlay = await deps.overlays.read(goalWorkspaceId);
    if (overlay !== null && (await deps.manifests.get(overlay.baseManifestId)) !== null) {
      retain(overlay.baseManifestId, 'overlay-base');
    }
  }
  for (const manifestId of deps.indexJobManifestIds) {
    if ((await deps.manifests.get(manifestId)) !== null) retain(manifestId, 'index-job');
  }
  for (const manifestId of await deps.pins.pinnedManifestIds()) {
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
