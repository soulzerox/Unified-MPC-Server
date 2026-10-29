import {
  DEFAULT_RAG_INDEX_ADMISSION_COST,
  DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
  HeavyJobWaiterQueue,
  type HeavyJobQueueStore,
  type ResourceAdmissionController,
  type ResourceAdmissionLease,
} from '@unified-mpc/workspace';
import type {
  ShellHeavyAdmissionEnqueueResult,
  ShellHeavyAdmissionGrant,
  ShellHeavyAdmissionLease,
  ShellHeavyAdmissionPort,
  ShellHeavyAdmissionRequest,
} from '@unified-mpc/capabilities';

const ADMISSION_COST: Readonly<Record<ShellHeavyAdmissionRequest['resourceClass'], number>> = {
  rag_indexing: DEFAULT_RAG_INDEX_ADMISSION_COST,
  verification_heavy: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
};

/** Global bound on shell work waiting for one heavy slot. */
export const SHELL_HEAVY_ADMISSION_QUEUE_LIMIT = 16;
export const SHELL_HEAVY_ADMISSION_JOB_KIND = 'shell_command';

/**
 * Durable queue adapter for declared heavy `shell` runs (#145).
 *
 * The controller stays the only admission authority and the `HeavyJobWaiterQueue`
 * is the bounded durable waiter list. `enqueue` claims a row but starts nothing;
 * the backend reserves the durable task record first, then calls `pump()`.
 * Capacity releases wake the same drain, so the next declared run starts with
 * no second tool call.
 */
export function createShellHeavyAdmissionPort(
  getController: () => ResourceAdmissionController,
  getStore: () => HeavyJobQueueStore | undefined = () => undefined,
): ShellHeavyAdmissionPort {
  let queue: HeavyJobWaiterQueue | undefined;
  let controller: ResourceAdmissionController | undefined;
  const listeners = new Set<(grant: ShellHeavyAdmissionGrant) => void>();
  const retiredListeners = new Set<(operationId: string) => void>();

  const notifyRetired = (operationId: string): void => {
    for (const listener of [...retiredListeners]) {
      try {
        listener(operationId);
      } catch {
        // A failing owner must not block the rest of the retired batch.
      }
    }
  };

  const ensureQueue = (): HeavyJobWaiterQueue => {
    if (queue !== undefined) return queue;
    controller = getController();
    const store = getStore();
    queue = new HeavyJobWaiterQueue(controller, {
      maxQueued: SHELL_HEAVY_ADMISSION_QUEUE_LIMIT,
      ...(store === undefined ? {} : { store }),
      onRetired: notifyRetired,
    });
    controller.onRelease(() => { wake(); });
    return queue;
  };

  function wake(): void {
    if (queue === undefined || controller === undefined) return;
    for (const grant of drain(queue, controller)) {
      for (const listener of [...listeners]) {
        try {
          listener(grant);
        } catch {
          // A failing executor must not block the rest of the admitted batch.
        }
      }
    }
  }

  return {
    enqueue: (request: ShellHeavyAdmissionRequest): ShellHeavyAdmissionEnqueueResult => {
      const cost = ADMISSION_COST[request.resourceClass];
      try {
        const target = ensureQueue();
        const enqueued = target.enqueue({
          operationId: request.operationId,
          workspaceId: request.workspaceId ?? 'shell-heavy',
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          resourceClass: request.resourceClass,
          cost,
          blocking: true,
          jobKind: SHELL_HEAVY_ADMISSION_JOB_KIND,
        });
        if (enqueued.status === 'queued') {
          return { status: 'queued', position: target.position(request.operationId) ?? 0, depth: enqueued.depth, cost };
        }
        if (enqueued.status === 'coalesced') {
          // `queued` means this queue adopted the durable row (restart
          // re-attachment); a row held by a live foreign owner stays skipped.
          return enqueued.queued
            ? { status: 'queued', position: target.position(request.operationId) ?? 0, depth: enqueued.depth, cost }
            : { status: 'coalesced', depth: enqueued.depth, cost };
        }
        return { status: 'full', depth: enqueued.depth, cost };
      } catch {
        return { status: 'failed', depth: 0, cost };
      }
    },
    pump: (): readonly ShellHeavyAdmissionGrant[] => {
      if (queue === undefined || controller === undefined) return [];
      try {
        return drain(queue, controller);
      } catch {
        // The durable rows remain; the next release or request retries the drain.
        return [];
      }
    },
    cancel: (operationId: string): boolean => {
      try {
        return queue?.cancel(operationId) ?? false;
      } catch {
        return false;
      }
    },
    position: (operationId: string): number | undefined => queue?.position(operationId),
    onAdmitted: (listener: (grant: ShellHeavyAdmissionGrant) => void): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    onRetired: (listener: (operationId: string) => void): (() => void) => {
      retiredListeners.add(listener);
      return (): void => {
        retiredListeners.delete(listener);
      };
    },
  };
}

function drain(queue: HeavyJobWaiterQueue, controller: ResourceAdmissionController): ShellHeavyAdmissionGrant[] {
  return queue.drain().map(({ lease }) => ({
    operationId: lease.operationId,
    lease: settleOnce(queue, controller, lease),
  }));
}

/** One lease, two settles: the durable queue row and the controller slot. */
function settleOnce(
  queue: HeavyJobWaiterQueue,
  controller: ResourceAdmissionController,
  lease: ResourceAdmissionLease,
): ShellHeavyAdmissionLease {
  let settled = false;
  return {
    settle: (outcome): void => {
      if (settled) return;
      settled = true;
      // Settle the durable row before releasing capacity, so the wake that
      // follows can never observe this job as still running.
      queue.settle(lease.operationId, outcome === 'completed' ? 'completed' : 'failed', outcome);
      controller.release(lease);
    },
  };
}
