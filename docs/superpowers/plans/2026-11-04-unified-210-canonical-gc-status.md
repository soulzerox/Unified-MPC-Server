# Unified #210 slice — GC status surface (`index gc status`)

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune, GC)
Depends on: U21 `ArtifactQuarantineStore`, U28 `GcLeaseStore`, `index gc --dry-run`
(#628), `index gc --apply` (#630), `index gc expire --dry-run` (#629),
`index gc expire --apply` (#631).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

The GC loop is closed but invisible. After `index gc --apply` quarantines rows
and `index gc expire --apply` releases them, an operator still cannot answer the
two questions that decide whether to run either verb: is a destructive pass
already holding the lease, and how many quarantine rows are due right now?
`index status` reports a single `quarantined` count and says nothing about the
lease, and both GC verbs only reveal their state by attempting a pass.

This slice adds one read-only surface, `index gc status`, that answers those
questions without taking the lease, evaluating reachability or writing a row.

## What lands

### 1. `GcLeaseStore.inspect()` (packages/workspace)

`read()` returns `null` for a missing file *and* for a corrupt record, because a
fence must fail closed. A status surface must not blur those: it has to say
"corrupt" out loud. Add a read-only `inspect()` that reuses the existing
internal `readFenced()` and returns a discriminated result:

- `{ status: 'free' }` — no lease file.
- `{ status: 'held', ownerId, generation, acquiredAt, expiresAt }` — not released.
- `{ status: 'released', ownerId, generation, expiresAt, releasedAt }` — the
  last pass released it; the retired record keeps the generation monotonic, so
  it is reported as `released`, never as `free`.
- `{ status: 'corrupt' }` — the file exists but is not a valid record.

Read-only: no acquire, no renew, no release. `readFenced` stays private; the new
method is its public projection, so the lease fence itself is untouched. A read
that fails for any reason other than `ENOENT` still throws — the same
fail-closed rule as `read()`.

### 2. `gcStatus()` projection (packages/workspace/src/gc-status.ts)

One snapshot answering the two questions above, so the CLI layer stays a
formatter and the projection is unit-testable without a terminal:

- `lease`: the `inspect()` result, except that a `held` lease carries
  `expired: now >= expiresAt`. `acquire` grants at exactly that point, so a
  status that said "held" without the flag would claim a fence that would not
  hold. An unreadable deadline is reported as `expired` for the same reason.
- `quarantine`: `total`, `due`, `inGrace`, and every row in both id spaces with
  `quarantinedAt`, `graceMs`, the derived `expiresAt` (ISO, or `null` when the
  row's own time cannot be parsed) and `due`. Due rows sort first, then by
  target key, so the output is stable.
- `status`: `degraded` only when the lease record is corrupt — the next
  `--apply` will refuse on it, so the operator must be told. A due row is a
  normal state and stays `healthy`.

The projection never decides reachability: a due row is "due", never "garbage".
That verdict belongs to `expire --dry-run`, which re-assembles the roots.

### 3. `index gc status [--json]` (apps/cli/src/commands/index-gc-status.ts)

Wraps a new read-only dependency, `indexGcStatus(): Promise<GcStatusReport>`,
built in `createDefaultCliDependencies` over the real `canonical` root. Operator
lines and `--json` mirror `index status`:

```
gc status: healthy
lease free
quarantine 2 (due 1, in-grace 1)
  due 4d1c0a1f8b25 until 2026-11-11T00:00:00.000Z
  in-grace repo:v1:documented file:v1:9b1c4f2e7a60 until 2026-11-11T00:00:00.000Z
```

A held lease prints `lease held by <owner> until <deadline> (generation <n>)`
with `, expired` appended once the deadline has passed; a retired record prints
`lease released by <owner> at <time>`.

- Exit `0` when the lease and ledger are readable, even with due rows.
- Exit `1` when the lease is `corrupt` (the next destructive pass will refuse)
  or a store cannot be read — including an unreadable quarantine ledger, which
  must never print `due 0` in place of an error.
- Exit `2` for a usage error.

### 4. Docs and guard

- `docs/CLI_REFERENCE.md` gains `index gc status` next to the two GC verbs, with
  the lease states, the due/in-grace split, and the exit codes.
- The new documented example is replayed by `docs-examples.test.ts` through a
  new `index-gc-status` expectation, which must be declared before the plain
  `index gc` pattern.

## Explicit non-goals

- No reachability plan (that is `index gc expire --dry-run`).
- No lease reaping: an expired lease is reported, and the next `--apply`
  overwrites it through `acquire`, exactly as today.
- No scheduling or janitor loop (#80/#145 own periodic runs).
- No history: the report describes the ledger now, not a timeline.

## Verification

1. Unit: parser (`--json`, duplicates, positional args, sibling verbs),
   formatter for free/held/expired/released/corrupt, empty ledger, due vs
   in-grace split across both id spaces, unreadable deadline, exit codes.
2. Projection: free lease and empty ledger; due/in-grace split across both id
   spaces with stable order; held → expired at the deadline; released reported
   as released; corrupt lease degrades; an unparseable row deadline is never
   due; the call mutates neither the lease nor the ledger.
3. CLI: dispatch with `--json` and operator output, usage exit `2`, unreadable
   lease/ledger exit `1`, corrupt lease exit `1`.
4. Default dependency over real canonical stores: quarantine a row with a past
   and a future deadline, hold a lease, assert the report reads both and the
   lease is still held afterwards.
