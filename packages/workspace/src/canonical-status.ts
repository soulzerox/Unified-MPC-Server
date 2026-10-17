import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import type { ArtifactQuarantineStore } from './artifact-quarantine.js';
import type { IndexJobLedger } from './index-job-ledger.js';
import { verifyCanonicalStore } from './canonical-store-verify.js';

export interface CanonicalStatusDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly quarantine: ArtifactQuarantineStore;
  readonly jobs: IndexJobLedger;
}

export interface CanonicalRefPointer {
  readonly ref: string;
  readonly manifestId: string;
  readonly commitSha: string;
}

export interface CanonicalStatusReport {
  readonly status: 'healthy' | 'degraded';
  readonly refs: readonly CanonicalRefPointer[];
  readonly manifestCount: number;
  readonly pinCount: number;
  readonly overlayCount: number;
  readonly quarantinedCount: number;
  readonly activeJobCount: number;
  readonly danglingRefs: readonly { readonly ref: string; readonly manifestId: string }[];
  readonly missingOverlayBases: readonly string[];
  readonly orphanedPins: readonly string[];
}

/**
 * Canonical store status projection for WebUI/admin observability (#210 U26, §11).
 *
 * One read-only snapshot answering: what is the active canonical pointer
 * (ref -> manifest/commit), how many manifests/pins/overlays/quarantined
 * rows/unsettled index jobs exist, and what is blocking (dangling refs,
 * missing overlay bases, orphaned pins). Hard health verdicts come from
 * `verifyCanonicalStore` (U19); counting and ledger sizes are separate
 * from that verdict so a degraded store still reports how much of each
 * kind of state exists. No logical/read-path claiming: quarantined rows
 * are counted as quarantined, never as indexed; index jobs are counted as
 * in-flight work, never as embedded chunks.
 */
export async function canonicalStatus(deps: CanonicalStatusDeps): Promise<CanonicalStatusReport> {
  const [refStates, manifests, pinned, overlayIds, quarantined, jobs] = await Promise.all([
    deps.refs.list(),
    deps.manifests.listAll(),
    deps.pins.pinnedManifestIds(),
    deps.overlays.listIds(),
    deps.quarantine.list(),
    deps.jobs.list(),
  ]);
  const verify = await verifyCanonicalStore({
    refs: deps.refs,
    manifests: deps.manifests,
    pins: deps.pins,
    overlays: deps.overlays,
  });
  return {
    status: verify.status,
    refs: [...refStates]
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .map(({ ref, state }) => ({ ref, manifestId: state.manifestId, commitSha: state.commitSha })),
    manifestCount: manifests.length,
    pinCount: pinned.length,
    overlayCount: overlayIds.length,
    quarantinedCount: quarantined.length,
    activeJobCount: jobs.length,
    danglingRefs: [...verify.danglingRefs],
    missingOverlayBases: [...verify.missingOverlays],
    orphanedPins: [...verify.orphanedPins],
  };
}
