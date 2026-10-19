import { fileArtifactId } from '@unified-mpc/domain';
import type { CanonicalArtifactStore, StoredFileArtifact } from './canonical-artifact-store.js';
import type { CanonicalManifestStore } from './canonical-manifest-store.js';

/**
 * Caller policy for one manifest path: is it a source artifact, and how does it
 * classify? The content hash is never taken from here — the manifest stays the
 * authority for content (#210 §2); this only says how to represent it.
 */
export interface ArtifactClassification {
  readonly path: string;
  readonly language: string;
  readonly sourceKind: string;
  readonly representationVersion: string;
}

export interface ManifestArtifactRegistrationInput {
  readonly manifests: CanonicalManifestStore;
  readonly store: CanonicalArtifactStore;
  readonly manifestId: string;
  readonly now: Date;
  readonly classifications: readonly ArtifactClassification[];
}

export interface RegisteredManifestArtifact {
  readonly path: string;
  readonly artifactKey: string;
  /**
   * True when the artifact record already existed: reuse, not new indexing
   * (§11 forbids labelling an already-present artifact as newly indexed).
   */
  readonly reused: boolean;
}

export type ManifestArtifactRegistrationReport =
  | {
    readonly status: 'registered';
    readonly manifestId: string;
    readonly repositoryId: string;
    readonly artifacts: readonly RegisteredManifestArtifact[];
    /** Manifest entries the classification policy does not cover. */
    readonly unclassifiedPaths: readonly string[];
    /** Policy rows for paths this manifest does not carry. */
    readonly unknownClassifiedPaths: readonly string[];
  }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Register one manifest's source entries as content-addressed file artifacts (#210 §1/§2/§8).
 *
 * The missing producer of the canonical artifact chain: without it no artifact
 * record ever exists, so every GC pass has an empty candidate set and no reuse
 * is observable. This walks the stored manifest and, per covered path, writes
 * (or re-binds) one `StoredFileArtifact`:
 *
 * - the key is `fileArtifactId` over the *manifest's* content hash plus the
 *   classification's language/source-kind/representation version, so a rename
 *   or a re-commit adds a binding instead of an artifact, and unchanged content
 *   is one artifact with one binding per referencing revision;
 * - the binding records path, manifest id and revision id — provenance that the
 *   frozen identity deliberately excludes.
 *
 * Two-phase and fail-closed: every entry is hashed and validated before any
 * write, so an unknown manifest, an invalid classification or a duplicated path
 * policy refuses the whole registration instead of leaving partial state.
 * Coverage gaps are reported, never dropped silently: `unclassifiedPaths` and
 * `unknownClassifiedPaths` let the caller see what the policy missed.
 *
 * Metadata only. Payload bytes, chunk/embedding artifacts and base/overlay
 * materialization are Thai-RAG-owned (#210 §13); which pass schedules this is
 * #145 policy.
 */
export async function registerManifestArtifacts(
  input: ManifestArtifactRegistrationInput,
): Promise<ManifestArtifactRegistrationReport> {
  const manifest = await input.manifests.get(input.manifestId);
  if (manifest === null) {
    return { status: 'refused', reason: `unknown manifest: ${input.manifestId}` };
  }

  const byPath = new Map<string, ArtifactClassification>();
  for (const classification of input.classifications) {
    if (byPath.has(classification.path)) {
      return { status: 'refused', reason: `duplicate classification for path: ${classification.path}` };
    }
    byPath.set(classification.path, classification);
  }

  const planned: { readonly path: string; readonly artifact: StoredFileArtifact }[] = [];
  const unclassifiedPaths: string[] = [];
  try {
    for (const entry of manifest.entries) {
      const classification = byPath.get(entry.path);
      if (classification === undefined) {
        unclassifiedPaths.push(entry.path);
        continue;
      }
      planned.push({
        path: entry.path,
        artifact: {
          kind: 'file',
          artifactKey: fileArtifactId({
            sourceContentSha256: entry.contentHash,
            language: classification.language,
            sourceKind: classification.sourceKind,
            representationVersion: classification.representationVersion,
          }),
          repositoryId: manifest.repositoryId,
          sourceContentSha256: entry.contentHash.toLowerCase(),
          language: classification.language,
          sourceKind: classification.sourceKind,
          representationVersion: classification.representationVersion,
          bindings: [{ path: entry.path, manifestId: manifest.manifestId, revisionId: manifest.revisionId }],
          createdAt: input.now.toISOString(),
        },
      });
    }
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }

  // Reuse is measured against what existed before this pass, so two identical
  // files inside one manifest do not report themselves as reuse of each other.
  const existedBefore = new Set<string>();
  for (const artifactKey of new Set(planned.map((item) => item.artifact.artifactKey))) {
    if (await input.store.has(manifest.repositoryId, artifactKey)) existedBefore.add(artifactKey);
  }

  for (const item of planned) {
    await input.store.put(item.artifact);
  }

  const classifiedPaths = new Set(planned.map((item) => item.path));
  return {
    status: 'registered',
    manifestId: manifest.manifestId,
    repositoryId: manifest.repositoryId,
    artifacts: planned.map((item) => ({
      path: item.path,
      artifactKey: item.artifact.artifactKey,
      reused: existedBefore.has(item.artifact.artifactKey),
    })),
    unclassifiedPaths,
    unknownClassifiedPaths: [...byPath.keys()].filter((pathValue) => !classifiedPaths.has(pathValue)).sort(),
  };
}
