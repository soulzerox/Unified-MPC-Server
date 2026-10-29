# Heavy headroom design

Date: 2026-10-30
Issue: [#145](https://github.com/soulzerox/Unified-MPC-Server/issues/145)

## Decision

The heavy-job cap stays **one base slot**, but the controller may add a bounded
number of **extra heavy slots** from measured memory and CPU headroom at
admission time. The configured cap is the floor and the hard upper bound; the
measured signals decide whether the extra slots are usable right now.

This is the "measured, not configured" slice of #145: an operator no longer has
to raise `maxHeavyOperations` manually to let a large host run two heavy jobs,
and a constrained or CPU-saturated host keeps one slot without any
configuration.

```text
base cap (configured, default 1)
        +
extra slots = min(
  maxExtraHeavyJobs,                         configured ceiling
  floor((availableBytes - reserveBytes)      measured memory now
        / bytesPerExtraHeavyJob)
)
        =
effective cap used by tryAcquire()
```

Extra slots are available only while `pressureState === 'normal'` **and** the
1-minute load average stays at or below `maxLoadPerCore` per CPU core. Elevated
or critical pressure, or an over-threshold load, drops the effective cap back to
the base immediately; already running leases are never revoked.

## Why measured available memory and CPU load

- `ProcessMemoryPressureProbe` already prefers Linux `MemAvailable`, so
  reclaimable page cache is not mistaken for free memory.
- `ProcessCpuLoadProbe` reads `os.loadavg()[0]` and `os.cpus().length`, the
  cheapest cross-platform signal Node exposes. Memory alone would let a
  CPU-saturated host start a second heavy job.
- The controller already reduces the effective global weighted cost under
  pressure. Reusing the same samples keeps one admission story instead of a
  second scheduler with its own view of the host.
- Total RAM is deliberately not an input: a 16 GiB host with 3 GiB available is
  not a two-job host. "16 GiB means 2 jobs" is exactly the blind inference #145
  rejects.

## Policy details

1. `maxHeavyOperations` (default `1`) is the base cap and remains reported as
   the configured ceiling.
2. `heavyHeadroom.maxExtraHeavyJobs` (default `1`, `0` disables) bounds the
   number of extra slots regardless of how much memory is free.
3. `heavyHeadroom.bytesPerExtraHeavyJob` (default **4 GiB**) is the conservative
   memory estimate one extra heavy job may consume. It is an estimate, not a
   per-job measurement; class costs and workspace/session/global ceilings still
   apply independently.
4. `heavyHeadroom.reserveBytes` (default **2 GiB**) is memory kept free for the
   OS, the unified runtime, and other processes before any extra slot counts.
5. `heavyHeadroom.maxLoadPerCore` (default **0.5**, `0` disables the CPU gate) is
   the highest 1-minute load average per core that still permits extra slots.
   The load average is a system-wide signal, not a per-process one: a busy host
   should not start another heavy job merely because RAM is free.
6. A missing, unreadable, or malformed memory **or** CPU sample fails closed to
   the base cap. `tryAcquire()` never widens capacity because a probe failed.
7. The weighted-cost checks run unchanged. Two heavy jobs at cost 8 still need
   the default global ceiling of 16; a custom global ceiling is the operator's
   responsibility.
8. Per-class ceilings are unchanged. With the default 8-cost
   `verification_heavy` class, two verification jobs still do not overlap even
   when the effective heavy cap is 2; the measured extra slot pairs a
   verification job with a `rag_indexing` job. Raising the class ceiling is a
   separate operator decision.
9. Fairness, blocking promotion, scoped-denial backfill, and the durable queue
   are untouched. `drain()` already walks the fair order until the controller
   denies, so an extra slot simply admits the next candidate in that order.

## Configuration

Process-wide environment, read once when the shared controller is created:

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS` | `1` | Extra heavy slots allowed above the base cap; `0` disables the feature. |
| `UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES` | `4294967296` (4 GiB) | Memory reserved per extra heavy job. |
| `UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES` | `2147483648` (2 GiB) | Memory kept free before extra slots count. |
| `UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE` | `0.5` | Highest 1-minute load average per core for extra slots; `0` disables the CPU gate. |

Memory values are positive integers (`UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS` may be
`0`); the load threshold is a non-negative number. Invalid values fail
controller creation with an explicit error instead of silently changing the cap.

## Observability

`ResourceAdmissionSnapshot` keeps `maxHeavyOperations` (configured) and adds
`effectiveMaxHeavyOperations` (measured). The `pressure` sample reports
`availableMemoryBytes`, `availableRatio`, and `state`; the `cpu` sample reports
`loadAverage1m` and `cpuCount`, so an operator can reconstruct both gates.

`heavy_job_queue_status` projects both caps plus the memory and CPU samples in
its `admission` block, and keeps the existing `heavy_capacity_exhausted` reason
when the effective cap denies a job. No new counters or durable state are added.

## Why load average, not PSI

PSI would give a cleaner per-resource stall signal, but it is Linux-specific and
needs its own bounded reader and tuning. `os.loadavg()` is portable, cheap, and
already includes uninterruptible I/O wait on Linux. The policy normalizes it by
CPU count so the same threshold means the same thing on a 2-core and a 32-core
host. PSI can join the sample type later without changing the admission
contract; this slice does not pretend to measure it.

## Non-goals

- No preemption of running heavy work; the cap only shapes new admissions.
- No per-workspace or per-Goal caps (deferred by the fairness design).
- No class-specific extra slots; every `HEAVY_ADMISSION_CLASSES` job shares the
  same effective cap.
- No durable headroom counters; the decision is recomputed from live pressure.
- No worker recycle integration (#133).
- No change to light classes, LSP, Goal processes, or delegated agents.

## Verification

- Default profile on a constrained host (normal pressure, little free memory):
  effective cap stays `1`, second heavy job is `heavy_capacity_exhausted`.
- Normal pressure with enough free memory: effective cap rises to `2`, a
  `rag_indexing` job and a `verification_heavy` job from different workspaces
  are admitted, and a second verification job still hits the default per-class
  ceiling.
- Elevated or critical pressure: extra slots disappear even when memory numbers
  would otherwise fit; already running leases stay active.
- CPU load above `maxLoadPerCore`: extra slots disappear even when memory would
  otherwise fit; at or below the threshold they remain available.
- Missing or malformed memory or CPU sample: effective cap stays `1` (fail
  closed).
- `maxExtraHeavyJobs: 0` and `maxLoadPerCore: 0` behave as documented.
- Global/class/workspace/session ceilings still deny before the extra slot can
  be used.
- Snapshot and `heavy_job_queue_status` report configured/effective caps and the
  CPU sample consistently.
- Invalid env values fail startup with a clear error; unset env keeps defaults.

## Delivery sequence

1. Pure `effectiveHeavyCapacity()` policy module and tests (TDD, public
   interface only).
2. Controller integration: normalized headroom limits, effective snapshot field,
   `tryAcquire()` uses the effective cap.
3. Shared-controller env parsing and validation.
4. `heavy_job_queue_status` projection and deployment documentation.
5. CPU load gate: cached `ProcessCpuLoadProbe`, policy threshold, snapshot
   projection and status sample.

Each step is TDD, and the controller/queue contract is exercised through its
public interface.
