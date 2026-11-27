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
| merge (runtime) | `GuardedMergeService` + `evaluateMergeEvidence` | Unified, in-process, and cheap |
| close | `apps/cli/src/commands/gate.ts` (`gate check --phase close`) | Unified, in-process, and cheap |

Only the three CLI adapters are heavy: they build the workspace, run its test
suites, and can take minutes. All three are spawned by the caller, so Unified
owns neither their process nor their lifetime. Their RSS belongs to the host
shell; nothing registers them, leases them or evicts them.

When the caller reaches the shell through Unified, the *request* is already
admitted by #13: `heavy-headroom` bounds how many heavy jobs run beside each
other and the heavy-job queue parks the rest. That admission decides whether a
job starts now. It does not own the process that runs it, and it has no view of
the child's RSS.

The runtime merge gate and the close gate are capability-shaped already in the
sense that matters: they are decisions taken in-process, so there is nothing to
spawn.

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

## Decision 1 — no dormant manifests

A manifest that nothing starts is dead data plus a false claim: the registry
would report a `COLD` capability, and #142's box would look satisfied while the
work still ran in the host shell. Gate-check manifests land with the runner that
spawns them, in the same change that makes the box true.

## Decision 2 — what must exist before the box is true

One Unified-owned runner for one heavy gate profile:

- it spawns the profile as a `burst` native worker under the phase-2 supervisor,
  with the stdio tee that #999/#1005 already bound, so a chatty profile cannot
  ratchet parent memory;
- the run holds a capability lease from the moment the worker starts until its
  receipt is written, so pressure cannot silently kill a live check;
- under `critical` pressure the phase-4 leased-worker path ends the lane that
  holds the lease. That fails the check **closed**: no receipt is written, the
  worker's exit is not a verdict, and the gate a caller needs stays shut;
- an unverifiable termination leaves the record `termination_unverified`, exactly
  like any other supervised worker, so nobody releases a process that may still
  be alive.

The receipt stays the truth. A killed, crashed or unverified run produces no
receipt, and "no receipt" already means "gate closed" in every consumer, so
eviction can never be mistaken for approval.

## Decision 3 — admission and residency stay separate

#13 answers *whether* a heavy request starts now. #133 answers *what process
runs it and when that process dies*. A gate check is the one case that needs
both: it is heavy enough to queue, and expensive enough to own. Merging the two
would make the queue into a second lifecycle authority, which is the state the
capability registry was built to replace.

## What this leaves open

- The runner above does not exist. Until it does, the three CLI adapters stay
  host-executed, #142's last box stays unticked, and this item is recorded as
  planned rather than landed.
- Which profiles count as heavy is a per-project answer: `verify:local` is the
  reference, a docs-only profile is not heavy at all. The runner should take the
  profile the gate names, not a hard-coded command.
- Warm-model reuse is out of scope: a gate check does not need the embedding
  model, and #133 keeps model lifecycle in the provider that owns it.

## Smallest honest first step

Run **one** profile (`verify:local`) in a single supervised burst worker, stream
its bounded output to the caller, and let the existing receipt writer stay the
only source of a verdict. That alone makes the manifests real, exercises lease +
burst stop + pressure eviction on a real workload, and lets #142 close its last
box without pretending the other profiles are done.
