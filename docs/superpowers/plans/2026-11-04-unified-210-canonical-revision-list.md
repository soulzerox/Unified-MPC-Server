# Unified #210 slice — canonical revision list verb

Issue: soulzerox/Unified-MPC-Server#210 (§7 admin surface, §11 observability)
Depends on: U15 `CanonicalManifestStore`, U7 ref store, pin registry, Goal
overlay store, index job ledger, and the #622/#623 operator verbs.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#623 made the canonical store *inspectable*: `index status` reports the active
refs, the counts and every blocking id. It cannot answer the other half of §7's
admin surface — **what revisions exist at all, and what still holds each of
them**.

That question decides whether a future prune/GC slice may delete a manifest:
`pruneRevisionManifests` already retains by canonical ref, pin reason, overlay
base and index job, but nothing lets an operator *see* those roots before they
are acted on. Merging a prune verb first would make the store's reachability
invisible at exactly the moment it becomes destructive.

The list is read-only, composes only existing stores, and is the smallest next
step in §7 after `index status`.

## What lands

### 1. `packages/workspace/src/canonical-revision-list.ts` (new, deep module)

`canonicalRevisionList({ refs, manifests, pins, overlays, jobs })` returns one
`CanonicalRevisionSummary` per stored manifest:

- the frozen identity (`manifestId`, `revisionId`), the exact Git evidence
  (`commitSha`, `treeOid`), `targetRef`, `entryCount`, `createdAt`;
- `refs` — every ref name still pointing at it;
- `pins` — distinct pin reasons (deduped, sorted);
- `overlayGoalIds` — every Goal overlay whose base manifest is this revision;
- `indexJobOperationIds` — unsettled index jobs still holding it.

Ordering is newest first by `createdAt`, with `manifestId` as a deterministic
tiebreak, so two manifests written in the same millisecond still list stably.

The module counts roots; it makes no reachability decision. Deciding what may be
deleted stays with `pruneRevisionManifests` and the GC path, which re-check
reachability after quarantine.

### 2. `apps/cli/src/commands/index-revision-list.ts` (+ `index revision list`)

- Parses exactly `revision list` plus an optional `--json`; anything else is
  `INVALID_INPUT` → exit 2, matching every other command family.
- Prints one summary line per revision, then `refs` / `pins` / `overlay-bases` /
  `index-jobs` detail lines only when present, so an unreferenced revision is
  visibly bare instead of being described as active.
- Exit `0` for any successful read (including an empty store, which prints
  `revisions 0`), `1` when the service is unavailable or the read throws.

`parseCliArgs` grows the `index revision list|advance` sub-dispatch; the default
dependency resolves the same `<dataPath>/canonical` root as `advance`, `status`
and the WebUI, and asserts storage identity first.

### 3. Docs and guard

`docs/CLI_REFERENCE.md` §9 gains the subsection after `index revision advance`;
`apps/cli/src/docs-examples.test.ts` gains the expectation and a replay
dependency so the documented command line cannot drift from the parser.

## Explicit non-goals

- No `index_revision_pin` / `unpin` / `prune` / `gc` / `repair`. Those mutate or
  delete and need their own safety arguments; this slice only reports the roots
  they will have to respect.
- No artifact or chunk counts per revision (that needs the artifact store index
  and belongs with the GC slice).
- No WebUI projection and no automatic advance seam.

## Verification

1. Unit: empty store, newest-first ordering with a `createdAt` tiebreak, and one
   revision per retention root (ref, two pin reasons deduped, overlay base,
   index job).
2. CLI: parse (`list`, `--json`, wrong verb, unknown flag, duplicate flag),
   format (empty, unreferenced, fully referenced), dispatch (healthy → 0,
   empty → 0, unavailable → 1, thrown → 1) and the docs-example replay guard.
3. Live: run against a store written by `index revision advance` and confirm the
   listed manifest id/commit match what the advance printed.
