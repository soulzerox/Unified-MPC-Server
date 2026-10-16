export interface GcManifestEntry {
  readonly path: string;
  readonly contentHash: string;
}

/** One manifest's entries (the artifact references a revision holds). */
export type GcManifestEntries = readonly GcManifestEntry[];

/**
 * Reachability roots for logical artifact GC (#210 U17).
 *
 * Every retained manifest — active canonical refs, explicit pins, Goal
 * overlay bases, active/pending index jobs — contributes its referenced
 * artifacts as reachable. Callers own policy about *which* manifests are
 * roots; this planner only computes what is still reachable from them.
 */
export interface GcRootSet {
  readonly canonicalRefManifests: readonly GcManifestEntries[];
  readonly pinnedManifests: readonly GcManifestEntries[];
  readonly goalOverlayBases: readonly GcManifestEntries[];
  readonly indexJobManifests: readonly GcManifestEntries[];
}

export type GcPlan =
  | { readonly status: 'planned'; readonly reachable: readonly string[]; readonly unreachable: readonly string[] }
  | { readonly status: 'refused'; readonly reason: string };

function rootCount(roots: GcRootSet): number {
  return roots.canonicalRefManifests.length
    + roots.pinnedManifests.length
    + roots.goalOverlayBases.length
    + roots.indexJobManifests.length;
}

function collect(roots: GcRootSet, into: Set<string>): void {
  for (const group of [
    roots.canonicalRefManifests,
    roots.pinnedManifests,
    roots.goalOverlayBases,
    roots.indexJobManifests,
  ]) {
    for (const manifest of group) {
      for (const entry of manifest) into.add(entry.contentHash.toLowerCase());
    }
  }
}

/**
 * Compute logical GC reachability (#210 U17).
 *
 * Pure: no store access, no deletion. An artifact is retainable if *any*
 * retained root manifest references it, so pruning an old revision can
 * never delete content another revision/Goal/pin still needs. Refuses to
 * plan at all when no roots were supplied — a plan with zero roots would
 * mark everything unreachable, which is exactly the destructive mistake
 * fail-closed policy must prevent. Physical deletion stays with a later
 * quarantine/grace step; this returns candidates only.
 */
export function planArtifactGc(input: {
  readonly roots: GcRootSet;
  readonly candidates: readonly string[];
}): GcPlan {
  if (rootCount(input.roots) === 0) {
    return { status: 'refused', reason: 'no reachability roots supplied; refusing to plan artifact GC' };
  }
  const reachableSet = new Set<string>();
  collect(input.roots, reachableSet);
  const reachable: string[] = [];
  const unreachable: string[] = [];
  for (const candidate of new Set(input.candidates.map((value) => value.toLowerCase()))) {
    (reachableSet.has(candidate) ? reachable : unreachable).push(candidate);
  }
  return { status: 'planned', reachable: reachable.sort(), unreachable: unreachable.sort() };
}
