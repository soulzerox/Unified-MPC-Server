# Unified #210 slice — canonical store status verb

Issue: soulzerox/Unified-MPC-Server#210 (§7 admin capabilities, §11 observability)
Depends on: U26 `canonicalStatus` projection, U19 `verifyCanonicalStore`,
canonical ref/manifest/pin/overlay/quarantine/job stores.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#622 gave the canonical chain its first producer (`index revision advance`).
The store can now hold refs, manifests and artifacts in production, but nothing
can answer **what is in it** or whether it is consistent: `canonicalStatus`
(U26) and `verifyCanonicalStore` (U19) are fully tested and have no caller
outside tests.

That gap matters before any automatic advance is wired: an operator who cannot
see the active pointer, the dangling refs, the missing overlay bases or the
orphaned pins cannot tell a healthy store from a silently broken one, and a
reviewer cannot verify what a promotion actually wrote.

The status verb is read-only, composes only existing modules, and is the
smallest next step in §7's admin surface.

## What lands

### 1. `apps/cli/src/commands/index-status.ts`

`unified-mpc index status [--json]`

- Parses exactly `status` plus an optional `--json`; anything else is
  `INVALID_INPUT` → exit 2, matching every other command family.
- Formats one evidence-shaped report: health verdict, every active ref with its
  manifest id and commit, store counts (manifests, pins, overlays, quarantined
  rows, unsettled index jobs), and every blocking id (dangling refs, missing
  overlay bases, orphaned pins). Counts are always printed; offending ids are
  printed only when present, so a clean store is one short block.
- Exit `0` only when the verdict is `healthy`; `1` for `degraded`. A degraded
  store is a real answer, not an error, so it prints the report and exits 1.

### 2. CLI dispatch

`apps/cli/src/index.ts` grows an `index` sub-dispatch (`status` | `revision`)
and a `canonicalStatus` dependency. The default implementation constructs the
same root-based stores the advance verb uses at `<dataPath>/canonical` and
asserts storage identity first, so a drifted data path cannot report a fresh
empty store as healthy.

### 3. Docs and guard

`docs/CLI_REFERENCE.md` §9 gains the `index status` subsection with a real
output block; `apps/cli/src/docs-examples.test.ts` gains the expectation and a
replay dependency so the documented line cannot drift from the parser.

## Explicit non-goals

- No `index_revision_list` / `pin` / `unpin` / `prune` / `gc` / `repair` verbs.
  Those mutate or delete and need their own safety arguments.
- No automatic post-merge advance. The seam decision (guarded-merge tail vs.
  reconciliation poller) is unchanged by this read-only slice.
- No WebUI projection; this is the CLI admin surface only.

## Verification

1. Unit: parse (status, `--json`, duplicate/unknown flags), format (healthy,
   degraded with dangling ref / missing overlay / orphaned pin), exit codes.
2. Dispatch: missing service → 1; healthy → 0; degraded → 1; thrown error → 1.
3. Docs guard: the documented line parses to `index-status` and dispatches
   `canonicalStatus` exactly once.
4. Smoke: `index status` against the store written by `index revision advance`
   reports `healthy`, one ref, and the same manifest id the advance printed.
