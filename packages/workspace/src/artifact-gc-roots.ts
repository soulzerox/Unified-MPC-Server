import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import type { GcManifestEntries, GcRootSet } from './artifact-gc.js';

export interface GcRootAssemblerDeps {
  readonly manifests: CanonicalManifestStore;
  readonly refs: CanonicalRefStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  /** Manifests referenced by active/pending index jobs; caller owns that ledger. */
  readonly indexJobManifestIds: readonly string[];
}

async function entriesFor(
  manifests: CanonicalManifestStore,
  manifestId: string,
  missing: string[],
): Promise<GcManifestEntries> {
  const manifest = await manifests.get(manifestId);
  if (manifest === null) {
    missing.push(manifestId);
    return [];
  }
  return manifest.entries.map((entry) => ({ path: entry.path, contentHash: entry.contentHash }));
}

/**
 * Assemble logical GC reachability roots from live store state (#210 U18).
 *
 * Folds the real reachability holders — active canonical refs, explicit
 * pins, Goal overlay bases and caller-supplied index-job manifests — into
 * the `GcRootSet` the U17 planner consumes, so GC policy runs against
 * actual retained state instead of hand-passed roots.
 *
 * Fails closed when any root manifest referenced by the stores is missing
 * on disk: a silently dropped root would make the planner treat artifacts
 * that are still in use as unreachable, which is the destructive failure
 * this path must never allow. Roots themselves are never deleted here.
 */
export async function assembleGcRoots(deps: GcRootAssemblerDeps): Promise<GcRootSet> {
  const missing: string[] = [];

  const canonicalRefManifests: GcManifestEntries[] = [];
  for (const { state } of await deps.refs.list()) {
    canonicalRefManifests.push(await entriesFor(deps.manifests, state.manifestId, missing));
  }

  const pinnedManifests: GcManifestEntries[] = [];
  for (const manifestId of await deps.pins.pinnedManifestIds()) {
    pinnedManifests.push(await entriesFor(deps.manifests, manifestId, missing));
  }

  const goalOverlayBases: GcManifestEntries[] = [];
  for (const goalWorkspaceId of await deps.overlays.listIds()) {
    const overlay = await deps.overlays.read(goalWorkspaceId);
    if (overlay === null) continue;
    goalOverlayBases.push(await entriesFor(deps.manifests, overlay.baseManifestId, missing));
  }

  const indexJobManifests: GcManifestEntries[] = [];
  for (const manifestId of deps.indexJobManifestIds) {
    indexJobManifests.push(await entriesFor(deps.manifests, manifestId, missing));
  }

  if (missing.length > 0) {
    throw new Error(`refusing to assemble GC roots: missing manifests on disk: ${missing.sort().join(', ')}`);
  }

  return { canonicalRefManifests, pinnedManifests, goalOverlayBases, indexJobManifests };
}
