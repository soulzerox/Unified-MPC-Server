export type ResourceAdmissionClass = 'dependency_bootstrap' | 'child_mcp_call';

export interface ResourceAdmissionLimits {
  readonly globalCost: number;
  readonly workspaceCost: number;
  readonly maxOperations: number;
}

export const DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS = Object.freeze({
  globalCost: 16,
  workspaceCost: 8,
  maxOperations: 8,
}) satisfies ResourceAdmissionLimits;

export const DEFAULT_CHILD_MCP_CALL_ADMISSION_COST = 3;

export interface ResourceAdmissionRequest {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly resourceClass: ResourceAdmissionClass;
  readonly cost: number;
}

export interface ResourceAdmissionLease {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly resourceClass: ResourceAdmissionClass;
  readonly cost: number;
}

export interface ResourceAdmissionSnapshot {
  readonly activeCost: number;
  readonly activeOperations: number;
  readonly activeCostByClass: Readonly<Record<ResourceAdmissionClass, number>>;
  readonly activeCostByWorkspace: Readonly<Record<string, number>>;
  readonly rejected: number;
}

export type ResourceAdmissionRejectionReason =
  | 'invalid_request'
  | 'duplicate_operation'
  | 'global_cost_exhausted'
  | 'workspace_cost_exhausted'
  | 'operation_limit_exhausted';

export type ResourceAdmissionDecision =
  | {
      readonly admitted: true;
      readonly lease: ResourceAdmissionLease;
      readonly snapshot: ResourceAdmissionSnapshot;
    }
  | {
      readonly admitted: false;
      readonly code: 'RESOURCE_PRESSURE';
      readonly reason: Exclude<ResourceAdmissionRejectionReason, 'invalid_request' | 'duplicate_operation'>;
      readonly requestedCost: number;
      readonly retryable: true;
      readonly snapshot: ResourceAdmissionSnapshot;
    }
  | {
      readonly admitted: false;
      readonly code: 'INVALID_INPUT';
      readonly reason: 'invalid_request' | 'duplicate_operation';
      readonly requestedCost: number;
      readonly retryable: false;
      readonly snapshot: ResourceAdmissionSnapshot;
    };

/**
 * Synchronous, fail-closed admission for expensive work.
 *
 * This intentionally has no waiter queue: callers either start now or receive
 * a bounded RESOURCE_PRESSURE decision and can retry under their own policy.
 * Share one instance across transports to make the limits process-wide.
 */
export class ResourceAdmissionController {
  private readonly limits: ResourceAdmissionLimits;
  private readonly active = new Map<string, ResourceAdmissionLease>();
  private rejected = 0;

  public constructor(limits: ResourceAdmissionLimits) {
    validateLimit(limits.globalCost, 'globalCost');
    validateLimit(limits.workspaceCost, 'workspaceCost');
    validateLimit(limits.maxOperations, 'maxOperations');
    this.limits = { ...limits };
  }

  public tryAcquire(request: ResourceAdmissionRequest): ResourceAdmissionDecision {
    const requestedCost = typeof request.cost === 'number' && Number.isFinite(request.cost) ? request.cost : 0;
    const invalid = validateRequest(request);
    if (invalid !== undefined) return this.rejectInvalid(invalid, requestedCost);
    if (this.active.has(request.operationId)) return this.rejectInvalid('duplicate_operation', requestedCost);

    const snapshot = this.snapshot();
    const workspaceCost = snapshot.activeCostByWorkspace[request.workspaceId] ?? 0;
    const reason = snapshot.activeCost + request.cost > this.limits.globalCost
      ? 'global_cost_exhausted'
      : workspaceCost + request.cost > this.limits.workspaceCost
        ? 'workspace_cost_exhausted'
        : snapshot.activeOperations >= this.limits.maxOperations
          ? 'operation_limit_exhausted'
          : undefined;
    if (reason !== undefined) {
      this.rejected += 1;
      return {
        admitted: false,
        code: 'RESOURCE_PRESSURE',
        reason,
        requestedCost,
        retryable: true,
        snapshot: this.snapshot(),
      };
    }

    const lease: ResourceAdmissionLease = {
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      resourceClass: request.resourceClass,
      cost: request.cost,
    };
    this.active.set(lease.operationId, lease);
    return { admitted: true, lease, snapshot: this.snapshot() };
  }

  public release(lease: ResourceAdmissionLease): boolean {
    const current = this.active.get(lease.operationId);
    if (current === undefined || !sameLease(current, lease)) return false;
    this.active.delete(lease.operationId);
    return true;
  }

  public snapshot(): ResourceAdmissionSnapshot {
    const activeCostByClass: Record<ResourceAdmissionClass, number> = {
      dependency_bootstrap: 0,
      child_mcp_call: 0,
    };
    const activeCostByWorkspace: Record<string, number> = {};
    let activeCost = 0;
    for (const lease of this.active.values()) {
      activeCost += lease.cost;
      activeCostByClass[lease.resourceClass] += lease.cost;
      activeCostByWorkspace[lease.workspaceId] = (activeCostByWorkspace[lease.workspaceId] ?? 0) + lease.cost;
    }
    return {
      activeCost,
      activeOperations: this.active.size,
      activeCostByClass,
      activeCostByWorkspace,
      rejected: this.rejected,
    };
  }

  private rejectInvalid(reason: 'invalid_request' | 'duplicate_operation', requestedCost: number): ResourceAdmissionDecision {
    this.rejected += 1;
    return {
      admitted: false,
      code: 'INVALID_INPUT',
      reason,
      requestedCost,
      retryable: false,
      snapshot: this.snapshot(),
    };
  }
}

export function tryAdmitDependencyBootstrap(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'dependency_bootstrap' });
}

export function tryAdmitChildMcpCall(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'child_mcp_call' });
}

let processResourceAdmissionController: ResourceAdmissionController | undefined;

/**
 * Process-owned default controller used by production runtime owners.
 *
 * Callers that need different tested limits can inject their own controller;
 * the default getter intentionally returns the same instance across transports.
 */
export function sharedProcessResourceAdmissionController(): ResourceAdmissionController {
  processResourceAdmissionController ??= new ResourceAdmissionController(DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS);
  return processResourceAdmissionController;
}

function validateLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function validateRequest(request: ResourceAdmissionRequest): 'invalid_request' | undefined {
  if (!isBoundedId(request.operationId) || !isBoundedId(request.workspaceId) || !isResourceClass(request.resourceClass) || !Number.isInteger(request.cost) || request.cost < 1) {
    return 'invalid_request';
  }
  return undefined;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function isResourceClass(value: unknown): value is ResourceAdmissionClass {
  return value === 'dependency_bootstrap' || value === 'child_mcp_call';
}

function sameLease(left: ResourceAdmissionLease, right: ResourceAdmissionLease): boolean {
  return left.operationId === right.operationId
    && left.workspaceId === right.workspaceId
    && left.resourceClass === right.resourceClass
    && left.cost === right.cost;
}
