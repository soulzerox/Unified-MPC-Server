import type { CanonicalRefStore, CanonicalRefState } from './canonical-ref-store.js';
import type { CanonicalManifestStore, StoredManifest } from './canonical-manifest-store.js';
import type { GoalOverlayStore } from './goal-overlay-store.js';
import { verifyGoalAdmission } from './goal-admission.js';

/**
 * The exact source identity a `code_index` request claims (#210 §13).
 *
 * Field names are the provider's (`source_identity`), not Unified's camelCase:
 * this shape is sent byte-for-byte and validated by the child, so a renamed
 * field would be refused as unknown input rather than silently ignored.
 */
export interface CanonicalSourceIdentity {
  readonly repository_id: string;
  readonly manifest_id: string;
  readonly revision_id: string;
  readonly commit_sha: string;
  readonly tree_oid: string;
  readonly ref: string;
}

/**
 * A resolution, not a bare identity.
 *
 * `absent` means this checkout can never bind a canonical ref: it has no
 * origin (`no_repository`) or its named ref has never been promoted
 * (`no_canonical_ref`). `goal_unadmitted` is the legitimate Goal state where
 * the overlay base no longer matches the live ref (or was never pinned), which
 * must keep indexing instead of failing. Every other condition — a corrupt
 * ref, a dangling manifest, a foreign repository id — throws, because reading
 * those as "never promoted" would silently drop the identity claim.
 */
export type CanonicalSourceResolution =
  | { readonly status: 'bound'; readonly identity: CanonicalSourceIdentity }
  | { readonly status: 'absent'; readonly reason: 'no_repository' | 'no_canonical_ref' }
  | { readonly status: 'goal_unadmitted'; readonly reason: string };

export interface CanonicalSourceStores {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly overlays: GoalOverlayStore;
}

export interface CanonicalSourceResolveInput {
  /** The exact canonical ref this checkout means to bind (never scanned). */
  readonly canonicalRef: string;
  /** Every repository id accepted for this worktree, or null when it has no origin. */
  readonly expectedRepositoryIds: readonly string[] | null;
  /** Present only for a Goal workspace; its id keys the overlay store. */
  readonly goal: { readonly goalWorkspaceId: string } | null;
}

/**
 * Resolve the canonical source identity for one `code_index` request (#210 §13).
 *
 * The caller names the ref explicitly: the store is store-wide and two
 * repositories can share a commit sha, so the resolver never scans refs or
 * picks among them. A missing ref is the ordinary "never promoted" answer; a
 * corrupt ref, a missing manifest row, and a manifest belonging to another
 * repository all refuse.
 */
export async function resolveCanonicalSourceIdentity(
  stores: CanonicalSourceStores,
  input: CanonicalSourceResolveInput,
): Promise<CanonicalSourceResolution> {
  const expected = input.expectedRepositoryIds;
  if (expected === null || expected.length === 0) {
    return { status: 'absent', reason: 'no_repository' };
  }
  // Strict: a corrupt ref must never read as "never promoted" and drop the
  // identity claim for a checkout that has one.
  const ref = await stores.refs.read(input.canonicalRef, { strict: true });
  if (ref === null) return { status: 'absent', reason: 'no_canonical_ref' };
  const manifest = await stores.manifests.get(ref.manifestId);
  if (manifest === null) {
    throw new Error(`canonical ref ${input.canonicalRef} names missing manifest ${ref.manifestId}`);
  }
  assertManifestMatchesRef(input.canonicalRef, ref, manifest);
  if (!expected.includes(manifest.repositoryId)) {
    throw new Error(
      `canonical manifest ${manifest.manifestId} belongs to repository ${manifest.repositoryId}, `
      + `not the workspace repository ${expected.join('|')}`,
    );
  }
  const identity: CanonicalSourceIdentity = {
    repository_id: manifest.repositoryId,
    manifest_id: ref.manifestId,
    revision_id: manifest.revisionId,
    commit_sha: ref.commitSha,
    tree_oid: ref.treeOid,
    ref: input.canonicalRef,
  };
  if (input.goal === null) return { status: 'bound', identity };
  // Read the overlay strictly before admission: `verifyGoalAdmission` reads it
  // tolerantly, so a corrupt overlay would otherwise look like "no overlay"
  // and be reported as an ordinary goal_unadmitted instead of refused.
  await stores.overlays.read(input.goal.goalWorkspaceId, { strict: true });
  const verdict = await verifyGoalAdmission(stores.refs, stores.overlays, {
    goalWorkspaceId: input.goal.goalWorkspaceId,
    canonicalRef: input.canonicalRef,
  });
  if (!verdict.admitted) return { status: 'goal_unadmitted', reason: verdict.reason };
  return { status: 'bound', identity };
}

/**
 * A ref and its manifest are written from one Git advance, so a disagreement
 * is a damaged store. Binding the ref's commit to the manifest's revision
 * metadata would attach an identity the provider cannot reproduce.
 */
function assertManifestMatchesRef(
  canonicalRef: string,
  ref: CanonicalRefState,
  manifest: StoredManifest,
): void {
  if (manifest.commitSha !== ref.commitSha || manifest.treeOid !== ref.treeOid) {
    throw new Error(
      `canonical manifest ${manifest.manifestId} describes ${manifest.commitSha.slice(0, 12)} `
      + `but canonical ref ${canonicalRef} is at ${ref.commitSha.slice(0, 12)}`,
    );
  }
}
