import { canonicalManifestId, computeTreeOid } from '@unified-mpc/domain';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';

export interface RevisionVerifyInput {
  readonly repositoryId: string;
  /** Exact pinned manifest id the caller believes is current. */
  readonly manifestId: string;
  /** Expected path -> content hash for the target evidence under check. */
  readonly expectedEntriesByPath: Readonly<Record<string, string>>;
}

export type RevisionVerifyVerdict =
  | { readonly verified: true; readonly manifestId: string; readonly commitSha: string }
  | { readonly verified: false; readonly reason: string; readonly manifestId?: string; readonly path?: string };

/**
 * Verify an exact revision manifest against expected content (#210 U24).
 *
 * The U10 pre-edit gate's `can_proceed` must be rejected when the
 * source-view or target content hash does not match the currently admitted
 * workspace state. This module answers the Thai-RAG side question:
 * "does the pinned manifest still say exactly this for exactly this
 * path, in this repository?" Fails closed on: missing manifest, wrong
 * repository, tampered tree OID, missing path, or content mismatch.
 * Read-only; no writes.
 */
export async function verifyRevisionAgainstManifest(
  manifests: CanonicalManifestStore,
  input: RevisionVerifyInput,
): Promise<RevisionVerifyVerdict> {
  const manifest = await manifests.get(input.manifestId);
  if (manifest === null) {
    return { verified: false, reason: `missing manifest: ${input.manifestId}` };
  }
  if (manifest.repositoryId !== input.repositoryId) {
    return { verified: false, reason: `manifest ${manifest.manifestId} belongs to repository ${manifest.repositoryId}, not ${input.repositoryId}` };
  }
  const recomputed = canonicalManifestId({
    repositoryId: manifest.repositoryId,
    revisionId: manifest.revisionId,
    entries: manifest.entries,
  });
  if (recomputed !== manifest.manifestId) {
    return { verified: false, reason: `manifest ${manifest.manifestId} fails identity check` };
  }
  const treeOid = computeTreeOid(manifest.entries);
  if (treeOid !== manifest.treeOid) {
    return { verified: false, reason: `manifest ${manifest.manifestId} tree mismatch: stored tree does not match entries` };
  }
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry.contentHash.toLowerCase()]));
  for (const [requestPath, expectedHash] of Object.entries(input.expectedEntriesByPath)) {
    const actual = byPath.get(requestPath);
    if (actual === undefined) {
      return { verified: false, reason: `missing path in manifest: ${requestPath}`, manifestId: manifest.manifestId, path: requestPath };
    }
    if (actual !== String(expectedHash).toLowerCase()) {
      return { verified: false, reason: `content mismatch at ${requestPath}: manifest disagrees with expected hash`, manifestId: manifest.manifestId, path: requestPath };
    }
  }
  return { verified: true, manifestId: manifest.manifestId, commitSha: manifest.commitSha };
}
