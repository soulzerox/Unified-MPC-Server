# Unified #210 slice — quarantine expiry apply (`index gc expire --apply`)

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune, GC)
Depends on: U23 `expireGcQuarantine`, U21 `ArtifactQuarantineStore`, U28
`GcLeaseStore`, and the operator verbs #623–#630 (`status`, `revision list`,
`pin|unpin`, `prune`, `gc --dry-run`, `gc --apply`, `gc expire --dry-run`).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#629 exposed the expire plan and #630 made quarantine actionable, but the
delete step still had no caller: `expireGcQuarantine` could release rows and
call the delete callbacks only from a unit test. An operator could quarantine
an artifact and see it become due, then had no way to finish the flow. This
slice closes the #210 deletion loop.

## What lands

### 1. `apps/cli/src/commands/index-gc-expire.ts`

- Parser accepts exactly one of `--dry-run` / `--apply`; neither is defaulted,
  because this is the destructive step. Both, duplicates, unknown flags and
  positional arguments are `INVALID_INPUT` (exit `2`). `--grace` is rejected:
  each ledger row already carries its own deadline.
- Formatter is told the mode: a plan prints `planned (dry-run) expired <n>
  retained <n>`; an apply pass prints `applied due <n> released <n> retained
  <n>` and lists the rows it **released** (not the due candidates), so a
  released row is never mistaken for a planned one.

### 2. CLI wiring (`apps/cli/src/index.ts`)

- `CliDependencies.indexGcExpire({ dryRun })`; the dispatcher passes the mode to
  the formatter.
- Only `--apply` constructs the U28 lease (same owner/TTL as `gc --apply`) and
  the delete callback:
  - `deleteStoredArtifact` calls `CanonicalArtifactStore.delete` — that record is
    the store's physical artifact. `delete` fails closed: it returns `false` only
    for an already-missing record and throws for every other failure, and it
    removes the record by path so a corrupt or unreadable file is still
    deletable. The CLI wraps the throw with the artifact key and repository and
    keeps the underlying cause.
  - no callback for content hashes, deliberately: the canonical store keeps no
    content-addressed bytes, so those rows are Git-owned content and releasing
    the ledger entry is the only deletion that exists. This answers the open
    policy question recorded on #628/#630.
- Help gains the apply line.

### 3. Fail-closed reachability roots (`packages/workspace`)

The destructive pass derives its only garbage verdict from the refs, pins,
overlays and index-job ledger. Those readers used to swallow read/parse errors
and return a smaller set, which a *listing* may do but a *delete plan* may not:
one unreadable ref/pin/overlay/ledger file would silently drop a live root and
make its artifacts look unreachable.

- `CanonicalRefStore.list`, `RevisionPinRegistry.pinnedManifestIds`,
  `GoalOverlayStore.listIds`/`read` and `IndexJobLedger.liveManifestIds` accept
  `{ strict: true }` (`ReachabilityReadOptions`). Strict mode still treats a
  missing file/directory as the legitimately empty case, and refuses on any
  other failure or on a malformed record.
- `assembleGcRoots`, `collectRetainedManifestIds` and `pruneRevisionManifests`
  read strictly, because all three can end in a deletion. A thrown strict read
  becomes `refused <reason>` (expire) or an error exit (prune), never a
  partial plan.
- Operator surfaces (`index status`) keep the tolerant readers, so they still
  report what they can.

### 4. Docs and guard

- `docs/CLI_REFERENCE.md` §9 gains the apply subsection with the two id spaces'
  deletion semantics, the lease refusal, retained-row behavior and exit codes.
- The documented apply example is replayed by `docs-examples.test.ts` through the
  existing expire expectation.

## Explicit non-goals

- No scheduling or janitor loop (#80/#145 own periodic runs).
- No content-addressed blob deletion; no such storage exists in this store.
- No repair of a partially failing delete: a failed record delete throws, the
  dispatcher reports it with the underlying cause, the ledger row survives and
  the lease is released in the `finally`. Re-running is safe because an
  already-missing record is a no-op and released rows are gone.
- No ledger reset: an unreadable quarantine ledger (`EACCES`, corrupt JSON, or a
  non-array document) now throws instead of reading as an empty ledger, so a
  later quarantine cannot overwrite evidence and a GC pass cannot report
  `due 0` while rows are still on disk. Malformed individual rows keep the
  original drop-on-read tolerance.
- No lease renewal; the same TTL ceiling noted on #630 applies.
- No tolerant reachability: `assembleGcRoots`, `collectRetainedManifestIds` and
  `pruneRevisionManifests` now read refs, pins, overlays and the index-job
  ledger in strict mode (`ReachabilityReadOptions`), so one unreadable root file
  refuses the pass instead of silently dropping that root and making live
  artifacts look unreachable. Operator surfaces keep the tolerant listing.
- No silent skip of a due artifact-key row: if the record delete callback is not
  wired the destructive pass refuses up front instead of releasing the ledger
  row and reporting it as deleted.
- No fabricated status counts: an unreadable quarantine ledger makes
  `index status` exit `1` with the error rather than print `quarantined 0`.

## Verification

1. Unit: mode exclusivity, duplicate/unknown/postional/`--grace` rejection,
   dry-run vs apply formatting, empty apply, refusal text, exit codes.
2. CLI: dispatch of both modes with the parsed `dryRun`, apply output lines,
   usage exit `2`, unavailable exit `1`, thrown exit `1`, docs replay guard.
3. Default dependency over real canonical stores: a due artifact-key row deletes
   its record, a due content-hash row is released from the ledger without a
   callback, a still-referenced artifact survives, and the lease is released.
