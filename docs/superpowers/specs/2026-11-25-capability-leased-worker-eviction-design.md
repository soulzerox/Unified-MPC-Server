# On-demand capability runtime — phase 4: evicting a leased worker

Status: decision record for the one gap the phase-3 design recorded, and for the
two pieces it named as the way to close it
(`docs/superpowers/specs/2026-11-24-capability-pressure-driver-design.md`,
"Non-goals" and "What this phase does not bound"). No code changes here; this
settles what the phase-4 code must do and what it must not.

Refs #133

## The open item

Phase 3 shipped the sweep and the first supervised worker, the native Thai-RAG
provider. It also recorded, plainly, that the worker it supervises is **not
evictable**:

> `evictionPlan` returns `WARM_IDLE` ids with `leaseCount === 0`, so the provider
> — pinned by a lane that holds a lease for the driver's lifetime — is never in
> the plan. On it, `reclaim` only records `pendingStop`, and the stop runs on the
> last release, which that pin never performs.

The worker that costs the most resident memory is therefore the one pressure can
never reclaim. Phase 3 named two missing pieces: holder attribution and a
manager-level lane close.

## What exists today

| Fact | Where |
| --- | --- |
| A lease is anonymous: an id, a generation and two methods, no holder identity | `packages/capabilities/src/capability-registry.ts:106-114` |
| `acquire` returns that opaque lease; `releaseLease` counts to zero and runs the `pendingStop` a `reclaim` left | `capability-registry.ts:345`, `:477-495` |
| `reclaim` on a leased id only marks `record.pendingStop = 'reclaimed while leased'` | `capability-registry.ts:497-506` |
| Neither `health(id)` nor `snapshot()` exposes that mark, so no caller can see the request is pending | `capability-registry.ts:322-333`, `:529-538` |
| `evictionPlan` can only return `leaseCount === 0`, `WARM_IDLE`, recyclable ids | `packages/capabilities/src/capability-supervisor.ts:409-421` |
| The tick sweeps expired idle TTLs, samples pressure, plans, then calls `reclaim`; it has no other lever | `apps/cli/src/runtime/capability-pressure.ts:105-126` |
| The factory already refuses a second live session per worker: one child's pipes carry one JSON-RPC conversation | `packages/extensions/src/capability-worker-client-factory.ts:153-155` |
| The lease is taken at `connect` and released when the session closes | `capability-worker-client-factory.ts:158`, `:167-173`, `:189-195` |
| `McpSessionManager.ensure` reuses an entry whose launch fingerprint matches and never probes it, so dropping the transport is not enough — the entry itself must go | `packages/extensions/src/mcp-session-manager.ts:292-300` |
| `drop` deletes the entry and closes the session; it is private, and the idle sweep skips pinned lanes | `mcp-session-manager.ts:417-422`, `:432-438`, `pin`/`unpin` `:96-104` |
| The provider pins its lane when it starts and unpins it only on the stop path | `apps/cli/src/runtime/native-thai-rag-provider.ts:554`, `:711` |
| The provider refuses new work while stopping, and refuses to start while stopping | `native-thai-rag-provider.ts:2517`, `:444` |

## Decision 1 — holder attribution is the wrong lever

Attributing leases to named holders sounds like the direct answer, and it is the
one to reject. The registry would gain a `Map<holderId, count>`, an `acquire`
option to fill it, and a `holders(id)` reader — and the only consumer of that
data would be the runtime, to translate a holder id back into an MCP lane name.
That is identity the registry cannot use and the runtime already has.

It is also unnecessary, because **there is at most one holder of a supervised
worker**: the factory refuses a second live session on the same child
(`capability-worker-client-factory.ts:153-155`), so a worker's `leaseCount` is
0 or 1 and the one holder is the factory's open session. "Which holder do I
close?" has a single answer for every supervised worker, and it is "the lane
this worker was launched for". Adding holder identity would buy the same answer
at the cost of a registry type that contradicts its own invariant.

If a second consumer ever needs to share a worker, it multiplexes on the
existing session (as the comment at `capability-worker-client-factory.ts:135`
says), and closing that session is a decision the multiplexed session's owner
must take. That is the open question at the end, not a leak this phase hides.

## Decision 2 — eviction is a request to the layer that owns the lane

Eviction stays where phase 3 put it — a pressure decision over `snapshot()` —
and gains exactly one new verb: when a reclaim is *blocked by a lease*, the
driver asks the layer that owns that lease to let go. Nothing reaches into the
worker; nothing kills a leased child; the registry's rule that a lease forbids a
kill is untouched.

```text
tick (critical)
  sweep   registry.sweep()                                     unchanged: stops WARM_IDLE past its TTL
  plan    supervisor.evictionPlan(tier, registry.snapshot())   unchanged: unleased WARM_IDLE only
  reclaim registry.reclaim(id)                                 unchanged: leased id -> pendingStop
  nudge   registry.health(id).pendingStop !== undefined        new read: the mark is visible
            -> requestEviction(id)                             new: runtime callback, once per id per tick
                 provider driver: sessions.dropServer(name)   existing public close, pinned allowed by this path
                   session close -> factory release -> last release -> pendingStop runs
                     -> child stopped, worker COLD
                       -> next provider call acquires a fresh child (existing #766 path)
```

`requestEviction` is a runtime-provided callback with one argument, the
capability id, and one contract: it must not throw, and it returns whether it
was able to release the lane. The driver never learns what a lane is; the
runtime never learns what pressure tier means.

The two new reads/writes are small and stay on the side that owns them:

1. `CapabilityHealth.pendingStop?: string` — the registry already stores the
   mark (`capability-registry.ts:503`); this exposes it. Diagnostics only, no
   lifecycle change.
2. No new manager surface: `McpSessionManager.dropServer(server)` is already
   public (`mcp-session-manager.ts:240-242`) and wraps the private `drop`, which
   deletes the entry so the next `ensure` connects (`:417-422`). That is the
   whole reason a transport-level close is not enough, and it is why the
   provider can release its lane without `close()`, which means "close every
   session and the manager" (`:276-291`).

Nothing else moves. `evictionPlan` keeps refusing leased ids; `reclaim` keeps
marking instead of killing; the provider keeps pinning for its lifetime; the
idle sweep keeps skipping pinned lanes.

## Rules that decide whether it is safe

- **`critical` only.** `elevated` may reclaim an unleased idle worker but never
  ends a live session: a session is work in progress, and a pressure tier that
  asks for caches to shrink is not a reason to fail a call.
- **Only for a worker that already carries the mark.** The nudge follows a
  `pendingStop` the reclaim just wrote, so an id is never closed without the
  registry having decided the worker should stop. A host whose reclaim was
  refused does not close anything.
- **Once per id per tick, and idempotent.** A lane already closed returns `ok`
  from the manager (no entry); a second nudge for the same id in the same tick
  is skipped. The existing `sweeping` guard already stops ticks from stacking.
- **An in-flight call may fail, truthfully.** `closeSessionWithin`
  (`mcp-session-manager.ts:57-70`) waits a bounded `closeTimeoutMs`, and a
  pending JSON-RPC request rejects when its client closes. The provider already
  answers a stop in flight with `CONFLICT` (`:2517`) and its callers already
  retry onto a fresh child (`#766`). The alternative — waiting for a queue to
  drain that a pinned lane may keep non-empty — is an unbounded wait in a
  pressure path, which is worse than a truthful failure the caller retries.
- **A rejected nudge is reported, never thrown.** Same contract as a rejected
  reclaim today: `onError`, next tick retries.
- **Not for a lane this runtime did not register.** The callback carries the
  manifest id and the runtime resolves it to the lane it registered for that id;
  an unknown id returns `false` and closes nothing.
- **Shutdown still wins.** `close()` cancels the driver before it stops
  workers, so no nudge can run against a runtime that is already tearing down.

## What this makes evictable, stated plainly

The provider becomes evictable **only under `critical`**, and only by ending its
one live session. Under `elevated` it stays resident. That is the honest
trade: the memory the provider holds is worth reclaiming when the host is out of
headroom, and not worth failing a call for when it is merely busy.

Two things this still does not do: it does not give a lease a deadline, and it
does not reclaim a worker whose holder is not the lane this runtime registered
(the shared-session case below).

## Required tests

- Registry: `health(id)` reports `pendingStop` while leased and stops reporting
  it after the last release; `snapshot()` is unchanged in shape (the driver's
  plan must not start seeing leased ids).
- Driver: at `critical`, a leased id with a pending mark calls `requestEviction`
  once; at `elevated` and `normal` it never does; a nudge that returns `false`
  is reported and retried next tick; a nudge that throws is caught and reported,
  never thrown into the interval.
- Manager: `dropServer(name)` ends a **pinned** entry, deletes it, and a following
  `ensure` with the same fingerprint connects instead of reusing; a drop of an
  unknown name is a no-op; a drop while a connect is pending settles after it.
- Provider (fake supervised child, real factory and manager): a `critical`
  eviction closes the lane, the lease releases, the worker reaches `WARM_IDLE`
  and then stops via the `pendingStop` path; the next call connects a fresh
  child; an in-flight call at the moment of the close gets a bounded error, not
  a hang.
- Regression: the idle sweep still skips a pinned lane; `evictionPlan` still
  never returns a leased id; a provider call with no pressure behaves exactly as
  before.

## Non-goals

- A lease deadline, or any expiry of a live lease. Phase 4 makes the one known
  holder releasable, not every holder bounded; expiry needs a caller contract
  for "your lease may end" and stays an open question.
- Killing a leased child. The registry's rule stands: a lease forbids a kill.
- Holder identity on leases (rejected above), a second consumer lane, or moving
  `llama-server` under supervision.
- Admission, source-identity anchors, index generations, launch fingerprints,
  tool-catalog validation or the one-session-per-worker rule.

## Open questions

1. **A shared session.** If Code Intelligence or Context Assurance starts
   multiplexing on the provider's session, that session has more than one owner
   and closing it is no longer "the lane this runtime registered". The first
   such consumer needs its own lease story — this phase's callback is per
   capability id, so it can be extended to per owner, but not guessed now.
2. **Whether `critical` is the right and only tier.** If the provider proves to
   dominate peak RSS on real hosts, `elevated` may deserve the nudge too; the
   measurement is the missing input, not the design.
