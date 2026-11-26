# On-demand capability runtime — restart recovery: what must be durable

Status: decision record for one open item of #133. No code changes; it settles
what "crash/restart rehydrates from durable state" means before anyone writes a
persistence layer for the capability registry.

Refs #133

## The open item

The #133 checklist carries one behaviour item still marked missing:

> crash/restart rehydrates from durable state — the registry is in-memory; a
> restarted host answers `PROCESS_NOT_FOUND` and nothing rehydrates capability
> state from durable storage.

Read as "persist the registry", that sentence asks for a storage layer. Read
against the microkernel rule it is already satisfied. The difference is worth
writing down, because the wrong reading produces a store that is worse than
none.

## What the registry actually holds

`CapabilityRegistry` (`packages/capabilities/src/capability-registry.ts`) keeps
one record per capability with these mutable fields:

| Field | Meaning | Sound to persist? |
| --- | --- | --- |
| `state` | lifecycle state | no — a worker is not alive after restart; it is `COLD` by definition |
| `leaseCount` | live holders | no — see below |
| `nextLeaseId` | lease numbering | no — leases are gone with the holders |
| `highestGeneration` | generation high-water mark | **not yet durable, and this is the only real hazard** |
| `idleSince` | warm-idle clock | no — restart starts cold |
| `starting` | in-flight start promise | no — a promise is process-local |
| `stopEpoch`, `pendingStop`, `lastStopFailure` | stop bookkeeping, and the last unverified stop's own message | no — the stop it describes already happened |
| `transitions` | bounded history | no — diagnostics only |

Manifests are not state: the host declares them in code at boot, so a restart
re-registers the same set. The registry is a derived view of live workers, which
is exactly the "workers are compute, not truth" rule in #133.

## Finding 1 — a persisted lease would be a phantom

A lease is a claim held by a caller in this process. When the process dies, the
caller dies too. Rehydrating `leaseCount: 2` would invent two holders that can
never release, so the capability could never reach `STOPPING` — the registry's
own rule ("while a lease is held the capability cannot enter `STOPPING`") would
then block reclamation forever. That is the failure mode the lease accounting
exists to prevent, not a recovery from it.

Durability belongs to the work, not to the claim on the worker. A goal that
still needs a capability after restart re-acquires it; the registry sees a fresh
lease with a fresh id.

## Finding 2 — the generation fence is process-local today

`highestGeneration` is advanced on `acquire` and compared on `publish`, so a
stale lease cannot write a newer generation **within one process lifetime**.
After a restart the counter starts empty again.

This is only reachable if a worker outlives the host and later re-attaches. A
graceful `shutdown()` stops every recyclable worker, but a crash stops nothing,
so an `external-process` child (and a `recyclable: false` one, which `shutdown`
skips by design) can outlive the host. What does not exist on `main` today is a
way back in: the pipes died with the host and no attach protocol replaces them.
The reset therefore cannot be exploited yet, and it becomes a real hole the
moment an attach path is added. The fix then is not "persist the counter": the
generation that matters is the durable goal execution generation (#82), which
already survives restarts.

The follow-up, when a detached worker can attach, is one injected seed per
capability at registration:

```ts
// shape only, not implemented
register({ ...manifest, restoredGeneration: durableGoalGenerationFor(id) })
```

A publish below that seed is then refused by the existing comparison, with no
new state and no new storage.

## Decision

1. **The registry stays in memory.** No persistence layer for states, leases,
   transitions or timers. A restarted host starts every capability `COLD` with
   zero leases, which is the truth.
2. **The durable anchors stay where they already are:** goal/checkpoint state
   (#82), the durable shell task store (`durable-shell-task-store.ts`, file
   backed, survives a backend replacement), and Shared Evidence. Those are what
   a resumed session reads to decide what to redo.
3. **A worker identity that did not survive is reported, not resurrected.** A
   task that names a worker from a previous host answers `PROCESS_NOT_FOUND`
   with restartable guidance; silently rehydrating a handle would hand the
   caller a dead pid.
4. **Generation seeding waits for an attach path.** When one lands, the seed is
   injected from durable goal state — the registry does not grow its own
   persistence.

Under this decision the checklist item is closed by behaviour, not by a store:
restart recovery = re-register manifests, re-read durable task/goal state, and
surface a typed error for anything that no longer exists.

## Tests that would pin this

Cheap, and they assert today's behaviour rather than a future store:

- a second `CapabilityRegistry` built after the first is dropped reports every
  capability `COLD` with `leaseCount: 0`, so no phantom holder survives;
- the durable shell task store is the only cross-restart anchor: a task
  reserved before the restart is readable after it, and a worker id from before
  the restart answers `PROCESS_NOT_FOUND`.

## Non-goals

- Persisting leases, transitions, `idleSince` or `stopEpoch`.
- A registry-wide generation counter that outlives the process: the durable
  generation is goal-scoped (#82), not registry-scoped.
- Reattaching to detached workers before an attach protocol exists.
