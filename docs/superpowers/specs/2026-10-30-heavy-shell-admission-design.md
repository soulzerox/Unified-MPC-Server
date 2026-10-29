# Heavy shell admission design

Date: 2026-10-30
Issue: [#145](https://github.com/soulzerox/Unified-MPC-Server/issues/145)

## Decision

A `shell` run may **declare** that it is heavy work. The declaration names a heavy admission class; the runtime then submits one durable heavy-job queue entry and starts the process only when admission is granted. No command name, argument, or cwd is ever inspected to guess cost.

Declarations are opt-in. An undeclared `shell` run keeps today's behaviour: policy-check, spawn, return `task_id`. The declaration changes **when a process may start**, not how a caller waits for it: MCP still forces `execution=background`, and `status` / `wait` / `logs` / `result` keep their current contract.

```text
shell run (admission_class declared)
        |
        v
  command policy + approval  --denied--> no queue slot consumed
        |
        v
  durable task record: waiting_resource   (payload already in spec.json)
        |
        v
  HeavyJobWaiterQueue.enqueue(jobKind=shell_command, blocking)
        |
        +-- admitted --> spawn durable worker, state=running, deadline starts now
        |
        +-- queued ----> task_id returned with admission.position
                              |
                              +-- release / wake (#517) --> admitted --> spawn
                              +-- cancel --> queue row cancelled, no process
```

## Implementation status

Slice 1 (declaration + admission) is merged; slice 2 (this change) adds durable parking. A declared run validates `admission_class`, claims one bounded durable queue row, writes the durable task as `waiting_resource`, and returns its task id with the queue position. The controller stays the admission authority: a queued run starts only when `drain()` admits it on the capacity release that frees the heavy slot, with no second tool call. Cancel while queued removes the queue row and creates no process; queue-full rejects before a task record exists. `status` / `wait` / `list` add an `admission` block with class, cost, state, position and waited time.

Still open: restart re-attachment. A `waiting_resource` task left by a dead runtime is not revived yet; the next slice re-attaches it to a live queue row or marks it interrupted. Until then the record is truthful (it never claims the work started) but needs operator attention after a restart.

## Existing seams to extend

- `packages/capabilities/src/shell-backend.ts` owns the run lifecycle: policy gate, `DurableShellTaskStore`, worker spawn, terminator, `tasks` map.
- `packages/capabilities/src/durable-shell-task-store.ts` already persists `spec.json` (executable, arguments, cwd, environment, owner, timeout, output flags) before the worker starts, plus `task.json` metadata. A queued task is therefore durable **without a new payload store**.
- `packages/workspace/src/heavy-job-queue.ts` is the ordered, bounded, durable waiter queue; `ResourceAdmissionController` remains the single admission authority, and `onRelease` fires on real capacity release.
- `apps/cli/src/runtime/stdio-mcp-runtime.ts` already wires `SqliteHeavyJobQueueRepository`, `HeavyJobQueueRecoveryService`, heartbeat, and the shared admission controller for the pre-edit consumer.
- `packages/mcp-server/src/tools/schemas.ts` (`shellCapabilitySchema`) and `capability-tools.ts` are the tool seam where a declaration enters.

The pre-edit demand runtime is consumer #1 of the queue. Shell is consumer #2. Until a third appears, both use `HeavyJobWaiterQueue` directly; extract a shared runner module only when the duplication is real, not speculatively.

## Declaration contract

Add one optional field to `shellCapabilitySchema`:

```ts
admission_class: z.enum(['verification_heavy', 'rag_indexing']).optional()
```

Rules:

1. Only classes in `HEAVY_ADMISSION_CLASSES` are accepted. Any other value is `INVALID_INPUT` **before** a task record or process exists - a declaration can never silently mean nothing.
2. The caller does not supply cost. The runtime uses the class's canonical admission cost, so `cost` cannot be spoofed below the class budget.
3. Other operations ignore the field: they cannot start work, and a value is never carried back onto a later `run`.
4. `dry_run` never queues: it is a non-mutating probe and must not consume a heavy slot.
5. Policy-denied or approval-required commands are rejected before enqueueing, so a refused command never takes the heavy slot from work that is allowed to run.
6. `blocking: true` for the queue entry: a shell build/test is interactive work whose result a caller is waiting for, so it must outrank background maintenance in queue order.

## Task lifecycle

A declared run writes the durable task record first and spawns second:

| Phase | Durable state | Effect |
|---|---|---|
| submitted, admission denied | `waiting_resource` | no worker, `task_id` returned with `admission.position` and `waitedMs` |
| admitted | `running` | worker spawned, `deadline_at` computed **at launch** |
| terminal | `completed` / `failed` / `timed_out` | queue settled, admission lease released |
| cancelled while queued | `cancelled` | queue row cancelled, no process, lease never taken |

`timeout_seconds` bounds execution, not queue residence. A task that waited 40 minutes for the heavy slot still gets its full execution budget; otherwise a long queue would fail work that had not started yet.

## Failure behavior

- Queue full: reject the run with `RESOURCE_PRESSURE` and an explicit queue-full detail **before** writing a task record, so callers never hold a `task_id` for work that was never accepted.
- Worker spawn failure after admission: settle the queue row as `failed` and release the lease in the same turn; never leak a slot.
- `termination_unverified`: **hold** the admission lease. The process may still be alive, so starting another heavy job would overlap it. The queue row stays `running` and the slot stays visibly held in `heavy_job_queue_status` until the store's worker-identity reconciliation proves the process is gone; only then is the row settled `failed` and the lease released. A permanently unverifiable process is an operator decision, never a silent release.
- Aborted request signal while queued: cancel the queue row, mark `cancelled`; a signal that arrives after admission follows the existing running-task cancellation path.

## Restart and recovery

- `waiting_resource` task with a matching live queue row (same `operationId`, same owner) is re-attached in place, keeping its queue position; recovery never starts work whose admission is unproven.
- `waiting_resource` task without a queue row is marked `interrupted`. It is **not** silently started after restart: the admission generation that would have run it is gone.
- `running` tasks keep the existing worker-identity reconciliation (`live` vs dead worker) unchanged.
- `operationId` is deterministic per durable task id, and queue ownership is fenced by `ownerId`, so two runtimes cannot both start one task.

## Observability

- `shell` `status` / `wait` gain an `admission` block for declared tasks: `{ class, cost, state, position?, waitedMs?, reason? }`. `reason` is the controller's rejection reason when the task is queued (`heavy_capacity_exhausted`, `memory_pressure`, ...).
- `heavy_job_queue_status` already lists queue rows; `jobKind` distinguishes `shell_command` from `pre_edit_delta`, and `position` gives the wait order.
- No new counters are required; the queue depth and admission snapshot already cover the acceptance items.

## Non-goals

- No command-name, argument, glob, or cwd heuristics; no inferred class from `package.json` scripts.
- No preemption of running heavy work; a blocking declaration only wins among **queued** jobs.
- No automatic class for undeclared shell, and no per-workspace default that would queue interactive probes.
- No change to `wsl_exec`, browser, or native capability paths.
- No worker recycle policy (#133) in this slice.

## Verification

- Undeclared run: spawns immediately, queue depth stays 0.
- Declared heavy behind a running heavy: no process starts, task is `waiting_resource`, queue position and `heavy_capacity_exhausted` reason are reported.
- Release of the blocking heavy lease starts the declared task with **no second tool call** (reuses wake-on-release).
- `deadline_at` is computed at launch: a task queued past its `timeout_seconds` still runs its full budget.
- Cancel while queued: no spawn, queue row `cancelled`, task `cancelled`.
- Queue full: `RESOURCE_PRESSURE`, no task record created.
- Unknown or non-heavy `admission_class`: `INVALID_INPUT`, no task, no queue row.
- Policy-denied command with a declaration: denial as today, queue depth stays 0.
- Restart: `waiting_resource` + live row resumes in place; `waiting_resource` without a row becomes `interrupted`.
- Lease released on every verified terminal path and on spawn failure, proven by a controller snapshot showing zero active heavy operations; `termination_unverified` holds it until reconciliation proves the process gone.

## Delivery sequence

1. Schema field + `INVALID_INPUT` validation (no behaviour change for undeclared runs).
2. Durable task record `waiting_resource` + queue submission behind a `ShellHeavyAdmission` port injected into `ShellCapabilityBackend`, so the backend stays testable without a real controller.
3. Admission grant starts the worker; settle/release on every terminal path; deadline at launch.
4. `status` / `wait` admission projection.
5. Cancel-while-queued and queue-full rejection.
6. Restart re-attachment and `interrupted` fallback.
7. Only then consider documenting an operator-facing default in `docs/DEPLOYMENT_LINUX.md`.

Each step is TDD, and the queue/controller contract is exercised through its public interface - no test reaches into queue internals.
