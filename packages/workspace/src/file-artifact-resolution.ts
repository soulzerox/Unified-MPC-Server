import { fileArtifactId } from '@unified-mpc/domain';
import type { CanonicalArtifactStore, StoredFileArtifact } from './canonical-artifact-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';
import type { CanonicalRefStore } from './canonical-ref-store.js';
import type { ArtifactClassification } from './manifest-artifact-registration.js';

export interface FileArtifactResolutionInput {
  readonly refs: CanonicalRefStore;
  readonly manifests: CanonicalManifestStore;
  readonly store: CanonicalArtifactStore;
  readonly repositoryId: string;
  readonly ref: string;
  readonly path: string;
  /**
   * How this path is represented. Without it the content hash is still
   * resolved, but no artifact key can be derived and no reuse is claimed.
   */
  readonly classification?: ArtifactClassification;
}

export type FileArtifactResolution =
  | {
    readonly status: 'resolved';
    readonly repositoryId: string;
    readonly ref: string;
    readonly commitSha: string;
    readonly treeOid: string;
    readonly manifestId: string;
    readonly revisionId: string;
    readonly path: string;
    readonly contentHash: string;
    /** Derived artifact identity; absent only when no classification was supplied. */
    readonly artifactKey?: string;
    /** The stored record, present only when this repository already has it. */
    readonly artifact?: StoredFileArtifact;
    /** True exactly when `artifact` is present — the reuse signal, never silent. */
    readonly registered: boolean;
  }
  | { readonly status: 'ref-not-observed'; readonly repositoryId: string; readonly ref: string; readonly path: string }
  | {
    readonly status: 'manifest-missing';
    readonly repositoryId: string;
    readonly ref: string;
    readonly path: string;
    readonly manifestId: string;
  }
  | {
    readonly status: 'repository-mismatch';
    readonly repositoryId: string;
    readonly ref: string;
    readonly path: string;
    readonly manifestRepositoryId: string;
  }
  | {
    readonly status: 'path-not-in-revision';
    readonly repositoryId: string;
    readonly ref: string;
    readonly path: string;
    readonly commitSha: string;
  }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Resolve the current immutable artifact for one path of an observed ref (#210 §2/§6/§8).
 *
 * The read half of the canonical artifact chain: ref state (U7) -> manifest
 * (U15) -> entry content hash -> `fileArtifactId` -> artifact store record. A
 * consumer uses this to answer "which artifact holds this file's content, and
 * is it already registered?" before claiming a file is current or deciding to
 * reuse rather than rebuild (§11: reused vs newly indexed).
 *
 * Fail-closed, and never answers for the wrong boundary:
 *
 * - an unobserved ref, or a ref whose manifest is not stored (a dangling ref),
 *   reports itself rather than claiming currency;
 * - refs are namespaced by ref path only, so a manifest that belongs to another
 *   repository is reported as a mismatch instead of being answered for the
 *   requested repository — cross-boundary access is never inferred;
 * - the key comes from the *manifest entry's* content hash, so a changed file
 *   resolves to a different key with `registered: false` until it is
 *   registered; a stale artifact of the same path can never be reported as
 *   current.
 *
 * Git tree/blob verification (§2's second half) stays with the advancement gate
 * (U9): this join answers only ref state -> manifest -> artifact.
 */
export async function resolveRefFileArtifact(input: FileArtifactResolutionInput): Promise<FileArtifactResolution> {
  const { repositoryId, ref, path: filePath } = input;

  const state = await input.refs.read(ref);
  if (state === null) {
    return { status: 'ref-not-observed', repositoryId, ref, path: filePath };
  }
  const manifest = await input.manifests.get(state.manifestId);
  if (manifest === null) {
    return { status: 'manifest-missing', repositoryId, ref, path: filePath, manifestId: state.manifestId };
  }
  if (manifest.repositoryId !== repositoryId) {
    return { status: 'repository-mismatch', repositoryId, ref, path: filePath, manifestRepositoryId: manifest.repositoryId };
  }
  const entry = manifest.entries.find((candidate) => candidate.path === filePath);
  if (entry === undefined) {
    return { status: 'path-not-in-revision', repositoryId, ref, path: filePath, commitSha: manifest.commitSha };
  }

  const contentHash = entry.contentHash.toLowerCase();
  const current = {
    status: 'resolved' as const,
    repositoryId,
    ref,
    commitSha: manifest.commitSha,
    treeOid: manifest.treeOid,
    manifestId: manifest.manifestId,
    revisionId: manifest.revisionId,
    path: filePath,
    contentHash,
  };

  const classification = input.classification;
  if (classification === undefined) {
    return { ...current, registered: false };
  }

  let artifactKey: string;
  try {
    artifactKey = fileArtifactId({
      sourceContentSha256: contentHash,
      language: classification.language,
      sourceKind: classification.sourceKind,
      representationVersion: classification.representationVersion,
    });
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }

  const stored = await input.store.get(repositoryId, artifactKey);
  const artifact = stored !== null && stored.kind === 'file' ? stored : undefined;
  return { ...current, artifactKey, registered: artifact !== undefined, ...(artifact === undefined ? {} : { artifact }) };
}
