# Heavy-job queue fairness and aging design

Date: 2026-10-30
Issue: [#145](https://github.com/soulzerox/Unified-MPC-Server/issues/145)

## Decision

Fairness is a **selection policy at drain time**, not a change to durable queue
positions. The store keeps FIFO positions as the audit order and restart
fallback; the waiter queue reorders only the candidates it is about to try
against the admission controller.

Two rules, in order:

1. **Blocking first** — existing #145 U12 promotion of user-blocking gate work
   stays authoritative and is never outranked by aged or background work.
2. **Least-recently-served workspace first**, with a bounded aging escape.

Rotation applies **inside** the blocking tier as well: every current producer
(declared heavy `shell`, pre-edit gate) enqueues `blocking: true`, so FIFO
among blocking jobs would leave cross-project fairness inert in production.
Blocking work still always precedes aged and background work; only the order
between blocking jobs from different workspaces changes.

Aging is the safety net, not the primary mechanism: round-robin between active
workspaces already prevents one project from monopolizing a single heavy slot,
and an aged job only has to outrank the rotation in pathological admission
cases. Aging never skips the controller; it only changes which candidate is
attempted first.

## Existing seams

- `HeavyJobWaiterQueue.drain()` already walks local rows in position order,
  backfills past scoped denials, breaks on global denials, acquires the
  controller lease, and calls `store.start()` before handing back a grant.
  Fairness belongs at that walk.
- `SqliteHeavyJobQueueRepository` already persists `position`, `blocking`,
  `workspace_id`, `requested_at`, owner fencing and heartbeats. No schema
  change is needed.
- `ResourceAdmissionController` stays the final admission authority; fairness
  never over-admits and never preempts running work.
- `heavy_job_queue_status` already projects queued rows, positions, wait/run
  durations, blocking and the admission snapshot.

## Interface

A pure module in `@unified-mpc/workspace`:

```ts
export interface HeavyJobFairnessCandidate {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly requestedAt: string;
  readonly blocking: boolean;
  readonly position: number;
}

export interface HeavyJobFairnessContext {
  readonly now: number;
  readonly agingMs: number;
  /** Last selection time per workspace; missing means never served. */
  readonly lastServedAt: ReadonlyMap<string, number>;
}

/** Returns the operation ids in the order the caller should try them. */
export function orderHeavyJobs(
  candidates: readonly HeavyJobFairnessCandidate[],
  context: HeavyJobFairnessContext,
): readonly string[];
```

`HeavyJobWaiterQueue` owns the bounded `lastServedAt` map, updates it when a
candidate is admitted (after `store.start()` succeeds, never on a scoped
denial), and prunes workspaces that no longer have a local row. The map is process-local and intentionally not durable.

The ordering is:

1. blocking candidates, rotated by workspace with the same
   least-recently-served rule, FIFO within one workspace;
2. aged candidates (`now - requestedAt >= agingMs`), FIFO by `requestedAt`;
3. every other candidate grouped by workspace, choosing the workspace with the
   oldest `lastServedAt` first (never-served before any served workspace), then
   its FIFO head. Repeated by grouping until all candidates are ordered. Within
   one ordering pass a workspace that was already selected moves behind every
   other workspace with candidates, so a configured cap above one still
   alternates instead of draining one workspace in a single drain.

Ties always fall back to `requestedAt` and then durable position, so ordering is
deterministic for a given context.

### Amendment (implementation step 2)

The original rule kept blocking candidates strictly FIFO. That would have made
fairness inert for both production queues: the declared heavy `shell` adapter
and the pre-edit gate both enqueue `blocking: true`, so every real candidate
would have landed in the FIFO blocking tier and a burst from one project could
still hold the single heavy slot. Rotation therefore also applies inside the
blocking tier. The tier boundary is unchanged — blocking work still always
precedes aged and background work, and `promote()` still moves a job ahead of
background maintenance — but two projects' blocking jobs now alternate instead
of one project draining its burst first. Single-workspace blocking queues are
still FIFO by `requestedAt` then position.

## Why not durable fairness state

- The queue already survives restart through durable rows; adding a second
  durable generation counter would add migration and reconciliation surface for
  a policy that only shapes the next few milliseconds of selection.
- After a restart the map is empty: every workspace is "never served", so the
  first choice is the oldest queued job, then rotation resumes. No work is lost
  and no workspace is permanently preferred.
- Two runtimes never contend for the same row (`ownerId` fencing), so each
  runtime only orders rows it owns. Cross-runtime fairness is out of scope and
  would need a shared scheduler, not more queue columns.

## Aging bound

`agingMs` defaults to **30 minutes**, below the one-hour queue retention window
so an aged job is still revivable. The bound is a starvation ceiling, not a
latency promise: a job can still wait for controller denials, and the existing
retention/expiry rules remain the only way queued work becomes terminal.

Aging must never promote a job past a blocking job, and must never bypass a
global admission denial. Scoped-denial backfill continues unchanged: if the
chosen candidate is denied for its workspace/session/class, the next candidate
in the fair order is tried before the drain gives up.

## Observability

`heavy_job_queue_status` continues to report durable `position`, `waitedMs`,
`blocking` and the admission snapshot. Because fairness can change the next
attempt without changing the stored position, the serving seam exposes a bounded
projection:

```ts
// ShellHeavyAdmissionPort, implemented by the CLI adapter
fairnessSnapshot(): {
  readonly agingMs: number;
  readonly entries: readonly { operationId: string; effectiveRank: number; aged: boolean }[];
}
```

The projection is derived from the same `HeavyJobWaiterQueue` state that drives
`drain()`, so it cannot disagree with the order the queue actually tries. The
MCP runtime already holds `heavyJobQueue` in its service context; it gains an
optional `heavyJobFairness` provider populated from the shell admission port.
`heavy_job_queue_status` annotates the queued entries it already returns when
that provider is present and omits the fields otherwise (for example a runtime
with no shell admission port). The projection is local to the serving runtime
and is labelled as such; it is not durable state. No workspace cost map is added
to the response.

## Non-goals

- No priority tiers beyond the existing `blocking` flag.
- ~~No per-workspace or per-Goal queue caps; the existing shell bound (16 rows,
  `SHELL_HEAVY_ADMISSION_QUEUE_LIMIT`) remains.~~ Superseded by the #543
  amendment below: a per-workspace queued bound now sits inside the global one.
  There is still no per-Goal cap.
- No cross-runtime scheduler and no durable fairness counters.
- No dynamic headroom (auto-raising the heavy slot from measured pressure);
  that is a separate #145 slice.
- No preemption of running heavy work.

## Verification

- Two workspaces with two queued jobs each, one heavy slot: starts alternate
  A, B, A, B rather than draining A first.
- A workspace that was just served yields to a workspace with older or missing
  service history.
- A job waited past `agingMs` is attempted before non-aged jobs, but after all
  blocking jobs.
- Blocking promotion, scoped-denial backfill and global-denial drain stop keep
  their current behavior; the fair order only changes candidate order.
- Single-workspace queues behave exactly as today (FIFO by position).
- Restart resets the fairness map and still starts the oldest queued job with
  no loss or duplicate.
- `heavy_job_queue_status` reports `effectiveRank`/`aged` consistently with the
  order the queue actually tries, including after a restart, and omits them when
  no fairness provider is configured.
- A configured heavy cap above one still alternates workspaces inside a single
  drain instead of draining one workspace's rows first.
- Controller snapshot still shows one active heavy operation at the default cap.

## Delivery sequence

1. `orderHeavyJobs()` pure module + unit tests (TDD, public interface only).
2. Wire the waiter queue `drain()` to the policy and track `lastServedAt`;
   regression tests for promotion, backfill and global-denial behavior.
3. `ShellHeavyAdmissionPort.fairnessSnapshot()` plus the optional runtime
   provider, then `heavy_job_queue_status` annotations.
4. Deployment docs: describe round-robin, the 30-minute aging bound and that
   restart resets fairness history.

Each step is TDD and exercises the queue/controller contract through its public
interface.

## Amendment: per-workspace queued bound (#543)

Rotation decides *which* workspace runs next; it does not decide *how much* of
the queue one workspace may hold. With only a global bound, one project could
occupy every waiting row and keep every other project's eligible work out of the
queue entirely — a different failure from starvation, and rotation cannot fix it
because the work never gets a row.

The bound is therefore a queued-row count, not an ordering rule:

```text
global    maxQueued                     (16 declared shell runs)
workspace maxQueuedPerWorkspace          (default: global, never above it)
```

- **Where it lives.** `HeavyJobWaiterQueueOptions.maxQueuedPerWorkspace`, passed
  to `HeavyJobQueueStore.claim()`/`supersede()` and enforced **inside** the
  claim transaction, like the global depth check. A process-local check alone
  would let two runtimes each admit under the cap.
- **What overflow does.** Reject with `WORKSPACE_QUEUE_FULL` at the queue layer
  before a task record or process exists. The shell port maps any full queue —
  global or workspace — onto its existing `RESOURCE_PRESSURE` refusal with
  `reason: 'queue_full'`, so operators see one recovery path, not two.
  Coalescing still wins: identical work that is already queued is adopted, not
  rejected, because it costs no new row.
- **What the count covers.** Every queued row with that `workspace_id`, whichever
  job kind wrote it. Shell and pre-edit work share the durable table, so the
  bound is a workspace intake budget rather than a shell-only counter, and
  promotion, re-attach and recovery never create rows that could exceed it.
- **Known limit.** `supersede()` re-checks the bound for a replacement row in the
  same workspace, but a row that *moves* into another workspace is not counted
  against the destination before the swap. No caller supersedes across
  workspaces today; a future one must re-check the destination depth inside the
  same transaction.
- **Why not retire a stale row on overflow.** Retirement is a cancellation of
  real pending work; using it as an overflow valve would make a bounded intake
  decision destroy someone else's job. Rejection is visible and recoverable by
  the caller; retirement is not.
- **Per Goal instead of per workspace.** Goal identity is not a durable queue
  column, and a Goal may move between workspaces. Adding it would need a schema
  change plus a decision about which one wins when both apply. Workspace is the
  identity the queue already owns, so it is the bound that can be enforced
  atomically today.

Operator contract and default live in `docs/DEPLOYMENT_LINUX.md`; the runtime
reads `UNIFIED_MPC_HEAVY_MAX_QUEUED_PER_WORKSPACE` once at port creation and
fails startup on a malformed or oversized value.
