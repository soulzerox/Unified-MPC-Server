import {
  canonicalManifestId,
  classifyRevisionDelta,
  computeTreeOid,
  type AdvancementDecision,
  type CanonicalRefState,
  type RevisionDelta,
} from '@unified-mpc/domain';
import type { CanonicalRefStore } from './canonical-ref-store.js';
import { CanonicalManifestStore, type StoredManifest } from './canonical-manifest-store.js';

export interface AdvanceRevisionInput {
  readonly canonicalRef: string;
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly commitSha: string;
  readonly targetEntries: readonly { readonly path: string; readonly contentHash: string }[];
  readonly expectedCurrent: CanonicalRefState | null;
  readonly targetVerified: boolean;
  readonly createdAt: string;
}

export interface AdvanceReuseReport {
  readonly reusedPaths: readonly string[];
  readonly newPaths: readonly string[];
  readonly renamedPaths: readonly string[];
  readonly deletedPaths: readonly string[];
}

export type AdvanceRevisionResult =
  | ({ readonly status: 'promoted' | 'noop'; readonly manifestId: string; readonly decision: AdvancementDecision } & AdvanceReuseReport)
  | { readonly status: 'conflict'; readonly current: CanonicalRefState | null }
  | ({ readonly status: 'rejected'; readonly reason: string } & AdvanceReuseReport);

const EMPTY: AdvanceReuseReport = { reusedPaths: [], newPaths: [], renamedPaths: [], deletedPaths: [] };

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * Canonical Revision Advancement Gate orchestration (#210 U16).
 *
 * Ties U5 classification, U6 tree/gate identity, U7 ref CAS and U15
 * manifest persistence into one merge-advancement step. The resulting
 * reuse report is the evidence that unchanged paths were *reused* rather
 * than re-embedded — the core "3/695 changed files must not rebuild"
 * guarantee.
 *
 * Fail-closed rules: an active ref without a readable base manifest, or a
 * base/target entry whose content hash is unverifiable, is rejected before
 * anything is written. The manifest is persisted before the ref moves, so
 * a reader that follows the ref always finds its manifest; a losing
 * promotion therefore leaves one unreferenced manifest, which is an
 * ordinary GC candidate.
 */
export async function advanceCanonicalRevision(
  manifests: CanonicalManifestStore,
  refs: CanonicalRefStore,
  input: AdvanceRevisionInput,
): Promise<AdvanceRevisionResult> {
  const live = await refs.read(input.canonicalRef);
  const base = live === null ? null : await manifests.get(live.manifestId);
  if (live !== null && base === null) {
    return { status: 'rejected', reason: `active ref ${input.canonicalRef} has no readable base manifest`, ...EMPTY };
  }

  const target = sorted(input.targetEntries.map((entry) => entry.path));
  const delta: readonly RevisionDelta[] = classifyRevisionDelta(base?.entries ?? [], input.targetEntries);
  const report: AdvanceReuseReport = {
    reusedPaths: sorted(delta.filter((d) => d.classification === 'UNCHANGED' || d.classification === 'RENAMED_SAME_CONTENT').map((d) => d.path)),
    newPaths: sorted(delta.filter((d) => d.classification === 'CHANGED' || d.classification === 'ADDED').map((d) => d.path)),
    renamedPaths: sorted(delta.filter((d) => d.classification === 'RENAMED_SAME_CONTENT').map((d) => d.path)),
    deletedPaths: sorted(delta.filter((d) => d.classification === 'DELETED').map((d) => d.path)),
  };
  const unverifiable = delta.filter((d) => d.classification === 'UNVERIFIABLE');
  if (unverifiable.length > 0) {
    return { status: 'rejected', reason: `unverifiable entries: ${sorted(unverifiable.map((d) => d.path)).join(', ')}`, ...report };
  }

  const entries = target.map((p) => input.targetEntries.find((e) => e.path === p)!)
    .map((entry) => ({ path: entry.path, contentHash: entry.contentHash }));
  const manifestId = canonicalManifestId({
    repositoryId: input.repositoryId,
    revisionId: input.revisionId,
    entries,
  });
  const state: CanonicalRefState = {
    commitSha: input.commitSha,
    treeOid: computeTreeOid(entries),
    manifestId,
  };

  if (live !== null && live.manifestId === manifestId) {
    return { status: 'noop', manifestId, decision: { action: 'noop', target: state }, ...report };
  }

  const manifest: StoredManifest = {
    manifestId,
    repositoryId: input.repositoryId,
    revisionId: input.revisionId,
    commitSha: input.commitSha,
    treeOid: state.treeOid,
    targetRef: input.canonicalRef,
    entries,
    createdAt: input.createdAt,
  };
  await manifests.put(manifest);

  const decision = await refs.promote(input.canonicalRef, {
    expectedCurrent: input.expectedCurrent,
    current: live,
    target: state,
    targetVerified: input.targetVerified,
  });
  if (decision.action === 'promote' || decision.action === 'noop') {
    return {
      status: decision.action === 'promote' ? 'promoted' : 'noop',
      manifestId,
      decision,
      ...report,
    };
  }
  if (decision.action === 'conflict') {
    return { status: 'conflict', current: decision.current };
  }
  return { status: 'rejected', reason: 'target not verified', ...report };
}
