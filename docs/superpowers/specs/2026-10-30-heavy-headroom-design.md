# Heavy headroom design

Date: 2026-10-30
Issue: [#145](https://github.com/soulzerox/Unified-MPC-Server/issues/145)

## Decision

The heavy-job cap stays **one base slot**, but the controller may add a bounded
number of **extra heavy slots** from measured memory headroom at admission time.
The configured cap is the floor and the hard upper bound; the measured signal
decides whether the extra slots are usable right now.

This is the remaining "measured, not configured" slice of #145: an operator no
longer has to raise `maxHeavyOperations` manually to let a large host run two
heavy jobs, and a constrained host keeps one slot without any configuration.

```text
base cap (configured, default 1)
        +
extra slots = min(
  maxExtraHeavyJobs,                         configured ceiling
  floor((availableBytes - reserveBytes)      measured now
        / bytesPerExtraHeavyJob)
)
        =
effective cap used by tryAcquire()
```

Extra slots are available only while `pressureState === 'normal'`. Elevated or
critical pressure drops the effective cap back to the base immediately; already
running leases are never revoked.

## Why measured available memory

- `ProcessMemoryPressureProbe` already prefers Linux `MemAvailable`, so
  reclaimable page cache is not mistaken for free memory.
- The controller already reduces the effective global weighted cost under
  pressure. Reusing the same sample keeps one admission story instead of a
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
5. A missing, unreadable, or malformed pressure sample fails closed to the base
   cap. `tryAcquire()` never widens capacity because a probe failed.
6. The weighted-cost checks run unchanged. Two heavy jobs at cost 8 still need
   the default global ceiling of 16; a custom global ceiling is the operator's
   responsibility.
7. Per-class ceilings are unchanged. With the default 8-cost
   `verification_heavy` class, two verification jobs still do not overlap even
   when the effective heavy cap is 2; the measured extra slot pairs a
   verification job with a `rag_indexing` job. Raising the class ceiling is a
   separate operator decision.
8. Fairness, blocking promotion, scoped-denial backfill, and the durable queue
   are untouched. `drain()` already walks the fair order until the controller
   denies, so an extra slot simply admits the next candidate in that order.

## Configuration

Process-wide environment, read once when the shared controller is created:

| Variable | Default | Meaning |
| --- | --- | --- |
| `UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS` | `1` | Extra heavy slots allowed above the base cap; `0` disables the feature. |
| `UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES` | `4294967296` (4 GiB) | Memory reserved per extra heavy job. |
| `UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES` | `2147483648` (2 GiB) | Memory kept free before extra slots count. |

Values are positive integers (`UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS` may be `0`).
Invalid values fail controller creation with an explicit error instead of
silently changing the cap.

## Observability

`ResourceAdmissionSnapshot` keeps `maxHeavyOperations` (configured) and adds
`effectiveMaxHeavyOperations` (measured). The existing `pressure` sample already
reports `availableMemoryBytes`, `availableRatio`, and `state`, so an operator
can reconstruct the decision.

`heavy_job_queue_status` projects both caps in its `admission` block and keeps
the existing `heavy_capacity_exhausted` reason when the effective cap denies a
job. No new counters or durable state are added.

## Why not CPU/PSI now

Memory pressure is the signal the controller already admits against, and the one
this host family exposes portably. A CPU/load or PSI gate needs a bounded,
cross-platform probe and its own tuning; adding it alongside the memory formula
would make a bad CPU reading able to starve all heavy work. The policy module's
sample type is the place a future CPU signal can join, but this slice does not
pretend to measure it.

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
- Missing or malformed sample: effective cap stays `1` (fail closed).
- `maxExtraHeavyJobs: 0`: identical behavior to today on every sample.
- Global/class/workspace/session ceilings still deny before the extra slot can
  be used.
- Snapshot and `heavy_job_queue_status` report configured and effective caps
  consistently.
- Invalid env values fail startup with a clear error; unset env keeps defaults.

## Delivery sequence

1. Pure `effectiveHeavyCapacity()` policy module and tests (TDD, public
   interface only).
2. Controller integration: normalized headroom limits, effective snapshot field,
   `tryAcquire()` uses the effective cap.
3. Shared-controller env parsing and validation.
4. `heavy_job_queue_status` projection and deployment documentation.

Each step is TDD, and the controller/queue contract is exercised through its
public interface.
