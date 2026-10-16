import {
  type ResourceAdmissionClass,
  type ResourceAdmissionController,
  type ResourceAdmissionLease,
  type ResourceAdmissionRequest,
} from './resource-admission.js';

export const HEAVY_JOB_QUEUE_VERSION = 1 as const;

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
}

export type HeavyJobEnqueueResult =
  | { readonly status: 'queued'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'coalesced'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'rejected'; readonly code: 'QUEUE_FULL'; readonly operationId: string; readonly depth: number };

export type HeavyJobSupersedeResult =
  | { readonly status: 'superseded'; readonly retired: string; readonly queued: string; readonly depth: number }
  | { readonly status: 'queued'; readonly queued: string; readonly depth: number }
  | { readonly status: 'rejected'; readonly code: 'QUEUE_FULL'; readonly queued: string; readonly depth: number };

export interface HeavyJobAdmission {
  readonly lease: ResourceAdmissionLease;
}

export interface HeavyJobWaiterQueueOptions {
  readonly maxQueued?: number;
}

/**
 * Bounded FIFO waiter queue above the admission controller (#145 U3).
 *
 * The controller stays the final admission authority: this queue never
 * admits over limits itself. It holds RESOURCE_PRESSURE work, coalesces
 * duplicate exact-input requests, rejects over bound, and cancels queued
 * (never running) work immediately. Callers invoke drain() after a lease
 * release so the next eligible job starts without a retry round-trip.
 */
export class HeavyJobWaiterQueue {
  private readonly queued: HeavyJobRequest[] = [];
  private readonly maxQueued: number;

  public constructor(
    private readonly controller: ResourceAdmissionController,
    options: HeavyJobWaiterQueueOptions = {},
  ) {
    const max = options.maxQueued ?? 64;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError('maxQueued must be a positive safe integer');
    }
    this.maxQueued = max;
  }

  public enqueue(request: HeavyJobRequest): HeavyJobEnqueueResult {
    const existing = this.queued.findIndex((entry) => entry.operationId === request.operationId);
    if (existing !== -1) {
      return { status: 'coalesced', operationId: request.operationId, depth: this.queued.length };
    }
    if (this.queued.length >= this.maxQueued) {
      return { status: 'rejected', code: 'QUEUE_FULL', operationId: request.operationId, depth: this.queued.length };
    }
    this.queued.push({ ...request });
    return { status: 'queued', operationId: request.operationId, depth: this.queued.length };
  }

  /**
   * Promote a queued blocking operation to the head (#145 U12).
   *
   * A pending background delta that becomes a blocking pre-edit target
   * jumps ahead of background work; relative order of everything else is
   * preserved. Returns false only when the operation is not queued.
   */
  public promote(operationId: string): boolean {
    const index = this.queued.findIndex((entry) => entry.operationId === operationId);
    if (index === -1) return false;
    if (index === 0) return true;
    const [entry] = this.queued.splice(index, 1);
    this.queued.unshift(entry!);
    return true;
  }

  public cancel(operationId: string): boolean {
    const index = this.queued.findIndex((entry) => entry.operationId === operationId);
    if (index === -1) return false;
    this.queued.splice(index, 1);
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
    const index = this.queued.findIndex((entry) => entry.operationId === staleOperationId);
    if (index === -1) {
      const enqueued = this.enqueue({ ...request, operationId: replacementOperationId });
      if (enqueued.status === 'rejected') {
        return { status: 'rejected', code: 'QUEUE_FULL', queued: replacementOperationId, depth: enqueued.depth };
      }
      return { status: 'queued', queued: replacementOperationId, depth: enqueued.depth };
    }
    this.queued.splice(index, 1, { ...request, operationId: replacementOperationId });
    return { status: 'superseded', retired: staleOperationId, queued: replacementOperationId, depth: this.queued.length };
  }

  public depth(): number {
    return this.queued.length;
  }

  /**
   * Admit queued jobs FIFO while the controller allows. Stops at the first
   * still-pressured head so ordering is preserved across drains.
   */
  public drain(): HeavyJobAdmission[] {
    const admitted: HeavyJobAdmission[] = [];
    while (this.queued.length > 0) {
      const head = this.queued[0] as HeavyJobRequest;
      const candidate: ResourceAdmissionRequest = {
        operationId: head.operationId,
        workspaceId: head.workspaceId,
        ...(head.sessionId === undefined ? {} : { sessionId: head.sessionId }),
        resourceClass: head.resourceClass,
        cost: head.cost,
      };
      const decision = this.controller.tryAcquire(candidate);
      if (!decision.admitted) break;
      this.queued.shift();
      admitted.push({ lease: decision.lease });
    }
    return admitted;
  }
}
