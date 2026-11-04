import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { IndexJobLedger } from './index-job-ledger.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';

export interface CanonicalRevisionListDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly jobs: IndexJobLedger;
}

/** One stored revision manifest plus every store root that still references it. */
export interface CanonicalRevisionSummary {
  readonly manifestId: string;
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly commitSha: string;
  readonly treeOid: string;
  readonly targetRef: string;
  readonly entryCount: number;
  readonly createdAt: string;
  readonly refs: readonly string[];
  readonly pins: readonly string[];
  readonly overlayGoalIds: readonly string[];
  readonly indexJobOperationIds: readonly string[];
}

export interface CanonicalRevisionListReport {
  readonly revisions: readonly CanonicalRevisionSummary[];
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else if (!existing.includes(value)) existing.push(value);
}

function sorted(map: Map<string, string[]>, key: string): string[] {
  return [...(map.get(key) ?? [])].sort();
}

/**
 * Read-only listing of the stored canonical revision manifests (#210 §7).
 *
 * `canonicalStatus` answers "what is active and is the store consistent"; this
 * answers "what revisions exist and what still holds each of them". Every
 * retention root the prune path respects is reported per manifest — canonical
 * refs, pin reasons, Goal overlay bases and unsettled index jobs — so an
 * operator can see whether a revision is reachable before a future prune or GC
 * slice acts on it. Counting only: no reachability decision is made here.
 *
 * Newest manifest first by `createdAt`, with the manifest id as a deterministic
 * tiebreak so two manifests written in the same millisecond still list in a
 * stable order. A manifest whose file cannot be parsed is not listed; the store
 * skipping it is the same behaviour `listAll()` already has.
 */
export async function canonicalRevisionList(
  deps: CanonicalRevisionListDeps,
): Promise<CanonicalRevisionListReport> {
  const [manifests, refStates, overlayIds, jobs] = await Promise.all([
    deps.manifests.listAll(),
    deps.refs.list(),
    deps.overlays.listIds(),
    deps.jobs.list(),
  ]);

  const refsByManifest = new Map<string, string[]>();
  for (const { ref, state } of refStates) push(refsByManifest, state.manifestId, ref);

  const overlayGoalIdsByManifest = new Map<string, string[]>();
  for (const goalWorkspaceId of overlayIds) {
    const overlay = await deps.overlays.read(goalWorkspaceId);
    if (overlay === null) continue;
    push(overlayGoalIdsByManifest, overlay.baseManifestId, goalWorkspaceId);
  }

  const jobsByManifest = new Map<string, string[]>();
  for (const job of jobs) push(jobsByManifest, job.manifestId, job.operationId);

  const revisions: CanonicalRevisionSummary[] = [];
  for (const manifest of manifests) {
    const pins = await deps.pins.list(manifest.manifestId);
    revisions.push({
      manifestId: manifest.manifestId,
      repositoryId: manifest.repositoryId,
      revisionId: manifest.revisionId,
      commitSha: manifest.commitSha,
      treeOid: manifest.treeOid,
      targetRef: manifest.targetRef,
      entryCount: manifest.entries.length,
      createdAt: manifest.createdAt,
      refs: sorted(refsByManifest, manifest.manifestId),
      pins: [...new Set(pins.map((pin) => pin.reason))].sort(),
      overlayGoalIds: sorted(overlayGoalIdsByManifest, manifest.manifestId),
      indexJobOperationIds: sorted(jobsByManifest, manifest.manifestId),
    });
  }

  revisions.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    return left.manifestId < right.manifestId ? -1 : left.manifestId > right.manifestId ? 1 : 0;
  });
  return { revisions };
}
