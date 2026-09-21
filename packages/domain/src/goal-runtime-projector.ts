import {
  classifyGoalRuntimeEvent,
  isGoalScopedRuntimeEvent,
  validateGoalStateTransition,
  type ExecutionScopedRuntimeEvent,
  type GoalRuntimeEvent,
  type GoalRuntimeEventDecision,
  type GoalScopedRuntimeEvent,
} from './goal-runtime-event.js';
import type {
  GoalBlockerKind,
  GoalRuntimeProjection,
  GoalRuntimeState,
} from './goal-runtime.js';

export interface GoalRuntimeProjectionResult {
  readonly decision: GoalRuntimeEventDecision;
  readonly projection: GoalRuntimeProjection;
}

/**
 * Pure authoritative projector. Events reach here only after durable identity
 * has been established; this function never consults UI selection/default
 * state and never invents percentage progress.
 */
export function projectGoalRuntimeEvent(
  current: GoalRuntimeProjection,
  event: GoalRuntimeEvent,
): GoalRuntimeProjectionResult {
  const classified = classifyGoalRuntimeEvent(current, event);
  if (classified.disposition !== 'apply') return { decision: classified, projection: current };

  const applied = isGoalScopedRuntimeEvent(event)
    ? applyGoalScopedEvent(current, event)
    : applyExecutionScopedEvent(current, event);
  if ('reason' in applied) {
    return {
      decision: { disposition: 'reject', reason: applied.reason },
      projection: current,
    };
  }

  const transitionFailure = validateProjectionTransitions(current, applied.projection);
  if (transitionFailure !== undefined) {
    return {
      decision: { disposition: 'reject', reason: 'invalid_transition' },
      projection: current,
    };
  }
  if (!projectionInvariantHolds(applied.projection)) {
    return {
      decision: { disposition: 'reject', reason: 'projection_invariant' },
      projection: current,
    };
  }

  return { decision: { disposition: 'apply' }, projection: applied.projection };
}

type ProjectionApplication =
  | { readonly projection: GoalRuntimeProjection }
  | { readonly reason: 'missing_event_data' };

function applyGoalScopedEvent(
  current: GoalRuntimeProjection,
  event: GoalScopedRuntimeEvent,
): ProjectionApplication {

  switch (event.type) {
    case 'goal_selected':
      // Selection is UI/operator context, not runtime activity.
      return { projection: current };
    case 'goal_created':
      return { projection: withLastActivity(current, event.occurredAt) };
    case 'goal_completed':
      return {
        projection: withLastActivity({
          ...current,
          lifecycleState: 'completed',
        }, event.occurredAt),
      };
    case 'goal_abandoned':
      return {
        projection: withLastActivity({
          ...current,
          lifecycleState: 'abandoned',
        }, event.occurredAt),
      };
    case 'goal_archived':
      return {
        projection: withLastActivity({
          ...current,
          lifecycleState: 'archived',
        }, event.occurredAt),
      };
    case 'goal_cleaned':
      return {
        projection: withLastActivity({
          ...current,
          lifecycleState: 'cleaned',
        }, event.occurredAt),
      };
    case 'workspace_observed':
      return {
        projection: applyWorkspaceObservation(current, event.workspaceState, event.occurredAt, event.detail),
      };
    case 'goal_blocker_observed':
      return {
        projection: withLastActivity(
          applyGoalBlockerObservation(current, event.blockerKind, event.occurredAt, event.detail),
          event.occurredAt,
        ),
      };
  }
}

function applyExecutionScopedEvent(
  current: GoalRuntimeProjection,
  event: ExecutionScopedRuntimeEvent,
): ProjectionApplication {
  switch (event.type) {
    case 'execution_submitted': {
      const reset = resetExecutionLocalObservations(current);
      const next = clearBlocker({
        ...reset,
        activeExecutionId: event.executionId,
        executionGeneration: event.executionGeneration,
        runtimeState: 'queued',
        desiredRuntimeState: 'running',
      });
      return { projection: withLastActivity(next, event.occurredAt) };
    }
    case 'execution_queued':
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          runtimeState: 'queued',
        }), event.occurredAt),
      };
    case 'execution_started':
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          runtimeState: 'running',
          desiredRuntimeState: 'running',
        }), event.occurredAt),
      };
    case 'execution_heartbeat':
      return {
        projection: {
          ...withLastActivity(current, event.occurredAt),
          lastHeartbeatAt: event.occurredAt,
        },
      };
    case 'phase_started':
      if (event.phase === undefined || event.phase.trim().length === 0) return { reason: 'missing_event_data' };
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          runtimeState: 'running',
          phase: event.phase,
          progress: mergeProgress(current, event.phase, event.detail),
        }), event.occurredAt),
      };
    case 'phase_completed':
      if (event.phase === undefined || event.phase.trim().length === 0) return { reason: 'missing_event_data' };
      return {
        projection: withLastActivity({
          ...current,
          phase: event.phase,
          progress: mergeProgress(current, event.phase, event.detail),
        }, event.occurredAt),
      };
    case 'task_started':
    case 'task_progress':
    case 'task_completed':
      if (event.taskId === undefined || event.taskId.trim().length === 0) return { reason: 'missing_event_data' };
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          runtimeState: 'running',
          progress: mergeProgress(current, current.phase, event.detail),
        }, 'task_failed'), event.occurredAt),
      };
    case 'task_failed':
      if (event.taskId === undefined || event.taskId.trim().length === 0) return { reason: 'missing_event_data' };
      return {
        projection: withLastActivity({
          ...current,
          runtimeState: 'blocked',
          blocker: blocker('task_failed', event),
          progress: mergeProgress(current, current.phase, event.detail),
        }, event.occurredAt),
      };
    case 'checkpoint_created':
      if (event.checkpointId === undefined || event.checkpointId.trim().length === 0) return { reason: 'missing_event_data' };
      return { projection: withLastActivity(current, event.occurredAt) };
    case 'approval_required':
      return {
        projection: withLastActivity({
          ...current,
          runtimeState: 'waiting_approval',
          blocker: blocker('waiting_approval', event),
        }, event.occurredAt),
      };
    case 'approval_resolved':
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          runtimeState: 'running',
        }, 'waiting_approval'), event.occurredAt),
      };
    case 'input_required':
      return {
        projection: withLastActivity({
          ...current,
          runtimeState: 'waiting_input',
          blocker: blocker('waiting_input', event),
        }, event.occurredAt),
      };
    case 'input_resolved':
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          runtimeState: 'running',
        }, 'waiting_input'), event.occurredAt),
      };
    case 'execution_pause_requested':
      return {
        projection: withLastActivity({
          ...current,
          desiredRuntimeState: 'paused',
        }, event.occurredAt),
      };
    case 'execution_paused':
      return {
        projection: withLastActivity({
          ...current,
          runtimeState: 'paused',
          desiredRuntimeState: 'paused',
        }, event.occurredAt),
      };
    case 'execution_resumed':
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          runtimeState: 'running',
          desiredRuntimeState: 'running',
        }), event.occurredAt),
      };
    case 'execution_cancel_requested':
      return {
        projection: withLastActivity({
          ...current,
          desiredRuntimeState: 'cancelled',
        }, event.occurredAt),
      };
    case 'integration_started':
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          integrationState: 'integrating',
        }, 'integration_conflict'), event.occurredAt),
      };
    case 'integration_completed':
      return {
        projection: withLastActivity(clearBlocker({
          ...current,
          integrationState: 'integrated',
        }, 'integration_conflict'), event.occurredAt),
      };
    case 'integration_conflict':
      return {
        projection: withLastActivity({
          ...current,
          integrationState: 'conflict',
          blocker: blocker('integration_conflict', event),
        }, event.occurredAt),
      };
    case 'execution_completed': {
      const next = clearActiveExecution(clearBlocker({
        ...current,
        runtimeState: 'idle',
        desiredRuntimeState: 'idle',
      }));
      return { projection: withLastActivity(next, event.occurredAt) };
    }
    case 'execution_failed': {
      const next = clearActiveExecution({
        ...current,
        runtimeState: 'failed',
        desiredRuntimeState: 'idle',
      });
      return { projection: withLastActivity(next, event.occurredAt) };
    }
    case 'execution_cancelled': {
      const next = clearActiveExecution({
        ...current,
        runtimeState: 'cancelled',
        desiredRuntimeState: 'cancelled',
      });
      return { projection: withLastActivity(next, event.occurredAt) };
    }
    case 'worker_lost':
      return {
        projection: withLastActivity({
          ...current,
          runtimeState: 'recovery_required',
          blocker: blocker('worker_lost', event),
        }, event.occurredAt),
      };
  }
}

function applyGoalBlockerObservation(
  current: GoalRuntimeProjection,
  blockerKind: 'goal_blocked' | undefined,
  observedAt: string,
  detail: string | undefined,
): GoalRuntimeProjection {
  if (blockerKind === undefined) {
    return current.blocker?.kind === 'goal_blocked'
      ? clearBlocker(current, 'goal_blocked')
      : current;
  }

  if (current.blocker !== undefined && current.blocker.kind !== 'goal_blocked') return current;
  return {
    ...current,
    blocker: {
      kind: 'goal_blocked',
      observedAt,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

function applyWorkspaceObservation(
  current: GoalRuntimeProjection,
  workspaceState: GoalRuntimeProjection['workspaceState'],
  observedAt: string,
  detail: string | undefined,
): GoalRuntimeProjection {
  const next: GoalRuntimeProjection = { ...current, workspaceState };

  if (workspaceState === 'unknown') {
    return isWorkspaceDerivedBlocker(current)
      ? clearBlocker(next)
      : next;
  }

  if (workspaceState === 'clean') {
    return isWorkspaceDerivedBlocker(current)
      ? clearBlocker(next)
      : next;
  }

  if (current.blocker !== undefined
    && !isWorkspaceDerivedBlocker(current)
    && current.blocker.kind !== 'goal_blocked') {
    return next;
  }

  const kind = workspaceBlockerKind(workspaceState);
  if (kind === undefined) return next;
  return {
    ...next,
    blocker: {
      kind,
      observedAt,
      ...(detail === undefined ? {} : { detail }),
    },
  };
}

function isWorkspaceDerivedBlocker(current: GoalRuntimeProjection): boolean {
  if (current.blocker?.kind === 'dirty_workspace') {
    return current.workspaceState === 'dirty';
  }
  return current.blocker?.kind === 'recovery_required'
    && (current.workspaceState === 'missing'
      || current.workspaceState === 'unavailable'
      || current.workspaceState === 'conflict');
}

function workspaceBlockerKind(
  workspaceState: GoalRuntimeProjection['workspaceState'],
): GoalBlockerKind | undefined {
  if (workspaceState === 'dirty') return 'dirty_workspace';
  if (workspaceState === 'missing'
    || workspaceState === 'unavailable'
    || workspaceState === 'conflict') return 'recovery_required';
  return undefined;
}

function validateProjectionTransitions(
  current: GoalRuntimeProjection,
  next: GoalRuntimeProjection,
): 'invalid_transition' | undefined {
  if (!validateGoalStateTransition({
    dimension: 'lifecycle',
    from: current.lifecycleState,
    to: next.lifecycleState,
  }).valid) return 'invalid_transition';

  if (!validateGoalStateTransition({
    dimension: 'runtime',
    from: current.runtimeState,
    to: next.runtimeState,
    executionGenerationChanged: current.executionGeneration !== next.executionGeneration,
  }).valid) return 'invalid_transition';

  if (!validateGoalStateTransition({
    dimension: 'integration',
    from: current.integrationState,
    to: next.integrationState,
  }).valid) return 'invalid_transition';

  if (!validateGoalStateTransition({
    dimension: 'workspace',
    from: current.workspaceState,
    to: next.workspaceState,
  }).valid) return 'invalid_transition';

  return undefined;
}

function projectionInvariantHolds(projection: GoalRuntimeProjection): boolean {
  if (projection.activeExecutionId !== undefined && projection.executionGeneration === undefined) return false;
  const requiresExecution = runtimeRequiresActiveExecution(projection.runtimeState);
  if (requiresExecution && projection.activeExecutionId === undefined) return false;
  if (!requiresExecution && projection.activeExecutionId !== undefined
    && (projection.runtimeState === 'idle' || projection.runtimeState === 'failed' || projection.runtimeState === 'cancelled')) {
    return false;
  }
  if (projection.lifecycleState !== 'open' && requiresExecution) return false;
  return true;
}

function runtimeRequiresActiveExecution(state: GoalRuntimeState): boolean {
  return state === 'queued'
    || state === 'starting'
    || state === 'running'
    || state === 'paused'
    || state === 'waiting_approval'
    || state === 'waiting_input'
    || state === 'blocked'
    || state === 'recovering'
    || state === 'recovery_required';
}

function resetExecutionLocalObservations(projection: GoalRuntimeProjection): GoalRuntimeProjection {
  const next = { ...projection };
  delete next.phase;
  delete next.progress;
  delete next.lastHeartbeatAt;
  return next;
}

function clearActiveExecution(projection: GoalRuntimeProjection): GoalRuntimeProjection {
  const next = { ...projection };
  delete next.activeExecutionId;
  return next;
}

function clearBlocker(
  projection: GoalRuntimeProjection,
  onlyKind?: GoalBlockerKind,
): GoalRuntimeProjection {
  if (projection.blocker === undefined) return projection;
  if (onlyKind !== undefined && projection.blocker.kind !== onlyKind) return projection;
  const next = { ...projection };
  delete next.blocker;
  const workspaceKind = workspaceBlockerKind(next.workspaceState);
  if (workspaceKind === undefined) return next;
  return {
    ...next,
    blocker: { kind: workspaceKind },
  };
}

function withLastActivity(projection: GoalRuntimeProjection, occurredAt: string): GoalRuntimeProjection {
  return { ...projection, lastActivityAt: occurredAt };
}

function blocker(kind: GoalBlockerKind, event: ExecutionScopedRuntimeEvent): NonNullable<GoalRuntimeProjection['blocker']> {
  return {
    kind,
    observedAt: event.occurredAt,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  };
}

function mergeProgress(
  current: GoalRuntimeProjection,
  phase: string | undefined,
  detail: string | undefined,
): NonNullable<GoalRuntimeProjection['progress']> {
  return {
    ...(current.progress ?? {}),
    ...(phase === undefined ? {} : { phase }),
    ...(detail === undefined ? {} : { detail }),
  };
}
