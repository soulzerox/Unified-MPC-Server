import {
  RESOURCE_ADMISSION_CLASSES,
  type ResourceAdmissionClass,
  type ResourceAdmissionController,
  type ResourceAdmissionLease,
  type ResourceAdmissionRejectionReason,
  type ResourceAdmissionRequest,
} from './resource-admission.js';

export const HEAVY_JOB_QUEUE_VERSION = 1 as const;

export const DEFAULT_HEAVY_JOB_KIND = 'generic' as const;

export interface HeavyJobRequest {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly resourceClass: ResourceAdmissionClass;
  readonly cost: number;
  /**
   * Blocking pre-edit work (#145 U12): user-blocking gate evidence that
   * must jump ahead of background maintenance when promoted. Never
   * admits over controller limits by itself — drain() still decides.
   */
  readonly blocking?: boolean;
  /** Durable job kind used by queue receipts and recovery (#145 U5). */
  readonly jobKind?: string;
  /** Caller-supplied request time; the queue stamps one when omitted. */
  readonly requestedAt?: string;
}

/** Normalized durable identity of one queued heavy job. */
export interface HeavyJobQueueEntry {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly sessionId?: string;
  readonly jobKind: string;
  readonly resourceClass: ResourceAdmissionClass;
  readonly cost: number;
  readonly blocking: boolean;
  readonly requestedAt: string;
}

export type HeavyJobEnqueueResult =
  | { readonly status: 'queued'; readonly operationId: string; readonly depth: number }
  | {
      readonly status: 'coalesced';
      readonly operationId: string;
      readonly depth: number;
      /**
       * `true` when this queue now owns the coalesced work locally, so a
       * later drain() can execute it. `false` means another live owner (or a
       * running generation) already holds it.
       */
      readonly queued: boolean;
    }
  | { readonly status: 'rejected'; readonly code: 'QUEUE_FULL'; readonly operationId: string; readonly depth: number };

export type HeavyJobSupersedeResult =
  | { readonly status: 'superseded'; readonly retired: string; readonly queued: string; readonly depth: number }
  | { readonly status: 'queued'; readonly queued: string; readonly depth: number }
  | { readonly status: 'coalesced'; readonly queued: string; readonly depth: number }
  | { readonly status: 'rejected'; readonly code: 'QUEUE_FULL'; readonly queued: string; readonly depth: number };

export interface HeavyJobAdmission {
  readonly lease: ResourceAdmissionLease;
}

export type HeavyJobClaimResult =
  | { readonly status: 'queued'; readonly operationId: string; readonly position: number; readonly depth: number }
  | { readonly status: 'coalesced'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'running'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'full'; readonly operationId: string; readonly depth: number };

/** Re-attachment never creates work: `missing` means the row is gone. */
export type HeavyJobReattachResult =
  | { readonly status: 'queued'; readonly operationId: string; readonly position: number; readonly depth: number }
  | { readonly status: 'coalesced'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'running'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'missing'; readonly operationId: string; readonly depth: number };

export type HeavyJobSupersedeStoreResult =
  | { readonly status: 'superseded'; readonly operationId: string; readonly position: number; readonly depth: number }
  | { readonly status: 'queued'; readonly operationId: string; readonly position: number; readonly depth: number }
  | { readonly status: 'coalesced'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'full'; readonly operationId: string; readonly depth: number };

export type HeavyJobLiveState = 'queued' | 'running';

/** One durable live queue row, as observed by restart recovery. */
export interface HeavyJobLiveEntry extends HeavyJobQueueEntry {
  readonly state: HeavyJobLiveState;
  readonly position: number;
  readonly attempt: number;
  readonly ownerId?: string;
  readonly startedAt?: string;
  readonly heartbeatAt: string;
}

export type HeavyJobTerminalOutcome = 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'superseded';

export type HeavyJobRecoveryAction = 'orphan' | 'interrupt' | 'expire';

/**
 * Durable queue state at the #145 seam.
 *
 * Implementations must make every transition atomic: a claimed job is either
 * queued or owned by exactly one live owner, and a started job can only be
 * settled once. Ownership is fenced by `ownerId`; only restart recovery may
 * retire another owner's stale row through `recover()`.
 */
export interface HeavyJobQueueStore {
  claim(entry: HeavyJobQueueEntry, maxQueued: number): HeavyJobClaimResult;
  /**
   * Claim an existing live row only (#145 restart). Never inserts and never
   * revives a terminal row: `missing` means the admission generation is gone.
   */
  claimExisting(entry: HeavyJobQueueEntry): HeavyJobReattachResult;
  /** Returns the durable position the operation now holds, or undefined when it is not queued. */
  promote(operationId: string): number | undefined;
  cancel(operationId: string, finishedAt: string): boolean;
  supersede(
    staleOperationId: string,
    entry: HeavyJobQueueEntry,
    maxQueued: number,
  ): HeavyJobSupersedeStoreResult;
  start(operationId: string, startedAt: string): boolean;
  settle(
    operationId: string,
    outcome: Extract<HeavyJobTerminalOutcome, 'completed' | 'failed'>,
    finishedAt: string,
    detail?: string,
  ): boolean;
  recover(
    operationId: string,
    action: HeavyJobRecoveryAction,
    input: { readonly at: string; readonly detail?: string },
  ): boolean;
  depth(): number;
  listLive(): readonly HeavyJobLiveEntry[];
}

export interface HeavyJobWaiterQueueOptions {
  readonly maxQueued?: number;
  /** Durable state authority; omitted for the process-local queue. */
  readonly store?: HeavyJobQueueStore;
  readonly now?: () => Date;
  /**
   * Called when drain() drops a local row because its durable row is no longer
   * claimable (retired by recovery or another owner). The owner must retire the
   * work it parked for that operation; no admission will ever follow.
   */
  readonly onRetired?: (operationId: string) => void;
}

interface LocalHeavyJob {
  readonly entry: HeavyJobQueueEntry;
  position: number;
}

/**
 * Bounded FIFO waiter queue above the admission controller (#145 U3).
 *
 * The controller stays the final admission authority: this queue never
 * admits over limits itself. It holds RESOURCE_PRESSURE work, coalesces
 * duplicate exact-input requests, rejects over bound, and cancels queued
 * (never running) work immediately. Callers invoke drain() after a lease
 * release so the next eligible job starts without a retry round-trip.
 *
 * With a durable `store` (#145 U5) the queue becomes the process-local view
 * of durable state: a claim survives a restart, a live foreign owner is
 * never stolen, and start()/settle() keep the durable lifecycle truthful.
 */
export class HeavyJobWaiterQueue {
  private readonly queued: LocalHeavyJob[] = [];
  private readonly maxQueued: number;
  private readonly store: HeavyJobQueueStore | undefined;
  private readonly now: () => Date;
  private readonly onRetired: ((operationId: string) => void) | undefined;
  private nextPosition = 1;

  public constructor(
    private readonly controller: ResourceAdmissionController,
    options: HeavyJobWaiterQueueOptions = {},
  ) {
    const max = options.maxQueued ?? 64;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError('maxQueued must be a positive safe integer');
    }
    this.maxQueued = max;
    this.store = options.store;
    this.now = options.now ?? ((): Date => new Date());
    this.onRetired = options.onRetired;
  }

  public enqueue(request: HeavyJobRequest): HeavyJobEnqueueResult {
    const entry = normalizeEntry(request, this.now().toISOString());
    if (this.store !== undefined) return this.enqueueDurable(entry);
    return this.enqueueLocal(entry);
  }

  /**
   * Re-attach to a durable row that already exists (#145 restart). Unlike
   * enqueue(), this never creates or revives a row: a missing row is reported
   * so the caller can fail the parked work instead of starting a generation
   * whose admission is gone.
   */
  public reattach(request: HeavyJobRequest): HeavyJobReattachResult {
    const entry = normalizeEntry(request, this.now().toISOString());
    if (this.store === undefined) {
      return { status: 'missing', operationId: entry.operationId, depth: this.queued.length };
    }
    const claim = this.store.claimExisting(entry);
    if (claim.status === 'queued'
      && !this.queued.some((candidate) => candidate.entry.operationId === entry.operationId)) {
      this.insertLocal(entry, claim.position);
    }
    return claim;
  }

  private enqueueLocal(entry: HeavyJobQueueEntry): HeavyJobEnqueueResult {
    const existing = this.queued.find((candidate) => candidate.entry.operationId === entry.operationId);
    if (existing !== undefined) {
      return { status: 'coalesced', operationId: entry.operationId, depth: this.queued.length, queued: true };
    }
    if (this.queued.length >= this.maxQueued) {
      return { status: 'rejected', code: 'QUEUE_FULL', operationId: entry.operationId, depth: this.queued.length };
    }
    this.insertLocal(entry, this.nextPosition);
    return { status: 'queued', operationId: entry.operationId, depth: this.queued.length };
  }

  private enqueueDurable(entry: HeavyJobQueueEntry): HeavyJobEnqueueResult {
    const claim = this.store!.claim(entry, this.maxQueued);
    if (claim.status === 'full') {
      return { status: 'rejected', code: 'QUEUE_FULL', operationId: entry.operationId, depth: claim.depth };
    }
    if (claim.status === 'coalesced') {
      const local = this.queued.some((candidate) => candidate.entry.operationId === entry.operationId);
      return { status: 'coalesced', operationId: entry.operationId, depth: claim.depth, queued: local };
    }
    if (claim.status === 'running') {
      return { status: 'coalesced', operationId: entry.operationId, depth: claim.depth, queued: false };
    }
    if (!this.queued.some((candidate) => candidate.entry.operationId === entry.operationId)) {
      this.insertLocal(entry, claim.position);
    }
    return { status: 'queued', operationId: entry.operationId, depth: claim.depth };
  }

  /**
   * Promote a queued blocking operation to the head (#145 U12).
   *
   * A pending background delta that becomes a blocking pre-edit target
   * jumps ahead of background work; relative order of everything else is
   * preserved. Returns false only when the operation is not queued — or when
   * its durable row is no longer claimable, in which case the local entry is
   * dropped so it cannot execute without durable ownership.
   */
  public promote(operationId: string): boolean {
    const index = this.queued.findIndex((entry) => entry.entry.operationId === operationId);
    if (index === -1) return false;
    if (this.store !== undefined) {
      const position = this.store.promote(operationId);
      if (position === undefined) {
        this.queued.splice(index, 1);
        return false;
      }
      const [entry] = this.queued.splice(index, 1);
      entry!.position = position;
      this.queued.unshift(entry!);
      return true;
    }
    if (index === 0) return true;
    const [entry] = this.queued.splice(index, 1);
    entry!.position = this.minimumPosition() - 1;
    this.queued.unshift(entry!);
    return true;
  }

  public cancel(operationId: string): boolean {
    const index = this.queued.findIndex((entry) => entry.entry.operationId === operationId);
    if (index === -1) return false;
    this.queued.splice(index, 1);
    this.store?.cancel(operationId, this.now().toISOString());
    return true;
  }

  /**
   * Replace a stale queued generation with its successor (#145 U4).
   *
   * A stale exact-head verification job (H1 replaced by H2) must not waste
   * resources: H1 is retired in place and H2 inherits its queue position.
   * When H1 is absent (already drained/cancelled), H2 is enqueued normally.
   * Queued-only: running leases are never touched — cancellation of running
   * work stays with exact execution/generation cancellation.
   */
  public supersede(
    staleOperationId: string,
    replacementOperationId: string,
    request: Omit<HeavyJobRequest, 'operationId'>,
  ): HeavyJobSupersedeResult {
    const entry = normalizeEntry(
      { ...request, operationId: replacementOperationId },
      this.now().toISOString(),
    );
    if (this.store !== undefined) {
      const stored = this.store.supersede(staleOperationId, entry, this.maxQueued);
      if (stored.status === 'full') {
        return { status: 'rejected', code: 'QUEUE_FULL', queued: replacementOperationId, depth: stored.depth };
      }
      const index = this.queued.findIndex((candidate) => candidate.entry.operationId === staleOperationId);
      if (index !== -1) this.queued.splice(index, 1);
      if (stored.status === 'coalesced') {
        return { status: 'coalesced', queued: replacementOperationId, depth: stored.depth };
      }
      if (!this.queued.some((candidate) => candidate.entry.operationId === replacementOperationId)) {
        this.insertLocal(entry, stored.position);
      }
      if (stored.status === 'superseded') {
        return { status: 'superseded', retired: staleOperationId, queued: replacementOperationId, depth: stored.depth };
      }
      return { status: 'queued', queued: replacementOperationId, depth: stored.depth };
    }

    const index = this.queued.findIndex((candidate) => candidate.entry.operationId === staleOperationId);
    if (index === -1) {
      const enqueued = this.enqueueLocal(entry);
      if (enqueued.status === 'rejected') {
        return { status: 'rejected', code: 'QUEUE_FULL', queued: replacementOperationId, depth: enqueued.depth };
      }
      if (enqueued.status === 'coalesced') {
        return { status: 'coalesced', queued: replacementOperationId, depth: enqueued.depth };
      }
      return { status: 'queued', queued: replacementOperationId, depth: enqueued.depth };
    }
    if (this.queued.some((candidate) => candidate.entry.operationId === replacementOperationId)) {
      this.queued.splice(index, 1);
      return { status: 'coalesced', queued: replacementOperationId, depth: this.queued.length };
    }
    const stale = this.queued[index]!;
    this.queued.splice(index, 1, { entry, position: stale.position });
    return { status: 'superseded', retired: staleOperationId, queued: replacementOperationId, depth: this.queued.length };
  }

  public depth(): number {
    return this.store === undefined ? this.queued.length : this.store.depth();
  }

  /** Local queue position of one operation, or undefined when this queue does not hold it. */
  public position(operationId: string): number | undefined {
    return this.queued.find((candidate) => candidate.entry.operationId === operationId)?.position;
  }

  /**
   * Record the terminal outcome of one admitted job. Fail-closed callers invoke
   * this on every exit path; a duplicate/losing settle is a no-op.
   */
  public settle(
    operationId: string,
    outcome: Extract<HeavyJobTerminalOutcome, 'completed' | 'failed'>,
    detail?: string,
  ): boolean {
    return this.store?.settle(operationId, outcome, this.now().toISOString(), detail) ?? true;
  }

  /**
   * Admit queued jobs in position order while the controller allows.
   *
   * A scoped denial (workspace, session or resource-class ceiling) only
   * blocks that scope, so a later job from another scope may still run:
   * backfill it instead of letting one project's saturated workspace hold
   * the whole queue. Global denials (memory pressure, global cost or the
   * operation limit) stop the drain because no later job can fit either.
   * Within the admitted scopes, position order is preserved.
   */
  public drain(): HeavyJobAdmission[] {
    const admitted: HeavyJobAdmission[] = [];
    for (const queued of [...this.queued]) {
      const candidate: ResourceAdmissionRequest = {
        operationId: queued.entry.operationId,
        workspaceId: queued.entry.workspaceId,
        ...(queued.entry.sessionId === undefined ? {} : { sessionId: queued.entry.sessionId }),
        resourceClass: queued.entry.resourceClass,
        cost: queued.entry.cost,
      };
      const decision = this.controller.tryAcquire(candidate);
      if (!decision.admitted) {
        if (decision.code === 'RESOURCE_PRESSURE' && isGlobalAdmissionDenial(decision.reason)) break;
        continue;
      }
      if (this.store !== undefined && !this.store.start(queued.entry.operationId, this.now().toISOString())) {
        // The durable row was retired (recovery, cancellation, or another
        // owner) while this queue still held a stale local view. Never run
        // work that no longer owns a durable slot.
        this.controller.release(decision.lease);
        this.removeLocal(queued.entry.operationId);
        this.onRetired?.(queued.entry.operationId);
        continue;
      }
      this.removeLocal(queued.entry.operationId);
      admitted.push({ lease: decision.lease });
    }
    return admitted;
  }

  private insertLocal(entry: HeavyJobQueueEntry, position: number): void {
    const candidate: LocalHeavyJob = { entry, position };
    const index = this.queued.findIndex((queued) => queued.position > position);
    if (index === -1) this.queued.push(candidate);
    else this.queued.splice(index, 0, candidate);
    this.nextPosition = Math.max(this.nextPosition, position + 1);
  }

  private minimumPosition(): number {
    return this.queued.length === 0 ? 0 : Math.min(...this.queued.map((entry) => entry.position));
  }

  private removeLocal(operationId: string): void {
    const index = this.queued.findIndex((candidate) => candidate.entry.operationId === operationId);
    if (index !== -1) this.queued.splice(index, 1);
  }
}

/**
 * Denials that apply to every queued job, not a single workspace, session or
 * resource class. Costs are positive and the operation limit is global, so a
 * later job cannot fit once one of these is hit.
 *
 * `heavy_capacity_exhausted` is deliberately absent (#145): it denies only the
 * heavy classes, so a queued light job behind it may still be backfilled into
 * the remaining capacity.
 */
function isGlobalAdmissionDenial(
  reason: Exclude<ResourceAdmissionRejectionReason, 'invalid_request' | 'duplicate_operation'>,
): boolean {
  return reason === 'memory_pressure'
    || reason === 'global_cost_exhausted'
    || reason === 'operation_limit_exhausted';
}

function normalizeEntry(request: HeavyJobRequest, fallbackRequestedAt: string): HeavyJobQueueEntry {
  const jobKind = request.jobKind?.trim();
  return {
    operationId: request.operationId,
    workspaceId: request.workspaceId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    jobKind: jobKind !== undefined && jobKind.length > 0 ? jobKind : DEFAULT_HEAVY_JOB_KIND,
    resourceClass: request.resourceClass,
    cost: request.cost,
    blocking: request.blocking === true,
    requestedAt: request.requestedAt ?? fallbackRequestedAt,
  };
}

/** Runtime guard for durable rows written by newer/older builds. */
export function isResourceAdmissionClass(value: unknown): value is ResourceAdmissionClass {
  return typeof value === 'string' && (RESOURCE_ADMISSION_CLASSES as readonly string[]).includes(value);
}
