import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import { planArtifactGc, type GcRootSet } from './artifact-gc.js';
import { assembleGcRoots } from './artifact-gc-roots.js';
import type { ArtifactQuarantineStore, QuarantineTarget } from './artifact-quarantine.js';
import type { CanonicalArtifactStore } from './canonical-artifact-store.js';
import { collectRetainedManifestIds, planRepositoryArtifactGc } from './artifact-key-gc.js';
import { GcLeaseHeartbeat, type GcLeaseStore } from './gc-lease.js';

export interface GcCycleLease {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly ttlMs: number;
  /** Clock used by the lease heartbeat; defaults to the wall clock. */
  readonly clock?: () => Date;
}

/**
 * A fence the caller already holds.
 *
 * Used by a pass that runs inside a wider owner (the maintenance cycle) so it
 * still renews and asserts the *same* record before its only write instead of
 * acquiring a second one — which would self-deny while the record is live. The
 * GC cycle never releases a held fence; the owner that acquired it does.
 */
export interface GcCycleHeldFence {
  readonly store: GcLeaseStore;
  readonly ownerId: string;
  readonly generation: number;
  readonly ttlMs: number;
  /** Grant time; the first renewal falls due half a window later. */
  readonly grantedAt: Date;
  /** Clock used by the lease heartbeat; defaults to the wall clock. */
  readonly clock?: () => Date;
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
  /**
   * A fence this caller already holds (#210 §12). Mutually exclusive with
   * `lease`; supplied when the GC pass runs inside a wider owner such as the
   * maintenance cycle. The pass renews and asserts this record before its
   * write, and never releases it.
   */
  readonly heldFence?: GcCycleHeldFence;
}

export type GcCycleReport =
  | {
    readonly status: 'planned';
    readonly reachable: readonly string[];
    readonly unreachable: readonly string[];
    /**
     * Artifact keys the plan would quarantine. Unlike `quarantinedArtifacts`
     * this is populated in a dry run too, so a read-only caller can see the
     * plan instead of an empty list that looks like nothing to collect.
     */
    readonly unreachableArtifacts: readonly GcCycleArtifactCandidate[];
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
 * already-quarantined from newly-quarantined hashes; `unreachableArtifacts` is
 * the planned artifact-key set in both modes. Read-only aside from the
 * quarantine ledger; deletion stays a separate scheduled step.
 *
 * A non-dry run holds the U28 cleanup lease for the whole cycle (a held
 * or unreadable fence refuses before anything is quarantined) and
 * releases it in a finally, even on refusal. The window is renewed while the
 * cycle is still working, so a long plan cannot let the fence expire and admit
 * a concurrent destructive pass. A caller that already holds the fence passes
 * `heldFence` instead: the same renewal and assert run against that record, and
 * the caller's own finally releases it. Dry runs are read-only and deliberately
 * unfenced.
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
  const heldFence = input.dryRun ? undefined : input.heldFence;
  if (lease !== undefined && heldFence !== undefined) {
    return { status: 'refused', reason: 'gc cycle refuses both a lease and a held fence' };
  }
  let granted: { readonly generation: number; readonly heartbeat: GcLeaseHeartbeat } | undefined;
  let held: GcLeaseHeartbeat | undefined;
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
    granted = {
      generation: acquired.generation,
      heartbeat: new GcLeaseHeartbeat({
        store: lease.store,
        ownerId: lease.ownerId,
        generation: acquired.generation,
        ttlMs: lease.ttlMs,
        grantedAt: input.now,
        ...(lease.clock === undefined ? {} : { clock: lease.clock }),
      }),
    };
  } else if (heldFence !== undefined) {
    // The caller acquired this record; reuse it so a long plan still renews
    // and a moved generation still aborts before the quarantine write.
    held = new GcLeaseHeartbeat({
      store: heldFence.store,
      ownerId: heldFence.ownerId,
      generation: heldFence.generation,
      ttlMs: heldFence.ttlMs,
      grantedAt: heldFence.grantedAt,
      ...(heldFence.clock === undefined ? {} : { clock: heldFence.clock }),
    });
  }
  try {
    return await runCycle(stores, input, granted?.heartbeat ?? held);
  } finally {
    if (lease !== undefined && granted !== undefined) {
      await lease.store.release({ ownerId: lease.ownerId, generation: granted.generation });
    }
  }
}

async function runCycle(
  stores: GcCycleStores,
  input: GcCycleInput,
  heartbeat?: GcLeaseHeartbeat,
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
    let retainedManifestIds: string[];
    try {
      retainedManifestIds = await collectRetainedManifestIds({
        refs: stores.refs,
        pins: stores.pins,
        overlays: stores.overlays,
        indexJobManifestIds: input.indexJobManifestIds,
      });
    } catch (error) {
      return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }
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
      // Planning can outlast the acquisition window; renew before the only
      // write this pass makes, and abort if the fence moved to another owner.
      await heartbeat?.assert();
      await stores.quarantine.quarantine(targets, { now: input.now, graceMs: input.graceMs });
    }
  }
  return {
    status: 'planned',
    reachable: plan.reachable,
    unreachable: plan.unreachable,
    unreachableArtifacts,
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
