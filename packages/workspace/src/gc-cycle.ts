import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import { planArtifactGc, type GcRootSet } from './artifact-gc.js';
import { assembleGcRoots } from './artifact-gc-roots.js';
import type { ArtifactQuarantineStore } from './artifact-quarantine.js';

export interface GcCycleInput {
  readonly candidates: readonly string[];
  readonly indexJobManifestIds: readonly string[];
  readonly now: Date;
  readonly graceMs: number;
  readonly dryRun: boolean;
}

export type GcCycleReport =
  | { readonly status: 'planned'; readonly reachable: readonly string[]; readonly unreachable: readonly string[]; readonly quarantined: readonly string[] }
  | { readonly status: 'refused'; readonly reason: string };

export interface GcCycleStores {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly quarantine: ArtifactQuarantineStore;
}

/**
 * GC cycle: assemble roots -> plan -> quarantine (#210 U22).
 *
 * One GC run = `assembleGcRoots` (live refs/pins/overlay bases/index
 * jobs -> GcRootSet), `planArtifactGc` (plan), then `quarantine()`
 * records the unreachable candidates unless dry-run. Reports both the
 * plan and what was quarantined so a caller can distinguish
 * already-quarantined from newly-quarantined hashes. Read-only aside
 * from the quarantine ledger; deletion stays a separate scheduled step.
 */
export async function runGcCycle(
  stores: GcCycleStores,
  input: GcCycleInput,
): Promise<GcCycleReport> {
  let roots: GcRootSet;
  try {
    roots = await assembleGcRoots({
      manifests: stores.manifests,
      refs: stores.refs,
      pins: stores.pins,
      overlays: stores.overlays,
      indexJobManifestIds: input.indexJobManifestIds,
    });
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }
  const plan = planArtifactGc({ roots, candidates: input.candidates });
  if (plan.status !== 'planned') {
    return plan;
  }
  if (!input.dryRun && plan.unreachable.length > 0) {
    await stores.quarantine.quarantine(plan.unreachable, { now: input.now, graceMs: input.graceMs });
  }
  return {
    status: 'planned',
    reachable: plan.reachable,
    unreachable: plan.unreachable,
    quarantined: input.dryRun ? [] : [...plan.unreachable],
  };
}
