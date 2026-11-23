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
  already samples available memory with a cached, injectable clock. It is **not**
  reused in this phase and not imported: phase 2 ships only the pure mapping, and
  the phase-3 driver is the first consumer of the sample (see the pressure
  section).

Phase numbering note: the registry module docstring calls pressure reclamation
"phase 3". This spec keeps phase 2 = process work and phase 3 = pressure
reclamation, and the implementing PR for phase 2 updates those docstring lines
instead of leaving two numbering schemes in the tree.

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
  /** Absolute, already resolved through `resolveWorkerCwd`. */
  readonly cwd: string;
}

/**
 * The one enforcement point for `cwd`. The supervisor has no default and
 * refuses to start without it, so "inside a registered workspace" is checked
 * by the module that owns workspace roots, not assumed from a comment.
 */
export type ResolveWorkerCwd = (requested: string) => Promise<Result<string>>;

export interface CapabilitySupervisorOptions {
  readonly now?: () => number;
  /** Required: the only place a spec's `cwd` becomes trusted. */
  readonly resolveWorkerCwd: ResolveWorkerCwd;
  readonly processManager?: ProcessManager;
  /** Failure window for crash-loop bounding. */
  readonly crashWindowMs?: number;
  readonly maxCrashRestarts?: number;
}

/**
 * One registry fact `evictionPlan` needs, passed in rather than read: the
 * supervisor has no registry handle, so the caller supplies the snapshot it
 * already owns.
 */
export interface EvictionCandidate {
  readonly id: string;
  readonly state: CapabilityState;
  readonly leaseCount: number;
  readonly idleSince: number;
  readonly recyclable: boolean;
}

export class CapabilitySupervisor {
  /**
   * Declares how a non-in-process capability is spawned. One spec per id.
   * Async because it awaits `resolveWorkerCwd` once and stores the resolved
   * path, so no spec exists with an untrusted `cwd`.
   */
  public async register(manifest: CapabilityManifest, spec?: CapabilityWorkerSpec): Promise<Result<void>>;
  /** Called by the registry in place of its phase-1 `start` callback. */
  public start(manifest: CapabilityManifest): Promise<Result<void>>;
  /** Called by the registry before STOPPING -> COLD. Honours shutdownTimeoutMs. */
  public stop(manifest: CapabilityManifest): Promise<Result<void>>;
  /**
   * Which ids a `WARM_IDLE` reclaim at this pressure may stop, oldest first.
   * Pure: it starts nothing, stops nothing, holds no timer and reads no state.
   */
  public evictionPlan(tier: PressureTier, snapshot: readonly EvictionCandidate[]): readonly string[];
  /** Counts a diagnosis needs; no per-request allocation. */
  public health(): readonly CapabilityWorkerHealth[];
  /** Bounded graceful stop of everything this supervisor started. */
  public shutdown(): Promise<void>;
}
```

`evictionPlan` is deliberately read-only, and its snapshot argument is what
keeps that honest: `WARM_IDLE` membership, lease counts and `idleSince` are
registry-only facts, so the caller passes `registry.snapshot()` in and the
function stays a pure selection over its input. The governor passes the returned
ids to `registry.reclaim(id)`, so the stop is written by the module that owns the
transition. The earlier shape (the supervisor calling back into the registry)
would re-enter a transition while the registry was deciding one, which the
one-way seam below forbids.

```ts
/** Structural, local to this package: no cross-package type import. */
export type PressureTier = 'normal' | 'elevated' | 'critical';
```

`packages/capabilities` depends on `domain`, `process` and `shared` only. It does
not depend on `@unified-mpc/workspace`, so this phase introduces no such
dependency and no type-only import that the workspace dependency audit would
reject: the tier is a local union and the caller maps a probe sample onto it.

## Trust and admission

- `executable` and `args` come from the registered manifest and its spec, never
  from model or tool input. A caller that names a binary is the extension/tool
  layer, which already owns approval. The supervisor adds no new trust: it passes
  the pair to `ProcessManager`, which spawns without a shell, and `register`
  refuses an empty executable, an empty argv element, or a relative executable.
- `cwd` is the one input that could escape a workspace, so it has exactly one
  enforcement point, `resolveWorkerCwd`, with no default. `register` is async and
  awaits it once, storing the resolved absolute path; a rejected resolution fails
  the registration, so no registered spec ever holds an unresolved `cwd`.
- Memory/CPU admission stays with `ResourceAdmission` before `acquire`; the
  supervisor does not re-implement ceilings, and an admission-refused start never
  reaches it.

## Registry change required by phase 2

Six pieces of registry surface do not exist at head and are part of this
phase, not of the supervisor:

1. a `start` option that can report failure. Today it is
   `(manifest) => Promise<void> | void` and `start()` coerces the awaited value
   with `.then(() => 'started')`, so a returned `err(...)` would be recorded as
   `ACTIVE` with a dead worker. The option becomes
   `(manifest) => Promise<Result<void>> | Result<void>` and a returned `err`
   writes `FAILED` with the error's message, exactly like a thrown error does
   today. This is a breaking change to one internal option, taken before the
   supervisor exists so there is no caller to migrate;
2. a `stop` hook beside `start`, so `STOPPING -> COLD` can await verified
   termination before the transition is written (today `stop()` is private and
   completes the cycle in one synchronous tick);
3. a public `reclaim(id)` targeted stop that the governor can ask for with the
   ids `evictionPlan()` returned, since `sweep()` only applies each manifest's
   own `idleTtlMs`. `reclaim` **marks a pending stop**: on an
   `ACTIVE`/`WARM_IDLE` capability with no lease it takes the `STOPPING` edge at
   once, and when `leaseCount` is still positive the registry — the only module
   holding the count — completes the same stop from `releaseLease`. That removes
   the need for a lease-release subscription: a waiter polls `health(id)`, which
   already reports the state the registry wrote;
4. a way for `reclaim` and `sweep` to ignore the manifest TTL for one tick
   without editing an immutable manifest, and a `burst` default of
   `idleTtlMs = 0` in `normalizeCapabilityManifest`, so `activation: 'burst'`
   stops on its last release instead of going `WARM_IDLE` for the default 60 s;
5. a read-only `snapshot(): readonly EvictionCandidate[]` that returns one entry
   per registered capability. `health(id)` is per-id and `CapabilityHealth`
   carries no `idleSince`, so without this the governor cannot build the input
   `evictionPlan` needs and the plan would have to read registry internals.
   `EvictionCandidate` is that type: `id`, `state`, `leaseCount`, `idleSince`,
   `recyclable`;
6. a public `fail(id, reason)` for the worker-exit edge below. The registry owns
   every transition and the supervisor holds no registry handle, so an
   unrequested worker exit can only be written by the module that owns the
   transition, on the supervisor's report.

None of them changes the transition rules; they only let the supervisor drive
the existing ones.

Phase 1's table has no edge out of a running state on worker death:

```text
ACTIVE     -> WARM_IDLE | STOPPING
WARM_IDLE  -> ACTIVE | STOPPING
```

A real worker can exit on its own. Phase 2 adds exactly two edges, both with a
reason that names the exit and both written through the new `fail(id, reason)`
from registry change 6, because a transition never happens outside the registry:

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
`maxCrashRestarts` is not a new state and does not invent a transition reason the
registry never writes: the capability stays `FAILED`, `acquire` already returns a
conflict for `FAILED`, and the supervisor's own `health()` reports the count and a
`crashLoop: true` flag for that id. The registry has no counter and none is added.
**No automatic restart loop is allowed to be unbounded** — that is the failure
mode a supervisor exists to prevent, so the bound is configuration with a default
(5 failures in 60 s) rather than caller policy.

Ownership is explicit: **phase 2 never restarts on its own**. There is no timer in
the supervisor and no retry inside `start`. A restart is the caller's next
`acquire`, which is `FAILED -> COLD` (recycle) then `COLD -> STARTING -> ACTIVE`
through the registry, so the fence and the lease rules keep applying. The bound
exists to refuse that path once the window is exhausted.

## Pressure policy

| pressure | warm-idle TTL | `evictionPlan` | new large starts |
| --- | --- | --- | --- |
| `normal` | manifest `idleTtlMs` | none | allowed |
| `elevated` | clamp to `min(idleTtlMs, 5_000)` | `WARM_IDLE` only, oldest first | allowed |
| `critical` | `0` | every unleased `WARM_IDLE` immediately | refused by admission |

Rules that keep this honest:

- Pressure may shorten a TTL; it may never shorten a lease. The registry already
  refuses `STOPPING` while `leaseCount > 0`, and the supervisor must not route
  around that.
- `recyclable: false` is never evicted; the manifest promised residency.
- Refusing a large start under `critical` belongs to
  `ResourceAdmission` (`RESOURCE_PRESSURE`, `memory_pressure`, retryable), which
  already does it. The registry is not given a second refusal path, because a
  refusal here would have to move a `COLD` capability straight to `FAILED` and
  strand it after a transient spike.
- `burst` capabilities stop on their last release once phase 2 defaults
  `idleTtlMs` to `0` for that activation (registry change 4); today the default
  is 60 s for every activation, so the value alone does not stop them. No
  registered manifest uses `activation: 'burst'` yet, so this default costs no
  existing behaviour.

Responsibility split: `ProcessMemoryPressureProbe` owns the thresholds and the
sample, the caller maps a sample onto `PressureTier`, and the supervisor owns only
the response. **There is no governor loop in the tree today** — nothing calls
`sweep()` outside a test. Phase 2 therefore ships `evictionPlan` as a pure
function and does not add a timer; wiring a driver (goal runtime heartbeat or
workspace session tick) is phase 3. Phase 2 ships the pure function and the
`reclaim` it hands ids to, so that driver is a wiring change, not new surface.

## Burst concurrency

Phase 1 left this open. Decision: **no queue in phase 2**. A second `acquire`
while a burst capability is `STOPPING` is refused with a retryable conflict. A
queue here would need fairness, backpressure and its own lease to be correct;
none of that exists, and a busy host should shed burst work rather than stack it
in memory.

## Shutdown

- `stop` asks `ProcessManager` to terminate the tree and awaits verified
  termination. `ProcessManager.stop()` has **no deadline of its own**: after a
  signal it awaits `waitForVerifiedTermination()`, which only settles once some
  caller verifies, so the await can block indefinitely rather than return a
  useful error. The supervisor therefore races the call against
  `manifest.shutdownTimeoutMs` and reads `status(processId)` to learn the real
  state instead of waiting for a promise that may never settle.
- `termination_unverified` maps to `FAILED` with reason `stop-unverified`, and
  is reported by `health()`; it is never reported as `COLD`.
- `shutdown()` stops `WARM_IDLE` first, then asks `registry.reclaim(id)` for the
  remaining capabilities; a leased one completes its pending stop when
  `releaseLease` writes it (registry change 3), so the wait is a `health(id)`
  poll against one global deadline. A capability that misses the deadline is
  killed and recorded as failed — shutdown completes either way.

## Model lifecycle stays separate

Embedding/model servers are shared services, not capability workers. They are
declared as `externalRequires` (the registry never starts them) or given their
own keepalive outside this module. Phase 2 does not load or unload models; #133
keeps that as its own phase because a model's reload cost is an order of
magnitude above a worker's.

## Verification

Unit tests in `packages/capabilities`, with an injected fake `ProcessManager`, a
fake clock and a constant pressure:

1. `register` refuses a non-`in-process` manifest with no spec, refuses a spec
   for an id registered twice, and refuses a spec whose `resolveWorkerCwd`
   rejects the requested path (escaping `..`, relative, or outside every root);
2. start failure (fake spawn error, a start that exceeds `startupTimeoutMs`, and
   a supervisor `start` that returns `err`) leaves the registry in `FAILED`; the
   `err` case is the regression the old `Promise<void>` option could not express,
   because it coerced the value to `ACTIVE`;
3. a worker exit while `ACTIVE` and while `WARM_IDLE` moves the capability to
   `FAILED` with reason `worker-exited` through `fail(id, reason)` — the registry
   change above, pinned before the supervisor code exists;
4. `evictionPlan('elevated', snapshot)` lists `WARM_IDLE` ids only, oldest first,
   leaves leased capabilities out, and never lists `recyclable: false`, with the
   snapshot supplied by a fake registry so the function is proven pure;
5. `evictionPlan('critical', snapshot)` lists every unleased `WARM_IDLE`, and a
   refused start under critical pressure is admission's `RESOURCE_PRESSURE`, not
   a registry failure;
6. crash-loop bounding: after `maxCrashRestarts` failures inside the window the
   supervisor reports `crashLoop: true` from `health()` and its `start` refuses
   without spawning; the registry keeps `FAILED` and writes no invented reason;
7. `stop` that exceeds `shutdownTimeoutMs` is killed and reported
   `stop-unverified`, never `COLD`, including when `ProcessManager.stop()` never
   settles because nothing verified termination;
8. `shutdown()` stops idle capabilities first, waits for a leased capability's
   pending `reclaim` to complete on its last release, and returns inside the
   global deadline even when one capability ignores its grace period.

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
