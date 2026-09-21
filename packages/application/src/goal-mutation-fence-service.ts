import { createHash } from 'node:crypto';
import {
  GoalStateError,
  appError,
  err,
  ok,
  type GoalLeaseProof,
  type GoalTrackedTask,
  type Result,
  type ScheduledContinuationRepository,
  type ScheduledContinuationWorkerLiveness,
  type ScheduledContinuationWorkerLivenessPort,
} from '@unified-mpc/domain';
import type { FileActor } from './file-service.js';
import type { GoalRuntimeEventPublisher } from './goal-runtime-control-plane-service.js';

export type ManagedGoalTaskState = 'running' | 'terminal' | 'absent' | 'unknown';

export interface GoalManagedTaskStateReader {
  read(workspaceId: string, task: GoalTrackedTask | string): Promise<ManagedGoalTaskState>;
}

export interface GoalMutationFenceServiceOptions {
  readonly now?: () => Date;
  readonly callLeaseSeconds?: number;
  readonly taskStateReader?: GoalManagedTaskStateReader;
  readonly runtimeEvents?: GoalRuntimeEventPublisher;
}

export interface GoalMutationFenceAdmission {
  readonly goalId: string;
  readonly leaseGeneration: number;
}

export interface WorkspaceGoalFenceSnapshot {
  readonly goalId: string;
  readonly leaseGeneration: number;
}

interface GoalRuntimeCallBinding {
  readonly goalId: string;
  readonly workspaceId: string;
  readonly executionId: string;
  readonly executionGeneration: number;
}

interface GoalWorkspaceCallBinding {
  readonly goalId: string;
  readonly workspaceId: string;
}

export class GoalMutationFenceService implements ScheduledContinuationWorkerLivenessPort {
  private readonly now: () => Date;
  private readonly callLeaseSeconds: number;
  private readonly taskStateReader: GoalManagedTaskStateReader | undefined;
  private readonly runtimeEvents: GoalRuntimeEventPublisher | undefined;
  private readonly runtimeCalls = new Map<string, GoalRuntimeCallBinding>();
  private readonly workspaceCalls = new Map<string, GoalWorkspaceCallBinding>();

  public constructor(
    private readonly repository: ScheduledContinuationRepository,
    options: GoalMutationFenceServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.callLeaseSeconds = normalizeCallLeaseSeconds(options.callLeaseSeconds);
    this.taskStateReader = options.taskStateReader;
    this.runtimeEvents = options.runtimeEvents;
  }

  public async inspectWorkspaceFence(
    actor: FileActor,
    workspaceId: string,
  ): Promise<Result<WorkspaceGoalFenceSnapshot | null>> {
    try {
      const fence = await this.repository.getWorkspaceMutationFence(workspaceId);
      if (fence === null) return ok(null);
      return ok({ goalId: fence.goal.id, leaseGeneration: fence.goal.leaseGeneration });
    } catch (error: unknown) {
      return mapFenceError(error);
    }
  }

  public async begin(
    actor: FileActor,
    workspaceId: string,
    callId: string,
    proof: GoalLeaseProof,
  ): Promise<Result<GoalMutationFenceAdmission>> {
    try {
      const now = this.now();
      const startedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + this.callLeaseSeconds * 1000).toISOString();
      const admitted = await this.repository.beginGoalFencedMutation({
        callId,
        goalId: proof.goalId,
        workspaceId,
        ownerClientId: actor.clientId,
        ownerSessionId: actor.sessionId ?? actor.clientId,
        leaseTokenHash: hashLeaseToken(proof.leaseToken),
        leaseGeneration: proof.leaseGeneration,
        startedAt,
        expiresAt,
      });
      this.workspaceCalls.set(callId, { goalId: admitted.goalId, workspaceId });
      await this.recordRuntimeStartBestEffort(callId, workspaceId, admitted.goalId, admitted.leaseGeneration, startedAt);
      return ok(admitted);
    } catch (error: unknown) {
      return mapFenceError(error);
    }
  }

  public async heartbeat(callId: string, leaseGeneration: number): Promise<void> {
    const now = this.now();
    const heartbeatAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.callLeaseSeconds * 1000).toISOString();
    await this.repository.heartbeatGoalFencedMutation(callId, leaseGeneration, heartbeatAt, expiresAt);
    await this.recordRuntimeHeartbeatBestEffort(callId, leaseGeneration, heartbeatAt);
  }

  public async end(callId: string): Promise<void> {
    const workspaceBinding = this.workspaceCalls.get(callId);
    try {
      await this.repository.endGoalFencedMutation(callId, this.now().toISOString());
      await this.refreshWorkspaceTruthBestEffort(workspaceBinding?.goalId);
    } finally {
      this.runtimeCalls.delete(callId);
      this.workspaceCalls.delete(callId);
    }
  }

  public async observe(goalId: string, trackedTasks: readonly (GoalTrackedTask | string)[]): Promise<ScheduledContinuationWorkerLiveness> {
    const observedAt = this.now().toISOString();
    const durable = await this.repository.observeGoalFencedMutations(goalId, observedAt);
    const normalizedTasks = trackedTasks
      .map((task) => ({ original: task, binding: typeof task === 'string' ? legacyTrackedTask(task) : task }))
      .filter((entry) => entry.binding.role === 'blocking_job');
    const blockingTaskStates = await Promise.all(normalizedTasks.map(async ({ original, binding }) => ({
      taskId: binding.taskId,
      provider: binding.provider,
      state: await this.readTaskState(durable.workspaceId, typeof original === 'string' ? original : binding),
    })));
    return {
      trustworthy: blockingTaskStates.every((entry) => entry.state !== 'unknown'),
      observedAt,
      leaseGeneration: durable.leaseGeneration,
      leaseActivitySeq: durable.leaseActivitySeq,
      liveFencedCallCount: durable.liveFencedCallCount,
      blockingTaskStates,
      activeTaskStates: blockingTaskStates.map(({ taskId, state }) => ({ taskId, state })),
    };
  }

  private async recordRuntimeStartBestEffort(
    callId: string,
    workspaceId: string,
    goalId: string,
    leaseGeneration: number,
    occurredAt: string,
  ): Promise<void> {
    if (this.runtimeEvents === undefined) return;
    try {
      const snapshot = await this.runtimeEvents.ensureGoalSnapshot(goalId);
      const projection = snapshot.projection;
      if (
        projection.workspaceId !== workspaceId
        || projection.activeExecutionId === undefined
        || projection.executionGeneration !== leaseGeneration
      ) return;

      this.runtimeCalls.set(callId, {
        goalId,
        workspaceId,
        executionId: projection.activeExecutionId,
        executionGeneration: projection.executionGeneration,
      });
      const type = projection.runtimeState === 'queued'
        || projection.runtimeState === 'starting'
        || projection.runtimeState === 'recovering'
          ? 'execution_started'
          : 'execution_heartbeat';
      await this.runtimeEvents.publishGoalRuntimeEvent({
        eventId: runtimeFenceEventId(goalId, type, `${callId}:start`),
        type,
        workspaceId,
        goalId,
        executionId: projection.activeExecutionId,
        executionGeneration: projection.executionGeneration,
        occurredAt,
        detail: 'authoritative fenced mutation activity',
      });
    } catch {
      // Runtime projection is a recoverable side path. A durable mutation fence
      // that was already admitted must not be failed by event delivery.
    }
  }

  private async recordRuntimeHeartbeatBestEffort(
    callId: string,
    leaseGeneration: number,
    occurredAt: string,
  ): Promise<void> {
    if (this.runtimeEvents === undefined) return;
    const binding = this.runtimeCalls.get(callId);
    if (binding === undefined || binding.executionGeneration !== leaseGeneration) return;
    try {
      await this.runtimeEvents.publishGoalRuntimeEvent({
        eventId: runtimeFenceEventId(binding.goalId, 'execution_heartbeat', `${callId}:${occurredAt}`),
        type: 'execution_heartbeat',
        workspaceId: binding.workspaceId,
        goalId: binding.goalId,
        executionId: binding.executionId,
        executionGeneration: binding.executionGeneration,
        occurredAt,
        detail: 'authoritative fenced mutation heartbeat',
      });
    } catch {
      // Durable fence heartbeat remains authoritative for admission/liveness.
      // Event delivery is repaired by later runtime activity/reconciliation.
    }
  }

  private async refreshWorkspaceTruthBestEffort(goalId: string | undefined): Promise<void> {
    if (goalId === undefined || this.runtimeEvents?.refreshGoalWorkspaceTruth === undefined) return;
    try {
      await this.runtimeEvents.refreshGoalWorkspaceTruth(goalId);
    } catch {
      // Filesystem/Git observation is a non-critical side path. Ending the
      // durable mutation fence must not fail because workspace truth refresh did.
    }
  }

  private async readTaskState(workspaceId: string, task: GoalTrackedTask | string): Promise<ManagedGoalTaskState> {
    if (this.taskStateReader === undefined) return 'unknown';
    try {
      return await this.taskStateReader.read(workspaceId, task);
    } catch {
      return 'unknown';
    }
  }
}

function legacyTrackedTask(taskId: string): GoalTrackedTask {
  return { taskId, provider: 'legacy_auto', role: 'blocking_job', cancelWithGoal: true };
}

function normalizeCallLeaseSeconds(value: number | undefined): number {
  const seconds = value ?? 30;
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) throw new Error('callLeaseSeconds must be between 5 and 300');
  return seconds;
}

function hashLeaseToken(token: string): string {
  if (typeof token !== 'string' || token.trim().length === 0 || token.length > 256) throw new Error('Goal lease token is invalid');
  return createHash('sha256').update(token).digest('hex');
}

function runtimeFenceEventId(goalId: string, type: 'execution_started' | 'execution_heartbeat', discriminator: string): string {
  const digest = createHash('sha256')
    .update([goalId, type, discriminator].join('\0'))
    .digest('hex');
  return `goal-runtime-fence-${digest}`;
}

function mapFenceError(error: unknown): Result<never> {
  if (error instanceof GoalStateError) {
    switch (error.reason) {
      case 'owner_mismatch': return err(appError('PERMISSION_DENIED', 'Goal belongs to another client'));
      case 'lease_invalid': return err(appError('CONFLICT', `Goal lease is no longer valid (${error.message}); read the latest goal and reacquire or claim the scheduled continuation before retrying`, true));
      case 'conflict': return err(appError('CONFLICT', error.message, true));
      case 'terminal': return err(appError('CONFLICT', 'Goal is already terminal'));
      case 'not_found': return err(appError('INVALID_INPUT', 'Goal was not found'));
      case 'corrupt': return err(appError('INTERNAL_ERROR', 'Durable goal fence state is corrupt'));
    }
  }
  if (error instanceof Error) return err(appError('INVALID_INPUT', error.message));
  return err(appError('INTERNAL_ERROR', 'Goal mutation fence failed'));
}
