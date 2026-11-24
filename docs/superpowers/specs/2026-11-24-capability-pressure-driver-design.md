# On-demand capability runtime — phase 3: the pressure driver and the first supervised worker

Status: design. Implements phase 3 of #133 on top of the phase-2 supervisor
(`docs/superpowers/specs/2026-11-24-capability-supervisor-design.md`).

Phase 2 shipped the supervisor, the registry lifecycle port, `evictionPlan` and
`reclaim`, and deliberately shipped no driver: nothing in the tree calls
`evictionPlan` outside a test, and no capability is a real child process, so a
registry constructed today would enforce nothing. This spec closes both gaps at
once, because a driver with no worker to evict and a worker with no driver are
each half a feature.

Every statement below is written against the tree at `823ed39`. Where a claim is
about code that exists, the file and the fact are named so a reviewer can check
it rather than trust it.

## Decision

1. The first supervised worker is the **native Thai-RAG provider** — the
   `venv/bin/python3 thai_rag_context_mcp.py` child the runtime launches today.
2. The seam is a **`ProcessManager`-backed `McpClientFactory`**. `McpSessionManager`
   already accepts an injected factory (`packages/extensions/src/mcp-session-manager.ts:21`),
   so the provider's child moves under `ProcessManager` without the provider
   driver, its admission rules or its restart semantics changing at all.
3. The driver is a **runtime-owned interval sweep** in
   `apps/cli/src/runtime/stdio-mcp-runtime.ts`, following the pattern the runtime
   already uses for the heavy-job queue (`heavyJobQueueRecoveryTimer`, line 1492):
   one `setInterval`, `unref()`ed, a `try`/`catch` per tick, no new module surface.
4. Phase 3 adds **one** process-package capability: a caller-owned stdio hook on
   `ProcessManager.start`, because `ProcessManager` today consumes `stdout`/`stderr`
   into its log ring buffer (`packages/process/src/process-manager.ts:99-100`) and
   returns only a snapshot, so no MCP client can attach to a supervised child.

## Why this worker, and not the other two candidates

The #133 acceptance criteria name the target: "Thai-RAG, Code Intelligence and
Context Assurance use this lifecycle rather than bespoke always-on daemons". The
provider is also the only child in the tree whose resident lifetime is a real
memory cost: it stays warm after indexing and it spawns `llama-server` itself.

The alternatives were checked and rejected on evidence, not taste:

- **Shell heavy runs.** `packages/capabilities/src/shell-backend.ts` spawns
  directly with `node:child_process` (line 480) and carries durable task parking,
  heartbeats, owner reconciliation and restart re-attachment around that spawn.
  Moving it under the supervisor means re-proving every one of those semantics
  against a new spawn path, for a capability whose work is burst-shaped and
  therefore the *least* valuable thing to keep warm or reclaim.
- **The native host bridge.** `NativeHostProcessBridge` already has the injection
  seam we would want (`NativeHostSpawner`), but it is not live in production:
  `createPlatformCapabilitySet` is called without `nativeHost`
  (`apps/cli/src/runtime/stdio-mcp-runtime.ts:2017`), so the platform backends
  fall back to `unavailable`, and `LinuxProcessBridge` requires an
  integrity-bound packaged binary (`packages/capabilities/src/linux-process-bridge.ts:5-14`).
  Supervising it would first require a packaging story that phase 3 does not own.

## Seam

```text
NativeThaiRagProviderDriver            (unchanged: admission, anchors, retries)
        │  sessions.call(...) / describe(...)
        ▼
McpSessionManager (×3: sessions, index, probe)      (unchanged)
        │  clientFactory.connect(config)            ← the one injected seam
        ▼
ProcessManagerMcpClientFactory          (new, apps/cli/src/runtime)
        │  registry.acquire('thai-rag-provider')    → lease
        │  supervisor.start(manifest)               → ProcessManager child
        │  MCP client over the child's stdio
        ▼
CapabilityRegistry ──start/stop──▶ CapabilitySupervisor ──▶ ProcessManager
        ▲                                                       │
        │ snapshot()/reclaim()                                  │ onExit
        └───────────── pressure driver (runtime tick) ───────────┘
```

The provider driver keeps speaking MCP to a session manager. What changes is who
owns the process behind that session: the supervisor, through the registry, so a
reclamation order and a provider call can no longer race on the same child.

## The one process addition

`ProcessManager` must hand the child's stdio to the caller that needs it, without
losing the log ring buffer that `health`/diagnostics read. The interfaces are in
`packages/process/src/process-types.ts`, and `ManagedProcess` carries no streams
today (lines 15-25).

```ts
interface ManagedProcessStart {
  // … existing fields
  /** `false` keeps today's behaviour: pipes are drained into the log ring buffer only. */
  readonly exposeStdio?: boolean;
}

// start() gains no new parameter; the created child is announced through the
// existing onCreated callback, which now carries the streams when the spec asks.
interface ManagedProcess {
  readonly stdin?: Writable;
  readonly stdout?: Readable;
  readonly stderr?: Readable;
}
```

Rules the addition must keep:

- With `exposeStdio` absent or `false`, nothing changes: both pipes are still
  consumed by the ring buffer, and `ManagedProcess` carries no streams.
- With `exposeStdio: true`, both pipes are *teed*: the ring buffer still receives
  every chunk, and the caller's transport receives the same chunks. Diagnostics
  must not go blind because a worker became supervised.
- The supervisor passes `exposeStdio: true` only for a worker whose spec declares
  it needs a transport. A plain `executable`+`args` worker (the phase-2 shape)
  keeps the default.
- No new public method on `ProcessManager`; `onExit` and `status` keep their
  phase-2 contracts.

## The factory

`ProcessManagerMcpClientFactory implements McpClientFactory` and is constructed
with `{ registry, supervisor, manifestId, launch }`, where `launch` carries the
executable, args and cwd the runtime already computes for the provider.

`connect(config, signal)`:

1. `registry.acquire(manifestId)` — this is the lease. A refusal (crash loop,
   `FAILED`, a stop in flight) surfaces as the same connection failure the
   driver already handles, not as a new error type.
2. The registry's start hook calls `supervisor.start(manifest)`, which spawns
   through `ProcessManager` and subscribes `onExit` as phase 2 defined.
3. The factory builds an MCP client over the supervised child's stdio and
   performs the existing handshake (`describe`/version validation stays in
   `McpSessionManager`).
4. The returned session's `close()` releases the lease. A lane the manager closes
   on idle timeout releases only that lane's own lease; because the pinned main
   lane holds one for the driver's whole lifetime, the worker stays `ACTIVE`.
   `WARM_IDLE` is reached only when every lease is gone, which for this worker is
   the driver's own close, not an idle timer.

One factory instance serves all three managers; each `connect` takes its own
lease, so the index lane cannot be evicted while a probe lane is idle.

## Worker manifest

```ts
{
  id: 'thai-rag-provider',
  provides: ['pre_edit_context', 'code_index', 'code_search', 'code_context'],
  runtimeKind: 'external-process',
  activation: 'on-demand',
  costClass: 'large',
  idleTtlMs: 5 * 60_000,   // 5 min: only releaseIdle's zero-check and evictionPlan's 5 s clamp read it
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000,
  recyclable: true,
  generationFenced: false,
}
```

`recyclable: true` is the point of the whole phase: an idle provider must be
stoppable under pressure and start again on the next call. The provider is
restartable by design — `McpSessionManager` already reconnects, and the driver's
restart tests (`native-thai-rag-provider.test.ts`) cover provider loss — so
recycling it costs a cold start, not correctness.

`idleTtlMs` is not a copy of any lane's idle close, and it is not a warm-window
ceiling either. The provider pins the session that holds the worker
(`apps/cli/src/runtime/native-thai-rag-provider.ts:554`), and
`McpSessionManager`'s idle sweep skips pinned servers
(`packages/extensions/src/mcp-session-manager.ts:432-438`), so the main lane is
never closed by idle at all; only the unpinned index (24 h) and probe (60 s)
managers age out (`native-thai-rag-provider.ts:404,412`).

Two readers see `idleTtlMs`. `releaseIdle` stops the worker synchronously only
when the value is `0`, and otherwise lands it in `WARM_IDLE`
(`packages/capabilities/src/capability-registry.ts:653-665`). `evictionPlan`
clamps it to 5 s under `elevated` and does not consult it under `critical`
(`packages/capabilities/src/capability-supervisor.ts:362-372`). `registry.sweep()`
would stop a worker whose TTL elapsed
(`packages/capabilities/src/capability-registry.ts:415-426`), but nothing in
production calls it, and the driver tick below calls `snapshot()` and `reclaim()`
only. The 5-minute value therefore bounds nothing: a released worker stays up
until a pressure tick reaches it — the same unbounded class as the
never-released lease this spec already admits — and closing it needs a `sweep()`
call from the tick, or a lease deadline in the registry, not a different TTL.

## cwd containment

`CapabilitySupervisor` refuses to register without `resolveWorkerCwd`, and the
provider's cwd is not a workspace root: the runtime launches it from
`thaiRagInstallRoot` (`apps/cli/src/runtime/stdio-mcp-runtime.ts:530-535`), the
checkout that holds `thai_rag_context_mcp.py`.

Decision: the runtime's `resolveWorkerCwd` accepts exactly two shapes — a
canonical registered workspace root, or the canonical provider install root the
runtime itself resolved. It is one function with one allowlist entry, not a
second containment check, and it refuses everything else. A worker whose cwd is
neither is a registration failure, reported at boot rather than at first call.

## The driver

One tick, five steps. Its only state is the map of sessions it opened:

```text
sample  ProcessMemoryPressureProbe.sample()      → 'normal' | 'elevated' | 'critical'
map     tier === 'normal' ? skip : tier
plan    supervisor.evictionPlan(tier, registry.snapshot())
        plus every recyclable id of costClass 'large' that the driver holds
        sessions for and that evictionPlan did not return
reclaim for each planned id: await registry.reclaim(id)
                                  → WARM_IDLE stops now; a leased id gets pendingStop
release for each reclaimed id: close the driver's recorded sessions for it
                                  → the last release runs the stop
```

`evictionPlan` alone cannot evict this worker: it returns `WARM_IDLE` ids with
`leaseCount === 0` (`packages/capabilities/src/capability-supervisor.ts:362-372`),
and the pinned main lane holds a lease for the driver's lifetime. The second
selection is the driver's own, and it is why the driver keeps the map: the
registry counts leases but does not name their holders (`leaseCount` is an
anonymous counter, `packages/capabilities/src/capability-registry.ts:101`), so
nothing upstream can say which session to close. `shutdown()` already applies
the same idea to every `WARM_IDLE` then `ACTIVE` id
(`capability-supervisor.ts:390-406`); a tick doing it under pressure is the
phase-3 addition.

Details that decide whether it is safe:

- **Interval.** 30 s, `unref()`ed, started after the runtime's existing recovery
  promises settle, never awaited by boot. One interval per process, cancelled in
  the runtime's shutdown path beside `heavyJobQueueRecoveryTimer`.
- **Overlap.** A tick that is still running makes the next tick a no-op (`let
  sweeping = false`), so a slow `reclaim` cannot stack.
- **Failure isolation.** A rejected `reclaim` is logged and skipped; the next
  tick retries. The driver never throws into the interval.
- **One new surface, and it is driver-local.** The driver reads `snapshot()`,
  calls `reclaim(id)` and closes sessions it opened itself; it adds no registry
  or supervisor method. The map is `manifestId → Set<close()>`: written on
  `connect`, removed on the session's own `close()`. It is the only way to
  attribute a lease, because `acquire` hands the caller an opaque
  `CapabilityLease` (`capability-registry.ts:345`) and the registry keeps a
  count. `PressureTier` is structurally identical to `ResourcePressureState`
  (`packages/workspace/src/resource-pressure.ts:4`), so the mapping is an
  assignment, not a table.
- **Leased workers.** `reclaim` on a leased id records a `pendingStop`
  (`capability-registry.ts:502-505`) and the stop runs on the last release
  (`capability-registry.ts:477-490`). This worker is always in that shape: the
  pinned main lane holds one lease for the driver's lifetime, so eviction is a
  two-part step — `reclaim(id)`, then close the driver's recorded sessions for
  that id, and the last release runs the stop. Without the second part the
  provider is un-evictable, which is the leak this phase narrows below.
- **Calls in flight are not drained.** Closing a session does not wait for its
  queue (`McpSessionManager.drop` closes and returns,
  `packages/extensions/src/mcp-session-manager.ts:415-422`), so a call running
  when pressure closes its lane fails the way a crashed child fails, and the
  provider's existing restart path retries it. Eviction is therefore not
  transparent to a concurrent caller; it is the same failure the worker already
  has to survive.

## What this phase does not bound

Phase 2 left one leak open and this phase narrows it rather than closing it: a
resident worker whose lease is held by a caller the driver does not own has no
deadline. The driver's `reclaim` becomes a `pendingStop` and waits for a release
that may never come, and the driver can only close sessions it opened. The
provider is not in that class — every lane that leases it was created by the
driver's factory, so the tick can close them — but a future worker leased
directly by callers would be. That is observable: `health(id)` keeps reporting
the live worker and its lease count, and it is bounded to one worker per id,
because the registry starts only from `COLD`.

Closing it needs a lease deadline, which is a registry concept (a lease that
expires) and not a driver concept. It stays out of phase 3 on purpose: expiring
a lease under a caller that is still using it turns a leak into a correctness
bug. Recorded as an open question, not as a promise.

## What must not change

- Provider admission, source-identity anchors, index generations and the
  "cannot restart after stop" refusal in `NativeThaiRagProviderDriver`.
- `McpSessionManager`'s launch fingerprints, tool-catalog validation, idle close
  and per-session queue.
- The phase-2 supervisor interface: `register`, `start`, `stop`, `evictionPlan`,
  `health`, `shutdown` keep their signatures.
- `ProcessManager`'s default behaviour for every existing caller.

## Verification

- `ProcessManager`: `exposeStdio: true` still fills the log ring buffer; without
  it, `ManagedProcess` carries no streams; a stream consumer that stops reading
  cannot wedge the ring buffer.
- `ProcessManagerMcpClientFactory`: acquire-then-connect ordering, lease released
  on close, a refused acquire surfaces as a connection failure, and two managers
  hold two leases for one worker.
- Registry/supervisor integration: a reclamation order on a leased worker becomes
  `pendingStop` and runs on the last release; `WARM_IDLE` under `elevated`
  respects the 5 s clamp; `critical` evicts an idle worker immediately.
- Driver: normal tier reclaims nothing; a slow reclaim does not stack ticks; a
  rejected reclaim does not stop the interval; shutdown cancels the timer; the
  session map drops an entry when that session closes.
- Provider end-to-end: with the factory injected, a provider call starts a
  supervised child and records its session under the id; `evictionPlan` alone
  returns nothing for it while the main lane is pinned (the regression this
  design exists to avoid); a critical sample takes the driver's own selection,
  reclaims the id, closes the recorded sessions, the pending stop runs, and the
  next call starts a new child; an idle close on an unpinned lane releases only
  that lane's lease and leaves the worker `ACTIVE`.
- `verify:local --pr <n>` on the exact head, plus the exact-head review capsule,
  as the repository requires.

## Non-goals

- Supervising the shell backend, the browser backend or the native host.
- A lease deadline, or any expiry of a live lease.
- A pressure queue, admission change or backpressure policy: admission keeps
  refusing with `RESOURCE_PRESSURE` exactly as `ResourceAdmission` does today.
- Moving `llama-server` under supervision. It is the provider's own child; phase
  3 supervises the provider, and a nested worker is a later question.
- Any model-lifecycle work.

## Open questions

1. **Lease deadline.** The one unbounded case above. Needs a registry concept
   (lease expiry with generation fencing) and a caller contract for "your lease
   may end". Phase 4 at the earliest.
2. **`llama-server` as a nested worker.** The provider spawns it from PATH and
   owns its lifetime. If pressure reclamation must reach it, the provider has to
   expose that child, which is a provider-contract change, not a runtime one.
3. **Second worker.** Code Intelligence and Context Assurance share the provider
   process today, so the next real worker id is whichever of them stops sharing
   it. Nothing in this spec assumes one.
