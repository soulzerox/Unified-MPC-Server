# Unified #210 slice — artifact-key reachability planner for GC

Issue: soulzerox/Unified-MPC-Server#210 (§7 refs/pins/prune/GC, §12 fencing)
Depends on: #395 (`4dbaf13` identity keys), #396 (`552f4c4` artifact store).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#396 added the artifact store and its reachability projection
(`artifactKeysReferencedBy`), but nothing turns live retained state into an
artifact-key GC plan. Today's U17/U18/U22/U23 chain plans *content hashes*:

~~~text
retained manifests -> GcRootSet(entries) -> planArtifactGc -> quarantine(64-hex) -> expire
~~~

Artifact keys (`file:v1:…`, `chunk:v1:…`) are a different id space, so the
chain cannot express them. This slice supplies the missing planning half:

~~~text
retained manifests (refs/pins/overlay bases/index jobs)
  -> retained manifest ids
  -> artifact store bindings
  -> plan over artifact keys
~~~

## What lands

`packages/workspace/src/artifact-key-gc.ts`:

- `planArtifactKeyGc({ retainedManifestIds, referencedKeys, candidates })` —
  pure split of candidates into reachable/unreachable by the referenced-key
  set, sorted, case-normalized. Fail-closed in the two shapes that mirror U17's
  zero-roots refusal:
  - no retained manifests supplied → refuse (an empty root set would mark
    every artifact unreachable);
  - candidates supplied but no reachability evidence at all → refuse (a
    silently empty referenced set is the same destructive mistake one step
    later).
- `collectRetainedManifestIds(deps)` — folds live `refs.list()` states, pinned
  manifest ids, Goal overlay bases and caller-supplied index-job manifest ids
  into the sorted unique id set the planner needs. This is the id-level
  counterpart of U18's entry-level assembler; callers that need the
  missing-manifest fail-closed guarantee still run `assembleGcRoots`.
- `planRepositoryArtifactGc({ store, repositoryId, retainedManifestIds,
  candidates? })` — store-backed convenience: candidates default to every
  artifact registered in that repository; referenced keys come from the store.
- `artifactKeysReferencedBy` gains an optional `repositoryId` filter in the
  store (additive): the same key may exist in two trust boundaries, and a
  credential in one boundary must not make the other boundary's copy look
  reachable.

## Explicit non-goals

- No quarantine-ledger or delete-pass change. The ledger validates entries as
  64-hex content hashes; teaching it artifact keys (schema/migration, plus a
  delete callback that needs the owning repository) is the next slice and
  deserves its own design, not a quiet widening here.
- No `planArtifactGc` change: U17's root-set shape and zero-roots refusal stay
  exactly as frozen.
- No scheduler wiring: which retained manifests participate and when a pass
  runs stays Unified policy under #145.

## Gate

`packages/workspace` suite green (new tests authored before implementation),
workspace `pnpm -r build` clean, `tsc` 0, `eslint` clean, PR CI `verify` green.
