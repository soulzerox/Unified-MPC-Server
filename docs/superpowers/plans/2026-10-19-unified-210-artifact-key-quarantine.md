# Unified #210 slice — artifact-key quarantine and delete wiring

Issue: soulzerox/Unified-MPC-Server#210 (§1 durable store, §7 refs/pins/prune/GC, §12 fencing)
Depends on: #395 (`4dbaf13` identity keys), #396 (`552f4c4` artifact store), #397 (`c132d94` artifact-key planner).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#397 can plan artifact-key reachability, but nothing can act on the result:

- the quarantine ledger (`artifact-quarantine.ts`, U21) validates every row as a
  64-hex content hash, so an artifact key cannot even be recorded;
- the destructive pass (`gc-expire.ts`, U23) re-checks reachability with
  `planArtifactGc` (content hashes) and hands its delete callback a bare hash —
  no repository, so it cannot resolve an artifact-store record.

Artifact keys are a second id space: `file:v1:…` / `chunk:v1:…`, and an artifact
is only identified together with its `repositoryId` (the store digests the
repository into the on-disk name for exactly that reason). This slice teaches
the middle and last steps of the flow that id space while leaving the U17/U18
reachability shapes and the U28/U30 fences exactly as they are.

## What lands

`artifact-quarantine.ts` (U21 ledger)

- `QuarantineEntry` becomes a discriminated union:
  - `{ kind: 'content-hash', hash, quarantinedAt, graceMs }` — the original id
    space;
  - `{ kind: 'artifact-key', repositoryId, artifactKey, quarantinedAt, graceMs }`
    — the row carries the owning repository, because the key alone cannot be
    resolved or deleted.
- `QuarantineTarget = string | { kind: 'artifact-key', repositoryId, artifactKey }`
  is what callers ask to quarantine/release; a bare string stays the content-hash
  shorthand, so the U22 cycle's existing call keeps working unchanged and both
  spaces may be mixed in one call. Dedupe, first-write-wins and the deterministic
  on-disk order stay per identity (hash, or repository+key).
- Legacy rows written before this slice (no `kind`) are read back as content-hash
  rows, so existing ledgers keep working with no migration step.
- `releaseDue` returns the released *entries* and hands each entry to
  `isReachable`, so a caller re-checks a key as repository+key rather than a
  string. The "became reachable again stays quarantined" rule is unchanged.
- `quarantineEntryTarget(entry)` exposes the entry-as-target conversion callers
  need to release rows they just handled.

`gc-cycle.ts` (U22 producer)

- `GcCycleStores.artifacts?` and `GcCycleInput.artifactCandidates?`
  (`{ repositoryId, artifactKey }[]`). When supplied, candidates are grouped per
  repository and planned with #397's `planRepositoryArtifactGc`, so the
  reachability evidence stays scoped to that repository.
- A refused artifact plan refuses the whole cycle before anything is mutated —
  the same stance the content-hash plan already takes.
- Both spaces are quarantined under the one existing U28/U30 fence (dry runs stay
  unfenced and mutate nothing). `quarantinedArtifacts` reports what was newly
  quarantined, `quarantined` stays the content-hash list.

`gc-expire.ts` (U23 destructive pass)

- `GcExpireStores.artifacts?` and `GcExpireInput.deleteStoredArtifact?`
  (`(repositoryId, artifactKey) => Promise<void>`). Content-hash rows keep using
  `deleteArtifact(hash)` exactly as before.
- Artifact-key rows are re-checked with `planRepositoryArtifactGc` against
  retained manifest ids from #397's `collectRetainedManifestIds`; a refused
  per-repository plan refuses the whole pass, and rows present without a wired
  artifact store refuse rather than being treated as garbage.
- `expired` / `deleted` / `retained` become `QuarantineTarget[]`: the identities
  of the rows involved in their own id space (bare strings for content hashes —
  unchanged values for every existing caller — descriptors for artifact keys).

Side effect worth naming: `canonicalStatus().quarantinedCount` (U26) counts rows
in the one ledger, so it now counts both id spaces. It stays a ledger size, not
a claim about any artifact's indexed state.

## Explicit non-goals

- No change to `planArtifactGc`, `GcRootSet`, `assembleGcRoots` or the U17
  content-hash reachability semantics; artifact reachability stays in #397's
  planner.
- No new lock, scheduler or second fence: the cycle keeps taking exactly one
  U28/U30 lease and the expire pass keeps its own.
- No default candidate set for the cycle: which repositories and which keys a
  pass may prune stays caller/scheduler policy under #145, exactly as content
  hashes are today.
- No object layout change to the artifact store: `delete(repositoryId, key)`
  already exists from #396 and is what the callback will generally call.

## Gate

`packages/workspace` suite green (new tests authored before implementation),
workspace `pnpm -r build` clean, `tsc` 0, `eslint` clean, PR CI `verify` green.
