# Unified #210 slice — operator-triggered maintenance cycle

Issue: soulzerox/Unified-MPC-Server#210 (§3 compaction gate, §5-§7 bounded
maintenance, §12 single-owner fence).

## Why this slice now

`runMaintenanceCycle` landed with the fence, headroom gate and admission lease,
but nothing in the product calls it. The canonical store has every piece of the
safety story and no operator path that runs them together, so the only way to
exercise the cycle is a unit test.

~~~text
packages/workspace/src/maintenance-cycle.ts   runMaintenanceCycle (unused)
  headroom -> compactionGate
  fence    -> GcLeaseStore
  lease    -> ResourceAdmissionController
  work     -> runGcCycle + verifyCanonicalStore
~~~

This slice makes the cycle reachable:

~~~text
unified-mpc index maintenance --dry-run|--apply [--json]
  -> resolve data path, canonical root
  -> database.physicalMetrics()          (PhysicalSpaceEvidence)
  -> statfsSync(dataPath).bavail*bsize   (disk headroom)
  -> runMaintenanceCycle(...)
       -> fence, gate, admission
       -> runCanonicalGc(root, { dryRun })  (no nested lease)
       -> verifyCanonicalStore (strict manifest reads)
  -> exit 0 completed/skipped, 1 refused
~~~

Scope is deliberately operator-triggered. Automatic scheduling stays a
follow-up: nothing here adds a timer, a second lock or a background loop.

## Contract

### 1. One command, one mode

`index maintenance` requires exactly one of `--dry-run` or `--apply`, exactly
like `index gc`. `--json` prints the `MaintenanceCycleReport` unchanged.

`--apply` uses the documented default quarantine window
(`DEFAULT_GC_GRACE_MS`, 7 days). There is no `--grace` here: the maintenance
cycle is one bounded pass, not a per-verb tuning surface, and adding a flag the
cycle does not thread would silently do nothing.

### 2. Dry run is a real plan under the real fence

`--dry-run` still resolves the data path, measures the database and takes the
single-owner fence plus the admission lease, because the cycle's *safety
decision* must be the same one an apply would take. It then runs
`runGcCycle` in plan mode (no quarantine row is written) and verifies the store
read-only. Only the fence record is written and immediately released, exactly
as `index gc --apply` already does.

`physicalMetrics()` keeps its default `passive` checkpoint: it is bounded and
non-blocking, and its `busy` flag is the only cross-process reader signal a
one-shot CLI can observe. `activeReaderCount` is `0` because this process holds
no long-lived reader of its own; the gate's `reader-pressure` skip must come
from a real blocked checkpoint, not from a fabricated count.

### 3. The cycle owns the fence, so GC must not take it twice

The GC closure reuses the extracted `runCanonicalGc` helper with **no** lease.
`runMaintenanceCycle` already holds the `GcLeaseStore` fence for the whole
cycle; asking `runGcCycle` to acquire the same fence again would self-deny
(the record is live until the cycle's `finally`). The helper keeps its own
`lease` option for the standalone `index gc` verb, which does own its fence.

Review fix: "no lease" is not enough. `runGcCycle` renews the fence at its own
destructive boundary, and with no lease it had no heartbeat, so a pass that
outlived the 15-minute window could let another process acquire the expired
record and mutate concurrently — the defect #646 fixed for the other
destructive passes. The cycle now hands its live fence to the GC pass
(`GcCycleInput.heldFence`, produced from `MaintenanceCycleFence`). With a held
fence the pass renews and asserts that exact record before its only write, and
never acquires or releases it: the cycle still owns the grant and its
`finally`. Supplying both `lease` and `heldFence` is refused outright.

### 4. Refusal vocabulary is the cycle's

The command prints the cycle report, not a re-derived verdict:

- `completed (dry-run|applied) verification healthy manifests <n>` plus the
  existing `formatIndexGc` lines;
- `skipped below-threshold|reader-pressure`;
- `refused headroom-unknown|headroom-insufficient|fence-acquire-failed|
  admission-rejected|gc-refused|verify-degraded`.

Exit codes: `completed`/`skipped` → 0, `refused` → 1. A skip is a successful
"nothing to do", a refusal is a blocking condition for the store.

The cycle is pressure-gated on purpose: when the freelist is below the
compaction threshold the command reports `skipped below-threshold` and GC does
not run. `index gc --apply` stays the unconditional GC verb; `index
maintenance` is the bounded all-in-one pass the gate admits.

### 5. Where the module lives

Thai-RAG pre-edit evidence for a nonexistent path is `code_index_missing`, and
that state is not demandable (`pre-edit-demand.ts` only refreshes
`missing`/`stale` evidence and missing/stale/degraded channels). A new module
therefore cannot be authorized by the harness gate at all, while an existing
one can. The command parser, formatter and exit code live in
`apps/cli/src/commands/index-gc.ts` next to the GC plan renderer they reuse, and
their unit tests live in `index-gc.test.ts`. This is a harness constraint, not
a preference: the same code in a new file is refused before the first write.

## Tests

- Parser: any-position mode flags, JSON, exactly one mode, no `--grace`,
  duplicates/unknown/positional rejected, non-`maintenance` verbs rejected.
- Formatter: completed dry-run and applied (with GC rows), skipped, refused.
- Exit codes: refused 1, skipped/completed 0.
- CLI dispatch: dry-run/apply wiring, JSON output, usage exit 2, missing
  dependency exit 1, thrown error exit 1.
- Real-store wiring: a foreign `other_gc` lease refuses the cycle as
  `fence-acquire-failed` without touching quarantine and without releasing a
  fence it never owned; a fresh data path then skips below threshold in both
  modes, leaves no quarantine row, releases the cycle's own fence, and exits 0.
  The cycle's GC/verify path under pressure is covered by
  `packages/workspace/src/maintenance-cycle.test.ts`, which now also captures
  the fence handed to GC (same store, owner, generation, TTL and grant time)
  and asserts the cycle released it. `gc-cycle.test.ts` covers the held-fence
  contract directly: renewal of the caller's grant without a release, abort
  when the generation was replaced, and refusal when both a lease and a held
  fence are supplied.

## Not in scope

- Scheduling or automatic triggering of the cycle.
- Physical SQLite compaction itself: the cycle only decides whether it is
  admissible and runs GC + verification under that decision.
- The Thai-RAG semantic GC boundary.
