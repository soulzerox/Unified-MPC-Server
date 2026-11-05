# Unified #210 slice — re-check the manifest before every repair unpin

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune and GC)
Follow-up: the two nonblocking findings on #652 (`index repair` re-checked the
manifest row once per pin instead of once per removal, and the strict `unpin`
call site had no repair-path coverage).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`repairCanonicalStore` classifies every orphan pin before it mutates anything,
then re-checks the manifest row before the reason loop. The CLI reference and
the function contract already promise the row is re-checked **before each
unpin**, because `advanceRevisionFromGit` can re-create a manifest without
taking the repair's GC lease.

The gap is narrow but real: a pin can carry more than one reason. If the
manifest is re-created after the first reason is removed, the current pass keeps
removing the remaining reasons for a manifest that now exists, stripping the
retention evidence the re-created revision needs. The code comment says "never
unpin a row that exists now"; the implementation only proves that once per pin.

The second finding is coverage: the repair tests make the pin record unreadable
before `pinnedManifestIds`/`list`, so removing `{ strict: true }` from the
`unpin` call would leave the suite green. A record that turns unreadable
between classification and removal must refuse, not report "already removed".

## What lands

### 1. Per-removal manifest re-check in `packages/workspace`

`repairCanonicalStore` keeps the classification pass unchanged. In the apply
loop it reads the manifest row before **every** reason removal; when the row
exists it stops removing reasons for that pin and keeps the reasons already
removed in the report. The GC heartbeat assertion stays immediately before each
mutation.

### 2. Strict `unpin` call-site coverage

The repair suite gains two deterministic cases:

- a pin with two reasons whose manifest is re-created during the first removal:
  the pass removes one reason, reports one removal, and leaves the pin with the
  remaining reason (red before the fix);
- a pin record corrupted between classification and removal: the pass rejects
  with `cannot read revision pin`, releases the lease, and does not report a
  repair (coverage pin: deleting `{ strict: true }` from the call site makes it
  fail).

### 3. Contract wording

The `repairCanonicalStore` comment says the manifest row and the pin record are
read strictly again before **each** removal, matching the CLI reference that
already documents that behaviour. No CLI or registry format change.

## Explicit non-goals

- No per-removal advancement-fence acquisition; the GC lease remains the only
  fence this pass takes, and the narrow re-check window stays documented.
- No change to classification ordering, the lease shape, or the pin registry.
- No automatic repair of dangling refs or missing overlay bases.

## Tests

1. Workspace repair suite: the two new cases above, plus the existing
   re-created-before-removal, corrupt-record, non-canonical-name, lease and
   idempotency cases.
2. Targeted `vitest` for `canonical-store-repair`, `tsc --noEmit` and `eslint`
   for `packages/workspace`.
3. Full `verify:local` on the exact head before the review capsule.

## Verification

```sh
corepack pnpm@10.15.0 --filter @unified-mpc/workspace test
corepack pnpm@10.15.0 typecheck
corepack pnpm@10.15.0 lint
corepack pnpm@10.15.0 verify:local
```
