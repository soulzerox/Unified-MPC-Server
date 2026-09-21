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
  'recovery_required',
  'unknown',
] as const;
export type GoalBlockerKind = typeof GOAL_BLOCKER_KINDS[number];

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
