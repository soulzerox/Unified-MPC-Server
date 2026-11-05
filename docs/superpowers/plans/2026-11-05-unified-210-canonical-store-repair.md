# Unified #210 slice — `index repair` for orphaned revision pins

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune and GC)
Follow-up: `index verify` / `index repair` are still their own slices; repair is
the first one because the degraded state it removes is already observable.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`verifyCanonicalStore` (U19) reports three degraded states and `index status`
surfaces them, but nothing repairs them. The only supported repair is
`index revision unpin`, and it deliberately removes **only** the operator
`user-pin` reason; a pin written by a system owner (`index-job`, `rollback`,
...) cannot be cleared by the CLI even when its manifest is gone.

An orphan pin protects nothing: the manifest row it names does not exist, so
revision prune cannot retain anything from it and artifact GC cannot reach
anything through it. The store still reports degraded, `index status` exits
`1`, and an operator has no auditable path to clear it.

The other two degraded states are **not** automatically repairable:

- a dangling canonical ref points at a missing manifest — dropping the ref
  would silently discard the evidence of which revision was active; the owning
  advancement gate must re-advance it;
- a Goal overlay whose base manifest is missing still holds the Goal's dirty
  state — deleting the overlay would destroy uncommitted work; Goal admission
  must re-pin the base.

So `index repair` removes exactly one thing and reports the rest.

## What lands

### 1. `repairCanonicalStore` in `packages/workspace`

`packages/workspace/src/canonical-store-repair.ts`:

```ts
repairCanonicalStore({
  refs, manifests, pins, overlays,
  dryRun, lease?, now?,
})
  -> { status: 'planned' | 'applied', orphanPins, danglingRefs, missingOverlayBases }
   | { status: 'refused', reason }
```

- The manifest store is constructed with `strictReads: true` by the CLI, so a
  corrupt manifest read **throws** instead of looking like a missing row.
  Classification of every pin completes before the first mutation, so a corrupt
  manifest aborts the whole pass with nothing removed.
- The plan is built from strict root reads (`refs.list({ strict: true })`,
  `overlays.listIds({ strict: true })` and `read(..., { strict: true })`,
  `pins.pinnedManifestIds({ strict: true })`), matching revision prune: an
  unreadable root must refuse rather than look absent.
- Only pins whose manifest is genuinely missing (`manifests.get()` returned
  `null`) are removed, the row is re-checked immediately before each unpin, and
  **every** reason on that manifest is removed.
- Removing the pin is deliberately not reachability-neutral: artifact-key GC
  treats every pin id as retention evidence and `assembleGcRoots` refuses while
  a pinned manifest is missing, so the repair releases artifacts bound only to
  the missing manifest to the normal grace window and unblocks GC. A regression
  test pins the before/after retention and roots behaviour.
- The workspace function refuses a tolerant manifest store, so strictness is not
  just a CLI wiring convention.
- `--apply` requires the shared GC lease and renews it per removal, exactly like
  revision prune. A pin command takes the same lease, so it normally cannot land
  while the repair holds the fence; the acquire path is read-then-write, so the
  same narrow double-grant window as revision prune applies.
- `--dry-run` never takes the lease and never writes.

### 2. `index repair --dry-run|--apply [--json]`

`apps/cli/src/commands/index-repair.ts` follows the prune parser/formatter/exit
shape: exactly one mode is required, `--json` prints the unprojected report, and
a refused pass prints `refused <reason>`.

Exit code is the post-pass health verdict:

- `0` — the store is healthy after the plan/pass (orphan pins count as repaired,
  and a dry run reports what apply would repair);
- `1` — a refused pass, an unreadable root/store, or degraded state this verb
  will not touch (dangling refs, missing overlay bases).

### 3. Docs and docs replay

`docs/CLI_REFERENCE.md` gains the `index repair` section after revision prune,
and `apps/cli/src/docs-examples.test.ts` gains the expectation so the documented
example cannot silently dispatch elsewhere.

## Explicit non-goals

- No automatic deletion of dangling refs or Goal overlays; both need their
  owning store to re-advance/re-admit, and deleting them would destroy evidence
  or dirty state.
- No artifact deletion in this pass. Reachability does change: artifacts bound
  only to the missing manifest become GC candidates under the normal grace
  window, which is the intended unblock described above.
- No `index verify` verb in this slice; `index status` already reports the same
  verify report.
- No change to the pin registry format or to `index revision unpin`.

## Verification

1. Workspace unit tests: dry run removes nothing and reports the orphan; apply
   removes every reason and leaves healthy state; a corrupt manifest is not
   removed and the pass throws before any mutation; an apply without a lease is
   refused; an unreadable pin record is refused by the strict root read; a
   tolerant manifest store is refused; a manifest re-created after
   classification stays pinned; removing the orphan pin releases artifact
   retention and lets root assembly proceed.
2. CLI boundary tests with real stores: dry run leaves the pin file; apply
   removes it and exits `0`; `--json` prints the unprojected report; a corrupt
   manifest exits `1` with the pin intact; a dangling ref keeps exit `1` after
   the repairable pin is removed.
3. Targeted `vitest`/`tsc`/`eslint`, then the full `verify:local` profile on the
   exact head before the review capsule.
