import { ProcessMemoryPressureProbe } from './resource-pressure.js';
import type { ResourcePressureProbe, ResourcePressureSample, ResourcePressureState } from './resource-pressure.js';
import {
  DEFAULT_HEAVY_BYTES_PER_EXTRA_JOB,
  DEFAULT_HEAVY_HEADROOM_RESERVE_BYTES,
  DEFAULT_HEAVY_MAX_EXTRA_JOBS,
  effectiveHeavyCapacity,
  heavyHeadroomFromEnv,
  normalizeHeavyHeadroom,
  type HeavyHeadroomLimits,
  type NormalizedHeavyHeadroom,
} from './heavy-headroom.js';

export const RESOURCE_ADMISSION_CLASSES = [
  'dependency_bootstrap',
  'context_scan',
  'child_mcp_call',
  'lsp_process',
  'rag_indexing',
  'goal_process',
  'delegated_agent',
  'verification_heavy',
] as const;

export type ResourceAdmissionClass = (typeof RESOURCE_ADMISSION_CLASSES)[number];

/**
 * Classes that consume the same constrained machine budget (#145): a full
 * build/test/lint verification and an embedding/index batch must not overlap
 * on a small host even though they are different classes whose weighted costs
 * (8 + 8) still fit the default global ceiling of 16.
 *
 * Long-lived process classes (`lsp_process`, `goal_process`, `delegated_agent`)
 * and cheap probes stay outside the set: they are bounded by their own class
 * ceiling and by memory pressure, not by the heavy-job concurrency policy.
 */
export const HEAVY_ADMISSION_CLASSES = ['rag_indexing', 'verification_heavy'] as const;

export type HeavyAdmissionClass = (typeof HEAVY_ADMISSION_CLASSES)[number];

const HEAVY_ADMISSION_CLASS_SET: ReadonlySet<ResourceAdmissionClass> = new Set(HEAVY_ADMISSION_CLASSES);

/** One heavy job at a time on the default constrained profile (#145). */
export const DEFAULT_MAX_HEAVY_OPERATIONS = 1;

export interface ResourceAdmissionLimits {
  readonly globalCost: number;
  readonly workspaceCost: number;
  /** Optional for backwards-compatible callers; defaults to the global ceiling. */
  readonly sessionCost?: number;
  readonly maxOperations: number;
  /**
   * Optional configured ceiling on concurrently active `HEAVY_ADMISSION_CLASSES`
   * operations, independent of class and workspace. Defaults to
   * `DEFAULT_MAX_HEAVY_OPERATIONS`. This is the floor and hard bound for the
   * measured extra slots configured by `heavyHeadroom`.
   */
  readonly maxHeavyOperations?: number;
  /**
   * Measured extra heavy slots (#145). Omitted keeps the default policy:
   * one extra slot when normal pressure leaves enough available memory.
   * Set `maxExtraHeavyJobs: 0` to disable the measured widening.
   */
  readonly heavyHeadroom?: Partial<HeavyHeadroomLimits>;
  /** Optional per-class ceilings; unspecified classes default to the global ceiling. */
  readonly resourceClassCost?: Readonly<Partial<Record<ResourceAdmissionClass, number>>>;
}

interface NormalizedResourceAdmissionLimits {
  readonly globalCost: number;
  readonly workspaceCost: number;
  readonly sessionCost: number;
  readonly maxOperations: number;
  readonly maxHeavyOperations: number;
  readonly heavyHeadroom: NormalizedHeavyHeadroom;
  readonly resourceClassCost: Readonly<Record<ResourceAdmissionClass, number>>;
}

export interface ResourceAdmissionControllerOptions {
  readonly pressureProbe?: ResourcePressureProbe;
  /** Effective global weighted-cost ceiling while memory pressure is elevated. */
  readonly elevatedGlobalCostRatio?: number;
  /** Effective global weighted-cost ceiling while memory pressure is critical. */
  readonly criticalGlobalCostRatio?: number;
}

const DEFAULT_ELEVATED_GLOBAL_COST_RATIO = 0.5;
const DEFAULT_CRITICAL_GLOBAL_COST_RATIO = 0;

export const DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS = Object.freeze({
  globalCost: 16,
  workspaceCost: 8,
  sessionCost: 8,
  maxOperations: 8,
  // #145: build/test/lint verification and embedding/index work share one
  // constrained budget, so the default profile runs at most one of them.
  maxHeavyOperations: DEFAULT_MAX_HEAVY_OPERATIONS,
  // #145 measured headroom: one extra slot is possible, but only while the
  // live sample is normal and 4 GiB remains after a 2 GiB reserve.
  heavyHeadroom: Object.freeze({
    maxExtraHeavyJobs: DEFAULT_HEAVY_MAX_EXTRA_JOBS,
    bytesPerExtraHeavyJob: DEFAULT_HEAVY_BYTES_PER_EXTRA_JOB,
    reserveBytes: DEFAULT_HEAVY_HEADROOM_RESERVE_BYTES,
  }),
  resourceClassCost: Object.freeze({
    dependency_bootstrap: 8,
    context_scan: 8,
    child_mcp_call: 12,
    // Preserve cross-project parallelism: two 8-cost LSP processes can run
    // concurrently when global capacity permits; workspace/session caps stay 8.
    lsp_process: 16,
    // Native Thai-RAG indexing has a cancellable lifecycle, but embedding/indexing
    // remains memory-heavy, so keep one 8-cost index at a time by default.
    rag_indexing: 8,
    // Goal-owned project/process work can survive its initiating request, so
    // account one live process per workspace/session by default while allowing
    // two independent workspaces to progress under the global ceiling.
    goal_process: 16,
    // Delegated model/agent workers are long-lived and may fan out. Default to
    // one 8-cost child per workspace/session while allowing independent
    // workspaces to use the remaining global capacity.
    delegated_agent: 16,
    // Exact-head merge verification runs full build/test/lint suites. Keep one
    // verification per class so two heavy verdicts cannot overlap on a
    // constrained host (#305/#145).
    verification_heavy: 8,
  }),
}) satisfies ResourceAdmissionLimits;

export const DEFAULT_CONTEXT_SCAN_ADMISSION_COST = 4;
export const DEFAULT_CHILD_MCP_CALL_ADMISSION_COST = 3;
export const DEFAULT_LSP_PROCESS_ADMISSION_COST = 8;
export const DEFAULT_RAG_INDEX_ADMISSION_COST = 8;
export const DEFAULT_GOAL_PROCESS_ADMISSION_COST = 8;
export const DEFAULT_DELEGATED_AGENT_ADMISSION_COST = 8;
export const DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST = 8;

export interface ResourceAdmissionRequest {
  readonly operationId: string;
  readonly workspaceId: string;
  /**
   * Stable caller/session owner. Background lifecycle work may omit this and
   * is accounted to the explicit non-client "system" owner.
   */
  readonly sessionId?: string;
  readonly resourceClass: ResourceAdmissionClass;
  readonly cost: number;
}

export interface ResourceAdmissionLease {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly resourceClass: ResourceAdmissionClass;
  readonly cost: number;
}

export interface ResourceAdmissionSnapshot {
  readonly activeCost: number;
  readonly activeOperations: number;
  readonly activeCostByClass: Readonly<Record<ResourceAdmissionClass, number>>;
  readonly activeCostByWorkspace: Readonly<Record<string, number>>;
  readonly activeCostBySession: Readonly<Record<string, number>>;
  /** Live `HEAVY_ADMISSION_CLASSES` operations, regardless of workspace. */
  readonly activeHeavyOperations: number;
  /** Configured heavy ceiling; the floor and hard bound for measured extras. */
  readonly maxHeavyOperations: number;
  /**
   * Ceiling that `activeHeavyOperations` is actually compared against: the
   * configured cap plus any measured extra slots available right now.
   */
  readonly effectiveMaxHeavyOperations: number;
  readonly rejected: number;
  readonly pressureState: ResourcePressureState;
  readonly effectiveGlobalCost: number;
  /** Present when a live pressure probe produced the current bounded sample. */
  readonly pressure?: ResourcePressureSample;
}

export type ResourceAdmissionRejectionReason =
  | 'invalid_request'
  | 'duplicate_operation'
  | 'memory_pressure'
  | 'global_cost_exhausted'
  | 'workspace_cost_exhausted'
  | 'session_cost_exhausted'
  | 'resource_class_cost_exhausted'
  | 'heavy_capacity_exhausted'
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
  private readonly limits: NormalizedResourceAdmissionLimits;
  private readonly pressureProbe: ResourcePressureProbe | undefined;
  private readonly elevatedGlobalCostRatio: number;
  private readonly criticalGlobalCostRatio: number;
  private readonly active = new Map<string, ResourceAdmissionLease>();
  private readonly releaseListeners = new Set<() => void>();
  private rejected = 0;

  public constructor(limits: ResourceAdmissionLimits, options: ResourceAdmissionControllerOptions = {}) {
    validateLimit(limits.globalCost, 'globalCost');
    validateLimit(limits.workspaceCost, 'workspaceCost');
    validateLimit(limits.sessionCost ?? limits.globalCost, 'sessionCost');
    validateLimit(limits.maxOperations, 'maxOperations');
    validateLimit(limits.maxHeavyOperations ?? DEFAULT_MAX_HEAVY_OPERATIONS, 'maxHeavyOperations');
    const heavyHeadroom = normalizeHeavyHeadroom(limits.heavyHeadroom);
    for (const resourceClass of RESOURCE_ADMISSION_CLASSES) {
      validateLimit(limits.resourceClassCost?.[resourceClass] ?? limits.globalCost, `resourceClassCost.${resourceClass}`);
    }
    this.limits = {
      globalCost: limits.globalCost,
      workspaceCost: limits.workspaceCost,
      sessionCost: limits.sessionCost ?? limits.globalCost,
      maxOperations: limits.maxOperations,
      maxHeavyOperations: limits.maxHeavyOperations ?? DEFAULT_MAX_HEAVY_OPERATIONS,
      heavyHeadroom,
      resourceClassCost: {
        dependency_bootstrap: limits.resourceClassCost?.dependency_bootstrap ?? limits.globalCost,
        context_scan: limits.resourceClassCost?.context_scan ?? limits.globalCost,
        child_mcp_call: limits.resourceClassCost?.child_mcp_call ?? limits.globalCost,
        lsp_process: limits.resourceClassCost?.lsp_process ?? limits.globalCost,
        rag_indexing: limits.resourceClassCost?.rag_indexing ?? limits.globalCost,
        goal_process: limits.resourceClassCost?.goal_process ?? limits.globalCost,
        delegated_agent: limits.resourceClassCost?.delegated_agent ?? limits.globalCost,
        verification_heavy: limits.resourceClassCost?.verification_heavy ?? limits.globalCost,
      },
    };

    this.pressureProbe = options.pressureProbe;
    this.elevatedGlobalCostRatio = options.elevatedGlobalCostRatio ?? DEFAULT_ELEVATED_GLOBAL_COST_RATIO;
    this.criticalGlobalCostRatio = options.criticalGlobalCostRatio ?? DEFAULT_CRITICAL_GLOBAL_COST_RATIO;
    validateCostRatio(this.elevatedGlobalCostRatio, 'elevatedGlobalCostRatio');
    validateCostRatio(this.criticalGlobalCostRatio, 'criticalGlobalCostRatio');
    if (this.criticalGlobalCostRatio > this.elevatedGlobalCostRatio) {
      throw new Error('criticalGlobalCostRatio must be <= elevatedGlobalCostRatio');
    }
  }

  public tryAcquire(request: ResourceAdmissionRequest): ResourceAdmissionDecision {
    const requestedCost = typeof request.cost === 'number' && Number.isFinite(request.cost) ? request.cost : 0;
    const invalid = validateRequest(request);
    if (invalid !== undefined) return this.rejectInvalid(invalid, requestedCost);
    if (this.active.has(request.operationId)) return this.rejectInvalid('duplicate_operation', requestedCost);

    const sessionId = normalizeSessionId(request.sessionId);
    const pressure = this.readPressure();
    const snapshot = this.buildSnapshot(pressure);
    const workspaceCost = snapshot.activeCostByWorkspace[request.workspaceId] ?? 0;
    const sessionCost = snapshot.activeCostBySession[sessionId] ?? 0;
    const classCost = snapshot.activeCostByClass[request.resourceClass];
    const exceedsEffectiveGlobalCost = snapshot.activeCost + request.cost > snapshot.effectiveGlobalCost;
    // #145 one-heavy-at-a-time: heavy classes share one machine budget, so the
    // cross-class ceiling sits after the class ceiling. Global/pressure denials
    // still win (they hold for every later job), and a same-workspace or
    // same-class denial keeps its more specific reason.
    const heavyCapacityExhausted = isHeavyAdmissionClass(request.resourceClass)
      && snapshot.activeHeavyOperations >= snapshot.effectiveMaxHeavyOperations;
    const reason = exceedsEffectiveGlobalCost
      ? snapshot.pressureState === 'normal'
        ? 'global_cost_exhausted'
        : 'memory_pressure'
      : workspaceCost + request.cost > this.limits.workspaceCost
        ? 'workspace_cost_exhausted'
        : sessionCost + request.cost > this.limits.sessionCost
          ? 'session_cost_exhausted'
          : classCost + request.cost > this.limits.resourceClassCost[request.resourceClass]
            ? 'resource_class_cost_exhausted'
            : heavyCapacityExhausted
              ? 'heavy_capacity_exhausted'
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
        snapshot: this.buildSnapshot(pressure),
      };
    }

    const lease: ResourceAdmissionLease = {
      operationId: request.operationId,
      workspaceId: request.workspaceId,
      sessionId,
      resourceClass: request.resourceClass,
      cost: request.cost,
    };
    this.active.set(lease.operationId, lease);
    return { admitted: true, lease, snapshot: this.buildSnapshot(pressure) };
  }

  /**
   * Restore already-running durable resource debt after a backend restart.
   *
   * This is not a new admission decision: the external work already exists, so
   * restored debt may exceed current pressure/limit ceilings and intentionally
   * blocks competing work until the recovered lease is released. Replaying the
   * exact same lease is idempotent; an operation-id collision with different
   * ownership/cost fails closed.
   */
  public restore(lease: ResourceAdmissionLease): boolean {
    if (validateRequest(lease) !== undefined) return false;
    const current = this.active.get(lease.operationId);
    if (current !== undefined) return sameLease(current, lease);
    this.active.set(lease.operationId, lease);
    return true;
  }

  /**
   * Observe successful lease releases (#145 wake-on-release).
   *
   * A waiter queue above the controller has no way to learn that capacity
   * became available: without this it only drains when another request
   * arrives, so a queued job can sit behind a released lease indefinitely.
   * Listeners are best-effort — one that throws can never fail the caller
   * that is releasing — and the returned function removes the subscription.
   */
  public onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener);
    return (): void => {
      this.releaseListeners.delete(listener);
    };
  }

  public release(lease: ResourceAdmissionLease): boolean {
    const current = this.active.get(lease.operationId);
    if (current === undefined || !sameLease(current, lease)) return false;
    this.active.delete(lease.operationId);
    for (const listener of [...this.releaseListeners]) {
      try {
        listener();
      } catch {
        // A wake failure must not fail the release: capacity is already free,
        // and the next successful release or drain still makes progress.
      }
    }
    return true;
  }

  public snapshot(): ResourceAdmissionSnapshot {
    return this.buildSnapshot(this.readPressure());
  }

  private buildSnapshot(pressure: ResourcePressureSample | undefined): ResourceAdmissionSnapshot {
    const activeCostByClass: Record<ResourceAdmissionClass, number> = {
      dependency_bootstrap: 0,
      context_scan: 0,
      child_mcp_call: 0,
      lsp_process: 0,
      rag_indexing: 0,
      goal_process: 0,
      delegated_agent: 0,
      verification_heavy: 0,
    };
    const activeCostByWorkspace: Record<string, number> = {};
    const activeCostBySession: Record<string, number> = {};
    let activeCost = 0;
    let activeHeavyOperations = 0;
    for (const lease of this.active.values()) {
      activeCost += lease.cost;
      activeCostByClass[lease.resourceClass] += lease.cost;
      if (isHeavyAdmissionClass(lease.resourceClass)) activeHeavyOperations += 1;
      activeCostByWorkspace[lease.workspaceId] = (activeCostByWorkspace[lease.workspaceId] ?? 0) + lease.cost;
      activeCostBySession[lease.sessionId] = (activeCostBySession[lease.sessionId] ?? 0) + lease.cost;
    }

    const pressureState = pressure?.state ?? 'normal';
    return {
      activeCost,
      activeOperations: this.active.size,
      activeCostByClass,
      activeCostByWorkspace,
      activeCostBySession,
      activeHeavyOperations,
      maxHeavyOperations: this.limits.maxHeavyOperations,
      effectiveMaxHeavyOperations: effectiveHeavyCapacity(
        this.limits.maxHeavyOperations,
        this.limits.heavyHeadroom,
        pressure,
      ),
      rejected: this.rejected,
      pressureState,
      effectiveGlobalCost: effectiveGlobalCost(
        this.limits.globalCost,
        pressureState,
        this.elevatedGlobalCostRatio,
        this.criticalGlobalCostRatio,
      ),
      ...(pressure === undefined ? {} : { pressure }),
    };
  }

  private readPressure(): ResourcePressureSample | undefined {
    if (this.pressureProbe === undefined) return undefined;
    try {
      return this.pressureProbe.sample();
    } catch {
      // OS/process metric failure must not take down admission; static ceilings
      // remain in force until the pressure probe can produce a sample again.
      return undefined;
    }
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

export function tryAdmitContextScan(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'context_scan' });
}

export function tryAdmitChildMcpCall(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'child_mcp_call' });
}

export function tryAdmitLspProcess(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'lsp_process' });
}

export function tryAdmitRagIndex(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'rag_indexing' });
}

export function tryAdmitGoalProcess(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'goal_process' });
}

export function tryAdmitDelegatedAgent(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'delegated_agent' });
}

export function tryAdmitVerificationHeavy(
  controller: ResourceAdmissionController,
  request: Omit<ResourceAdmissionRequest, 'resourceClass'>,
): ResourceAdmissionDecision {
  return controller.tryAcquire({ ...request, resourceClass: 'verification_heavy' });
}

let processResourceAdmissionController: ResourceAdmissionController | undefined;

/**
 * Process-owned default controller used by production runtime owners.
 *
 * Callers that need different tested limits can inject their own controller;
 * the default getter intentionally returns the same instance across transports.
 */
export function sharedProcessResourceAdmissionController(): ResourceAdmissionController {
  processResourceAdmissionController ??= new ResourceAdmissionController(
    {
      ...DEFAULT_PROCESS_RESOURCE_ADMISSION_LIMITS,
      heavyHeadroom: heavyHeadroomFromEnv(),
    },
    { pressureProbe: new ProcessMemoryPressureProbe() },
  );
  return processResourceAdmissionController;
}

function validateLimit(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function validateCostRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite ratio between 0 and 1`);
  }
}

function effectiveGlobalCost(
  configuredGlobalCost: number,
  state: ResourcePressureState,
  elevatedRatio: number,
  criticalRatio: number,
): number {
  if (state === 'normal') return configuredGlobalCost;
  const ratio = state === 'critical' ? criticalRatio : elevatedRatio;
  if (ratio <= 0) return 0;
  return Math.max(1, Math.floor(configuredGlobalCost * ratio));
}

function isHeavyAdmissionClass(resourceClass: ResourceAdmissionClass): boolean {
  return HEAVY_ADMISSION_CLASS_SET.has(resourceClass);
}

function validateRequest(request: ResourceAdmissionRequest): 'invalid_request' | undefined {
  if (!isBoundedId(request.operationId)
    || !isBoundedId(request.workspaceId)
    || (request.sessionId !== undefined && !isBoundedId(request.sessionId))
    || !isResourceClass(request.resourceClass)
    || !Number.isInteger(request.cost)
    || request.cost < 1) {
    return 'invalid_request';
  }
  return undefined;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function isResourceClass(value: unknown): value is ResourceAdmissionClass {
  return typeof value === 'string' && (RESOURCE_ADMISSION_CLASSES as readonly string[]).includes(value);
}

function normalizeSessionId(value: string | undefined): string {
  return value === undefined ? 'system' : value.trim();
}

function sameLease(left: ResourceAdmissionLease, right: ResourceAdmissionLease): boolean {
  return left.operationId === right.operationId
    && left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
    && left.resourceClass === right.resourceClass
    && left.cost === right.cost;
}
