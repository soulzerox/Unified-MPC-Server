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
}

export type HeavyJobEnqueueResult =
  | { readonly status: 'queued'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'coalesced'; readonly operationId: string; readonly depth: number }
  | { readonly status: 'rejected'; readonly code: 'QUEUE_FULL'; readonly operationId: string; readonly depth: number };

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

  public cancel(operationId: string): boolean {
    const index = this.queued.findIndex((entry) => entry.operationId === operationId);
    if (index === -1) return false;
    this.queued.splice(index, 1);
    return true;
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
