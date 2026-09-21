import type {
  GoalLeaseRecoveryEvidence,
  GoalRecord,
  GoalTrackedTask,
} from './goal-continuation.js';
import type { ScheduledContinuationWorkerLiveness } from './scheduled-continuation.js';

export const DEFAULT_GOAL_STALE_HEARTBEAT_GRACE_SECONDS = 60;

export type GoalWorkerLivenessEvidence =
  | GoalLeaseRecoveryEvidence
  | ScheduledContinuationWorkerLiveness;

export type GoalWorkerLivenessAssessment =
  | {
      readonly state: 'inactive';
      readonly reason: 'no_live_worker' | 'stale_heartbeat';
    }
  | {
      readonly state: 'live';
      readonly reason: 'fenced_call' | 'blocking_task' | 'heartbeat_grace';
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly state: 'untrusted';
      readonly reason:
        | 'missing_evidence'
        | 'evidence_untrustworthy'
        | 'generation_mismatch'
        | 'activity_mismatch'
        | 'future_observation'
        | 'missing_heartbeat'
        | 'future_heartbeat'
        | 'blocking_task_unknown';
    };

export interface AssessGoalWorkerLivenessRequest {
  readonly goal: GoalRecord;
  readonly evidence?: GoalWorkerLivenessEvidence;
  readonly now: string;
  readonly hasLiveScheduledContinuation: boolean;
  readonly staleHeartbeatGraceSeconds?: number;
}

/**
 * Shared fail-closed worker-liveness decision used by lease takeover and the
 * Goal runtime control plane. Absence of evidence is never proof of absence.
 */
export function assessGoalWorkerLiveness(
  request: AssessGoalWorkerLivenessRequest,
): GoalWorkerLivenessAssessment {
  const evidence = request.evidence;
  if (evidence === undefined) return { state: 'untrusted', reason: 'missing_evidence' };
  if (!evidence.trustworthy) return { state: 'untrusted', reason: 'evidence_untrustworthy' };
  if (evidence.leaseGeneration !== request.goal.leaseGeneration) {
    return { state: 'untrusted', reason: 'generation_mismatch' };
  }
  if (evidence.leaseActivitySeq !== request.goal.leaseActivitySeq) {
    return { state: 'untrusted', reason: 'activity_mismatch' };
  }

  const nowMs = parseIso(request.now);
  const observedAtMs = parseIso(evidence.observedAt);
  if (observedAtMs > nowMs) return { state: 'untrusted', reason: 'future_observation' };

  if (evidence.liveFencedCallCount > 0) {
    return { state: 'live', reason: 'fenced_call' };
  }

  const blockingTasks = (request.goal.trackedTasks ?? legacyTrackedTasks(request.goal.activeTaskIds))
    .filter((task) => task.role === 'blocking_job');
  const states = blockingStates(evidence);
  const stateByBinding = new Map(
    states.map((entry) => [bindingKey(entry.provider, entry.taskId), entry.state]),
  );
  for (const task of blockingTasks) {
    const state = stateByBinding.get(bindingKey(task.provider, task.taskId)) ?? 'unknown';
    if (state === 'running') return { state: 'live', reason: 'blocking_task' };
    if (state === 'unknown') return { state: 'untrusted', reason: 'blocking_task_unknown' };
  }

  if (request.goal.leaseHeartbeatAt === undefined) {
    return { state: 'untrusted', reason: 'missing_heartbeat' };
  }
  const heartbeatMs = parseIso(request.goal.leaseHeartbeatAt);
  if (heartbeatMs > nowMs) return { state: 'untrusted', reason: 'future_heartbeat' };

  if (!request.hasLiveScheduledContinuation) {
    return { state: 'inactive', reason: 'no_live_worker' };
  }

  const graceSeconds = normalizeGrace(request.staleHeartbeatGraceSeconds);
  const heartbeatAgeSeconds = Math.floor((nowMs - heartbeatMs) / 1000);
  if (heartbeatAgeSeconds < graceSeconds) {
    return {
      state: 'live',
      reason: 'heartbeat_grace',
      retryAfterSeconds: graceSeconds - heartbeatAgeSeconds,
    };
  }

  return { state: 'inactive', reason: 'stale_heartbeat' };
}

function blockingStates(evidence: GoalWorkerLivenessEvidence): readonly {
  readonly taskId: string;
  readonly provider: GoalTrackedTask['provider'];
  readonly state: 'running' | 'terminal' | 'absent' | 'unknown';
}[] {
  if (evidence.blockingTaskStates !== undefined) return evidence.blockingTaskStates;
  return evidence.activeTaskStates?.map((entry) => ({
    ...entry,
    provider: 'legacy_auto' as const,
  })) ?? [];
}

function legacyTrackedTasks(activeTaskIds: readonly string[]): readonly GoalTrackedTask[] {
  return activeTaskIds.map((taskId) => ({
    taskId,
    provider: 'legacy_auto',
    role: 'blocking_job',
    cancelWithGoal: true,
  }));
}

function bindingKey(provider: GoalTrackedTask['provider'], taskId: string): string {
  return `${provider}\0${taskId}`;
}

function normalizeGrace(value: number | undefined): number {
  const seconds = value ?? DEFAULT_GOAL_STALE_HEARTBEAT_GRACE_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 600) {
    throw new Error('staleHeartbeatGraceSeconds must be between 0 and 600');
  }
  return seconds;
}

function parseIso(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Goal worker liveness timestamp is invalid');
  return parsed;
}
