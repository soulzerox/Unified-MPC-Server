# Unified #210 slice — one quarantine deadline rule

Issue: soulzerox/Unified-MPC-Server#210 (§7 quarantine/grace, §11 observability)
Follow-up: nonblocking review findings on #632 (out-of-range deadline crash,
impossible documented sample) and the same arithmetic in the expire paths.
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`index gc status` promises that a row whose own deadline cannot be read prints
`until unreadable` and is never counted as due. The projection only checked
whether `quarantinedAt` parses, then built the deadline with
`new Date(quarantinedAt + graceMs).toISOString()`. A row whose sum leaves the
range a `Date` can represent therefore throws `RangeError: Invalid time value`
instead of printing the documented line — a corrupt ledger crashes the
read-only status surface.

The same sum is computed independently in three places, with different
tolerance:

- `gc-status.ts` — throws on an out-of-range sum (the reported bug);
- `gc-expire.ts` — treats any finite sum as a real deadline, so a row with a
  large negative `graceMs` is deleted while status calls its deadline
  unreadable;
- `ArtifactQuarantineStore.releaseDue` — same fail-open arithmetic on the
  exported ledger API.

Two readers disagreeing about whether a row has a provable deadline is the
real defect: the destructive pass can delete a row the read-only surface
reports as unreadable. One shared predicate removes the disagreement.

## What lands

### 1. `quarantineDeadline` in `artifact-quarantine.ts`

`quarantineDeadline(entry): number | null` returns the grace deadline in epoch
milliseconds, or `null` when the row's own times cannot be placed on the
timeline: unparseable `quarantinedAt`, non-finite `graceMs`, or a finite sum
outside the `Date` range (±8.64e15 ms). `null` means "no provable deadline",
never "due".

### 2. Callers use the one predicate

- `gc-status.ts`: `expiresAt` is `null` when the predicate is `null`, so the
  formatter prints `until unreadable` and `due` stays false instead of
  throwing.
- `gc-expire.ts`: a `null` deadline is retained, so the destructive pass can
  never delete a row status calls unreadable.
- `ArtifactQuarantineStore.releaseDue`: same rule, so the exported ledger API
  cannot drift from the CLI surfaces.

### 3. Docs

`docs/CLI_REFERENCE.md` §9 `index gc status`: the sample is corrected so a
`due` row has an earlier deadline than the `in-grace` row (the old sample gave
both rows the same deadline, which no single snapshot can produce), and the
deadline paragraph states that an out-of-range deadline is `until unreadable`
too.

## Explicit non-goals

- No change to the quarantine ledger format, grace policy or the lease.
- No repair of a row with an unreadable deadline: it stays in the ledger for an
  operator, exactly like a row that became reachable again.
- No new verb; `index verify` / `index repair` remain their own slices.

## Verification

1. `gc-status.test.ts`: a parseable `quarantinedAt` whose `graceMs` sum leaves
   the `Date` range projects `expiresAt: null` and `due: false` instead of
   throwing.
2. `gc-expire.test.ts`: an out-of-range deadline in the numerical past is
   retained (no delete callback, row stays in the ledger) while a normal due
   row in the same pass still deletes — proving the fix does not disable
   expiry.
3. `artifact-quarantine.test.ts`: `releaseDue` retains the same row.
4. Targeted vitest for the three files, `pnpm typecheck`, ESLint on the changed
   files, then the full merge-readiness profile.
