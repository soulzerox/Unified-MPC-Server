# Unified #210 slice — refuse GC verbs on an unreadable index-job ledger

Issue: soulzerox/Unified-MPC-Server#210 (§7 reachability, quarantine, GC)
Follow-up: nonblocking review finding on #631 (`index gc expire` documents
`refused <reason>` for an unreadable index-job ledger, but the CLI prints a bare
error).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`IndexJobLedger.liveManifestIds({ strict: true })` fails closed: a corrupt,
unreadable or non-array ledger throws instead of returning an empty set, so a
live job cannot lose its manifest and get it collected. But the CLI reads the
ledger **before** it calls the planner:

```ts
indexJobManifestIds: await jobs.liveManifestIds({ strict: true })
```

That `await` sits in the argument object, outside every `refused` mapping. The
dispatcher catches the throw and prints the bare message on stderr with exit
`1`, while `docs/CLI_REFERENCE.md` promises `refused <reason>` on stdout for the
same state. Three verbs share the pattern:

- `index revision prune` (plan and apply),
- `index gc` (plan and apply),
- `index gc expire` (plan and apply).

The exit code is right but the observable contract is not: an operator sees what
looks like a crash where the documented surface is a considered refusal, and the
JSON mode emits nothing at all instead of a `refused` report. The pass itself is
safe — the throw happens before the lease and before any mutation — so this is a
contract and observability gap, not a data-loss path.

## What lands

### 1. One strict-ledger mapping

A small helper next to `gcLeaseOwnerId()` reads the ledger once and maps any
failure to `{ status: 'refused', reason }`:

```ts
type StrictIndexJobRead =
  | { readonly status: 'read'; readonly manifestIds: readonly string[] }
  | { readonly status: 'refused'; readonly reason: string };
```

All three verbs call it before acquiring the lease and return the refusal
unchanged, so nothing is pruned, quarantined or released.

### 2. Docs match the surface

`docs/CLI_REFERENCE.md`:

- `index gc` lists an unreadable index-job ledger among the refusal causes.
- `index gc expire` lists an artifact record among the refusal causes (the
  deferred docs finding from the #643 review) alongside the index-job ledger.
- `index revision prune` lists an unreadable index-job ledger among the refusal
  causes.

## Explicit non-goals

- No new verb and no change to the ledger format or the refusal exit code.
- No change to dry-run/apply semantics or to the pre-fence snapshot window: the
  ledger is still read immediately before the pass, not inside the planner.
- Delete-callback failures keep their existing plain-error path; they are a
  failed mutation, not an unreadable input.
- The `RevisionPinRegistry` unlocked read-modify-write concurrency finding stays
  its own slice.

## Verification

1. One real-store CLI regression test seeds the shared canonical GC fixture, adds
   a due quarantine row, corrupts `canonical/index-jobs/jobs.json`, then runs
   `index revision prune --apply`, `index gc --apply` and
   `index gc expire --apply`.
2. Every verb must exit `1`, write a `refused <reason>` line naming the index
   job ledger on stdout, write nothing on stderr, and leave the quarantine rows,
   the artifact record and the lease untouched. Before the fix the message lands
   on stderr and stdout/JSON output is empty.
3. Targeted vitest, `pnpm typecheck`, ESLint on the changed files, then the full
   merge-readiness profile.
