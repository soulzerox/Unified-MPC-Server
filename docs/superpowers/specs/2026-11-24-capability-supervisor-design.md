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
work behind the registry's `start`/`stop` hooks. It owns no lifecycle state: it
reads and reports through a narrow `CapabilityLifecyclePort` the registry
implements. The registry stays the only authority for `state`, `leaseCount` and
generations, so every lifecycle rule is still testable with a fake clock and no
child processes.

Two things already exist and must be reused, not re-implemented:

- `ProcessManager` (`packages/process/src/process-manager.ts`) already spawns a
  process without a shell, enforces a wall-clock timeout, keeps bounded
  per-process logs, cancels through an `AbortSignal`, and terminates the tree
  with verification through `ProcessTreeTerminator`. `packages/capabilities`
  already depends on `@unified-mpc/process`.
- Two small additions to that package are required and named in the surface
  section: `onExit(processId, listener)` so an unrequested exit is observable
  without polling, and `timeoutMs: 0` to disable the wall-clock cap for a
  resident worker. Without the second, `ProcessManager` would kill every worker
  after its one-hour default (hard ceiling four hours) and the design's own exit
  notification would report that as `worker-exited` → `FAILED`.
- `ProcessMemoryPressureProbe` (`packages/workspace/src/resource-pressure.ts`)
  already samples available memory with a cached, injectable clock. Phase 2 does
  not import it: `ResourceAdmission` already owns the production consumer (it
  builds the probe and rejects with `RESOURCE_PRESSURE`/`memory_pressure`), and
  this phase only adds the pure tier → plan mapping on top of that signal.

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
   │                                │  ▲
   │                                │  │ CapabilityLifecyclePort
   │                    start/stop  │  │ (snapshot, health, reclaim, fail)
   │                                ▼  │
   │                        CapabilitySupervisor   (spawn, kill, restart bound)
   │                                │
   │                                ▼
   │                          ProcessManager        (existing)
   │
   └── evictionPlan(tier, registry.snapshot()) ──▶ registry.reclaim(id)
```

- The registry decides *when* a transition happens; the supervisor only makes
  the transition true and reports the outcome back through
  `CapabilityLifecyclePort`, which the registry implements. A spawn failure is
  reported as a failed start and the registry writes `FAILED`.
- The port is deliberately narrow: `snapshot`, `health`, `reclaim` and `fail`.
  The supervisor never calls `acquire`/`release`, never supplies a generation and
  never invents a capability id it was not registered for.
- A supervisor crash cannot corrupt lifecycle state, because it holds none: only
  its own per-worker health counters, which the registry can rebuild from a probe.

## Interface

```ts
export interface CapabilityWorkerSpec {
  readonly executable: string;
  readonly args: readonly string[];
  /** Path as requested; `register` resolves it through `resolveWorkerCwd`. */
  readonly cwd: string;
}

/**
 * The one enforcement point for `cwd`. The supervisor has no default and
 * refuses to register without it, so "inside a registered workspace" is checked
 * by the module that owns workspace roots, not assumed from a comment.
 */
export type ResolveWorkerCwd = (requested: string) => Promise<Result<string>>;

/**
 * The supervisor's whole view of the lifecycle. Implemented by
 * `CapabilityRegistry`; injected so the supervisor holds no reference to the
 * class and a fake port can drive every test.
 */
export interface CapabilityLifecyclePort {
  /** One entry per registered capability, including its own TTL. */
  snapshot(): readonly EvictionCandidate[];
  health(id: string): CapabilityHealth | undefined;
  /**
   * Targeted stop; marks a pending stop when a lease is still held. Async
   * because an unleased id reaches `COLD` only after the `stop` hook returns.
   */
  reclaim(id: string): Promise<Result<void>>;
  /**
   * The only writes a death needs: `ACTIVE|WARM_IDLE -> FAILED` for an
   * unrequested exit, `STOPPING -> FAILED` for `stop-unverified`. Nothing else
   * is a valid `fail` target — in particular a leased `ACTIVE` id is never
   * failed, because a lease may not be shortened.
   */
  fail(id: string, reason: string): Result<void>;
}

export interface CapabilitySupervisorOptions {
  readonly now?: () => number;
  /** Required: the only place a spec's `cwd` becomes trusted. */
  readonly resolveWorkerCwd: ResolveWorkerCwd;
  /** Required: the supervisor cannot report an exit or order a stop without it. */
  readonly lifecycle: CapabilityLifecyclePort;
  readonly processManager?: ProcessManager;
  /** Failure window for crash-loop bounding. */
  readonly crashWindowMs?: number;
  readonly maxCrashRestarts?: number;
}

/**
 * One registry fact `evictionPlan` needs, passed in rather than read: the
 * selection stays a pure function, so the caller supplies what its port
 * already exposes.
 */
export interface EvictionCandidate {
  readonly id: string;
  readonly state: CapabilityState;
  readonly leaseCount: number;
  readonly idleSince: number;
  /** The manifest TTL the clamp compares against. */
  readonly idleTtlMs: number;
  readonly recyclable: boolean;
}

/** What a diagnosis needs; the ring buffer stays in `ProcessManager`. */
export interface CapabilityWorkerHealth {
  readonly id: string;
  readonly processId?: string;
  readonly restarts: number;
  readonly crashLoop: boolean;
  /** A kill was attempted and could not be verified within its deadline. */
  readonly stopUnverified?: boolean;
  readonly lastFailure?: 'start-failed' | 'worker-exited' | 'stop-unverified';
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
  /** Bounded graceful stop of everything this supervisor started, via the port. */
  public shutdown(): Promise<void>;
}
```

`evictionPlan` is deliberately read-only, and its snapshot argument is what
keeps that honest: `WARM_IDLE` membership, lease counts, `idleSince` and
`idleTtlMs` are registry-only facts, so the caller passes
`registry.snapshot()` in and the function stays a pure selection over its input
plus its injected clock. The elevated clamp lives here, not in the registry: the
plan lists an id only when `now() - idleSince >= min(idleTtlMs, 5_000)`, which is
a comparison the snapshot can actually answer. The governor passes the returned
ids to `registry.reclaim(id)`, so the stop is written by the module that owns the
transition. The earlier shape (the supervisor calling back into the registry to
change state) would re-enter a transition while the registry was deciding one,
which the one-way seam below forbids; `reclaim` and `fail` are the two narrow
exceptions and both are registry-validated transitions, not state writes.

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

## Surface required by phase 2

Six pieces of registry surface do not exist at head and are part of this
phase, not of the supervisor:

1. a `start` option that can report failure. Today it is
   `(manifest) => Promise<void> | void` and `start()` coerces the awaited value
   with `.then(() => 'started')`, so a returned `err(...)` would be recorded as
   `ACTIVE` with a dead worker. The option becomes
   `(manifest) => Promise<Result<void>> | Result<void>` and a returned `err`
   writes `FAILED` with the error's message, exactly like a thrown error does
   today. This is a breaking change to one internal option, taken before the
   supervisor exists; the only callers are the 17 `start` callbacks in
   `capability-registry.test.ts`, which the same PR rewrites to return
   `ok(undefined)` for the type check to keep passing;
2. a `stop` hook beside `start`, so `STOPPING -> COLD` can await verified
   termination before the transition is written (today `stop()` is private and
   completes the cycle in one synchronous tick);
3. a public async `reclaim(id)` targeted stop that the governor can ask for with
   the ids `evictionPlan()` returned, since `sweep()` only applies each
   manifest's own `idleTtlMs`. `reclaim` **marks a pending stop**: on an
   `ACTIVE`/`WARM_IDLE` capability with no lease it takes the `STOPPING` edge,
   awaits the new `stop` hook and only then writes `COLD`; when `leaseCount` is
   still positive the registry — the only module holding the count — completes
   the same stop from `releaseLease`. That removes the need for a lease-release
   subscription: a waiter polls `health(id)`, which already reports the state the
   registry wrote. Making the private `stop` awaitable changes the public
   `sweep()` signature to `Promise<void>`, so its existing test call sites are
   updated to `await` it in the same PR;
4. a `burst` default of `idleTtlMs = 0` in `normalizeCapabilityManifest`, so
   `activation: 'burst'` stops on its last release instead of going `WARM_IDLE`
   for the default 60 s. No per-tick TTL override is needed once `reclaim` is
   targeted: `reclaim(id)` stops an id regardless of its TTL, and the elevated
   clamp is applied by `evictionPlan` before any id is passed to it;
5. a read-only `snapshot(): readonly EvictionCandidate[]` that returns one entry
   per registered capability. `health(id)` is per-id, `CapabilityHealth` carries
   neither `idleSince` nor `idleTtlMs`, and the elevated clamp needs both, so
   without this the governor cannot build the input `evictionPlan` needs.
   `EvictionCandidate` is that type: `id`, `state`, `leaseCount`, `idleSince`,
   `idleTtlMs`, `recyclable`;
6. a public `fail(id, reason)` for the worker-exit edge below. The registry owns
   every transition and the supervisor holds no lifecycle state, so an
   unrequested worker exit can only be written by the module that owns the
   transition, on the supervisor's report.

Items 3, 5 and 6 plus the existing `health(id)` are exactly what
`CapabilityLifecyclePort` declares, so the registry implements that interface
directly and the supervisor depends on no class.

Two additions belong to the process package instead, and neither is optional:

- `onExit(processId, listener): () => void` — one notification per process,
  fired from `handleClose`, returning an unsubscribe. `ProcessManager` already
  sees the child exit internally but publishes nothing, and `status()`/`list()`
  are pull-only, so an unrequested exit is invisible without a timer. The
  supervisor subscribes per started id and drops that subscription *before* it
  orders a stop, so the manager's own kill can never be reported as an
  unrequested exit, and the two `FAILED` edges above have a real caller with no
  polling loop introduced.
- `ManagedProcessStart.timeoutMs` accepts `0` meaning "no wall-clock cap", and a
  zero skips the manager's timer. The supervisor always passes `0` and owns
  worker lifetime itself: a resident worker must not be killed by a fixed hour,
  and the bound that replaces it is an explicit one — the manifest's
  `shutdownTimeoutMs`, the crash-loop refusal, and `reclaim`. A nonzero value
  keeps today's meaning, so no existing caller changes.

Items 1–5 add surface and change no transition. Item 6 is the exception and is
listed here for exactly that reason: it adds the two `FAILED` edges below, which
phase 1's table does not contain, so the phase-2 PR needs the guard tests for
those two edges and nothing else in the table moves.

Phase 1's table has no edge out of a running state on worker death:

```text
ACTIVE     -> WARM_IDLE | STOPPING
WARM_IDLE  -> ACTIVE | STOPPING
```

A real worker can exit on its own. Phase 2 adds exactly two edges, both with a
reason that names the exit and both written through `fail(id, reason)` from
registry change 6. The trigger is a subscription, not a poll: the supervisor
keeps the `processId` it started and subscribes with the one small
`@unified-mpc/process` addition below, then calls
`port.fail(id, 'worker-exited')` from the listener:

```text
ACTIVE     -> FAILED   (reason 'worker-exited')
WARM_IDLE  -> FAILED   (reason 'worker-exited')
```

Nothing else changes: `FAILED -> COLD` already exists for recycling, `acquire`
still refuses `FAILED`, and the phase-1 tests for every other edge stay as they
are.

`onExit` fires from `handleClose`, which also runs for a kill the manager was
asked to perform, so the listener is a reporter with a guard rather than a
transition: it reads `port.health(id)` and writes `fail(id, 'worker-exited')`
only while the state is still `ACTIVE` or `WARM_IDLE`. A stop already in
flight (`STOPPING`, `FAILED`, `COLD`) means the exit is expected, so it is
ignored and never counted toward the crash-loop bound.

`STARTING` is the one state that needs its own handling rather than
"ignore": the registry writes `ACTIVE` only after the supervisor's `start` hook
resolves, so a death inside the start window would otherwise be dropped and the
registry would write `ACTIVE` over a dead worker. The supervisor records the
pending exit per id and its `start` hook then returns `err`, which is the same
`STARTING -> FAILED` path a failed spawn already takes; nothing new is added to
the transition table. Both halves of the stop guard are required — the
subscription is dropped before the supervisor calls `ProcessManager.stop()`, and
the guard holds even if a fake or a future manager delivers the notification
first, so no ordering between the two decides whether a clean stop is written as
a crash.

The alternative — treating a dead worker as `STOPPING -> COLD` — would let an
unrequested exit look like a clean shutdown and hide it from `health()`.

`FAILED -> COLD` recycle stays caller-owned: `registry.recycle(id)` never
re-reads durable artifacts itself, and the supervisor does not read them either,
because the registry is never persisted (matching phase 1).

## Crash-loop bounding

Every failure is counted per capability inside `crashWindowMs`. Exceeding
`maxCrashRestarts` is not a new state and does not invent a transition reason the
registry never writes: the capability stays `FAILED`, `acquire` already returns a
conflict for `FAILED`, and the supervisor's own `health()` reports the count and a
`crashLoop: true` flag for that id. The registry has no counter and none is added.
**No automatic restart loop is allowed to be unbounded** — that is the failure
mode a supervisor exists to prevent, so the bound is configuration with a default
(5 failures in 60 s) rather than caller policy.

Ownership is explicit: **phase 2 never restarts on its own**. There is no periodic
restart timer in the supervisor and no retry inside `start`; the only deadlines it
schedules are the spawn, stop and shutdown bounds described below and in
"Shutdown", which bound an attempt instead of starting a new one. A restart is the
caller's next
attempt: `registry.recycle(id)` (`FAILED -> COLD`) followed by `acquire`, so the
fence and the lease rules keep applying; `acquire` alone still refuses `FAILED`,
exactly as phase 1 pinned it. The bound exists to refuse that path once the
window is exhausted.

The supervisor does own its spawn deadline, because the registry's
`startupTimeoutMs` race only abandons the hook and never aborts it. `start` races
`ProcessManager.start` against `manifest.startupTimeoutMs`; if the spawn settles
after the registry already wrote `FAILED`, the supervisor does not store an
orphaned `processId` — it stops that process immediately with
`ProcessManager.stop()` and reports the late failure through `health()`. No
unleased worker outlives the attempt that started it.

## Pressure policy

| pressure | warm-idle TTL | `evictionPlan` | new large starts |
| --- | --- | --- | --- |
| `normal` | manifest `idleTtlMs` | none | allowed |
| `elevated` | clamp to `min(idleTtlMs, 5_000)` | `WARM_IDLE`, unleased, `now - idleSince >=` the clamped TTL, oldest first | allowed |
| `critical` | `0` | every unleased `WARM_IDLE` immediately, TTL ignored | refused by admission |

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
function, the `reclaim` it hands ids to, and no polling loop of its own; wiring a
driver (goal
runtime heartbeat or workspace session tick) is phase 3, so that driver is a
wiring change, not new surface.

## Burst concurrency

Phase 1 left this open. Decision: **no queue in phase 2**. A second `acquire`
while a burst capability is `STOPPING` is refused with a retryable conflict. A
queue here would need fairness, backpressure and its own lease to be correct;
none of that exists, and a busy host should shed burst work rather than stack it
in memory.

A burst worker still exits only through the stop hook: phase 1's "exits after its
work" is honoured by the registry taking the stop edge on the last release (the
`idleTtlMs = 0` default above), not by the child deciding it is done. A child
that exits on its own is `worker-exited` → `FAILED` and counts toward the
crash-loop bound for every activation, including `burst`; treating it as success
would hide a real crash and needs a reason the registry does not have.

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
- `shutdown()` reads `port.snapshot()`, stops `WARM_IDLE` first, then awaits
  `port.reclaim(id)` for the remaining ids; a leased one completes its pending
  stop when `releaseLease` writes it (registry change 3), so the wait is a
  `port.health(id)` poll against one global deadline. The deadline bounds three
  different outcomes, and they must not be conflated:
  - an id that reached `STOPPING` and whose termination could not be verified is
    written `FAILED` with `stop-unverified` through `port.fail`;
  - an id killed during its own stop window but still leased stays `ACTIVE`:
    leases are never shortened, so the supervisor writes no transition and
    reports `stopUnverified: true` from `health()` while the lease holder keeps
    the capability it is using;
  - `ProcessManager` already attempted its own SIGTERM/SIGKILL escalation inside
    `ProcessTreeTerminator`, and the supervisor has no second kill primitive, so
    the honest outcome for a missed deadline is "kill attempted, may be
    unverified", not "killed".

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
   `FAILED` with reason `worker-exited` through `fail(id, reason)`, driven by the
   fake manager's `onExit` notification; a death delivered inside the `STARTING`
   window instead makes the supervisor's `start` hook return `err`, so the
   registry writes `FAILED` on its existing `STARTING -> FAILED` path and never
   writes `ACTIVE` over a dead worker; a fake manager that delivers `onExit`
   for the kill the supervisor itself ordered writes no `FAILED` and raises no
   crash count, because the guard is the contract and not the ordering; the
   subscription is released by that `stop`;
4. `evictionPlan('elevated', snapshot)` lists only unleased `WARM_IDLE` ids whose
   `now - idleSince` reached `min(idleTtlMs, 5_000)`, oldest first, and never
   lists `recyclable: false`, with the snapshot supplied by a fake port so the
   function is proven pure;
5. `evictionPlan('critical', snapshot)` lists every unleased `WARM_IDLE` whatever
   its TTL; the `RESOURCE_PRESSURE` refusal it relies on is asserted in
   `packages/workspace` next to `ResourceAdmission`, not here, because
   `capabilities` must not import that package;
6. crash-loop bounding: after `maxCrashRestarts` failures inside the window the
   supervisor reports `crashLoop: true` from `health()` and its `start` refuses
   without spawning; the registry keeps `FAILED` and writes no invented reason;
7. `stop` that exceeds `shutdownTimeoutMs` abandons the await, reports
   `stop-unverified`, never `COLD`, and leaves `ProcessManager`'s
   `termination_unverified` state visible instead of claiming a kill;
8. `shutdown()` stops idle capabilities first, waits for a leased capability's
   pending `reclaim` to complete on its last release, and returns inside the
   global deadline even when one capability ignores its grace period;
9. spawn bounds: the supervisor passes `timeoutMs: 0`, a spawn that settles after
   the registry's `startupTimeoutMs` is stopped instead of stored, and a worker
   that outlives several hours is not reported as `timed_out`.

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

- Should the elevated TTL clamp move from `evictionPlan` into #13's governor
  policy? It is decided here on purpose: the clamp is a comparison over
  `idleTtlMs` and `idleSince`, so the pure plan is the only place that can apply
  it without a new registry parameter. Moving it later means the governor selects
  ids itself and passes them to `reclaim`.
- Should a `FAILED -> COLD` recycle stay an explicit `recycle(id)`? Phase 1 pins
  it that way and `acquire` refuses `FAILED`, so phase 2 keeps it explicit; an
  automatic recycle would be a separate registry change with its own test.
- When a worker is spawned, should its stdout/stderr stream into the supervisor's
  `health()` or stay only in `ProcessManager`'s ring buffer? The ring buffer
  already bounds the memory; the supervisor should read it lazily by
  `processId`, not copy it.
