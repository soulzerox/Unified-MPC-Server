# Unified #210 slice — strict artifact reads in every GC verdict

Issue: soulzerox/Unified-MPC-Server#210 (§7 reachability, quarantine, GC)
Follow-up: nonblocking review finding on #631 (`artifactKeysReferencedBy` derives
a GC verdict from a tolerant listing).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`logicalSpaceReportFromRoot` (#636/#637) and the GC root assembler already read
refs, pins, overlays, index jobs and the artifact listing strictly: a record
they cannot read refuses the report instead of shrinking it. Two GC inputs were
still tolerant:

- `CanonicalArtifactStore.artifactKeysReferencedBy` iterates `listAll()` without
  `strict`, so an artifact record whose read or parse fails loses its bindings.
  `planArtifactKeyGc` then classifies the key as unreachable, and
  `index gc expire --apply` **deletes the record and releases its row**. Only
  another readable artifact has to keep the referenced set non-empty; otherwise
  the planner refuses for lack of evidence and masks the bug.
- `listRepository` (the default candidate universe of
  `planRepositoryArtifactGc`) is tolerant too, so a corrupt record silently
  leaves the plan instead of refusing it.
- The CLI `index gc` derives its candidate universe from `artifacts.list()`
  without `strict`, so an unreadable store produces an applied plan with an
  undercounted artifact set.

A destructive verdict must never read "I could not read this record" as "no
bindings". The fix is to thread the existing `ReachabilityReadOptions` through
the two projections and make the GC planner and the CLI ask for `strict`.

## What lands

### 1. Strict projections

`CanonicalArtifactStore.listRepository(repositoryId, options?)` and
`artifactKeysReferencedBy(manifestIds, repositoryId?, options?)` accept the
existing `ReachabilityReadOptions`. Defaults stay tolerant for operator
surfaces; a GC caller passes `{ strict: true }`.

### 2. Strict planner

`planRepositoryArtifactGc` reads both the candidate universe and the
reachability evidence with `{ strict: true }`, and maps any read failure to
`{ status: 'refused', reason }`. Its callers (`runGcCycle`, `expireGcQuarantine`)
already treat a refused plan as "delete nothing", so no call-site change is
needed and a corrupt record now blocks the destructive pass.

### 3. Strict CLI candidate universe

`indexGc` lists the artifact store with `{ strict: true }` and returns a
`refused` report when the read fails, matching the documented contract that a GC
plan which cannot read the store exits `1`.

### 4. Docs

`docs/CLI_REFERENCE.md`:

- `index gc` lists an unreadable artifact record among the refusal causes and
  says why a skipped record is dangerous.
- `index gc expire --apply` extends the strict-roots bullet to artifact records.
- The deferred provenance sentence from the #642 review is corrected: an
  unreadable-deadline row can also be carried over from a build that accepted an
  unrepresentable `--grace`, not only from a hand-edited ledger.

## Explicit non-goals

- No new verb and no change to the quarantine format.
- No index or cache: the listing stays a directory scan.
- Tolerant `list()`/`listRepository()` defaults stay for `index status` and
  `index space`, which must still report what they can (the latter already asks
  for strict explicitly).
- The `RevisionPinRegistry` unlocked read-modify-write concurrency finding stays
  its own slice.

## Verification

1. `canonical-artifact-store.test.ts`: with one corrupt record, the tolerant
   projections still return the readable record while both strict projections
   throw naming the file.
2. `artifact-key-gc.test.ts`: a corrupt record that is still referenced by a
   retained manifest refuses both the default and the explicit-candidate plans.
   Before the fix the explicit-candidate plan returns `planned` with the live
   key in `unreachable`.
3. `gc-expire.test.ts`: a quarantined live artifact whose own record is corrupt
   refuses the destructive pass; no delete callback runs and the row stays.
   Before the fix the same fixture deletes the record and releases the row.
4. `apps/cli/src/index.test.ts`: `index gc --apply` against a real store with a
   corrupt artifact record exits `1` with `refused cannot read canonical
   artifact ...` and writes no quarantine row.
5. Targeted vitest, `pnpm typecheck`, ESLint on the changed files, then the full
   merge-readiness profile.
