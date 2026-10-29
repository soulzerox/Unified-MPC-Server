import {
  DEFAULT_RAG_INDEX_ADMISSION_COST,
  DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
  type ResourceAdmissionController,
  type ResourceAdmissionLease,
} from '@unified-mpc/workspace';
import type {
  ShellHeavyAdmissionLease,
  ShellHeavyAdmissionPort,
  ShellHeavyAdmissionRequest,
  ShellHeavyAdmissionResult,
} from '@unified-mpc/capabilities';

const ADMISSION_COST: Readonly<Record<ShellHeavyAdmissionRequest['resourceClass'], number>> = {
  rag_indexing: DEFAULT_RAG_INDEX_ADMISSION_COST,
  verification_heavy: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
};

const RETRY_INTERVAL_MS = 100;

/**
 * Admission adapter for declared heavy `shell` runs (#145).
 *
 * The controller stays the only admission authority. A declaration either takes
 * the slot now, waits for it up to the caller's bounded budget, or fails closed
 * with the controller's last reason. The backend owns the task lifetime and
 * reports the terminal outcome back through the lease, which releases exactly
 * once.
 *
 * There is no durable queue row here on purpose: a queued-not-started shell run
 * needs a durable `waiting_resource` task record first, so slice 1 keeps the
 * caller's retry policy instead of pretending the work is parked.
 */
export function createShellHeavyAdmissionPort(
  getController: () => ResourceAdmissionController,
  now: () => number = () => Date.now(),
): ShellHeavyAdmissionPort {
  return {
    acquire: async (request: ShellHeavyAdmissionRequest): Promise<ShellHeavyAdmissionResult> => {
      const controller = getController();
      const deadline = now() + Math.max(0, request.waitMs);
      for (;;) {
        const decision = controller.tryAcquire({
          operationId: request.operationId,
          workspaceId: request.workspaceId ?? 'shell-heavy',
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          resourceClass: request.resourceClass,
          cost: ADMISSION_COST[request.resourceClass],
        });
        if (decision.admitted) {
          return { admitted: true, lease: releaseOnce(controller, decision.lease) };
        }
        if (now() >= deadline) return { admitted: false, reason: decision.reason };
        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
      }
    },
  };
}

function releaseOnce(controller: ResourceAdmissionController, lease: ResourceAdmissionLease): ShellHeavyAdmissionLease {
  let released = false;
  return {
    settle: (): void => {
      if (released) return;
      released = true;
      controller.release(lease);
    },
  };
}
