# Unified #210 slice — manifest → file-artifact registration

Issue: soulzerox/Unified-MPC-Server#210 (§1 file artifact identity, §2 current-file invariant, §6 one canonical store, §8 path is metadata, §11 observability, §13 ownership)
Depends on: #395 (`4dbaf13` identity keys), #396 (`552f4c4` store), #397 (`c132d94` planner), #398 (`e1a0f5c` quarantine/expire).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The canonical artifact chain is complete end to end — store, planner, quarantine
ledger, destructive pass — but **nothing ever creates an artifact record in
production**. Only tests write to `CanonicalArtifactStore`, so every GC pass
today has an empty candidate set and no reuse is ever observed:

~~~text
manifest entries (path -> content hash)   <-- exists (U15 store)
  -> ???                                      <-- missing: this slice
file artifact record + binding(path, revision, manifest)
  -> planner / quarantine / expire            <-- exists (#397, #398)
~~~

#210 §13 keeps payload execution on the Thai-RAG side (chunk/semantic artifact
execution, embeddings, base/overlay materialization), and §16 forbids one full
index copy per commit. What Unified owns and is missing is the metadata step:
turn one manifest's entries into content-addressed file artifacts with provenance
bindings, so the same content in many revisions is one artifact with many
bindings.

## What lands

`packages/workspace/src/manifest-artifact-registration.ts`

- `registerManifestArtifacts({ manifests, store, manifestId, now, classifications })`
  walks the stored manifest's entries and, for every entry the caller's
  `classifications` policy covers, writes (or re-binds) one
  `StoredFileArtifact`:
  - the artifact key comes from `fileArtifactId` over **the manifest's** content
    hash plus the classification's `language` / `sourceKind` /
    `representationVersion`, never from a caller-asserted hash — the manifest
    stays the authority for content (§2);
  - the binding records `path`, `manifestId` and the manifest's `revisionId`, so
    a rename or a re-commit adds a binding instead of an artifact (§8).
- Registration is two-phase: every record is validated and hashed first, and a
  refusal (unknown manifest, invalid classification, duplicate classification
  for one path) leaves the store untouched. No partial writes.
- The report distinguishes `newlyRegistered` from `reused` per artifact, because
  §11 forbids labelling an already-present artifact as newly indexed, and it
  reports `unclassifiedPaths` (manifest entries the policy does not cover) and
  `unknownClassifiedPaths` (policy rows for paths this manifest does not carry)
  rather than silently dropping either side.
- Path is metadata: two paths with identical content and classification resolve
  to one artifact key with two bindings; a classification change (language,
  source kind, representation version) is a different artifact, exactly as the
  frozen identity says.

## Explicit non-goals

- **No payload bytes.** File payload materialization, chunk/embedding artifacts,
  semantic execution and base/overlay materialization are Thai-RAG-owned
  (#210 §13) and stay out; this slice registers metadata only.
- No classification *policy* is invented here: which paths are artifacts and how
  they classify is caller input (today's index-job path is #145 scheduling).
- No producer wiring into `runGcCycle` / index jobs: the cycle already takes
  artifact candidates, and who schedules the registration pass is #145 policy.
- No change to the frozen identity helpers, the stores, the planner or the
  ledger; `gitBlobOid` stays optional and unset here (a Git blob oid is not
  derivable from a content SHA-256; the caller may add it when it has one).

## Gate

`packages/workspace` suite green (new tests authored before implementation),
workspace `pnpm -r build` clean, `tsc` 0, `eslint` clean, PR CI `verify` green.
