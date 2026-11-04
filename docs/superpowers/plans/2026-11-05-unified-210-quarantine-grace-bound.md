# Unified #210 slice — representable grace windows only

Issue: soulzerox/Unified-MPC-Server#210 (§7 quarantine/grace)
Follow-up: nonblocking review finding on #641 (an unreadable-deadline row is
retained forever, and `index gc --apply --grace` could stamp one).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

#641 made `quarantineDeadline` the one rule for "does this row have a provable
deadline", and made every reader retain a row that does not. That fixed the
crash and the status/expire disagreement, but it left the producer side open:

- `parseGcGrace` accepts any duration whose millisecond count is a safe
  integer, and `ArtifactQuarantineStore.quarantine` only required a positive
  safe integer. A window such as `100000000d` is therefore a *valid* request
  that stamps rows whose `quarantinedAt + graceMs` leaves the range a `Date`
  can represent.
- Those rows are exactly the ones #641 now retains forever: no expire pass can
  ever prove them due, and no CLI verb removes a single ledger row, so the
  unreadable set is monotonic and only a hand-edited ledger can clear it.

A validating writer closes the hole where the state is born; the read side
already handles records corrupted outside the API.

## What lands

### 1. `requireGraceMs(value, now)` in `artifact-quarantine.ts`

The write boundary now checks the window against the caller's own `now`: a
positive safe integer is still required, and `|now + graceMs|` must stay within
the representable range (±8.64e15 ms). An unrepresentable window is refused
before anything is written, so `quarantine()` cannot create a row that
`quarantineDeadline` would report as unreadable forever.

Large but representable windows are still accepted; this is a range check, not
a policy cap.

### 2. Docs

`docs/CLI_REFERENCE.md` §9:

- `index gc --apply` states that an unrepresentable `--grace` is refused rather
  than stamped.
- `index gc expire --apply` states that an unreadable-deadline row never
  becomes due and needs an operator to remove it from
  `quarantine/candidates.json`, and that this state now only comes from a
  ledger edited outside the API.

## Explicit non-goals

- No new verb for releasing a single ledger row. That is an operator-surface
  design decision (whether it needs a lease, an audit row and a dry run) and
  belongs in its own slice.
- No repair of rows already stamped by an older build.
- No change to the default window or to the quarantine format.

## Verification

1. `artifact-quarantine.test.ts`: `Number.MAX_SAFE_INTEGER` is a positive safe
   integer today and is refused after the change with a range reason, the
   ledger stays empty, and a 365-day window is still accepted.
2. Red-first: the new test fails on the pre-fix writer.
3. Targeted vitest for the ledger and both GC surfaces, `pnpm typecheck`,
   ESLint on the changed files, then the full merge-readiness profile.
