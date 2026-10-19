import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import { planArtifactGc, type GcRootSet } from './artifact-gc.js';
import { assembleGcRoots } from './artifact-gc-roots.js';
import type { ArtifactQuarantineStore, QuarantineTarget } from './artifact-quarantine.js';
import type { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { collectRetainedManifestIds, planRepositoryArtifactGc } from './artifact-key-gc.js';
import type { GcLeaseStore } from './gc-lease.js';

export interface GcCycleLease {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly ttlMs: number;
}

/** One prunable canonical artifact: a key is only resolvable inside its repository. */
export interface GcCycleArtifactCandidate {
  readonly repositoryId: string;
  readonly artifactKey: string;
}

export interface GcCycleInput {
  readonly candidates: readonly string[];
  /**
   * Canonical-artifact candidates (#210 §1/§7). Which repositories and which
   * keys a pass may prune stays caller policy; the cycle only plans them
   * against retained manifests. Requires `stores.artifacts`.
   */
  readonly artifactCandidates?: readonly GcCycleArtifactCandidate[];
  readonly indexJobManifestIds: readonly string[];
  readonly now: Date;
  readonly graceMs: number;
  readonly dryRun: boolean;
  /** Single-owner guard for the quarantine mutation (#210 §12); dry runs take none. */
  readonly lease?: GcCycleLease;
}

export type GcCycleReport =
  | {
    readonly status: 'planned';
    readonly reachable: readonly string[];
    readonly unreachable: readonly string[];
    readonly quarantined: readonly string[];
    readonly quarantinedArtifacts: readonly GcCycleArtifactCandidate[];
  }
  | { readonly status: 'refused'; readonly reason: string };

export interface GcCycleStores {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly quarantine: ArtifactQuarantineStore;
  /** Required as soon as artifact candidates are planned. */
  readonly artifacts?: CanonicalArtifactStore;
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
 *
 * A non-dry run holds the U28 cleanup lease for the whole cycle (a held
 * or unreadable fence refuses before anything is quarantined) and
 * releases it in a finally, even on refusal. Dry runs are read-only and
 * deliberately unfenced.
 *
 * Artifact candidates (optional) are planned in the same pass with the
 * repository-scoped artifact-key planner and quarantined under that one
 * fence: a refused artifact plan refuses the whole cycle before anything
 * is mutated, exactly like a refused content-hash plan.
 */
export async function runGcCycle(
  stores: GcCycleStores,
  input: GcCycleInput,
): Promise<GcCycleReport> {
  const lease = input.dryRun ? undefined : input.lease;
  let granted: number | undefined;
  if (lease !== undefined) {
    const acquired = await lease.store.acquire({ ownerId: lease.ownerId, now: input.now, ttlMs: lease.ttlMs });
    if (acquired.status === 'denied') {
      return {
        status: 'refused',
        reason: acquired.reason === 'held'
          ? `gc lease held by ${acquired.holder} until ${acquired.expiresAt}`
          : 'gc lease fence unreadable: refusing to start a mutating cycle',
      };
    }
    granted = acquired.generation;
  }
  try {
    return await runCycle(stores, input);
  } finally {
    if (lease !== undefined && granted !== undefined) {
      await lease.store.release({ ownerId: lease.ownerId, generation: granted });
    }
  }
}

async function runCycle(stores: GcCycleStores, input: GcCycleInput): Promise<GcCycleReport> {
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

  const artifactCandidates = input.artifactCandidates ?? [];
  const unreachableArtifacts: GcCycleArtifactCandidate[] = [];
  if (artifactCandidates.length > 0) {
    const artifacts = stores.artifacts;
    if (artifacts === undefined) {
      return {
        status: 'refused',
        reason: 'artifact candidates supplied but no artifact store is wired: refusing to plan artifact-key GC',
      };
    }
    const retainedManifestIds = await collectRetainedManifestIds({
      refs: stores.refs,
      pins: stores.pins,
      overlays: stores.overlays,
      indexJobManifestIds: input.indexJobManifestIds,
    });
    for (const [repositoryId, keys] of groupByRepository(artifactCandidates)) {
      const artifactPlan = await planRepositoryArtifactGc({ store: artifacts, repositoryId, retainedManifestIds, candidates: keys });
      if (artifactPlan.status !== 'planned') {
        return { status: 'refused', reason: artifactPlan.reason };
      }
      for (const artifactKey of artifactPlan.unreachable) unreachableArtifacts.push({ repositoryId, artifactKey });
    }
    unreachableArtifacts.sort(compareCandidates);
  }

  if (!input.dryRun) {
    const targets: QuarantineTarget[] = [
      ...plan.unreachable,
      ...unreachableArtifacts.map((artifact): QuarantineTarget => ({ kind: 'artifact-key', ...artifact })),
    ];
    if (targets.length > 0) {
      await stores.quarantine.quarantine(targets, { now: input.now, graceMs: input.graceMs });
    }
  }
  return {
    status: 'planned',
    reachable: plan.reachable,
    unreachable: plan.unreachable,
    quarantined: input.dryRun ? [] : [...plan.unreachable],
    quarantinedArtifacts: input.dryRun ? [] : unreachableArtifacts,
  };
}

function groupByRepository(candidates: readonly GcCycleArtifactCandidate[]): Map<string, string[]> {
  const byRepository = new Map<string, string[]>();
  for (const candidate of candidates) {
    const keys = byRepository.get(candidate.repositoryId);
    if (keys === undefined) byRepository.set(candidate.repositoryId, [candidate.artifactKey]);
    else keys.push(candidate.artifactKey);
  }
  return byRepository;
}

function compareCandidates(a: GcCycleArtifactCandidate, b: GcCycleArtifactCandidate): number {
  if (a.repositoryId !== b.repositoryId) return a.repositoryId < b.repositoryId ? -1 : 1;
  if (a.artifactKey === b.artifactKey) return 0;
  return a.artifactKey < b.artifactKey ? -1 : 1;
}
