# Unified #210 slice — repair partial-removal wording

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune and GC)
Follow-up: the nonblocking review finding on #653 (the `RepairedPin` and
`orphanPins` contract comments, and the CLI reference paragraph they mirror,
still said every reason on an orphan pin is removed).
Status: docs/comments-only slice; no behaviour change.

## Why this slice now

#653 made `repairCanonicalStore` re-check the strict manifest row immediately
before every reason removal. A pin can carry several reasons, so the pass can
now stop mid-pin when the row is re-created; the removed reasons are reported
and the remaining reasons stay pinned. The report contract still claimed every
reason was removed because the manifest no longer existed, which contradicts
both the new loop and the test that proves it.

## What lands

- `RepairedPin.reasons` says it carries the reasons actually removed by an
  apply (or that a dry run would attempt).
- `CanonicalStoreRepairReport.orphanPins` says an apply lists only pins from
  which it removed at least one reason (a pin re-created before its first
  removal is omitted), a dry run reports every planned reason, and later
  reasons stay pinned when the row reappears.
- The `repairCanonicalStore` docblock and the `OPERATOR_PIN_REASON` comment say
  every reason is removed **while the row stays missing**, not unconditionally.
- `docs/CLI_REFERENCE.md` says the same in the repair section and in the
  `index revision unpin` cross-reference.

No code, schema, output format or test expectation changes.

## Explicit non-goals

- No change to `repairCanonicalStore` behaviour or the report shape.
- No new CLI output or exit-code semantics.
- No change to the pin registry, GC lease or advancement gate.

## Verification

1. Targeted `canonical-store-repair` tests and the CLI docs-example guard.
2. `tsc --noEmit` and `eslint` for `packages/workspace`.
3. Full `verify:local` on the exact head before the review capsule.
