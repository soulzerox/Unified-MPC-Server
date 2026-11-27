# Heavy gate checks as on-demand capabilities — decision record

Date: 2026-11-27
Status: decision record for the last open item of
[#142](https://github.com/soulzerox/Unified-MPC-Server/issues/142). No code
changes. It settles what "heavy gate checks are on-demand capabilities under
#133" means before anyone builds a runner for it.
Refs #142, #133

## The open item

`#142`'s definition of done carries one unticked box:

> heavy gate checks are on-demand capabilities under #133

Read as "declare a gate check in the capability registry today", that asks for
manifests nothing starts. Read as "the check must run in a process Unified owns
and can evict", it is not implemented and cannot be faked. The difference
matters, because the first reading produces dead data and a false claim.

## What a gate check is today

| Gate | Implementation | Who runs it |
| --- | --- | --- |
| local verification | `scripts/local-verify.mjs` (`verify:local`) | the host: an agent shell command or a person |
| exact-head review | `scripts/review-gate.mjs` (`review:pr capsule/record`) | the host, plus a separate reviewer context |
| merge (CLI) | `scripts/guarded-merge.mjs` (`merge:pr`) | the host |
| merge verification (runtime) | `apps/cli/src/runtime/merge-verification-runner.ts` via `merge_verification_run` | Unified: it `execFile`s each `local_command` gate of the repository policy |
| merge (runtime decision) | `GuardedMergeService` + `evaluateMergeEvidence` | Unified, in-process, and cheap |
| close | `apps/cli/src/commands/gate.ts` (`gate check --phase close`) | Unified, in-process, and cheap |

The three CLI adapters split by weight. Only local verification is heavy: it
builds the workspace, runs its test suites and can take minutes. `review:pr` and
`merge:pr` are not — they read a diff and a receipt, or run `gh pr merge
--match-head-commit` and read the resulting commit.

None of the three is a capability, even when the caller reaches it through
Unified's shell tool. A shell command there becomes a durable task only when the
caller declares an `admission_class`: then its pid and state row are written, it
can be cancelled and stopped (there is no resume — the local runner refuses that
operation), a parked row is re-attached after a restart, and #13's
`heavy-headroom` plus the heavy-job queue decide whether it may start. What it
never becomes is a manifest, a registry lease or a supervisor record, so pressure
has no capability to evict on memory grounds and nothing accounts for its RSS.

The runtime merge verification is the one heavy gate Unified already executes
itself, and it is worth being precise about what it does and does not own:

- it runs the host-owned argv of each policy gate (`local_command`) through
  `execFile`, with a 20-minute deadline and a 4 MiB output bound;
- it holds a #13 admission slot of class `verification_heavy` for the whole run,
  and its default cost equals that class's ceiling, so two verifications cannot
  hold a slot at the same time and pressure is part of the final admission
  answer;
- the durable attempt row, not the caller's transport, owns the run lifetime, so
  a client that disconnects does not cancel the gate and a queued attempt is
  promoted instead of restarted.

What it does **not** have is a capability identity. No manifest, no registry
lease, no supervisor record: the child is invisible to `registry.snapshot()`, so
pressure cannot evict a running verification, nothing accounts for its RSS, and
no capability transition or recycle count describes it. It is admitted heavy
work, not a supervised worker.

The runtime merge decision and the close gate are capability-shaped in the sense
that matters: they are decisions taken in-process, so there is nothing to spawn.

## What the manifest can already say

Phase 1 of #133 (`packages/capabilities/src/capability-registry.ts`) can express
a gate check without a new field:

```ts
{
  id: 'gate-verify-local',
  provides: ['gate:verify'],
  runtimeKind: 'native-worker',
  activation: 'burst',     // start on acquire; the registry defaults idleTtlMs to 0
  idleTtlMs: 0,            // one worker per run, stopped on the last release
  recyclable: true,
  costClass: 'large',
  startupTimeoutMs: ...,   // host budget for a cold start
  shutdownTimeoutMs: ...,
  generationFenced: false, // see below
}
```

Two of those values are decisions rather than defaults:

- **`burst` with `idleTtlMs: 0`.** A verification run has no warm state worth
  keeping: the next run builds and tests again from a fresh tree. A warm window
  would hold tens or hundreds of MiB for a request that probably arrives after
  the TTL.
- **`generationFenced: false`.** The fence exists so a stale lease cannot
  `publish` into a newer generation. A gate check publishes a receipt that names
  its exact inputs instead, and every consumer re-derives the answer from that
  receipt and refuses a stale one. Adding the fence would duplicate a guarantee
  the receipt already carries, and would demand a generation the caller does not
  have for a check that writes no workspace state.

## Decision 1 — no dormant manifests, and no new runner

A manifest that nothing starts is dead data plus a false claim: the registry
would report a `COLD` capability, and #142's box would look satisfied while the
work still ran somewhere the registry cannot see. Gate-check manifests land with
the code that starts them, in the same change that makes the box true.

That code exists. `merge_verification_run` is already the Unified-owned heavy
gate execution path; what it lacks is a capability identity. So the work is to
give that path a manifest, a lease and a supervisor record, not to build a second
runner beside it.

## Decision 2 — what must exist before the box is true

One supervised worker per gate run, in the path that already runs the gate:

- the `local_command` gate's argv is spawned as a `burst` native worker under the
  phase-2 supervisor instead of `execFile`, with the bounded stdio tee that
  #999/#1005 already ship, so a chatty profile cannot ratchet parent memory;
- the run holds a capability lease from the moment the worker starts until its
  receipt is written, so pressure cannot silently kill a live verification;
- a lease forbids a kill, so `critical` pressure can only *ask*: the driver plans
  an eviction, `reclaim` marks the pending stop, and it runs when the last lease
  is released — and only for a lane this runtime owns, because a mark nobody can
  release would schedule a stop that never runs. However the run ends, it ends
  **closed**: a killed or timed-out command yields no exit code, the gate's
  outcome is `unavailable`, and the receipt the writer appends is refused by every
  consumer, so the gate a caller needs stays shut;
- an unverifiable termination leaves the record `termination_unverified`, exactly
  like any other supervised worker, so nobody releases a process that may still
  be alive;
- the #13 `verification_heavy` admission stays where it is. It answers whether the
  run may start; the capability answers what owns the child and when it dies. The
  two are not merged, and the durable attempt keeps owning the run lifetime so a
  client that disconnects still cannot cancel a live verification.

The verdict is the truth, and eviction cannot forge one. A killed or unverified
run either writes no receipt at all or writes one whose gate outcome is
`unavailable`: `evaluateMergeEvidence` refuses an unavailable gate, and
`workflow-gate-core.mjs` refuses a CLI receipt that is missing or not
`mergeReady`. Pressure can close a gate but never approve one.

## Decision 3 — admission and residency stay separate

#13 answers *whether* a heavy request starts now. #133 answers *what process
runs it and when that process dies*. A gate check is the one case that needs
both: it is heavy enough to queue, and expensive enough to own. Merging the two
would make the queue into a second lifecycle authority, which is the state the
capability registry was built to replace.

## Reading the phase-1 claim

`capability-registry.ts` says a manifest plus the registry "is enough to declare a
gate check on-demand (#142)". That sentence is about *declarability*: the
contract can express a gate check, and the registry enforces the lease and
transition rules without a child process. It is true and stays true.

It is not the same claim as #142's box, which says the check *is* an on-demand
capability. Declaring something on-demand and running it on-demand differ by the
supervisor: today the only heavy gate Unified runs is admitted heavy work with no
manifest, no lease and no supervisor record. The box measures the second thing.

## What this leaves open

- The three CLI adapters (`verify:local`, `review:pr`, `merge:pr`) stay
  host-executed, and only `verify:local` is heavy enough to be worth a worker.
  Moving it under the runtime would change how the reference workflow runs, which
  is a larger change than making the existing runtime path a capability.
- Which profiles count as heavy is a per-project answer: the runtime gate argv is
  host-owned per repository policy, and a docs-only profile is not heavy at all.
  The capability should take the gate's own argv, never a hard-coded command.
- Warm-model reuse is out of scope: a gate check does not need the embedding
  model, and #133 keeps model lifecycle in the provider that owns it.

## Smallest honest first step

Run one `local_command` gate of the runtime verification as a supervised burst
worker holding a capability lease, keep the durable attempt and the receipt
writer exactly as they are, Let critical pressure be able to ask for its eviction, and let that request settle
as a closed gate.
That makes the manifest real, exercises lease + burst stop + pressure eviction on
the run that already exists, and is the change that should tick #142's last box.

