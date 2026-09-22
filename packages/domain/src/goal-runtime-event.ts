import type {
  GoalBlockerKind,
  GoalIntegrationState,
  GoalLifecycleState,
  GoalRuntimeProjection,
  GoalRuntimeState,
  GoalWorkspaceState,
} from './goal-runtime.js';

export const GOAL_SCOPED_RUNTIME_EVENT_TYPES = [
  'goal_created',
  'goal_selected',
  'goal_completed',
  'goal_abandoned',
  'goal_archived',
  'goal_cleaned',
  'goal_blocker_observed',
  'workspace_observed',
] as const;
export type GoalScopedRuntimeEventType = typeof GOAL_SCOPED_RUNTIME_EVENT_TYPES[number];

export const EXECUTION_SCOPED_RUNTIME_EVENT_TYPES = [
  'execution_submitted',
  'execution_queued',
  'execution_started',
  'execution_heartbeat',
  'phase_started',
  'phase_completed',
  'task_started',
  'task_progress',
  'task_completed',
  'task_failed',
  'checkpoint_created',
  'approval_required',
  'approval_resolved',
  'input_required',
  'input_resolved',
  'execution_pause_requested',
  'execution_paused',
  'execution_resumed',
  'execution_cancel_requested',
  'integration_started',
  'integration_completed',
  'integration_conflict',
  'execution_completed',
  'execution_failed',
  'execution_cancelled',
  'worker_lost',
] as const;
export type ExecutionScopedRuntimeEventType = typeof EXECUTION_SCOPED_RUNTIME_EVENT_TYPES[number];

export type GoalRuntimeEventType = GoalScopedRuntimeEventType | ExecutionScopedRuntimeEventType;

interface GoalRuntimeEventBase {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly goalId: string;
  readonly occurredAt: string;
  /** Concise operational detail only. Hidden model reasoning must never be stored here. */
  readonly detail?: string;
}

export type GoalScopedRuntimeEvent =
  | (GoalRuntimeEventBase & {
      readonly type: Exclude<GoalScopedRuntimeEventType, 'workspace_observed' | 'goal_blocker_observed'>;
    })
  | (GoalRuntimeEventBase & {
      readonly type: 'workspace_observed';
      readonly workspaceState: GoalWorkspaceState;
    })
  | (GoalRuntimeEventBase & {
      readonly type: 'goal_blocker_observed';
      /** Present when durable Goal blockers exist; omitted when that source clears. */
      readonly blockerKind?: 'goal_blocked';
    });

export interface ExecutionScopedRuntimeEvent extends GoalRuntimeEventBase {
  readonly type: ExecutionScopedRuntimeEventType;
  readonly executionId: string;
  readonly executionGeneration: number;
  readonly phase?: string;
  readonly taskId?: string;
  readonly checkpointId?: string;
  readonly blockerKind?: GoalBlockerKind;
}

export type GoalRuntimeEvent = GoalScopedRuntimeEvent | ExecutionScopedRuntimeEvent;


export interface GoalRuntimeEventRecord {
  readonly sequence: number;
  readonly event: GoalRuntimeEvent;
  readonly recordedAt: string;
}

export interface AppendGoalRuntimeEventRequest {
  readonly event: GoalRuntimeEvent;
  readonly recordedAt: string;
}

export interface AppendGoalRuntimeEventResult {
  readonly appended: boolean;
  readonly record: GoalRuntimeEventRecord;
}

export interface GoalRuntimeScheduledContinuationFence {
  readonly continuationId: string;
  readonly version: number;
}

export interface AppendGoalRuntimeReconciliationEventRequest {
  readonly event: ExecutionScopedRuntimeEvent;
  readonly recordedAt: string;
  /** Snapshot cursor that was current before liveness was probed. */
  readonly expectedSnapshotSequence: number;
  /** Lease fence that was current before liveness was probed. */
  readonly expectedLeaseGeneration: number;
  readonly expectedLeaseActivitySeq: number;
  /** Exact live watchdog observed before the probe, or null when none existed. */
  readonly expectedLiveScheduledContinuation: GoalRuntimeScheduledContinuationFence | null;
}

export type GoalRuntimeReconciliationConflictReason =
  | 'goal_not_active'
  | 'lease_changed'
  | 'snapshot_changed'
  | 'event_stream_advanced'
  | 'execution_changed'
  | 'scheduled_continuation_changed';

export type AppendGoalRuntimeReconciliationEventResult =
  | {
      readonly disposition: 'appended' | 'duplicate';
      readonly record: GoalRuntimeEventRecord;
    }
  | {
      readonly disposition: 'concurrent_change';
      readonly reason: GoalRuntimeReconciliationConflictReason;
    };

export interface GoalRuntimeReconciliationEventRepository {
  appendGoalRuntimeReconciliationEvent(
    request: AppendGoalRuntimeReconciliationEventRequest,
  ): Promise<AppendGoalRuntimeReconciliationEventResult>;
}

export interface ReplayWorkspaceGoalRuntimeEventsRequest {
  readonly workspaceId: string;
  /** Exclusive durable cursor. Omit for the oldest currently retained event. */
  readonly afterSequence?: number;
  readonly limit: number;
}

export interface ListGoalRuntimeEventsRequest {
  readonly goalId: string;
  readonly limit: number;
}

export interface GoalRuntimeEventReplayPage {
  readonly events: readonly GoalRuntimeEventRecord[];
  readonly oldestAvailableSequence?: number;
  readonly latestSequence?: number;
  readonly replayWindowMissed: boolean;
}

export interface GoalRuntimeEventRepository {
  appendGoalRuntimeEvent(request: AppendGoalRuntimeEventRequest): Promise<AppendGoalRuntimeEventResult>;
  replayWorkspaceGoalRuntimeEvents(request: ReplayWorkspaceGoalRuntimeEventsRequest): Promise<GoalRuntimeEventReplayPage>;
  listGoalRuntimeEvents(request: ListGoalRuntimeEventsRequest): Promise<readonly GoalRuntimeEventRecord[]>;
}

export type GoalRuntimeEventRejectionReason =
  | 'goal_mismatch'
  | 'workspace_mismatch'
  | 'goal_not_open'
  | 'execution_not_submitted'
  | 'future_generation'
  | 'generation_gap'
  | 'execution_identity_mismatch'
  | 'terminal_generation'
  | 'missing_event_data'
  | 'invalid_transition'
  | 'projection_invariant';

export type GoalRuntimeEventDecision =
  | { readonly disposition: 'apply' }
  | { readonly disposition: 'ignore'; readonly reason: 'stale_generation' }
  | { readonly disposition: 'reject'; readonly reason: GoalRuntimeEventRejectionReason };

/**
 * Generation fence applied before an execution-scoped event can reach the
 * authoritative projector. Older generations are harmlessly ignored; future
 * or mismatched identities are rejected until a valid submission establishes
 * the next generation.
 */
export function classifyGoalRuntimeEvent(
  current: GoalRuntimeProjection,
  event: GoalRuntimeEvent,
): GoalRuntimeEventDecision {
  if (event.goalId !== current.goalId) return { disposition: 'reject', reason: 'goal_mismatch' };
  if (event.workspaceId !== current.workspaceId) return { disposition: 'reject', reason: 'workspace_mismatch' };
  if (isGoalScopedRuntimeEvent(event)) return { disposition: 'apply' };

  if (current.lifecycleState === 'archived' || current.lifecycleState === 'cleaned') {
    return { disposition: 'reject', reason: 'goal_not_open' };
  }
  if (current.lifecycleState !== 'open' && event.type !== 'integration_started'
    && event.type !== 'integration_completed' && event.type !== 'integration_conflict') {
    return { disposition: 'reject', reason: 'goal_not_open' };
  }

  const currentGeneration = current.executionGeneration;
  if (currentGeneration === undefined) {
    return event.type === 'execution_submitted' && event.executionGeneration === 1
      ? { disposition: 'apply' }
      : { disposition: 'reject', reason: 'execution_not_submitted' };
  }

  if (event.executionGeneration < currentGeneration) {
    return { disposition: 'ignore', reason: 'stale_generation' };
  }

  if (event.executionGeneration > currentGeneration) {
    if (event.type !== 'execution_submitted') return { disposition: 'reject', reason: 'future_generation' };
    if (event.executionGeneration !== currentGeneration + 1) return { disposition: 'reject', reason: 'generation_gap' };
    return { disposition: 'apply' };
  }

  if (current.activeExecutionId !== undefined && current.activeExecutionId !== event.executionId) {
    return { disposition: 'reject', reason: 'execution_identity_mismatch' };
  }

  if (current.activeExecutionId === undefined
    && current.executionGeneration === event.executionGeneration
    && event.type !== 'integration_started'
    && event.type !== 'integration_completed'
    && event.type !== 'integration_conflict') {
    return { disposition: 'reject', reason: 'terminal_generation' };
  }

  if (isTerminalRuntimeState(current.runtimeState) && isExecutionActivityEvent(event.type)) {
    return { disposition: 'reject', reason: 'terminal_generation' };
  }

  return { disposition: 'apply' };
}

export function isGoalScopedRuntimeEvent(event: GoalRuntimeEvent): event is GoalScopedRuntimeEvent {
  return (GOAL_SCOPED_RUNTIME_EVENT_TYPES as readonly string[]).includes(event.type);
}

export function isGoalScopedRuntimeEventType(value: unknown): value is GoalScopedRuntimeEventType {
  return typeof value === 'string' && (GOAL_SCOPED_RUNTIME_EVENT_TYPES as readonly string[]).includes(value);
}

export function isExecutionScopedRuntimeEventType(value: unknown): value is ExecutionScopedRuntimeEventType {
  return typeof value === 'string' && (EXECUTION_SCOPED_RUNTIME_EVENT_TYPES as readonly string[]).includes(value);
}

export type GoalStateTransition =
  | {
      readonly dimension: 'lifecycle';
      readonly from: GoalLifecycleState;
      readonly to: GoalLifecycleState;
    }
  | {
      readonly dimension: 'runtime';
      readonly from: GoalRuntimeState;
      readonly to: GoalRuntimeState;
      readonly executionGenerationChanged?: boolean;
    }
  | {
      readonly dimension: 'integration';
      readonly from: GoalIntegrationState;
      readonly to: GoalIntegrationState;
    }
  | {
      readonly dimension: 'workspace';
      readonly from: GoalWorkspaceState;
      readonly to: GoalWorkspaceState;
    };

export type GoalStateTransitionDecision =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'invalid_transition' };

/**
 * Central state-machine guard. Workspace state reflects fresh probes and may
 * move between any observed states. Lifecycle/integration/runtime transitions
 * are intentionally stricter so clients cannot mutate authoritative state by
 * merely writing a label.
 */
export function validateGoalStateTransition(transition: GoalStateTransition): GoalStateTransitionDecision {
  if (transition.from === transition.to) return { valid: true };

  if (transition.dimension === 'workspace') return { valid: true };

  if (transition.dimension === 'lifecycle') {
    const allowed: Readonly<Record<GoalLifecycleState, readonly GoalLifecycleState[]>> = {
      open: ['completed', 'abandoned', 'archived'],
      completed: ['archived', 'cleaned'],
      abandoned: ['archived', 'cleaned'],
      archived: ['cleaned'],
      cleaned: [],
    };
    return allowed[transition.from].includes(transition.to)
      ? { valid: true }
      : { valid: false, reason: 'invalid_transition' };
  }

  if (transition.dimension === 'integration') {
    const allowed: Readonly<Record<GoalIntegrationState, readonly GoalIntegrationState[]>> = {
      not_started: ['pending', 'integrating', 'integrated', 'conflict', 'unknown'],
      pending: ['integrating', 'integrated', 'conflict', 'unknown'],
      integrating: ['pending', 'integrated', 'conflict', 'unknown'],
      integrated: [],
      conflict: ['pending', 'integrating', 'integrated', 'unknown'],
      unknown: ['not_started', 'pending', 'integrating', 'integrated', 'conflict'],
    };
    return allowed[transition.from].includes(transition.to)
      ? { valid: true }
      : { valid: false, reason: 'invalid_transition' };
  }

  if (transition.executionGenerationChanged === true && isExecutionActiveRuntimeState(transition.to)) {
    return { valid: true };
  }

  if (isTerminalRuntimeState(transition.from)
    && isExecutionActiveRuntimeState(transition.to)
    && transition.executionGenerationChanged !== true) {
    return { valid: false, reason: 'invalid_transition' };
  }

  const allowed: Readonly<Record<GoalRuntimeState, readonly GoalRuntimeState[]>> = {
    idle: ['queued', 'starting', 'running', 'waiting_approval', 'waiting_input', 'blocked', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    queued: ['starting', 'running', 'paused', 'blocked', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    starting: ['running', 'paused', 'waiting_approval', 'waiting_input', 'blocked', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    running: ['idle', 'paused', 'waiting_approval', 'waiting_input', 'blocked', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    paused: ['idle', 'running', 'blocked', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    waiting_approval: ['idle', 'running', 'paused', 'blocked', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    waiting_input: ['idle', 'running', 'paused', 'blocked', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    blocked: ['idle', 'running', 'paused', 'waiting_approval', 'waiting_input', 'recovering', 'recovery_required', 'failed', 'cancelled'],
    recovering: ['idle', 'running', 'paused', 'blocked', 'recovery_required', 'failed', 'cancelled'],
    recovery_required: ['idle', 'recovering', 'failed', 'cancelled'],
    failed: ['idle', 'queued', 'starting', 'running', 'recovering'],
    cancelled: ['idle', 'queued', 'starting', 'running', 'recovering'],
  };

  if (!allowed[transition.from].includes(transition.to)) {
    return { valid: false, reason: 'invalid_transition' };
  }

  if (isTerminalRuntimeState(transition.from) && isExecutionActiveRuntimeState(transition.to)) {
    return transition.executionGenerationChanged === true
      ? { valid: true }
      : { valid: false, reason: 'invalid_transition' };
  }

  return { valid: true };
}

function isTerminalRuntimeState(state: GoalRuntimeState): boolean {
  return state === 'failed' || state === 'cancelled';
}

function isExecutionActiveRuntimeState(state: GoalRuntimeState): boolean {
  return state === 'queued'
    || state === 'starting'
    || state === 'running'
    || state === 'paused'
    || state === 'waiting_approval'
    || state === 'waiting_input'
    || state === 'blocked'
    || state === 'recovering';
}

function isExecutionActivityEvent(type: ExecutionScopedRuntimeEventType): boolean {
  return type !== 'execution_submitted'
    && type !== 'integration_started'
    && type !== 'integration_completed'
    && type !== 'integration_conflict';
}
