# Unified #210 slice — durable canonical artifact store over the frozen identity keys

Issue: soulzerox/Unified-MPC-Server#210 (§1 identity, §6 one store many revisions,
§7 refs/pins/prune/GC, §16 non-goals)
Depends on: #395 (`4dbaf13`) — frozen `fileArtifactId` / `semanticArtifactId`.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#395 froze the artifact identity keys (`file:v1:<sha256>` / `chunk:v1:<sha256>`)
but nothing *stores* artifacts yet, and GC still talks about `entry.contentHash`
strings with no notion of the artifact keys #60 consumes. The missing producer
piece is a durable, repository-scoped artifact index:

~~~text
manifest (U15) ──references──> artifact binding ──points at──> artifact key
~~~

so a later GC pass can answer "which artifact keys do my reachable manifests
still reference?" without re-deriving identity from scratch.

## What this slice adds

`packages/workspace/src/canonical-artifact-store.ts` — `CanonicalArtifactStore`,
one JSON per (repository, artifact) record under `<root>/artifacts/`, tmp+rename
durable, exactly the U15 discipline (recompute identity on write, refuse drift,
skip corrupt files on read).

### Records

- `StoredFileArtifact` (`kind: 'file'`): the frozen `fileArtifactId` inputs
  (content sha256 + language + source-kind + representation version) plus
  `bindings` — the path / git-blob-oid / revision provenance that §8 keeps
  OUTSIDE the key, each binding optionally naming the `manifestId` that
  references it.
- `StoredSemanticArtifact` (`kind: 'chunk'`): the frozen `semanticArtifactId`
  inputs (trust boundary key + chunk content sha256 + embedding profile +
  dimension + normalization/chunker fingerprints + representation version).
- No payload bytes in this slice: the store indexes identity, provenance and
  references; blob/vector payload storage stays a later slice (and belongs to
  the embedding side of the trust boundary, #60's domain).

### Behavior

- `put(record)` recomputes `fileArtifactId`/`semanticArtifactId` from the
  record's own inputs and refuses any declared key that disagrees — tampered or
  drifted artifacts cannot be stored. Kind/prefix mismatches are refused too.
- Repository isolation is structural, not advisory: the on-disk path binds the
  record to a digest of its `repositoryId`, so the same content registered in
  two trust boundaries is two records and `get(repositoryId, key)` cannot read
  across boundaries. Cross-boundary sharing stays a policy decision made by
  callers via U27's trust-boundary contract — never inferred from a matching
  content hash.
- Re-`put` unions bindings instead of replacing them (rename reuse: many
  bindings, one immutable key) and is idempotent. `addBinding()` appends to an
  existing record and fails closed when the artifact is unknown.
- `artifactKeysReferencedBy(manifestIds)` returns the sorted, unique artifact
  keys whose bindings name any of those manifests — the projection the next GC
  slice consumes so reachability keeps working once artifacts, not raw content
  hashes, are the prunable objects.

### Explicit non-goals

- No GC planner change: `planArtifactGc` (U17) keeps operating on the frozen
  root-set shape. Wiring artifact keys into the destructive passes is the next
  slice, gated on this store existing.
- No manifest schema change: U2's `man:v1` identity is frozen; bindings carry
  the manifest association instead of touching manifest entries.
- No thai-rag change: #60 consumes these keys when its base+overlay slice runs.

## Gate

`packages/workspace` vitest suite green (new tests authored before
implementation), workspace `pnpm -r build` clean, `tsc` 0, `eslint` clean, PR
CI `verify` green.
