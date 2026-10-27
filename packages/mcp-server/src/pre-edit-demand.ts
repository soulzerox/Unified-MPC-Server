import { createHash } from 'node:crypto';
import {
  HeavyJobWaiterQueue,
  type HeavyJobQueueStore,
  type HeavyJobRequest,
  type ResourceAdmissionController,
  type ResourceAdmissionLease,
} from '@unified-mpc/workspace';

/** Bounded waiter queue for on-demand pre-edit evidence work (#145 U3). */
export const DEFAULT_PRE_EDIT_DEMAND_QUEUE_LIMIT = 16 as const;

/** Durable queue kind for demand-first pre-edit deltas (#145 U5). */
export const PRE_EDIT_DELTA_JOB_KIND = 'pre_edit_delta' as const;

/**
 * Hard ceiling on how long a later prepare may block inside
 * `prepare_code_change` waiting for the target's own demand-first delta
 * (#346 behaviour 5, Slice B / D2). Waiting is always fail-closed: on timeout
 * the refusal returns exactly as before, with the wait outcome recorded.
 */
export const DEFAULT_PRE_EDIT_DEMAND_WAIT_TIMEOUT_MS = 30_000 as const;

/** Outcome of one bounded wait (Slice B): waited, and how it ended. */
export interface PreEditWaitResult {
  /** `false` — the operation was not pending when the wait was requested. */
  readonly waited: boolean;
  readonly timedOut: boolean;
  /** The requesting caller's own signal aborted during the bounded wait. */
  readonly aborted: boolean;
}

/**
 * The submitted delta never widens past this file cap (#346 behaviour 5:
 * "target plus a deterministic required neighborhood" — Slice A: the
 * envelope names no extra neighborhood yet, so the payload is the target
 * path alone and the cap is the hard bound).
 */
export const MAX_PRE_EDIT_DELTA_FILES = 8 as const;

/**
 * Channel states a scoped delta can actually refresh (issue-60 channel
 * vocabulary). `unavailable` is excluded on purpose: a channel that cannot
 * run on this host will not be fixed by re-indexing the target, and a
 * poisoned retry loop is not a demand-first improvement.
 */
const REFRESHABLE_CHANNEL_STATES = new Set(['missing', 'stale', 'degraded']);

const REFRESHABLE_EVIDENCE_STATES = new Set(['missing', 'stale']);

/**
 * Whether the not-ready verdict describes refreshable evidence. Outlet
 * failures (malformed envelopes, target-identity problems, permanently
 * unavailable channels) submit nothing — the fail-closed envelope stays
 * exactly as it was before demand-first submission.
 */
export function isDemandablePreEditHead(
  evidenceState: string,
  evidenceChannels: Readonly<Record<string, string>> | undefined,
): boolean {
  const states = Object.values(evidenceChannels ?? {});
  if (states.length > 0) {
    return states.some((state) => REFRESHABLE_CHANNEL_STATES.has(state));
  }
  return REFRESHABLE_EVIDENCE_STATES.has(evidenceState);
}

/**
 * Deterministic per-(workspace, path, evidence-state) operation identity, so
 * coalescing a repeat prepare attempt lands on the same queue entry instead
 * of piling unbounded duplicates.
 */
export function preEditOperationId(
  workspaceId: string,
  filePath: string,
  evidenceState: string,
): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}\n${filePath}`)
    .digest('hex')
    .slice(0, 32);
  return `pre-edit:${workspaceId}:${digest}:${evidenceState}`;
}

/** One submitted demand-first delta, as echoed to the refusing caller. */
export interface PreEditSubmissionRecord {
  readonly operationId: string;
  readonly queueState: 'queued' | 'admitted' | 'coalesced' | 'rejected';
  readonly depth: number;
  readonly paths: readonly string[];
  readonly maxFiles: number;
}

/** The bounded scoped-delta work item an admitted queue slot executes. */
export interface PreEditDeltaJob {
  readonly workspaceId: string;
  readonly filePath: string;
  readonly paths: readonly string[];
  readonly evidenceState: string;
}

export type PreEditDeltaExecutor = (job: PreEditDeltaJob) => Promise<unknown> | unknown;

/**
 * Demand-first submission runtime (#346 behaviour 5, Slice A).
 *
 * The #145 `HeavyJobWaiterQueue` stays the final admission authority: this
 * runtime enqueues one bounded blocking request per demandable refusal,
 * promotes it to the queue head (U12), drains what the controller admits,
 * and executes it through the injected executor. Nothing supervises the
 * delta's *content* here — a later readiness check re-reads evidence from
 * the provider, and that check fails closed regardless of how the delta
 * ran (Slice B adds the waiting/verification).
 */
export class PreEditDemandRuntime {
  private readonly queue: HeavyJobWaiterQueue | undefined;
  private readonly controller: ResourceAdmissionController | undefined;
  private readonly executor: PreEditDeltaExecutor | undefined;
  private readonly cost: number;
  private readonly now: () => Date;
  private readonly running = new Set<string>();
  private readonly jobRecords = new Map<string, PreEditDeltaJob>();
  private readonly completions = new Map<string, Array<() => void>>();

  public constructor(input: {
    controller?: ResourceAdmissionController;
    executor?: PreEditDeltaExecutor;
    cost: number;
    queueLimit?: number;
    /** Durable queue authority (#145 U5); omitted keeps process-local behavior. */
    store?: HeavyJobQueueStore;
    now?: () => Date;
  }) {
    this.controller = input.controller;
    this.executor = input.executor;
    this.cost = input.cost;
    this.now = input.now ?? ((): Date => new Date());
    this.queue = input.controller === undefined
      ? undefined
      : new HeavyJobWaiterQueue(input.controller, {
        maxQueued: Math.max(1, input.queueLimit ?? DEFAULT_PRE_EDIT_DEMAND_QUEUE_LIMIT),
        ...(input.store === undefined ? {} : { store: input.store }),
        now: this.now,
      });
  }

  /**
   * Submit (or coalesce) a demand-first delta for a demandable refusal.
   * `undefined` means: nothing demandable happened, no submission echo.
   */
  public submit(request: {
    workspaceId: string;
    filePath: string;
    evidenceState: string;
    demandable: boolean;
  }): PreEditSubmissionRecord | undefined {
    const queue = this.queue;
    if (queue === undefined || !request.demandable) return undefined;
    const operationId = preEditOperationId(
      request.workspaceId,
      request.filePath,
      request.evidenceState,
    );
    try {
      return this.submitToQueue(queue, request, operationId);
    } catch {
      // Durable state is an optimization for later evidence reads, never a
      // prerequisite for failing closed: an unavailable store must not turn
      // the refusal envelope into an INTERNAL_ERROR.
      return {
        operationId,
        queueState: 'rejected',
        depth: 0,
        paths: [request.filePath],
        maxFiles: MAX_PRE_EDIT_DELTA_FILES,
      };
    }
  }

  private submitToQueue(
    queue: HeavyJobWaiterQueue,
    request: { workspaceId: string; filePath: string; evidenceState: string },
    operationId: string,
  ): PreEditSubmissionRecord {
    const paths = [request.filePath];
    const base = {
      operationId,
      depth: queue.depth(),
      paths,
      maxFiles: MAX_PRE_EDIT_DELTA_FILES,
    };
    if (this.running.has(operationId)) {
      return { ...base, queueState: 'coalesced' };
    }
    // D4 (Slice B): a NEWER requirement for the same target replaces an older
    // queued-not-started generation of that requirement in place (U4 supersede
    // on the waiter queue). Running generations are never cancelled — they
    // finish, and the caller's re-read re-checks evidence, so a stale-hash
    // result can never publish.
    for (const [staleId, staleJob] of [...this.jobRecords]) {
      if (staleId === operationId) continue;
      if (this.running.has(staleId)) continue;
      if (staleJob.workspaceId !== request.workspaceId || staleJob.filePath !== request.filePath) continue;
      const superseded = queue.supersede(staleId, operationId, this.jobRequest(request));
      if (superseded.status === 'rejected') {
        return { ...base, queueState: 'rejected' };
      }
      this.jobRecords.delete(staleId);
      this.releaseWaiters(staleId);
      if (superseded.status === 'coalesced') {
        // Another owner (or an already-queued generation) holds the exact
        // replacement. Fail closed: this caller may wait only when the work is
        // locally pending, and no duplicate execution is started here.
        return { ...base, depth: queue.depth(), queueState: 'coalesced' };
      }
      this.jobRecords.set(operationId, {
        workspaceId: request.workspaceId,
        filePath: request.filePath,
        paths,
        evidenceState: request.evidenceState,
      });
      // Blocking gate evidence (U12): the freshly described requirement jumps
      // ahead of background maintenance just like a fresh submission would.
      queue.promote(operationId);
      this.executePending();
      return {
        ...base,
        depth: queue.depth(),
        queueState: this.running.has(operationId) ? 'admitted' : 'queued',
      };
    }
    const enqueued = queue.enqueue(this.jobRequest(request));
    if (enqueued.status === 'rejected') {
      return { ...base, queueState: 'rejected' };
    }
    if (enqueued.status === 'coalesced' && !enqueued.queued) {
      // Live foreign owner or an already-running generation: report the
      // coalesce without claiming execution that this runtime does not own.
      return { ...base, depth: enqueued.depth, queueState: 'coalesced' };
    }
    // Blocking gate evidence (U12): jump ahead of background maintenance.
    queue.promote(operationId);
    this.jobRecords.set(operationId, {
      workspaceId: request.workspaceId,
      filePath: request.filePath,
      paths,
      evidenceState: request.evidenceState,
    });
    this.executePending();
    return {
      ...base,
      depth: queue.depth(),
      queueState: this.running.has(operationId) ? 'admitted' : 'queued',
    };
  }

  private jobRequest(
    request: { workspaceId: string; filePath: string; evidenceState: string },
  ): HeavyJobRequest {
    return {
      operationId: preEditOperationId(request.workspaceId, request.filePath, request.evidenceState),
      workspaceId: request.workspaceId,
      resourceClass: 'rag_indexing',
      cost: this.cost,
      blocking: true,
      jobKind: PRE_EDIT_DELTA_JOB_KIND,
      requestedAt: this.now().toISOString(),
    };
  }

  public enabled(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Whether the operation is still pending, and in which state. `undefined`
   * means the operation is unknown (never submitted, superseded or settled).
   */
  public pendingState(operationId: string): 'queued' | 'running' | undefined {
    if (this.running.has(operationId)) return 'running';
    return this.jobRecords.has(operationId) ? 'queued' : undefined;
  }

  /**
   * Bounded blocking wait for one queued or running delta to settle
   * (#346 behaviour 5, Slice B / D2).
   *
   * The pending check and the waiter registration happen synchronously in the
   * same turn, so a delta that settles later always reaches the registered
   * waiter. Callers waiting on an operation that is not pending (or has been
   * superseded and released) get `waited: false` immediately — the refusal
   * path then behaves exactly as a fresh submission.
   */
  public waitFor(operationId: string, input: { timeoutMs: number; signal?: AbortSignal }): Promise<PreEditWaitResult> {
    const pending = this.pendingState(operationId);
    if (pending === undefined) {
      return Promise.resolve({ waited: false, timedOut: false, aborted: false });
    }
    return new Promise((resolve) => {
      let done = false;
      const finishWait = (outcome: Pick<PreEditWaitResult, 'timedOut' | 'aborted'>): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const list = this.completions.get(operationId);
        if (list !== undefined) {
          const index = list.indexOf(waiter);
          if (index >= 0) list.splice(index, 1);
          if (list.length === 0) this.completions.delete(operationId);
        }
        signal.removeEventListener('abort', onAbort);
        resolve({ waited: true, ...outcome });
      };
      const waiter = (): void => finishWait({ timedOut: false, aborted: false });
      const timer = setTimeout(() => finishWait({ timedOut: true, aborted: false }), Math.max(1, input.timeoutMs));
      const signal = input.signal ?? new AbortController().signal;
      const onAbort = (): void => finishWait({ timedOut: false, aborted: true });
      let list = this.completions.get(operationId);
      if (list === undefined) {
        list = [];
        this.completions.set(operationId, list);
      }
      list.push(waiter);
      if (signal.aborted) finishWait({ timedOut: false, aborted: true });
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Release every bounded waiter of one operation (settled or superseded). */
  private releaseWaiters(operationId: string): void {
    const list = this.completions.get(operationId);
    if (list === undefined) return;
    this.completions.delete(operationId);
    for (const release of list.splice(0)) release();
  }

  private executePending(): void {
    const queue = this.queue;
    const controller = this.controller;
    if (queue === undefined || controller === undefined) return;
    for (const admitted of queue.drain()) {
      const job = this.jobRecords.get(admitted.lease.operationId);
      if (job === undefined) {
        controller.release(admitted.lease);
        continue;
      }
      this.running.add(admitted.lease.operationId);
      const executor = this.executor;
      if (executor === undefined) {
        this.finish(admitted.lease, 'failed', 'no executor configured');
        continue;
      }
      let started: Promise<unknown> | unknown;
      try {
        started = executor(job);
      } catch (cause) {
        this.finish(admitted.lease, 'failed', describeCause(cause));
        continue;
      }
      let failed = false;
      void Promise.resolve(started)
        .catch((cause: unknown) => {
          failed = true;
          this.finish(admitted.lease, 'failed', describeCause(cause));
        })
        .finally(() => {
          if (!failed) this.finish(admitted.lease, 'completed');
          try {
            this.executePending();
          } catch {
            // Drain failures are retried on the next submission; they must not
            // escape as an unhandled rejection from detached executor work.
          }
        });
    }
  }

  /**
   * Release the admission lease and record the durable terminal outcome in
   * one step (#145 U5). Fail-closed: every exit path settles exactly once,
   * and a losing duplicate settle is a no-op in the durable store.
   */
  private finish(
    lease: ResourceAdmissionLease,
    outcome: 'completed' | 'failed',
    detail?: string,
  ): void {
    this.running.delete(lease.operationId);
    this.jobRecords.delete(lease.operationId);
    try {
      this.queue?.settle(lease.operationId, outcome, detail);
    } catch {
      // A queue-store failure must never strand the admission lease or the
      // bounded waiters; restart recovery reconciles the durable row.
    }
    this.controller?.release(lease);
    this.releaseWaiters(lease.operationId);
  }
}

/** Flat scalar-pair details for the CONFLICT envelope (`error.details`). */
export function flatSubmissionDetails(submission: PreEditSubmissionRecord): Record<string, string | number> {
  return {
    submissionOperationId: submission.operationId,
    submissionQueueState: submission.queueState,
    submissionDepth: submission.depth,
    submissionPaths: submission.paths.join(','),
    submissionMaxFiles: submission.maxFiles,
  };
}

/** Bounded human-readable failure reason for the durable job receipt. */
function describeCause(cause: unknown): string {
  const message = cause instanceof Error
    ? cause.message
    : typeof cause === 'string'
      ? cause
      : 'unknown failure';
  return message.slice(0, 500);
}
