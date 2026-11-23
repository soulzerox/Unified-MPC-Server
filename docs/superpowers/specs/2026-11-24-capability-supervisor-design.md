# On-demand capability runtime — phase 2: the worker supervisor

Date: 2026-11-24
Issue: [#133](https://github.com/soulzerox/Unified-MPC-Server/issues/133)
Predecessor: [phase 1 — manifest and lifecycle](2026-11-23-on-demand-capability-runtime-design.md)

## Decision

Phase 1 shipped the manifest contract and the lifecycle registry
(`packages/capabilities/src/capability-registry.ts`). It accounts leases, enforces
warm-idle TTL and refuses illegal transitions, but its `start` option is a single
awaitable callback: nothing spawns, nothing is killed, nothing measures a
process.

Phase 2 adds **one module, `CapabilitySupervisor`**, that performs the process
work behind the registry's `start`/`stop` hooks. It does not own state. The
registry stays the only authority for `state`, `leaseCount` and generations, so
every lifecycle rule is still testable with a fake clock and no child processes.

Two things already exist and must be reused, not re-implemented:

- `ProcessManager` (`packages/process/src/process-manager.ts`) already spawns a
  process without a shell, enforces a timeout, keeps bounded per-process logs,
  cancels through an `AbortSignal`, and terminates the tree with verification
  through `ProcessTreeTerminator`. `packages/capabilities` already depends on
  `@unified-mpc/process`.
- `ProcessMemoryPressureProbe` (`packages/workspace/src/resource-pressure.ts`)
  already samples available memory with a cached, injectable clock.

## Seam

The supervisor is a **deep module**: one narrow interface for callers, process
management and pressure policy behind it. The split of authority is the whole
design:

```text
caller ── acquire/release ──▶ CapabilityRegistry   (state, leases, fence)
                                   │ start(manifest) / stop(manifest)
                                   ▼
                            CapabilitySupervisor    (spawn, kill, restart bound)
                                   │
                                   ▼
                              ProcessManager        (existing)
```

- The registry decides *when* a transition happens; the supervisor only makes
  the transition true. A spawn failure is reported back as a failed start and
  the registry writes `FAILED`.
- The supervisor never calls `acquire`/`release` and never invents a capability
  id it was not registered for.
- A supervisor crash cannot corrupt lifecycle state, because it holds none.

## Interface

```ts
export interface CapabilityWorkerSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Working directory must be inside a registered workspace root. */
}

export interface CapabilitySupervisorOptions {
  readonly now?: () => number;
  /** Existing probe, or a governor-provided equivalent. */
  readonly pressure?: () => ResourcePressureState;
  readonly processManager?: ProcessManager;
  /** Failure window for crash-loop bounding. */
  readonly crashWindowMs?: number;
  readonly maxCrashRestarts?: number;
}

export class CapabilitySupervisor {
  /** Declares how a non-in-process capability is spawned. One spec per id. */
  public register(manifest: CapabilityManifest, spec?: CapabilityWorkerSpec): Result<void>;
  /** Called by the registry in place of its phase-1 `start` callback. */
  public start(manifest: CapabilityManifest): Promise<Result<void>>;
  /** Called by the registry before STOPPING -> COLD. Honours shutdownTimeoutMs. */
  public stop(manifest: CapabilityManifest): Promise<Result<void>>;
  /** One pressure tick, driven by the existing governor loop. No own timers. */
  public evictIdle(state: 'normal' | 'elevated' | 'critical'): readonly string[];
  /** Counts a diagnosis needs; no per-request allocation. */
  public health(): readonly CapabilityWorkerHealth[];
  /** Bounded graceful stop of everything this supervisor started. */
  public shutdown(): Promise<void>;
}
```

`evictIdle` takes no list of capabilities: the governor calls it with the
current pressure state, and the supervisor asks the registry to stop the ones it
is allowed to stop. It returns the ids it asked for, so the governor can log one
line instead of polling.

The supervisor imports `ResourcePressureState` from `@unified-mpc/workspace`
**only as a type**; at runtime it receives the function. That keeps the
dependency direction legal (`workspace` does not depend on `capabilities`) and
lets a test pass a constant.

## Registry change required by phase 2

Phase 1's table has no edge out of a running state on worker death:

```text
ACTIVE     -> WARM_IDLE | STOPPING
WARM_IDLE  -> ACTIVE | STOPPING
```

A real worker can exit on its own. Phase 2 adds exactly two edges, both with a
reason that names the exit:

```text
ACTIVE     -> FAILED   (reason 'worker-exited')
WARM_IDLE  -> FAILED   (reason 'worker-exited')
```

Nothing else changes: `FAILED -> COLD` already exists for recycling, `acquire`
still refuses `FAILED`, and the phase-1 tests for every other edge stay as they
are. The alternative — treating a dead worker as `STOPPING -> COLD` — would let
an unrequested exit look like a clean shutdown and hide it from `health()`.

`FAILED -> COLD` recycle is driven by the supervisor re-reading the capability's
own durable artifacts; the registry is never persisted, matching phase 1.

## Crash-loop bounding

Every failure is counted per capability inside `crashWindowMs`. Exceeding
`maxCrashRestarts` is not a new state: the capability simply stays `FAILED`, its
last transition reason says `crash-loop`, and `acquire` already returns a
conflict for `FAILED`. **No automatic restart loop is allowed to be unbounded** —
that is the failure mode a supervisor exists to prevent, so the bound is
configuration with a default (5 restarts in 60 s) rather than caller policy.

A restart after a crash is a normal `acquire`: `FAILED -> COLD` (recycle) then
`COLD -> STARTING -> ACTIVE`, all through the registry, so the fence and lease
rules keep applying.

## Pressure policy

| pressure | warm-idle TTL | eviction | new large starts |
| --- | --- | --- | --- |
| `normal` | manifest `idleTtlMs` | none | allowed |
| `elevated` | clamp to `min(idleTtlMs, 5_000)` | `WARM_IDLE` only, oldest first | allowed |
| `critical` | `0` | every `WARM_IDLE` immediately | refused, retryable |

Rules that keep this honest:

- Pressure may shorten a TTL; it may never shorten a lease. The registry already
  refuses `STOPPING` while `leaseCount > 0`, and the supervisor must not route
  around that.
- `recyclable: false` is never evicted; the manifest promised residency.
- A refused start under `critical` is a retryable `CONFLICT`, not a silent
  fallback and not a fabricated success.
- `burst` capabilities already stop on their last release (`idleTtlMs: 0`), so
  pressure has nothing to add for them.

Thresholds stay where they are today: `ProcessMemoryPressureProbe` owns the
ratios, the supervisor owns only the response.

## Burst concurrency

Phase 1 left this open. Decision: **no queue in phase 2**. A second `acquire`
while a burst capability is `STOPPING` is refused with a retryable conflict. A
queue here would need fairness, backpressure and its own lease to be correct;
none of that exists, and a busy host should shed burst work rather than stack it
in memory.

## Shutdown

- `stop` asks `ProcessManager` to terminate the tree and awaits verified
  termination inside the manifest's `shutdownTimeoutMs`.
- `termination_unverified` maps to `FAILED` with reason `stop-unverified`, and
  is reported by `health()`; it is never reported as `COLD`.
- `shutdown()` stops `WARM_IDLE` first, then every leased capability once its
  leases release, bounded by one global deadline. A capability that misses the
  deadline is killed and recorded as failed — shutdown completes either way.

## Model lifecycle stays separate

Embedding/model servers are shared services, not capability workers. They are
declared as `externalRequires` (the registry never starts them) or given their
own keepalive outside this module. Phase 2 does not load or unload models; #133
keeps that as its own phase because a model's reload cost is an order of
magnitude above a worker's.

## Verification

Unit tests in `packages/capabilities`, with an injected fake `ProcessManager`, a
fake clock and a constant pressure:

1. `register` refuses a non-`in-process` manifest with no spec, and refuses a
   spec for an id registered twice;
2. start failure (fake spawn error, and a start that exceeds
   `startupTimeoutMs`) leaves the registry in `FAILED` and the capability is not
   `ACTIVE`;
3. a worker exit while `ACTIVE` and while `WARM_IDLE` moves the capability to
   `FAILED` with reason `worker-exited` — the registry change above, pinned
   before the supervisor code exists;
4. `evictIdle('elevated')` asks for `WARM_IDLE` only, leaves leased capabilities
   alone, and never touches `recyclable: false`;
5. `evictIdle('critical')` stops every unleased `WARM_IDLE` and refuses a new
   start with a retryable conflict;
6. crash-loop bounding: the sixth failure inside the window stops restarting and
   `health()` reports `crash-loop`;
7. `stop` that exceeds `shutdownTimeoutMs` is killed and reported
   `stop-unverified`, never `COLD`;
8. `shutdown()` stops idle capabilities first and returns inside the global
   deadline even when one capability ignores its grace period.

Integration test in `packages/capabilities` with the real `ProcessManager` and a
`node -e` child that prints one line and exits: start, log, stop, and a start
timeout. It runs on every platform the suite already targets, because the child
is Node itself and no shell is involved.

The lifecycle invariants stay where phase 1 put them: a fake clock still proves
TTL, leases and the fence. Nothing in phase 2 changes how those are tested.

## Non-goals

- cgroups, sandboxes, WASI or memory ceilings per worker (see #135).
- Deriving pressure thresholds from the host budget (that is #13's job; the
  probe keeps its ratios).
- Persisting leases or the registry across a restart.
- Model load/unload cost measurement.
- Fair queueing for burst work.

## Open questions

- Does the elevated TTL clamp belong in the supervisor or in #13's governor
  policy? The supervisor enforces whatever TTL it is given, so moving the clamp
  later is a one-line change at the seam.
- Should a `FAILED -> COLD` recycle be automatic on the next acquire, or require
  an explicit `recycle(id)`? Automatic is simpler and is what the tests assume.
- When a worker is spawned, should its stdout/stderr stream into the supervisor's
  `health()` or stay only in `ProcessManager`'s ring buffer? The ring buffer
  already bounds the memory; the supervisor should read it lazily by
  `processId`, not copy it.
