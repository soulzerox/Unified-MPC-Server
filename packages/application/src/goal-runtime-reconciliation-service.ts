import { createHash } from 'node:crypto';
import {
  assessGoalWorkerLiveness,
  projectGoalRuntimeEvent,
  type ExecutionScopedRuntimeEvent,
  type GoalRecord,
  type GoalRepository,
  type GoalRuntimeProjection,
  type GoalRuntimeReconciliationEventRepository,
  type GoalRuntimeSnapshotRecord,
  type GoalRuntimeSnapshotRepository,
  type GoalTrackedTask,
  type ScheduledContinuationRepository,
  type ScheduledContinuationWorkerLivenessPort,
} from '@unified-mpc/domain';

const DEFAULT_RECONCILIATION_LIMIT = 500;

export type GoalRuntimeRestartReconciliationDisposition =
  | 'reconciled'
  | 'projection_pending'
  | 'state_not_worker_backed'
  | 'goal_not_active'
  | 'live_worker'
  | 'liveness_untrusted'
  | 'concurrent_change';

export interface GoalRuntimeRestartReconciliationEntry {
  readonly goalId: string;
  readonly disposition: GoalRuntimeRestartReconciliationDisposition;
  readonly reason?: string;
  readonly eventSequence?: number;
}

export interface GoalRuntimeReconciliationServiceOptions {
  readonly now?: () => Date;
}

export class GoalRuntimeReconciliationService {
  private readonly now: () => Date;

  public constructor(
    private readonly goals: Pick<GoalRepository, 'getById'>,
    private readonly snapshots: GoalRuntimeSnapshotRepository,
    private readonly events: GoalRuntimeReconciliationEventRepository,
    private readonly scheduledContinuations: Pick<ScheduledContinuationRepository, 'getLiveScheduledContinuation'>,
    private readonly workerLiveness: ScheduledContinuationWorkerLivenessPort,
    options: GoalRuntimeReconciliationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public async reconcileWorkspace(
    workspaceId: string,
    limit = DEFAULT_RECONCILIATION_LIMIT,
  ): Promise<readonly GoalRuntimeRestartReconciliationEntry[]> {
    const snapshots = await this.snapshots.listWorkspaceGoalRuntimeSnapshots({
      workspaceId,
      limit,
    });
    const results: GoalRuntimeRestartReconciliationEntry[] = [];
    for (const snapshot of snapshots) {
      results.push(await this.reconcileSnapshot(snapshot));
    }
    return results;
  }

  public async reconcileGoal(goalId: string): Promise<GoalRuntimeRestartReconciliationEntry> {
    const snapshot = await this.snapshots.getGoalRuntimeSnapshot(goalId);
    if (snapshot === null) {
      return { goalId, disposition: 'goal_not_active', reason: 'snapshot_not_found' };
    }
    return this.reconcileSnapshot(snapshot);
  }

  private async reconcileSnapshot(
    snapshot: GoalRuntimeSnapshotRecord,
  ): Promise<GoalRuntimeRestartReconciliationEntry> {
    const projection = snapshot.projection;
    if (!isWorkerBackedState(projection)) {
      return {
        goalId: projection.goalId,
        disposition: 'state_not_worker_backed',
        reason: projection.runtimeState,
      };
    }
    if (projection.activeExecutionId === undefined || projection.executionGeneration === undefined) {
      return {
        goalId: projection.goalId,
        disposition: 'concurrent_change',
        reason: 'snapshot_execution_identity_missing',
      };
    }

    const goal = await this.goals.getById(projection.goalId);
    if (goal === null || goal.status !== 'active') {
      return { goalId: projection.goalId, disposition: 'goal_not_active' };
    }
    if (goal.workspaceId !== projection.workspaceId
      || goal.executionId !== projection.activeExecutionId
      || goal.executionGeneration !== projection.executionGeneration
      || goal.leaseGeneration !== projection.executionGeneration) {
      return {
        goalId: projection.goalId,
        disposition: 'concurrent_change',
        reason: 'execution_fence_changed',
      };
    }

    const trackedTasks = goal.trackedTasks ?? legacyTrackedTasks(goal.activeTaskIds);
    const liveContinuation = await this.scheduledContinuations.getLiveScheduledContinuation(goal.id);
    const now = this.now().toISOString();

    let evidence: Awaited<ReturnType<ScheduledContinuationWorkerLivenessPort['observe']>>;
    try {
      evidence = await this.workerLiveness.observe(goal.id, trackedTasks);
    } catch {
      return {
        goalId: projection.goalId,
        disposition: 'liveness_untrusted',
        reason: 'probe_failed',
      };
    }

    const assessment = assessGoalWorkerLiveness({
      goal,
      evidence,
      now,
      hasLiveScheduledContinuation: liveContinuation !== null,
    });
    if (assessment.state === 'live') {
      return {
        goalId: projection.goalId,
        disposition: 'live_worker',
        reason: assessment.reason,
      };
    }
    if (assessment.state === 'untrusted') {
      return {
        goalId: projection.goalId,
        disposition: 'liveness_untrusted',
        reason: assessment.reason,
      };
    }

    const event: ExecutionScopedRuntimeEvent = {
      eventId: workerLostEventId(goal, snapshot),
      type: 'worker_lost',
      workspaceId: projection.workspaceId,
      goalId: projection.goalId,
      executionId: projection.activeExecutionId,
      executionGeneration: projection.executionGeneration,
      occurredAt: now,
      blockerKind: 'worker_lost',
      detail: `restart reconciliation: ${assessment.reason}`,
    };
    const committed = await this.events.appendGoalRuntimeReconciliationEvent({
      event,
      recordedAt: now,
      expectedSnapshotSequence: snapshot.lastEventSequence,
      expectedLeaseGeneration: goal.leaseGeneration,
      expectedLeaseActivitySeq: goal.leaseActivitySeq,
      expectedLiveScheduledContinuation: liveContinuation === null
        ? null
        : {
            continuationId: liveContinuation.continuationId,
            version: liveContinuation.version,
          },
    });
    if (committed.disposition === 'concurrent_change') {
      return {
        goalId: projection.goalId,
        disposition: 'concurrent_change',
        reason: committed.reason,
      };
    }

    const projected = projectGoalRuntimeEvent(projection, event);
    if (projected.decision.disposition !== 'apply') {
      return {
        goalId: projection.goalId,
        disposition: 'concurrent_change',
        reason: `projector_${projected.decision.disposition}`,
      };
    }

    try {
      await this.snapshots.storeGoalRuntimeSnapshot({
        projection: projected.projection,
        lastEventSequence: committed.record.sequence,
        updatedAt: now,
      });
    } catch {
      return {
        goalId: projection.goalId,
        disposition: 'projection_pending',
        reason: 'snapshot_write_failed',
        eventSequence: committed.record.sequence,
      };
    }

    return {
      goalId: projection.goalId,
      disposition: 'reconciled',
      reason: assessment.reason,
      eventSequence: committed.record.sequence,
    };
  }
}

function isWorkerBackedState(projection: GoalRuntimeProjection): boolean {
  return projection.lifecycleState === 'open'
    && (projection.runtimeState === 'starting'
      || projection.runtimeState === 'running'
      || projection.runtimeState === 'recovering');
}

function legacyTrackedTasks(taskIds: readonly string[]): readonly GoalTrackedTask[] {
  return taskIds.map((taskId) => ({
    taskId,
    provider: 'legacy_auto',
    role: 'blocking_job',
    cancelWithGoal: true,
  }));
}

function workerLostEventId(goal: GoalRecord, snapshot: GoalRuntimeSnapshotRecord): string {
  const digest = createHash('sha256')
    .update([
      goal.id,
      snapshot.projection.activeExecutionId ?? '',
      String(goal.leaseGeneration),
      String(goal.leaseActivitySeq),
      String(snapshot.lastEventSequence),
    ].join('\0'))
    .digest('hex');
  return `restart-worker-lost-${digest}`;
}
