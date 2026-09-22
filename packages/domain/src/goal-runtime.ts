/**
 * Authoritative Goal Runtime vocabulary.
 *
 * These dimensions are deliberately independent from the legacy GoalStatus
 * aggregate in goal-continuation.ts. Consumers must not infer runtime truth
 * from selection/default/open-goal metadata.
 */
export const GOAL_RUNTIME_CONTRACT_VERSION = 1 as const;

export const GOAL_LIFECYCLE_STATES = [
  'open',
  'completed',
  'abandoned',
  'archived',
  'cleaned',
] as const;
export type GoalLifecycleState = typeof GOAL_LIFECYCLE_STATES[number];

export const GOAL_RUNTIME_STATES = [
  'idle',
  'queued',
  'starting',
  'running',
  'paused',
  'waiting_approval',
  'waiting_input',
  'blocked',
  'recovering',
  'recovery_required',
  'failed',
  'cancelled',
] as const;
export type GoalRuntimeState = typeof GOAL_RUNTIME_STATES[number];

export const GOAL_DESIRED_RUNTIME_STATES = [
  'idle',
  'running',
  'paused',
  'cancelled',
] as const;
export type GoalDesiredRuntimeState = typeof GOAL_DESIRED_RUNTIME_STATES[number];

export const GOAL_INTEGRATION_STATES = [
  'not_started',
  'pending',
  'integrating',
  'integrated',
  'conflict',
  'unknown',
] as const;
export type GoalIntegrationState = typeof GOAL_INTEGRATION_STATES[number];

export const GOAL_WORKSPACE_STATES = [
  'clean',
  'dirty',
  'missing',
  'unavailable',
  'conflict',
  'unknown',
] as const;
export type GoalWorkspaceState = typeof GOAL_WORKSPACE_STATES[number];

export const GOAL_BLOCKER_KINDS = [
  'waiting_approval',
  'waiting_input',
  'resource_pressure',
  'dependency_unavailable',
  'worker_lost',
  'integration_conflict',
  'dirty_workspace',
  'active_lease_elsewhere',
  'provider_unavailable',
  'task_failed',
  'goal_blocked',
  'recovery_required',
  'unknown',
] as const;
export type GoalBlockerKind = typeof GOAL_BLOCKER_KINDS[number];

export const GOAL_EXECUTION_RECEIPT_STATES = [
  'active',
  'released',
  'superseded',
  'terminal',
] as const;
export type GoalExecutionReceiptState = typeof GOAL_EXECUTION_RECEIPT_STATES[number];

export interface GoalExecutionRecord {
  readonly id: string;
  readonly goalId: string;
  readonly workspaceId: string;
  /** Concrete execution attempt/generation exposed to runtime consumers. */
  readonly executionGeneration: number;
  /** Lease fence generation backing this execution attempt. */
  readonly leaseGeneration: number;
  readonly ownerClientId: string;
  readonly ownerSessionId: string;
  readonly receiptState: GoalExecutionReceiptState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListGoalExecutionsRequest {
  readonly goalId: string;
  readonly limit: number;
}

/** Parent-owned execution history store. It reuses #64 receipts rather than creating a second execution database. */
export interface GoalExecutionRepository {
  getExecutionById(executionId: string): Promise<GoalExecutionRecord | null>;
  listGoalExecutions(request: ListGoalExecutionsRequest): Promise<readonly GoalExecutionRecord[]>;
}

export type GoalRuntimeProgressStepState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface GoalRuntimeProgressStep {
  readonly id: string;
  readonly title: string;
  readonly state: GoalRuntimeProgressStepState;
  readonly summary?: string;
}

export interface GoalRuntimeProgress {
  /** Current truthful runtime phase. Never synthesize a percentage without a denominator. */
  readonly phase?: string;
  readonly steps?: readonly GoalRuntimeProgressStep[];
  readonly completedUnits?: number;
  readonly totalUnits?: number;
  readonly detail?: string;
}

export interface GoalRuntimeBlocker {
  readonly kind: GoalBlockerKind;
  readonly detail?: string;
  readonly observedAt?: string;
}

/**
 * Parent-owned projected Goal truth consumed by recovery, WebUI and cleanup.
 * Persistence/projector implementations may add evidence metadata, but they
 * should preserve these independent state dimensions.
 */
export interface GoalRuntimeProjection {
  readonly contractVersion: typeof GOAL_RUNTIME_CONTRACT_VERSION;
  readonly goalId: string;
  readonly workspaceId: string;
  readonly lifecycleState: GoalLifecycleState;
  readonly runtimeState: GoalRuntimeState;
  readonly desiredRuntimeState: GoalDesiredRuntimeState;
  readonly integrationState: GoalIntegrationState;
  readonly workspaceState: GoalWorkspaceState;
  readonly activeExecutionId?: string;
  readonly executionGeneration?: number;
  readonly phase?: string;
  readonly progress?: GoalRuntimeProgress;
  readonly lastActivityAt: string;
  readonly lastHeartbeatAt?: string;
  readonly blocker?: GoalRuntimeBlocker;
}

export interface GoalRuntimeSnapshotRecord {
  readonly projection: GoalRuntimeProjection;
  /** Last durable Goal runtime event sequence incorporated into this projection. */
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

export interface StoreGoalRuntimeSnapshotRequest {
  readonly projection: GoalRuntimeProjection;
  readonly lastEventSequence: number;
  readonly updatedAt: string;
}

export interface ListWorkspaceGoalRuntimeSnapshotsRequest {
  readonly workspaceId: string;
  readonly limit: number;
}

/**
 * Durable compaction point for the authoritative projector. Implementations
 * must never let an older event cursor replace a newer snapshot.
 */
export interface GoalRuntimeSnapshotRepository {
  getGoalRuntimeSnapshot(goalId: string): Promise<GoalRuntimeSnapshotRecord | null>;
  listWorkspaceGoalRuntimeSnapshots(
    request: ListWorkspaceGoalRuntimeSnapshotsRequest,
  ): Promise<readonly GoalRuntimeSnapshotRecord[]>;
  storeGoalRuntimeSnapshot(request: StoreGoalRuntimeSnapshotRequest): Promise<GoalRuntimeSnapshotRecord>;
}

export function isGoalLifecycleState(value: unknown): value is GoalLifecycleState {
  return typeof value === 'string' && (GOAL_LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function isGoalRuntimeState(value: unknown): value is GoalRuntimeState {
  return typeof value === 'string' && (GOAL_RUNTIME_STATES as readonly string[]).includes(value);
}

export function isGoalDesiredRuntimeState(value: unknown): value is GoalDesiredRuntimeState {
  return typeof value === 'string' && (GOAL_DESIRED_RUNTIME_STATES as readonly string[]).includes(value);
}

export function isGoalIntegrationState(value: unknown): value is GoalIntegrationState {
  return typeof value === 'string' && (GOAL_INTEGRATION_STATES as readonly string[]).includes(value);
}

export function isGoalWorkspaceState(value: unknown): value is GoalWorkspaceState {
  return typeof value === 'string' && (GOAL_WORKSPACE_STATES as readonly string[]).includes(value);
}

export function isGoalBlockerKind(value: unknown): value is GoalBlockerKind {
  return typeof value === 'string' && (GOAL_BLOCKER_KINDS as readonly string[]).includes(value);
}

export function isGoalExecutionReceiptState(value: unknown): value is GoalExecutionReceiptState {
  return typeof value === 'string' && (GOAL_EXECUTION_RECEIPT_STATES as readonly string[]).includes(value);
}
