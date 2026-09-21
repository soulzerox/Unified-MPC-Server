import {
  GOAL_RUNTIME_CONTRACT_VERSION,
  projectGoalRuntimeEvent,
  type GoalRecord,
  type GoalRepository,
  type GoalRuntimeEvent,
  type GoalRuntimeEventRepository,
  type GoalRuntimeProjection,
  type GoalRuntimeSnapshotRecord,
  type GoalRuntimeSnapshotRepository,
} from '@unified-mpc/domain';

const DEFAULT_BOOTSTRAP_LIMIT = 500;
const EVENT_REPLAY_PAGE_SIZE = 500;

export interface GoalRuntimeEventPublisher {
  ensureGoalSnapshot(goalId: string): Promise<GoalRuntimeSnapshotRecord>;
  publishGoalRuntimeEvent(event: GoalRuntimeEvent): Promise<GoalRuntimeSnapshotRecord>;
}

export interface GoalRuntimeBootstrapResult {
  readonly workspaceId: string;
  readonly goalsScanned: number;
  readonly snapshotsReady: number;
}

export class GoalRuntimeControlPlaneError extends Error {
  public constructor(
    public readonly reason: 'goal_not_found' | 'replay_window_missed' | 'projection_rejected',
    message: string,
  ) {
    super(message);
    this.name = 'GoalRuntimeControlPlaneError';
  }
}

/**
 * Parent-owned writer for authoritative Goal runtime truth.
 *
 * Durable Goal mutations remain the source for durable intent/ownership. This
 * service serializes runtime projection per Goal, replays any durable events
 * missed by a snapshot, and publishes one compact snapshot for WebUI/recovery/
 * cleanup consumers. It never infers "running" from selection, an open Goal,
 * a worktree, or lease ownership alone.
 */
export class GoalRuntimeControlPlaneService implements GoalRuntimeEventPublisher {
  private readonly goalChains = new Map<string, Promise<void>>();

  public constructor(
    private readonly goals: Pick<GoalRepository, 'getById' | 'list'>,
    private readonly snapshots: GoalRuntimeSnapshotRepository,
    private readonly events: GoalRuntimeEventRepository,
  ) {}

  public async ensureGoalSnapshot(goalId: string): Promise<GoalRuntimeSnapshotRecord> {
    return this.withGoalLock(goalId, async () => {
      let snapshot = await this.ensureGoalSnapshotUnlocked(goalId);
      snapshot = await this.catchUpSnapshotUnlocked(snapshot);
      return this.reconcileDurableTerminalStateUnlocked(snapshot);
    });
  }

  public async publishGoalRuntimeEvent(event: GoalRuntimeEvent): Promise<GoalRuntimeSnapshotRecord> {
    return this.withGoalLock(event.goalId, async () => {
      let snapshot = await this.ensureGoalSnapshotUnlocked(event.goalId);
      snapshot = await this.catchUpSnapshotUnlocked(snapshot);

      return this.appendAndReplayUnlocked(snapshot, event);
    });
  }

  public async bootstrapWorkspace(
    workspaceId: string,
    limit = DEFAULT_BOOTSTRAP_LIMIT,
  ): Promise<GoalRuntimeBootstrapResult> {
    const goals = await this.goals.list({ workspaceId, limit });
    let snapshotsReady = 0;
    for (const goal of goals) {
      await this.ensureGoalSnapshot(goal.id);
      snapshotsReady += 1;
    }
    return { workspaceId, goalsScanned: goals.length, snapshotsReady };
  }

  private async ensureGoalSnapshotUnlocked(goalId: string): Promise<GoalRuntimeSnapshotRecord> {
    const existing = await this.snapshots.getGoalRuntimeSnapshot(goalId);
    if (existing !== null) return existing;

    const goal = await this.goals.getById(goalId);
    if (goal === null) {
      throw new GoalRuntimeControlPlaneError('goal_not_found', `Goal '${goalId}' was not found`);
    }

    // If events predate snapshot materialization (or a crash occurred between
    // durable Goal mutation and projection), compact from the durable aggregate
    // at the latest known Goal-event cursor. Unknown integration/workspace facts
    // stay unknown rather than being guessed.
    const newest = await this.events.listGoalRuntimeEvents({ goalId, limit: 1 });
    const lastEventSequence = newest[0]?.sequence ?? 0;
    return this.snapshots.storeGoalRuntimeSnapshot({
      projection: projectionFromDurableGoal(goal),
      lastEventSequence,
      updatedAt: goal.updatedAt,
    });
  }

  private async reconcileDurableTerminalStateUnlocked(
    initial: GoalRuntimeSnapshotRecord,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const goal = await this.goals.getById(initial.projection.goalId);
    if (goal === null) {
      throw new GoalRuntimeControlPlaneError('goal_not_found', `Goal '${initial.projection.goalId}' was not found`);
    }
    if (goal.status === 'active') return initial;

    let snapshot = initial;
    const occurredAt = goal.terminalAt ?? goal.updatedAt;
    const executionId = snapshot.projection.activeExecutionId;
    const executionGeneration = snapshot.projection.executionGeneration;
    const discriminator = `durable-terminal:${goal.revision}`;

    if (executionId !== undefined && executionGeneration !== undefined) {
      if (goal.status === 'cancelled') {
        snapshot = await this.appendAndReplayUnlocked(snapshot, {
          eventId: durableRuntimeEventId(goal.id, 'execution_cancelled', discriminator),
          type: 'execution_cancelled',
          workspaceId: goal.workspaceId,
          goalId: goal.id,
          executionId,
          executionGeneration,
          occurredAt,
          detail: 'restart reconciliation from durable cancelled Goal',
        });
      } else if (goal.status === 'completed') {
        if (snapshot.projection.runtimeState === 'queued' || snapshot.projection.runtimeState === 'starting') {
          snapshot = await this.appendAndReplayUnlocked(snapshot, {
            eventId: durableRuntimeEventId(goal.id, 'execution_started', `${discriminator}:finish`),
            type: 'execution_started',
            workspaceId: goal.workspaceId,
            goalId: goal.id,
            executionId,
            executionGeneration,
            occurredAt,
            detail: 'restart reconciliation for durably completed Goal',
          });
        }
        snapshot = await this.appendAndReplayUnlocked(snapshot, {
          eventId: durableRuntimeEventId(goal.id, 'execution_completed', discriminator),
          type: 'execution_completed',
          workspaceId: goal.workspaceId,
          goalId: goal.id,
          executionId,
          executionGeneration,
          occurredAt,
          detail: 'restart reconciliation from durable completed Goal',
        });
      } else {
        snapshot = await this.appendAndReplayUnlocked(snapshot, {
          eventId: durableRuntimeEventId(goal.id, 'execution_failed', discriminator),
          type: 'execution_failed',
          workspaceId: goal.workspaceId,
          goalId: goal.id,
          executionId,
          executionGeneration,
          occurredAt,
          detail: `restart reconciliation from durable ${goal.status} Goal`,
        });
      }
    }

    const lifecycleType = goal.status === 'cancelled' ? 'goal_abandoned' : 'goal_completed';
    const lifecycleTarget = lifecycleType === 'goal_abandoned' ? 'abandoned' : 'completed';
    if (snapshot.projection.lifecycleState !== lifecycleTarget) {
      snapshot = await this.appendAndReplayUnlocked(snapshot, {
        eventId: durableRuntimeEventId(goal.id, lifecycleType, discriminator),
        type: lifecycleType,
        workspaceId: goal.workspaceId,
        goalId: goal.id,
        occurredAt,
        detail: `restart reconciliation from durable ${goal.status} Goal`,
      });
    }
    return snapshot;
  }

  private async appendAndReplayUnlocked(
    snapshot: GoalRuntimeSnapshotRecord,
    event: GoalRuntimeEvent,
  ): Promise<GoalRuntimeSnapshotRecord> {
    const preview = projectGoalRuntimeEvent(snapshot.projection, event);
    if (preview.decision.disposition === 'reject') {
      throw new GoalRuntimeControlPlaneError(
        'projection_rejected',
        `Goal runtime event '${event.type}' was rejected: ${preview.decision.reason}`,
      );
    }

    const appended = await this.events.appendGoalRuntimeEvent({
      event,
      recordedAt: new Date().toISOString(),
    });
    if (appended.record.sequence <= snapshot.lastEventSequence) return snapshot;

    // Replay from the snapshot cursor instead of blindly storing the preview.
    // This preserves event order if another authoritative producer appended
    // a same-Goal event between our preflight and durable append.
    return this.catchUpSnapshotUnlocked(snapshot);
  }

  private async catchUpSnapshotUnlocked(
    initial: GoalRuntimeSnapshotRecord,
  ): Promise<GoalRuntimeSnapshotRecord> {
    let snapshot = initial;
    let scanCursor = initial.lastEventSequence;

    for (;;) {
      const page = await this.events.replayWorkspaceGoalRuntimeEvents({
        workspaceId: snapshot.projection.workspaceId,
        afterSequence: scanCursor,
        limit: EVENT_REPLAY_PAGE_SIZE,
      });
      if (page.replayWindowMissed) {
        throw new GoalRuntimeControlPlaneError(
          'replay_window_missed',
          `Goal runtime replay window was missed after sequence ${scanCursor}`,
        );
      }
      if (page.events.length === 0) return snapshot;

      let projection = snapshot.projection;
      let lastGoalSequence = snapshot.lastEventSequence;
      for (const record of page.events) {
        if (record.event.goalId !== projection.goalId) continue;
        const projected = projectGoalRuntimeEvent(projection, record.event);
        if (projected.decision.disposition === 'reject') {
          throw new GoalRuntimeControlPlaneError(
            'projection_rejected',
            `Durable Goal runtime event ${record.sequence} was rejected: ${projected.decision.reason}`,
          );
        }
        projection = projected.projection;
        lastGoalSequence = record.sequence;
      }

      if (lastGoalSequence > snapshot.lastEventSequence) {
        snapshot = await this.snapshots.storeGoalRuntimeSnapshot({
          projection,
          lastEventSequence: lastGoalSequence,
          updatedAt: page.events.at(-1)!.recordedAt,
        });
      }

      scanCursor = page.events.at(-1)!.sequence;
      if (page.latestSequence === undefined || scanCursor >= page.latestSequence) return snapshot;
    }
  }

  private async withGoalLock<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.goalChains.get(goalId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.catch(() => undefined).then(() => gate);
    this.goalChains.set(goalId, chain);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.goalChains.get(goalId) === chain) this.goalChains.delete(goalId);
    }
  }
}

function projectionFromDurableGoal(goal: GoalRecord): GoalRuntimeProjection {
  const exactExecutionId = goal.status === 'active'
    && goal.executionId !== undefined
    && goal.executionGeneration !== undefined
    && goal.executionGeneration === goal.leaseGeneration
      ? goal.executionId
      : undefined;
  const hasExactExecution = exactExecutionId !== undefined;

  const base = {
    contractVersion: GOAL_RUNTIME_CONTRACT_VERSION,
    goalId: goal.id,
    workspaceId: goal.workspaceId,
    integrationState: 'unknown',
    workspaceState: 'unknown',
    lastActivityAt: goal.updatedAt,
    ...(goal.executionGeneration === undefined ? {} : { executionGeneration: goal.executionGeneration }),
  } as const;

  switch (goal.status) {
    case 'active':
      return {
        ...base,
        lifecycleState: 'open',
        runtimeState: hasExactExecution ? 'queued' : 'idle',
        desiredRuntimeState: hasExactExecution ? 'running' : 'idle',
        ...(exactExecutionId === undefined ? {} : { activeExecutionId: exactExecutionId }),
      };
    case 'completed':
      return {
        ...base,
        lifecycleState: 'completed',
        runtimeState: 'idle',
        desiredRuntimeState: 'idle',
      };
    case 'failed':
      return {
        ...base,
        lifecycleState: 'completed',
        runtimeState: 'failed',
        desiredRuntimeState: 'idle',
      };
    case 'blocked':
      return {
        ...base,
        lifecycleState: 'completed',
        runtimeState: 'failed',
        desiredRuntimeState: 'idle',
        blocker: {
          kind: 'unknown',
          detail: 'legacy terminal Goal status is blocked',
          observedAt: goal.updatedAt,
        },
      };
    case 'cancelled':
      return {
        ...base,
        lifecycleState: 'abandoned',
        runtimeState: 'cancelled',
        desiredRuntimeState: 'cancelled',
      };
  }
}

function durableRuntimeEventId(goalId: string, type: GoalRuntimeEvent['type'], discriminator: string): string {
  const input = [goalId, type, discriminator].join('\0');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `goal-runtime-reconcile-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
