import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import { assembleGcRoots } from './artifact-gc-roots.js';
import { planArtifactGc } from './artifact-gc.js';
import { pruneRevisionManifests } from './revision-prune.js';

export interface LogicalSpaceDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  /** Manifests referenced by active/pending index jobs; caller owns that ledger. */
  readonly indexJobManifestIds: readonly string[];
  /** Every content hash the artifact store currently holds. */
  readonly artifactCandidates: readonly string[];
  /**
   * Measured bytes per content hash. Omitted or partial maps are honest:
   * byte totals become `null` instead of a fabricated number.
   */
  readonly artifactBytes?: ReadonlyMap<string, number>;
}

export interface LogicalManifestCounts {
  readonly total: number;
  readonly retained: number;
  readonly prunable: number;
  readonly retainedManifestIds: readonly string[];
  readonly prunableManifestIds: readonly string[];
}

export interface LogicalArtifactCounts {
  readonly total: number;
  readonly reachable: number;
  readonly unreferenced: number;
  readonly unreferencedHashes: readonly string[];
  /** True only when every counted artifact has a measured size. */
  readonly bytesMeasurable: boolean;
  readonly reachableBytes: number | null;
  readonly unreferencedBytes: number | null;
}

export type LogicalSpaceReport =
  | {
    readonly status: 'measured';
    readonly manifests: LogicalManifestCounts;
    readonly artifacts: LogicalArtifactCounts;
  }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Logical canonical-space counts (#210 §2, "report logical counts separately
 * from physical SQLite metrics").
 *
 * Composes the existing reachability planners instead of duplicating them:
 * `pruneRevisionManifests` (dry run) classifies retained vs prunable manifests
 * and `assembleGcRoots` + `planArtifactGc` classify reachable vs unreferenced
 * artifacts. Nothing is deleted here, and no physical fact is claimed — DB/WAL/
 * SHM bytes, page/freelist counts and checkpoint status belong to
 * `SqliteDatabase.physicalMetrics` in `@unified-mpc/storage`. Row deletion and
 * revision prune are not compaction, so this report must never imply shrinkage.
 *
 * Fail closed: when reachability roots are absent or a root manifest is missing
 * on disk, the report is `refused` rather than a zero-retention count that
 * would make everything look deletable.
 */
export async function logicalSpaceReport(deps: LogicalSpaceDeps): Promise<LogicalSpaceReport> {
  const prune = await pruneRevisionManifests({ ...deps, dryRun: true });

  let roots;
  try {
    roots = await assembleGcRoots(deps);
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : 'failed to assemble GC roots' };
  }

  const plan = planArtifactGc({ roots, candidates: deps.artifactCandidates });
  if (plan.status === 'refused') return { status: 'refused', reason: plan.reason };

  const reachableSet = new Set(plan.reachable);
  const unreferencedHashes = [...plan.unreachable];
  const all = [...reachableSet, ...unreferencedHashes];

  const bytesFor = (hash: string): number | undefined => deps.artifactBytes?.get(hash);
  const bytesMeasurable = all.length > 0 && all.every((hash) => bytesFor(hash) !== undefined);
  const sumBytes = (hashes: readonly string[]): number | null => {
    if (!bytesMeasurable) return null;
    return hashes.reduce((total, hash) => total + (bytesFor(hash) as number), 0);
  };

  return {
    status: 'measured',
    manifests: {
      total: prune.retained.length + prune.pruneable.length,
      retained: prune.retained.length,
      prunable: prune.pruneable.length,
      retainedManifestIds: prune.retained.map((entry) => entry.manifestId),
      prunableManifestIds: [...prune.pruneable],
    },
    artifacts: {
      total: all.length,
      reachable: reachableSet.size,
      unreferenced: unreferencedHashes.length,
      unreferencedHashes,
      bytesMeasurable,
      reachableBytes: sumBytes(plan.reachable),
      unreferencedBytes: sumBytes(unreferencedHashes),
    },
  };
}
