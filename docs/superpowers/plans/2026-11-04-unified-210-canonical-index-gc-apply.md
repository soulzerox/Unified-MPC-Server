# Unified #210 slice — GC apply (`index gc --apply`)

Issue: soulzerox/Unified-MPC-Server#210 (§7 revision refs, pins, prune, GC)
Depends on: U22 `runGcCycle`, U28 `GcLeaseStore`, U21 `ArtifactQuarantineStore`,
and the operator verbs #623–#629 (`status`, `revision list`, `pin|unpin`,
`prune`, `gc --dry-run`, `gc expire --dry-run`).
Status: plan-first, red-first implementation in this slice.

## Why this slice now

`runGcCycle` has supported a mutating pass since U22, but the only CLI mode was
`--dry-run`: an operator could see the plan and never act on it, so the
quarantine ledger the expire verb reads could only be filled by tests. This
slice exposes the first half of the deletion flow — **quarantine** — and keeps
physical deletion (`index gc expire --apply`) for its own slice.

## What lands

### 1. `apps/cli/src/commands/index-gc.ts`

Parser becomes mode-explicit:

- exactly one of `--dry-run` / `--apply` is required; neither is defaulted.
- `--apply` accepts `--grace <n><s|m|h|d>` (default `7d`). Zero, negative,
  fractional and unknown units are `INVALID_INPUT`; `--grace` with `--dry-run`
  is rejected because a plan stamps no deadline.
- duplicate flags, unknown flags and positional arguments stay `INVALID_INPUT`
  (exit `2`).

Formatter is told the mode instead of guessing it from the report: a dry run
prints `planned (dry-run) ...`, an apply pass prints `applied quarantined <n>
artifact-quarantined <n>` plus one line per row it actually wrote. Refusals keep
the `refused <reason>` shape and exit `1`.

### 2. CLI wiring (`apps/cli/src/index.ts`)

- `CliDependencies.indexGc({ dryRun, graceMs })`; the dispatcher passes the
  parsed window and the mode to the formatter.
- The default dependency keeps deriving candidates from registered **file**
  artifacts (chunk artifacts stay Thai-RAG-owned) and reads `liveManifestIds()`
  immediately before the pass.
- Only `--apply` constructs a `GcLeaseStore` lease: owner
  `unified-mpc-cli:<host>:<pid>` (readable in the refusal message), TTL fifteen
  minutes. A held or unreadable lease refuses before anything is written and
  the lease is released in the cycle's `finally`.
- Help gains the apply line.

### 3. Docs and guard

- `docs/CLI_REFERENCE.md` §9 documents both modes, the grace grammar, the lease
  refusal and the exit codes. The expire subsection stays dry-run-only, since
  that verb is unchanged.
- The documented apply example is replayed by `docs-examples.test.ts` through
  the existing `index gc` expectation.

## Explicit non-goals

- No physical deletion. `index gc expire --apply` (ledger release + delete
  callbacks) is the next slice and needs its own callback policy per id space.
- No re-planning loop or retry on a refused lease; an operator re-runs the verb.
- No scheduling. The janitor (#80) and heavy-job scheduling (#145) own periodic
  runs; this is the operator verb.
- No change to content-hash deletion semantics: content hashes are Git's bytes,
  so the expire slice must decide whether a content-hash row releases the ledger
  row only. This slice only records them.

## Verification

1. Unit: mode exclusivity, grace grammar (all units, zero/negative/fractional/
   unknown, duplicate, missing value, `--grace` on dry-run), apply/dry-run
   formatting, refusal text, exit codes.
2. CLI: dispatch of both modes with the parsed `graceMs`, apply output lines,
   usage exit `2`, unavailable exit `1`, thrown exit `1`, the docs replay guard
   over `README.md`, `CLI_REFERENCE.md` and `USAGE_TH.md`, and a default-dependency
   pass over real canonical stores: a held lease refuses with no ledger write,
   the granted pass writes both id spaces with the requested grace and releases
   its lease.
3. Live: `index gc --apply --grace 1s` on a fixture store writes rows with that
   deadline; repeating it keeps the first `quarantinedAt`; a second concurrent
   pass while the lease is held exits `1` with `refused gc lease held by ...`;
   `index gc expire --dry-run` then reports the rows as due.
