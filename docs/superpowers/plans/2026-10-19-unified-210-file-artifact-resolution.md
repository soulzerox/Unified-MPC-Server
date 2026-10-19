# Unified #210 slice — file artifact resolution for a canonical ref

Issue: soulzerox/Unified-MPC-Server#210 (§2 how to know which file is current, §6 one canonical store, §8 path is metadata, §11 observability)
Depends on: #395 (`4dbaf13`), #396 (`552f4c4`), #397 (`c132d94`), #398 (`e1a0f5c`), #399 (`d322299` registration).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#399 gave the chain a producer, so artifacts are registered. The read side is
still missing: nothing answers "for this repository and ref, which immutable
artifact holds this path's content?" — the question every consumer of §2 needs
before it may claim a file is current or decide to reuse rather than rebuild.

~~~text
repositoryId + ref + path
  -> ref state (U7)                 -> commitSha / treeOid / manifestId
  -> manifest (U15)                 -> entry content hash for that path
  -> classification policy          -> expected artifact key
  -> artifact store (#396)          -> registered record, or none
~~~

`resolveGoalLogicalView` (U14) already resolves *content* through
base+overlay-tombstones, but it takes base entries from the caller and knows
nothing about artifacts; the registration writer (#399) only writes. This slice
is the missing join, and it is what makes the reuse signal observable to a
consumer (§11: reused vs newly indexed).

## What lands

`packages/workspace/src/file-artifact-resolution.ts`

- `resolveRefFileArtifact({ refs, manifests, store, repositoryId, ref, path, classification? })`
  returns a discriminated result:
  - `resolved` — `commitSha`, `treeOid`, `manifestId`, `revisionId`, the manifest
    entry's `contentHash`, and, when a classification policy was supplied, the
    derived `artifactKey` plus `artifact` + `registered` from this repository's
    artifact store (`registered: false` is the explicit "must register /
    materialize" signal, not a silent absence);
  - `ref-not-observed`, `manifest-missing` (dangling ref: the ref advanced to a
    manifest that is not stored — fail-closed rather than claiming currency),
    `repository-mismatch` (refs are namespaced by ref path only, so the resolved
    manifest must belong to the requested repository — cross-boundary isolation
    is never inferred), `path-not-in-revision`, `refused` (invalid classification).
- `artifactKey` is derived with `fileArtifactId` over the *manifest entry's*
  content hash plus the classification, so a stale artifact of the same path can
  never be reported as current: changed content yields a different key and
  `registered: false` until it is registered.
- Reuse is proven by key equality, so a rename that the manifest records at a new
  path resolves to the same artifact as its old path (§8), and a record in
  another trust boundary can never satisfy this repository's lookup.

## Explicit non-goals

- **No Git tree/blob verification.** §2 also requires the manifest to match the
  resulting Git tree of the exact commit; that is the advancement gate's
  evidence path (`advance-revision.ts`, U9), not this join. This resolver
  answers only ref state → manifest → artifact.
- No Goal-view variant yet: `resolveGoalLogicalView` output (base+overlay) can
  feed the same key derivation once the pre-edit gate needs it; adding it now
  would be an unused second entry point.
- No consumer/gate wiring in `packages/mcp-server`: the pre-edit readiness gate's
  own slice decides what it records and how it reports.
- No payload bytes, no store/ledger/planner changes, no new persistence.

## Gate

`packages/workspace` suite green (new tests authored before implementation),
workspace `pnpm -r build` clean, `tsc` 0, `eslint` clean, PR CI `verify` green.
