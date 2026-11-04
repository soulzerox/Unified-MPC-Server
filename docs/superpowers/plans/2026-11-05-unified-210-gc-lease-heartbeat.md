# Plan — keep the GC lease alive during long destructive passes (#210)

## Problem

`index gc --apply`, `index gc expire --apply` and `index revision prune --apply`
each acquire the single-owner GC lease with a fixed 15-minute TTL
(`GC_LEASE_TTL_MS`) and never renew it. `GcLeaseStore.renew()` existed but had no
production caller. A pass that outlives the window lets the lease expire while
the process is still deleting, so a second operator or worker can acquire the
fence and run a concurrent destructive pass — exactly what the lease prevents.

Source findings: review receipts `630` and `631`
(`apps/cli/src/index.ts:720` and `:1027`).

## Fix

- `GcLeaseHeartbeat` in `packages/workspace/src/gc-lease.ts`.
  - Holds `store`, `ownerId`, `generation`, `ttlMs`, `grantedAt` and an
    injectable `clock` (defaults to the wall clock).
  - `ensure()` renews once half the TTL has elapsed since the grant or the last
    renewal, and returns `false` when the fence is gone (released, replaced by a
    newer generation, or unreadable). No I/O when it is not due.
  - `assert()` throws `GcLeaseLostError` at a destructive boundary.
- Wire it into the three destructive phases:
  - `runGcCycle`: one `assert()` immediately before the quarantine write.
  - `expireGcQuarantine`: `assert()` before each entry delete.
  - `pruneRevisionManifests`: `assert()` before each manifest delete.
- On `false`/throw the pass stops. `release` is fenced on owner and generation,
  so the `finally` cannot clear a successor's record.
- Add optional `clock?: () => Date` to the three lease input types so tests can
  drive the heartbeat deterministically without sleeping.

## Why not a timer

An interval needs teardown and unref handling, and it still races when the event
loop is busy. Ticking at each destructive unit is deterministic, bounded by work
actually performed, and needs no lifecycle.

## Tests

- `gc-lease.test.ts`: no renewal before half the window; renewal extends
  `expiresAt` and restarts the cadence; a stale generation fails closed and
  leaves the successor's record untouched.
- `gc-expire.test.ts`: two due rows, a clock that crosses half the TTL between
  deletes — the second delete runs in the renewed window; and a mid-pass fence
  handover aborts with `GcLeaseLostError`, keeping the unreleased rows as retry
  evidence.
- `revision-prune.test.ts`: a mid-pass fence handover removes exactly one stale
  manifest and aborts before the next.
- Existing pass tests finish inside the first half window, so the heartbeat is
  silent for them.

## Docs

`docs/CLI_REFERENCE.md`: the three `--apply` sections state that the window is
renewed while work continues and that a lost fence stops the pass.

## Out of scope

- Pin-vs-prune snapshot window (#626 finding): still needs a design decision
  (writer fence on pin vs two-phase delete); documented follow-up.
