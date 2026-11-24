# On-demand capability runtime — phase 3: the pressure driver and the first supervised worker

Status: design. Implements phase 3 of #133 on top of the phase-2 supervisor
(`docs/superpowers/specs/2026-11-24-capability-supervisor-design.md`).

Phase 2 shipped the supervisor, the registry lifecycle port, `evictionPlan` and
`reclaim`, and deliberately shipped no driver: nothing in the tree calls
`evictionPlan` outside a test, and no capability is a real child process, so a
registry constructed today would enforce nothing. This spec closes both gaps at
once — a driver with no worker to evict and a worker with no driver are each half
a feature — and then states the one thing it cannot do: the first worker is
pinned, so pressure cannot evict it yet.

Every statement below is written against the tree at `acd7fb5`, this branch's
base; `capability-supervisor.ts` gained the worker-pipe accessor in `acd7fb5`, so
the ranges it cites were re-checked there, and the other cited files are
unchanged on `main`. Where a
claim is about code that exists, the file and the fact are named so a reviewer
can check it rather than trust it.

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
lease. An idle probe lane therefore releases only its own lease — the worker stays
leased by the pinned main lane, so a lane closing is never what frees it.

## Worker manifest

```ts
{
  id: 'thai-rag-provider',
  provides: ['pre_edit_context', 'code_index', 'code_search', 'code_context'],
  runtimeKind: 'external-process',
  activation: 'on-demand',
  costClass: 'large',
  idleTtlMs: 5 * 60_000,   // 5 min: read by releaseIdle's zero-check, evictionPlan's 5 s clamp, and sweep()
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000,
  recyclable: true,
  generationFenced: false,
}
```

`recyclable: true` is what the phase needs: an idle provider is restartable, so
stopping it costs a cold start, not correctness. Restart is not automatic,
though. `McpSessionManager.ensure` reuses an entry whose launch fingerprint still
matches and does not probe the transport
(`packages/extensions/src/mcp-session-manager.ts:296-300`), and a provider call
has no retry around `sessions.call`
(`apps/cli/src/runtime/native-thai-rag-provider.ts:2364-2371`): after the child
dies the next call fails and only writes a journal line. A fresh child therefore
needs the manager entry dropped — which deletes it, so the next `ensure`
connects — not a raw session close, and not a fresh acquire alone.

`idleTtlMs` is not a copy of any lane's idle close, and it is not a warm-window
ceiling either. The provider pins the session that holds the worker
(`apps/cli/src/runtime/native-thai-rag-provider.ts:554`), and
`McpSessionManager`'s idle sweep skips pinned servers
(`packages/extensions/src/mcp-session-manager.ts:432-438`), so the main lane is
never closed by idle at all; only the unpinned index (24 h) and probe (60 s)
managers age out (`native-thai-rag-provider.ts:404,412`).

Three readers see `idleTtlMs`. `releaseIdle` stops the worker synchronously only
when the value is `0`, and otherwise lands it in `WARM_IDLE`
(`packages/capabilities/src/capability-registry.ts:654-666`). `evictionPlan`
clamps it to 5 s under `elevated` and does not consult it under `critical`
(`packages/capabilities/src/capability-supervisor.ts:400-411`). `registry.sweep()`
stops a `WARM_IDLE` worker once the TTL elapsed
(`capability-registry.ts:415-426`), but nothing in production calls it, and the
driver tick below calls `snapshot()` and `reclaim()` only. The 5-minute value
therefore bounds nothing: a released worker stays up until a pressure tick
reaches it, and closing it needs a `sweep()` call from the tick or a lease
deadline in the registry, not a different TTL.

## cwd containment

`CapabilitySupervisor` refuses to register without `resolveWorkerCwd`, and the
provider's cwd is not a workspace root: the provider driver rewrites its launch
to `cwd = <dataRoot>/thai-rag/sources` and adds `THAI_RAG_CACHE_DIR` and
`THAI_RAG_CONTROL_MODE: unified_native` at `start()`
(`apps/cli/src/runtime/native-thai-rag-provider.ts:454-467`), so the install
root — the checkout holding `thai_rag_context_mcp.py` — is where the executable
and args come from, not where the child runs.

Decision: the runtime's `resolveWorkerCwd` accepts exactly three shapes — the
provider install root the runtime itself resolved, the provider-owned sources
root, or a registered workspace root. Each side of the comparison is
`realpath`-normalized where it resolves; an unreadable root falls back to the
path as given (`capability-pressure.ts:147-163`), so equality is canonical for
the boot paths that exist and literal only for the broken ones. The sources root
is a fixed path derived from the data root (`stdio-mcp-runtime.ts:520-524`),
created by the runtime at boot because the provider creates it later, and handed
to the resolver as its only extra root (`:558`); it is never user input. When
`resolveThaiRagProviderRoot` fails that derivation falls back to the install
root (`:521-524`), so the extra root then duplicates shape 1 and no `mkdirSync`
runs. It is one function with one allowlist, not a second containment check, and
it refuses everything else, including a nested path under an accepted root or a
sibling beside one. A worker whose cwd is none of these is a registration
failure, reported at boot rather than at first call.

## The driver

One tick, four steps, no state of its own:

```text
sample  ProcessMemoryPressureProbe.sample()      → 'normal' | 'elevated' | 'critical'
map     tier === 'normal' ? skip : tier
plan    supervisor.evictionPlan(tier, registry.snapshot())
reclaim for each id: await registry.reclaim(id)   → WARM_IDLE stops now,
                                                    a leased id only gets pendingStop
```

What that tick can actually reach, stated plainly: unleased `WARM_IDLE` workers.
`evictionPlan` returns `WARM_IDLE` ids with `leaseCount === 0`
(`packages/capabilities/src/capability-supervisor.ts:400-411`), so the provider —
pinned by a lane that holds a lease for the driver's lifetime — is never in the
plan. On it, `reclaim` only records `pendingStop`
(`packages/capabilities/src/capability-registry.ts:497-506`), and the stop runs on
the last release (`capability-registry.ts:477-490`), which that pin never
performs. **The provider is therefore not evictable in this phase.** Making it
evictable needs two things this phase does not have, and inventing them in the
driver is what earlier drafts of this section got wrong:

1. **Holder attribution.** Leases are an anonymous count
   (`capability-registry.ts:101`) and `acquire` hands back an opaque
   `CapabilityLease` (`:345`), so nothing can say which session to close.
2. **A manager-level lane close.** Dropping the transport is not enough: `ensure`
   reuses an entry whose launch fingerprint matches and never probes it
   (`packages/extensions/src/mcp-session-manager.ts:296-300`), and a provider call
   has no retry (`apps/cli/src/runtime/native-thai-rag-provider.ts:2364-2371`).
   The close has to delete the manager entry so the next `ensure` connects, which
   is `drop` (`mcp-session-manager.ts:417-422`) — private today, and pinned lanes
   are skipped by the idle sweep (`:432-438`).

Both are phase-4 work; the phase-3 deliverable is the tick above plus the
manifest, factory and cwd decisions around it.

Details that decide whether it is safe:

- **Interval.** 30 s, `unref()`ed, started after the runtime's existing recovery
  promises settle, never awaited by boot. One interval per process, cancelled in
  the runtime's shutdown path beside `heavyJobQueueRecoveryTimer`.
- **Overlap.** A tick that is still running makes the next tick a no-op (`let
  sweeping = false`), so a slow `reclaim` cannot stack.
- **Failure isolation.** A rejected `reclaim` is logged and skipped; the next
  tick retries. The driver never throws into the interval.
- **No new surface.** The driver reads `snapshot()` and calls `reclaim(id)`; it
  adds no registry or supervisor method. `PressureTier` is structurally identical
  to `ResourcePressureState` (`packages/workspace/src/resource-pressure.ts:4`), so
  the mapping is an assignment, not a table.
- **Repeating `reclaim` is harmless.** A non-recyclable id, or one not in
  `ACTIVE`/`WARM_IDLE`, returns `ok`; a leased id rewrites the same
  `pendingStop` string, which the last release clears
  (`capability-registry.ts:497-506`, `:477-490`). A tick that retries a
  still-blocked id changes nothing.

## What this phase does not bound

Phase 2 left one leak open and this phase does not close it: a resident worker
whose lease is never released has no deadline. The driver's `reclaim` becomes a
`pendingStop` and waits for a release that never comes. That is observable —
`health(id)` keeps reporting the live worker and its lease count — and it is
bounded to one worker per id, because the registry starts only from `COLD`.

The provider is in that class for its whole life, by design: the driver pins the
lane that holds the worker (`native-thai-rag-provider.ts:554`) and unpins it only
in the stop path (`:711`). Eviction waits on the two phase-4 pieces above, not on
a different TTL.

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
  respects the 5 s clamp; `critical` evicts an idle worker immediately; a second
  `reclaim` on the same leased id is a no-op.
- Driver: normal tier reclaims nothing; a slow reclaim does not stack ticks; a
  rejected reclaim does not stop the interval; shutdown cancels the timer.
- Provider, negative case only: with the factory injected, a provider call starts
  a supervised child and the pinned main lane holds its lease; `evictionPlan`
  returns nothing for the id at any tier, and `reclaim` leaves the worker
  `ACTIVE` with `pendingStop` set — the regression guard for the phase-4 gap this
  spec records. An idle close on an unpinned lane releases only that lane's lease
  and also leaves the worker `ACTIVE`.
- `verify:local --pr <n>` on the exact head, plus the exact-head review capsule,
  as the repository requires.

## Non-goals

- Supervising the shell backend, the browser backend or the native host.
- Evicting a pinned, leased worker. The provider stays un-evictable under
  pressure until holder attribution and a manager-level lane close exist; the
  tick's reach is unleased `WARM_IDLE` workers only.
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
