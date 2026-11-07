import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import type { RevisionPinRegistry } from './revision-pin-registry.js';
import type { ArtifactQuarantineStore } from './artifact-quarantine.js';
import type { IndexJobLedger, IndexJobStatus } from './index-job-ledger.js';
import { verifyCanonicalStore } from './canonical-store-verify.js';

export interface CanonicalStatusDeps {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly pins: RevisionPinRegistry;
  readonly overlays: GoalOverlayStore;
  readonly quarantine: ArtifactQuarantineStore;
  readonly jobs: IndexJobLedger;
}

/**
 * One active canonical pointer with the identity §11 asks status to keep
 * apart: revision (`commitSha`), tree (`treeOid`), manifest (`manifestId`,
 * creation time and entry count) and the pin roots retaining that manifest.
 *
 * The identity fields are null exactly when `manifestExists` is false: a
 * dangling ref still reports the pointer it names, never a guessed tree.
 */
export interface CanonicalRefPointer {
  readonly ref: string;
  readonly manifestId: string;
  readonly commitSha: string;
  readonly treeOid: string | null;
  readonly manifestCreatedAt: string | null;
  readonly manifestEntryCount: number | null;
  readonly manifestExists: boolean;
  readonly pinned: boolean;
  readonly pinReasons: readonly string[];
}

/**
 * One Goal overlay and its exact pinned base.
 *
 * `baseMatchesLiveRef` is the same commit/tree/manifest equality
 * `verifyGoalAdmission` uses to refuse a drifted Goal. Status reports it but
 * never degrades on it: whether drift must block a long-running Goal is a
 * product decision, not a store-consistency fact.
 */
export interface CanonicalOverlayStatus {
  readonly goalWorkspaceId: string;
  readonly baseManifestId: string;
  readonly baseCommitSha: string;
  readonly baseTreeOid: string;
  readonly baseManifestExists: boolean;
  readonly baseMatchesLiveRef: boolean;
  readonly modifiedCount: number;
  readonly addedCount: number;
  readonly deletedCount: number;
  readonly updatedAt: string;
}

/**
 * One unsettled index job.
 *
 * `manifestExists` is reported because the ledger accepts any well-formed
 * manifest id; a row that roots at a manifest no longer stored pins nothing.
 */
export interface CanonicalJobStatus {
  readonly operationId: string;
  readonly manifestId: string;
  readonly status: IndexJobStatus;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly manifestExists: boolean;
}

export interface CanonicalStatusReport {
  readonly status: 'healthy' | 'degraded';
  readonly refs: readonly CanonicalRefPointer[];
  readonly overlays: readonly CanonicalOverlayStatus[];
  readonly jobs: readonly CanonicalJobStatus[];
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
 * (ref -> manifest/commit/tree), which Goal overlays pin which base and
 * whether that base still matches the live ref, which index jobs are
 * unsettled and whether their manifests survive, and what is blocking
 * (dangling refs, missing overlay bases, orphaned pins). Hard health verdicts
 * come from `verifyCanonicalStore` (U19); counting and ledger sizes are
 * separate from that verdict so a degraded store still reports how much of
 * each kind of state exists.
 *
 * Provider-owned progress is deliberately absent: reused versus newly
 * embedded chunks, renamed paths, failures and incompatibility/rebuild
 * reasons belong to the thai-rag-mcp §13 contract. No logical/read-path
 * claiming either: quarantined rows are counted as quarantined, index jobs
 * as in-flight work, and a drifted overlay base as drifted — never as
 * indexed content or as a store failure.
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

  const manifestById = new Map(manifests.map((manifest) => [manifest.manifestId, manifest]));
  const sortedRefs = [...refStates].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const refStateByRef = new Map(sortedRefs.map(({ ref, state }) => [ref, state]));

  const refs: CanonicalRefPointer[] = [];
  for (const { ref, state } of sortedRefs) {
    const manifest = manifestById.get(state.manifestId);
    const pinRows = await deps.pins.list(state.manifestId);
    refs.push({
      ref,
      manifestId: state.manifestId,
      commitSha: state.commitSha,
      treeOid: manifest?.treeOid ?? null,
      manifestCreatedAt: manifest?.createdAt ?? null,
      manifestEntryCount: manifest?.entries.length ?? null,
      manifestExists: manifest !== undefined,
      pinned: pinRows.length > 0,
      pinReasons: [...new Set(pinRows.map((pin) => pin.reason))].sort(),
    });
  }

  const overlays: CanonicalOverlayStatus[] = [];
  for (const goalWorkspaceId of [...overlayIds].sort()) {
    const overlay = await deps.overlays.read(goalWorkspaceId);
    if (overlay === null) continue;
    const baseManifest = manifestById.get(overlay.baseManifestId);
    const live = baseManifest === undefined ? null : refStateByRef.get(baseManifest.targetRef) ?? null;
    const baseMatchesLiveRef = baseManifest !== undefined
      && live !== null
      && live.commitSha === overlay.baseCommitSha
      && live.treeOid === overlay.baseTreeOid
      && live.manifestId === overlay.baseManifestId;
    overlays.push({
      goalWorkspaceId,
      baseManifestId: overlay.baseManifestId,
      baseCommitSha: overlay.baseCommitSha,
      baseTreeOid: overlay.baseTreeOid,
      baseManifestExists: baseManifest !== undefined,
      baseMatchesLiveRef,
      modifiedCount: overlay.entries.filter((entry) => entry.kind === 'modified').length,
      addedCount: overlay.entries.filter((entry) => entry.kind === 'added').length,
      deletedCount: overlay.entries.filter((entry) => entry.kind === 'deleted').length,
      updatedAt: overlay.updatedAt,
    });
  }

  const jobRows: CanonicalJobStatus[] = jobs.map((job) => ({
    operationId: job.operationId,
    manifestId: job.manifestId,
    status: job.status,
    openedAt: job.openedAt,
    updatedAt: job.updatedAt,
    manifestExists: manifestById.has(job.manifestId),
  }));

  return {
    status: verify.status,
    refs,
    overlays,
    jobs: jobRows,
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
