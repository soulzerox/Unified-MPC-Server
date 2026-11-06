# Unified #210 slice — physical compaction inside the maintenance cycle

Issue: soulzerox/Unified-MPC-Server#210 (§2-§3 physical SQLite boundary,
§5-§7 bounded maintenance, §12 single-owner fence).

## Why this slice now

The operator-triggered maintenance cycle landed in #661/#662. It measures
pressure, decides whether compaction is admissible, then runs GC plus
verification under one fence — but it never compacts. The plan for that slice
listed the gap explicitly:

> Physical SQLite compaction itself: the cycle only decides whether it is
> admissible and runs GC + verification under that decision.

Issue #210 says row deletion/revision prune is not compaction, and a maintenance
controller may compact only when measured freelist/space pressure justifies it.
This slice closes that gap without adding a scheduler, timer, second lock or
automatic side effect.

~~~text
index maintenance --dry-run|--apply
  -> physicalMetrics()                 pressure evidence
  -> runMaintenanceCycle()
       -> headroom pre-flight
       -> single-owner GC fence + one admission lease
       -> compactionGate()             enqueue | skip | refuse
       -> GC quarantine under the live fence
       -> renew/assert the fence at the compaction boundary
       -> compactStore()               VACUUM + WAL checkpoint(TRUNCATE)
       -> verifyCanonicalStore()
  -> completed (dry-run|applied) + compaction evidence
~~~

## Contract

### 1. Compaction is a storage primitive, not a gate decision

`SqliteDatabase.compact()` owns the physical work:

1. measure physical metrics with `checkpointMode: 'none'` so measurement does
   not perturb the pass;
2. `VACUUM;`
3. `PRAGMA wal_checkpoint(TRUNCATE);`
4. measure again with `checkpointMode: 'none'`.

`VACUUM` alone writes the rebuilt database through the WAL. Until the WAL is
checkpointed, the main file can stay at its old size; in the probe for this
slice a 66 MB database stayed 66 MB after `VACUUM` and shrank to 8 KB only
after `wal_checkpoint`. `TRUNCATE` is the step that both copies the frames back
and reclaims WAL space.

A reader can block the truncate. The pass then reports
`checkpointBusy: true`, `checkpointTruncated: false`, and the measured bytes it
actually achieved. It never claims reclamation it cannot prove, and the next
maintenance pass retries. A `SQLITE_BUSY`/`SQLITE_LOCKED` from `VACUUM` is
reported as `skipped reader-pressure` instead of failing the cycle; any other
error is a real failure.

### 2. The cycle owns the fence; compaction asserts it

`runMaintenanceCycle` creates one `GcLeaseHeartbeat` from the grant it already
holds and calls `assert()` immediately before `compactStore()`. The GC pass has
its own heartbeat at its destructive boundary, using the same record. Neither
acquires a second lease. If the fence was replaced or released, the cycle
throws `GcLeaseLostError` and mutates nothing else.

### 3. Dry run plans, apply compacts

The cycle accepts an optional `compactStore` callback:

- `--dry-run` supplies a callback that returns
  `{ status: 'planned', reason: 'pressure-justified' }`;
- `--apply` supplies `() => database.compact()`;
- an omitted callback reports `{ status: 'not-requested' }`, so existing
  embedders and tests keep working without claiming a compaction happened.

The report gains a required `compaction` field on `completed`:

~~~text
not-requested
planned  (pressure-justified)
skipped  (reader-pressure, detail)
compacted (before/after bytes, reclaimed, freelist before/after,
           checkpointBusy, checkpointTruncated, walBytesAfter)
~~~

A compaction that throws is verified before refusal: if verification is
degraded the cycle refuses `verify-degraded` (integrity is the stronger
problem), otherwise it refuses `compaction-failed` with the error detail. Both
release the fence and admission lease in the existing `finally`.

### 4. Output and exit codes

`formatIndexMaintenance` prints one compaction line before the GC lines:

~~~text
completed (dry-run) verification healthy manifests 1
compaction planned (pressure-justified)
planned (dry-run) reachable 3 unreachable 1 artifact-unreachable 0
~~~

`compacted` prints before/after/reclaimed bytes and a `checkpoint busy` suffix
when truncation was blocked. `not-requested` prints nothing, preserving the
older report shape. `compaction-failed` joins the refusal vocabulary and exits
`1`; `planned`, `skipped` and `compacted` stay successful verdicts.

## Tests

- Storage: deleting rows grows the freelist without shrinking the file;
  `compact()` shrinks the file, empties the freelist, truncates the WAL and
  reports reclaimed bytes; a held reader produces `checkpointBusy: true`
  without claiming full reclamation, or a `reader-pressure` skip when SQLite
  reports the reader before `VACUUM` starts.
- Cycle: `compactStore` is called only after a successful GC pass; the report
  carries `not-requested` when omitted, `planned` for dry run, `compacted`
  evidence for apply, and `skipped reader-pressure` without failing the cycle;
  the heartbeat renews the exact grant before compaction; a compaction throw
  refuses `compaction-failed` or `verify-degraded` and releases both locks.
- Formatter: completed dry-run/applied include the compaction line; planner
  output omits it for `not-requested`; compacted busy output is explicit.
- Real store: the existing pressure-gated CLI test still skips a fresh
  database; the CLI wiring compiles with `database.compact()` in apply mode.

## Not in scope

- Scheduling or automatic triggering of the cycle.
- Thai-RAG semantic GC.
- A new command or flag; `index maintenance` is the only entry point.
- Changing the compaction thresholds or the gate's verdicts.
