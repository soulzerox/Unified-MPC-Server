# On-demand capability runtime — phase 1: manifest and lifecycle

Date: 2026-11-23
Issue: [#133](https://github.com/soulzerox/Unified-MPC-Server/issues/133)

## Decision

#133 asks for a microkernel-style runtime where heavy capabilities start on
demand, stay warm only while useful, and are recycled under pressure. That is
three separable problems, and only the first one is a data-shape problem:

1. **A capability manifest** — what a capability is, what it needs, and what it
   costs. This is the contract every later phase reads.
2. **A lifecycle registry** — the states a capability moves through, the leases
   that keep it alive, and the generation fence that stops a stale worker from
   publishing.
3. **A worker supervisor and pressure governor** — spawning, killing, and
   evicting real processes against real RSS.

This document designs **1 and 2 only**. Phases 2 and 3 stay open on #133; they
need a process supervisor and a memory signal, neither of which exists in this
repository yet.

The reason to split this way: #142's last definition-of-done item ("heavy gate
checks are on-demand capabilities under #133") is blocked on the manifest
contract, not on process management. A manifest plus a registry that enforces
lease and generation rules is enough to make a gate check *declarable* as an
on-demand capability, and it is testable with a fake clock and no child
processes.

## What exists today

- `packages/capabilities/src/capability-descriptors.ts` already describes every
  tool-level capability with `availability: 'always' | 'windows' | 'optional'`,
  `requirements`, `permission`, `supportsCancel`, `supportsDryRun` and
  `auditTarget`. That vocabulary is tool availability, not runtime residency; it
  has no lifecycle, no lease and no cost model.
- `packages/capabilities/src/async-ttl-cache.ts` is the closest existing
  warm-idle primitive: entries expire against an injected clock.
- `docs/superpowers/specs/2026-10-30-heavy-*.md` already define admission and
  queueing for heavy shell work. Those designs admit *requests*; they do not
  describe resident capability processes.
- There is no capability registry, no capability lease counter and no capability
  supervisor anywhere in `packages/`. Lease-like machinery does exist for other
  purposes — admission leases with generations in `tool-registry.ts`, managed
  resource bindings in `packages/storage` — and this document does not reuse or
  replace them.

So phase 1 is greenfield, and the cheapest honest deliverable is a manifest
type plus an in-process registry with the transition rules pinned by tests.

## Manifest contract

One record per capability, validated at registration, immutable afterwards:

```text
id                  stable string, unique in the registry
version             integer, bumped on any contract change
provides            non-empty string[] of capability tokens this worker answers
requires            string[] of ids/tokens that must be resolvable first
runtimeKind         'in-process' | 'native-worker' | 'external-process'
activation          'always' | 'on-demand' | 'burst'
costClass           'small' | 'medium' | 'large'   (advisory, for phase 3)
idleTtlMs           warm-idle lifetime; 0 means stop immediately on last release
startupTimeoutMs    bound on STARTING -> ACTIVE
shutdownTimeoutMs   graceful bound before a forced kill (phase 2 uses it)
recyclable          boolean; false pins the capability for the process lifetime
generationFenced    boolean; true requires a generation on every acquire
healthProbe         optional id of a registered probe
```

`runtimeKind` and `activation` are the fields that make phase 1 useful without a
supervisor: an `in-process` capability still gets lease accounting and warm-idle
reclamation, and `activation: 'burst'` documents intent even before phase 2 can
enforce it.

`costClass` and `shutdownTimeoutMs` are recorded now because changing the
manifest later is a `version` bump. Enforcing `shutdownTimeoutMs` is phase 2's
job, because it only matters once something can be killed; `costClass` is
advisory until phase 3 has a pressure signal to weigh it against.

`costClass` is deliberately not called `resourceClass`: that name already means
the admission class of a *request* (`goal_process`, `delegated_agent`,
`rag_indexing`) in the existing admission code, and the manifest describes a
resident capability instead. Two vocabularies, two names.

## Lifecycle

```text
REGISTERED -> COLD
COLD       -> STARTING      (acquire, activation allows it)
STARTING   -> ACTIVE        (startup succeeded inside startupTimeoutMs)
STARTING   -> FAILED        (startup error or timeout)
ACTIVE     -> WARM_IDLE     (last lease released, idleTtlMs > 0)
ACTIVE     -> STOPPING      (last lease released, idleTtlMs == 0)
WARM_IDLE  -> ACTIVE        (acquire while still warm)
WARM_IDLE  -> STOPPING      (idleTtlMs elapsed, or phase-3 pressure)
STOPPING   -> COLD          (stop completed)
STOPPING   -> FAILED        (stop error)
FAILED     -> COLD          (recycle by re-reading the capability's own
                             durable artifacts; the registry itself is never
                             persisted)
```

Rules that must hold, and are cheap to test:

- A transition not in the table is refused, not coerced. `STOPPING` leaves only
  for `COLD` or `FAILED`.
- `acquire` returns a lease only from `ACTIVE`, `WARM_IDLE`, or `COLD` (which
  starts it). It never resurrects `STOPPING` or `FAILED`.
- `leaseCount` never goes negative; releasing a lease twice is an error, not a
  decrement.
- While `leaseCount > 0` the capability cannot enter `STOPPING`, including when
  its TTL has expired. Pressure may shorten the TTL, never the leases.
- Every transition emits exactly one event carrying `id`, `from`, `to` and a
  reason, so `health`/`recovery_status` can report the last transition instead
  of a constant.

## Generation fencing

A capability whose manifest sets `generationFenced: true` must receive a
generation on every `acquire`. The registry keeps the highest generation it has
seen per capability and refuses:

- an acquire for a generation lower than the highest seen (stale caller);
- a publish/release from a lease whose generation is no longer current, so a
  worker that finished after a rollover cannot write into the new generation.

Phase 1 keeps the fence in the registry only. It is deliberately not a lock: the
durable goal lease in `ToolRegistry` remains the authority for mutation, and this
fence exists so a *capability* cannot outlive the generation that leased it.

## Dependency resolution

`requires` is resolved against the same registry at registration and at acquire:

- an unknown requirement fails registration, unless it is declared external
  (a token provided by a capability outside this registry, such as `host-cdp`);
- a cycle fails registration with the cycle named;
- resolving a request starts only the capabilities on its `requires` path, never
  unrelated ones.

## Verification

Unit tests in `packages/capabilities`, against a fake clock, no child processes:

1. manifest validation rejects: empty `provides`, duplicate `id`, unknown
   requirement, dependency cycle, negative TTL/timeouts;
2. the happy path for a manifest with `idleTtlMs > 0`:
   `COLD -> STARTING -> ACTIVE -> WARM_IDLE -> ACTIVE`, then
   `WARM_IDLE -> STOPPING -> COLD` once the TTL elapses with no lease held,
   asserting `leaseCount` at each step (the `idleTtlMs: 0` variant is item 6,
   because a manifest is immutable after registration and one capability can
   never traverse both edges);
3. `acquire` on `STOPPING` and on `FAILED` is refused;
4. double release is refused and leaves `leaseCount` unchanged;
5. TTL expiry while a lease is held does not stop the capability; the stop
   happens on the release that reaches zero;
6. `idleTtlMs: 0` stops on the last release without an idle window;
7. a stale-generation acquire and a stale-generation release are both refused
   when `generationFenced` is true;
8. each transition produces exactly one event with a reason, and the last event
   is what a health read reports.

## Non-goals

- Spawning, supervising, restarting or killing processes (phase 2).
- Reading RSS or any pressure signal; `costClass` is advisory (phase 3).
- Sandboxing, cgroups, worker recycling policy, or WASI (see #135).
- Persisting the registry across restarts. Registration is code-driven at boot;
  only *leases* would need persistence, and nothing leases across a restart yet.
- Replacing `capability-descriptors.ts`: a manifest may reference a descriptor's
  `auditTarget`/`permission`, but tool availability stays where it is.
- Changing the durable goal lease semantics owned by `ToolRegistry`.

## Open questions

- Should `idleTtlMs` live in the manifest or in runtime policy, so a host can
  tune warm time without a `version` bump? Manifest is simpler; policy is more
  useful for phase 3.
- Where does a generation come from for a capability that no goal leased, for
  example a scheduled audit? Today the goal lease is the only generation source.
- Do `burst` capabilities need a queue at all in phase 1, or is refusing a
  second concurrent acquire enough until the supervisor exists?
