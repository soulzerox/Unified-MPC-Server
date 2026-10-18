# Unified #210 slice — source/file + chunk/semantic artifact identity contract

Issue: soulzerox/Unified-MPC-Server#210 (§1 identity model, §8 path-is-metadata)
Status: plan-first, implemented red-first in this slice.

## Why this slice now

#210 has landed most of the identity story on main (U1 revision identity,
U2 manifest identity, U5 delta classifier, U6 advancement gate, U7 ref store,
U8 overlay store, U13/U15/U16 pin/manifest/advancement orchestration,
U17–U29 prune/GC reachability machinery, U30 GC fencing, U27 repository
provenance + trust scope). But the freeze-first list from the issue's
reconciliation comment still has a hole:

- "repository_id/trust_scope" — done (U27, `repository-provenance.ts`)
- "exact commit/tree identity" — done (U1, `canonical-revision.ts`)
- "manifest_id" — done (U2, `canonical-manifest.ts`)
- **"source/file artifact IDs" — missing.** No `fileArtifactId`/semantic-artifact
  identity exists in `packages/domain/src/`; the GC/planner layer only sees
  manifest entries (path + content hash).

The Thai-RAG #60 base+overlay consumer is explicitly blocked on this identity
("thai-rag#60 consumes #210 base manifest/evidence identity"). The artifact keys
are the contract that makes "Git tells us which source version is authoritative;
content hashes tell us which immutable artifacts can be reused" implementable.

## Contract being frozen

Motivated from #210 §1 (file artifact identity, semantic/chunk artifact
identity), §8 (path is metadata, not artifact identity), §16 non-goals (no
commit SHA in artifact keys, no global latest-file flag).

### File artifact identity

~~~text
fileArtifactId({ sourceContentSha256, language, sourceKind, representationVersion })
  -> "file:v1:<sha256>"
~~~

- The key binds ONLY: content hash + language + source-kind + representation
  schema version (§1: "content-addressed by source_content_sha256 plus
  language/source-kind contract and representation/schema version").
- Path, `git_blob_oid`, commit/revision provenance are binding records held
  OUTSIDE the key — a rename with identical content derives the same key
  (§8), and committing a file never changes its key (§16).
- Deliberately NOT in the key: repositoryId/room trust boundary. File content
  is content-addressed; cross-repository authorization is enforced by the
  trust boundary at lookup time (U27 `requireSameTrustBoundary`), not by
  baking repo ids into every content key. This keeps "same file exists at
  multiple Git revisions / renamed files" deduplicating inside a boundary
  without forgery outside it.

### Chunk/semantic artifact identity

~~~text
semanticArtifactId({
  trustBoundaryKey, chunkContentSha256, embeddingProfile, dimension,
  normalizationFingerprint, chunkerFingerprint, representationVersion,
})
  -> "chunk:v1:<sha256>"
~~~

- §1 requires the chunk/semantic key to include repository/trust provenance —
  semantic artifacts are only reusable within one trust boundary (frozen U27
  `trustBoundaryKey` is the accepted input; callers derive it from the
  repository identity so the key format stays stable).
- Chunk content hash + embedding profile + dimension + normalization/
  preprocessing fingerprint + chunker fingerprint + representation version go
  into the key; model edits, chunker upgrades or preprocessing changes are
  therefore *visible identity changes*, not silent reuse.
- Reembedding after a model/profile migration derives a different key — that
  is what makes migration-safe reuse provable (§9 full rebuild only when
  identity-migrating).

### Shared derivation rules (consistent with U1/U2 style)

- Digest inputs NUL-joined, prefixed by a domain tag + version term.
- Content hashes must be exact 64-hex (lowercased); all other parts non-empty,
  NUL-free; `dimension` a positive integer.
- Pure functions, no I/O, no clock. Deterministic and stable across processes.

## Implementation

- `packages/domain/src/file-artifact-identity.ts` — `FileArtifactIdentityInput`,
  `FileArtifactBinding` (path + optional gitBlobOid + optional revisionId,
  the record held OUTSIDE the key), `fileArtifactId()`.
- `packages/domain/src/semantic-artifact-identity.ts` —
  `SemanticArtifactIdentityInput`, `semanticArtifactId()`.
- Barrel exports in `packages/domain/src/index.ts`.
- Red-first colocated tests, mirroring the `canonical-manifest.test.ts` shape:
  stability, per-field sensitivity, exact validation rejections, and the two
  money identity properties from §8/§16: rename-with-identical-content keeps
  the same file key; a re-committed file keeps the same file key;
  chunk keys differ across profile/dimension/chunker/boundary changes and are
  unaffected by path.

## Non-goals (this slice)

- No storage: the artifact *store* (durable object table keyed by these ids)
  is the following slice.
- No thai-rag changes: consumption lands in #60's blocked base+overlay slice
  once this contract merges.
- No chunker/embedding fingerprint *computation* — fingerprints arrive as
  explicit data (same discipline as U5's rename-delta note).

## Gate

domain vitest suite green (red-first: new failing tests before implementation),
`tsc --noEmit` clean, `eslint` clean, repo CI `verify` on the PR.
