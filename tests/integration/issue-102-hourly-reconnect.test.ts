import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ScheduledContinuationWorkerLiveness,
  ScheduledContinuationWorkerLivenessPort,
} from '@unified-mpc/domain';
import { GatewayService, type TunnelHandle } from '../../apps/cf-gateway/src/gateway-service.js';
import type { FileActor } from '../../packages/application/src/file-service.js';
import { GoalContinuationService, type RunGoalResult } from '../../packages/application/src/goal-continuation-service.js';
import { ScheduledContinuationService } from '../../packages/application/src/scheduled-continuation-service.js';
import { SqliteDatabase } from '../../packages/storage/src/database.js';
import { SqliteGoalRepository } from '../../packages/storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../packages/storage/src/workspace-repository.js';

const temporaryRoots: string[] = [];
const openDatabases: SqliteDatabase[] = [];
const gateways: GatewayService[] = [];

afterEach(async () => {
  await Promise.allSettled(gateways.splice(0).map(async (gateway) => { await gateway.stop(); }));
  for (const database of openDatabases.splice(0)) {
    try { database.close(); } catch { /* already closed by the test */ }
  }
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const actor: FileActor = {
  clientId: 'chatgpt-web-client',
  clientName: 'ChatGPT Web',
  sessionId: 'issue-102-original-session',
};

const START = '2026-10-29T10:00:00.000Z';
const HOURLY_DUE = '2026-10-29T11:00:00.000Z';
const NATIVE_TASK_ID = 'native-hourly-issue-102';
const GOAL_KEY = 'issue-102-hourly-reconnect';

interface TestClock {
  now(): Date;
  set(iso: string): void;
}

interface GoalRuntime {
  readonly database: SqliteDatabase;
  readonly repository: SqliteGoalRepository;
  readonly goals: GoalContinuationService;
  readonly scheduled: ScheduledContinuationService;
}

interface GoalFixture {
  readonly root: string;
  readonly filename: string;
  readonly clock: TestClock;
  readonly runtime: GoalRuntime;
  readonly started: RunGoalResult;
  readonly continuationId: string;
}

function createClock(iso: string): TestClock {
  let value = new Date(iso);
  return {
    now: (): Date => value,
    set: (next: string): void => { value = new Date(next); },
  };
}

async function openRuntime(
  filename: string,
  root: string,
  clock: TestClock,
  options: {
    readonly createWorkspace?: boolean;
    readonly liveness?: (repository: SqliteGoalRepository) => ScheduledContinuationWorkerLivenessPort;
  } = {},
): Promise<GoalRuntime> {
  const database = new SqliteDatabase(filename);
  openDatabases.push(database);
  if (options.createWorkspace === true) {
    const workspaces = new SqliteWorkspaceRepository(database);
    await workspaces.insert({
      id: 'workspace-1',
      displayName: 'Issue 102',
      rootPath: root,
      realRootPath: root,
      createdAt: START,
    });
  }
  const repository = new SqliteGoalRepository(database);
  const workspaces = new SqliteWorkspaceRepository(database);
  const goals = new GoalContinuationService(workspaces, repository, {
    now: clock.now,
    scheduledContinuations: repository,
  });
  const scheduled = new ScheduledContinuationService(repository, {
    now: clock.now,
    hostTimeZone: 'Asia/Bangkok',
    ...(options.liveness === undefined ? {} : { workerLiveness: options.liveness(repository) }),
  });
  return { database, repository, goals, scheduled };
}

function livenessFor(
  clock: TestClock,
  overrides: Partial<ScheduledContinuationWorkerLiveness> = {},
): (repository: SqliteGoalRepository) => ScheduledContinuationWorkerLivenessPort {
  return (repository) => ({
    observe: async (goalId: string): Promise<ScheduledContinuationWorkerLiveness> => {
      const goal = await repository.getById(goalId);
      if (goal === null) throw new Error('goal disappeared during liveness observation');
      return {
        trustworthy: true,
        observedAt: clock.now().toISOString(),
        leaseGeneration: goal.leaseGeneration,
        leaseActivitySeq: goal.leaseActivitySeq,
        liveFencedCallCount: 0,
        blockingTaskStates: [],
        ...overrides,
      };
    },
  });
}

async function createGoalFixture(options: {
  readonly leaseExpiresAt?: string;
  readonly blockingTaskId?: string;
} = {}): Promise<GoalFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-issue-102-'));
  temporaryRoots.push(root);
  const filename = path.join(root, 'state.sqlite');
  const clock = createClock(START);
  const runtime = await openRuntime(filename, root, clock, { createWorkspace: true });

  const started = await runtime.goals.runGoal(actor, {
    workspaceId: 'workspace-1',
    goalKey: GOAL_KEY,
    objective: 'Resume the same durable goal after the original transport is gone.',
    plan: { steps: [{ id: 'continue', title: 'Continue after the reconnect' }] },
    leaseSeconds: 600,
  });
  expect(started.ok).toBe(true);
  if (!started.ok || started.value.leaseToken === undefined) throw new Error('failed to start the durable goal');
  const goal = started.value;

  let revision = goal.revision;
  if (options.blockingTaskId !== undefined) {
    const checkpoint = await runtime.goals.checkpointGoal(actor, {
      goalId: goal.goalId,
      leaseToken: goal.leaseToken!,
      expectedRevision: revision,
      currentPhase: 'waiting-on-blocking-job',
      summary: 'A blocking job still owns the goal lease.',
      stepUpdates: [],
      nextAction: 'Wait for the blocking job to finish.',
      blockers: [],
      evidence: [],
      trackedTasks: [{
        taskId: options.blockingTaskId,
        provider: 'shell',
        role: 'blocking_job',
        cancelWithGoal: true,
      }],
      releaseLease: false,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error('failed to attach the blocking task');
    revision = checkpoint.value.revision;
  }

  const blockingTasks = options.blockingTaskId === undefined
    ? undefined
    : [{
        taskId: options.blockingTaskId,
        provider: 'shell' as const,
        role: 'blocking_job' as const,
        cancelWithGoal: true,
      }];

  const prepared = await runtime.scheduled.prepareScheduledContinuation(actor, {
    goalId: goal.goalId,
    leaseToken: goal.leaseToken!,
    expectedRevision: revision,
    currentPhase: 'continuation-ready',
    summary: 'The hourly watchdog is ready to resume this goal after reconnect.',
    stepUpdates: [],
    nextAction: 'Resume the durable goal when the hourly watchdog wakes.',
    blockers: [],
    evidence: [],
    ...(blockingTasks === undefined ? { activeTaskIds: [] } : { trackedTasks: blockingTasks }),
    executionPreference: 'cloud',
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error('failed to prepare the scheduled continuation');
  const continuationId = prepared.value.continuation.continuationId;
  expect(prepared.value.continuation).toMatchObject({
    occurrence: 'interval',
    intervalMinutes: 60,
    dueAt: HOURLY_DUE,
  });

  const receipt = await runtime.scheduled.recordScheduledContinuationReceipt(actor, {
    continuationId,
    expectedVersion: prepared.value.continuation.version,
    outcome: 'created',
    nativeTaskId: NATIVE_TASK_ID,
    dueAt: prepared.value.continuation.dueAt,
    runsOn: 'cloud',
  });
  expect(receipt.ok).toBe(true);

  if (options.leaseExpiresAt !== undefined) {
    runtime.database.connection.prepare('UPDATE goals SET lease_expires_at = ? WHERE id = ?')
      .run(options.leaseExpiresAt, goal.goalId);
  }

  return { root, filename, clock, runtime, started: goal, continuationId };
}

function createGateway(): {
  readonly gateway: GatewayService;
  setHealthy(value: boolean): void;
  tunnelStarts(): number;
} {
  let healthy = true;
  let starts = 0;
  const gateway = new GatewayService({
    localPort: 18769,
    healthAttempts: 1,
    healthTimeoutMs: 50,
    healthMonitorIntervalMs: 10,
    healthFailureThreshold: 1,
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 10,
    reconnectJitterRatio: 0,
    tunnelProviderFactory: (): (() => Promise<TunnelHandle>) => async (): Promise<TunnelHandle> => {
      starts += 1;
      return { url: 'https://mcp.issue-102.test', stop: async (): Promise<void> => {} };
    },
    healthProbe: async (): Promise<number> => (healthy ? 200 : 530),
  });
  gateways.push(gateway);
  return {
    gateway,
    setHealthy: (value: boolean): void => { healthy = value; },
    tunnelStarts: (): number => starts,
  };
}

async function claim(
  runtime: GoalRuntime,
  continuationId: string,
  sessionId: string,
): Promise<ReturnType<ScheduledContinuationService['claimScheduledContinuation']>> {
  return runtime.scheduled.claimScheduledContinuation(
    { ...actor, sessionId },
    { continuationId },
  );
}

describe('Issue #102 hourly scheduled continuation across reconnect', () => {
  it('resumes the same durable goal after backend/tunnel reconnect and the hourly wake', async () => {
    const fixture = await createGoalFixture();
    const { gateway, setHealthy, tunnelStarts } = createGateway();

    const started = await gateway.start();
    expect(started.ok).toBe(true);
    const connected = await gateway.connectSession();
    expect(connected.ok).toBe(true);
    expect(gateway.status()).toMatchObject({
      state: 'SESSION_CONNECTED',
      connectorRegistration: { state: 'unverified' },
      endToEndState: 'unverified',
    });

    setHealthy(false);
    await expect.poll(() => gateway.status().state, { timeout: 2_000 }).toBe('ERROR');
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
      endToEndState: 'unverified',
    });

    setHealthy(true);
    await expect.poll(() => gateway.status().state, { timeout: 3_000 }).toBe('SESSION_CONNECTED');
    expect(tunnelStarts()).toBeGreaterThanOrEqual(2);
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
      endToEndState: 'unverified',
    });

    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: livenessFor(fixture.clock),
    });

    const resumed = await claim(fresh, fixture.continuationId, 'issue-102-post-reconnect-session');
    expect(resumed).toMatchObject({
      ok: true,
      value: {
        outcome: 'recurring_acquired',
        acquisition: 'expired_lease',
        continuation: {
          continuationId: fixture.continuationId,
          occurrence: 'interval',
          intervalMinutes: 60,
          nativeTaskId: NATIVE_TASK_ID,
          status: 'scheduled',
        },
        goal: {
          goalId: fixture.started.goalId,
          goalKey: GOAL_KEY,
          status: 'active',
        },
        currentWakeMayReturn: true,
        nextRequiredAction: 'continue_work_with_existing_recurring_watchdog',
      },
    });
    if (!resumed.ok) throw new Error('hourly wake did not resume the goal');
    expect(resumed.value.leaseGeneration).toBeGreaterThan(fixture.started.leaseGeneration);

    const goalCount = fresh.database.connection.prepare('SELECT COUNT(*) AS count FROM goals').get() as { count: number };
    const continuationCount = fresh.database.connection.prepare(
      'SELECT COUNT(*) AS count FROM goal_scheduled_continuations WHERE goal_id = ?',
    ).get(fixture.started.goalId) as { count: number };
    expect(goalCount.count).toBe(1);
    expect(continuationCount.count).toBe(1);

    const fenced = await fresh.goals.checkpointGoal(
      { ...actor, sessionId: 'issue-102-post-reconnect-session' },
      {
        goalId: fixture.started.goalId,
        leaseToken: fixture.started.leaseToken!,
        expectedRevision: resumed.value.goal.revision,
        currentPhase: 'stale-worker',
        summary: 'The pre-reconnect lease must not mutate the goal.',
        stepUpdates: [],
        nextAction: '',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
      },
    );
    expect(fenced).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });

    expect(gateway.status()).toMatchObject({
      state: 'SESSION_CONNECTED',
      connectorRegistration: { state: 'stale' },
      endToEndState: 'unverified',
    });
  });

  it('resumes the hourly wake while tunnel reconnection is still in progress', async () => {
    const fixture = await createGoalFixture();
    const { gateway, setHealthy } = createGateway();

    expect((await gateway.start()).ok).toBe(true);
    expect((await gateway.connectSession()).ok).toBe(true);
    setHealthy(false);
    await expect.poll(() => gateway.status().state, { timeout: 2_000 }).toBe('ERROR');

    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: livenessFor(fixture.clock),
    });

    const resumed = await claim(fresh, fixture.continuationId, 'issue-102-wake-during-reconnect');
    expect(resumed).toMatchObject({
      ok: true,
      value: {
        outcome: 'recurring_acquired',
        acquisition: 'expired_lease',
        goal: { goalId: fixture.started.goalId },
      },
    });
    expect(gateway.status()).toMatchObject({
      state: 'ERROR',
      connectorRegistration: { state: 'stale' },
      endToEndState: 'unverified',
    });

    setHealthy(true);
    await expect.poll(() => gateway.status().state, { timeout: 3_000 }).toBe('SESSION_CONNECTED');
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
      endToEndState: 'unverified',
    });
  });

  it('recovers an unexpired orphan lease only after the bounded stale-recovery grace', async () => {
    const fixture = await createGoalFixture({ leaseExpiresAt: '2026-10-29T12:00:00.000Z' });
    fixture.runtime.database.connection.prepare('UPDATE goals SET lease_heartbeat_at = ? WHERE id = ?')
      .run('2026-10-29T10:59:30.000Z', fixture.started.goalId);
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: livenessFor(fixture.clock),
    });

    const probed = await claim(fresh, fixture.continuationId, 'issue-102-orphan-probe');
    expect(probed).toMatchObject({
      ok: true,
      value: {
        outcome: 'worker_busy_noop',
        retryAfterSeconds: 30,
        nextRequiredAction: 'retry_claim_after_stale_grace_window',
      },
    });

    fixture.clock.set('2026-10-29T11:00:31.000Z');
    const recovered = await claim(fresh, fixture.continuationId, 'issue-102-orphan-recovered');
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        outcome: 'recurring_acquired',
        acquisition: 'orphan_recovered',
        continuation: {
          continuationId: fixture.continuationId,
          nativeTaskId: NATIVE_TASK_ID,
        },
        goal: { goalId: fixture.started.goalId },
      },
    });
    if (!recovered.ok) throw new Error('orphan lease was not recovered');
    expect(recovered.value.leaseGeneration).toBe(fixture.started.leaseGeneration + 1);
  });

  it('refuses takeover while a blocking job still owns the lease', async () => {
    const fixture = await createGoalFixture({
      leaseExpiresAt: '2026-10-29T12:00:00.000Z',
      blockingTaskId: 'job-blocking-1',
    });
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: livenessFor(fixture.clock, {
        blockingTaskStates: [{ taskId: 'job-blocking-1', provider: 'shell', state: 'running' }],
      }),
    });

    const refused = await claim(fresh, fixture.continuationId, 'issue-102-blocking-wake');
    expect(refused).toMatchObject({
      ok: true,
      value: {
        outcome: 'worker_busy_noop',
        continuation: { continuationId: fixture.continuationId },
        goal: { goalId: fixture.started.goalId },
      },
    });
    if (!refused.ok) throw new Error('blocking claim failed');
    expect(refused.value.retryAfterSeconds).toBeGreaterThan(60);

    const goal = await fresh.repository.getById(fixture.started.goalId);
    expect(goal).not.toBeNull();
    expect(goal?.leaseGeneration).toBe(fixture.started.leaseGeneration);
    expect(goal?.leaseOwnerSessionId).toBe(actor.sessionId);
  });

  it('fails closed when worker liveness is not trustworthy', async () => {
    const fixture = await createGoalFixture({ leaseExpiresAt: '2026-10-29T13:00:00.000Z' });
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: livenessFor(fixture.clock, { trustworthy: false }),
    });

    const refused = await claim(fresh, fixture.continuationId, 'issue-102-ambiguous-wake');
    expect(refused).toMatchObject({
      ok: true,
      value: {
        outcome: 'worker_busy_noop',
        continuation: { continuationId: fixture.continuationId },
      },
    });

    const goal = await fresh.repository.getById(fixture.started.goalId);
    expect(goal?.leaseGeneration).toBe(fixture.started.leaseGeneration);
    expect(goal?.leaseOwnerSessionId).toBe(actor.sessionId);
  });

  it('fails closed when the liveness provider is unavailable', async () => {
    const fixture = await createGoalFixture({ leaseExpiresAt: '2026-10-29T12:00:00.000Z' });
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: (): ScheduledContinuationWorkerLivenessPort => ({
        observe: async (): Promise<ScheduledContinuationWorkerLiveness> => {
          throw new Error('liveness provider unavailable');
        },
      }),
    });

    const refused = await claim(fresh, fixture.continuationId, 'issue-102-unavailable-liveness');
    expect(refused.ok).toBe(false);

    const goal = await fresh.repository.getById(fixture.started.goalId);
    expect(goal?.leaseGeneration).toBe(fixture.started.leaseGeneration);
    expect(goal?.leaseOwnerSessionId).toBe(actor.sessionId);
  });

  it('lets exactly one of two racing replacement wakes own the goal', async () => {
    const fixture = await createGoalFixture();
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: livenessFor(fixture.clock),
    });

    const [first, second] = await Promise.all([
      claim(fresh, fixture.continuationId, 'issue-102-racing-wake-a'),
      claim(fresh, fixture.continuationId, 'issue-102-racing-wake-b'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('racing claim failed');

    const outcomes = [first.value.outcome, second.value.outcome];
    expect(outcomes.filter((outcome) => outcome === 'recurring_acquired')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_claimed')).toHaveLength(1);

    const goal = await fresh.repository.getById(fixture.started.goalId);
    expect(goal).not.toBeNull();
    expect(goal?.leaseGeneration).toBe(fixture.started.leaseGeneration + 1);
    expect(['issue-102-racing-wake-a', 'issue-102-racing-wake-b']).toContain(goal?.leaseOwnerSessionId);

    const runCount = fresh.database.connection.prepare(
      'SELECT COUNT(*) AS count FROM goal_scheduled_continuation_runs WHERE continuation_id = ?',
    ).get(fixture.continuationId) as { count: number };
    expect(runCount.count).toBe(1);
  });

  it('keeps repeated hourly lease rotations bounded without duplicate goals or continuations', async () => {
    const fixture = await createGoalFixture();
    fixture.runtime.database.close();
    const fresh = await openRuntime(fixture.filename, fixture.root, fixture.clock, {
      liveness: livenessFor(fixture.clock),
    });

    const sessions = ['issue-102-rotation-1', 'issue-102-rotation-2', 'issue-102-rotation-3'];
    let expectedGeneration = fixture.started.leaseGeneration;
    for (const [index, sessionId] of sessions.entries()) {
      fixture.clock.set(new Date(Date.parse(HOURLY_DUE) + index * 60 * 60_000).toISOString());
      const rotated = await claim(fresh, fixture.continuationId, sessionId);
      expect(rotated).toMatchObject({
        ok: true,
        value: {
          outcome: 'recurring_acquired',
          acquisition: 'expired_lease',
          goal: { goalId: fixture.started.goalId },
        },
      });
      if (!rotated.ok) throw new Error('hourly rotation did not acquire the goal');
      expectedGeneration += 1;
      expect(rotated.value.leaseGeneration).toBe(expectedGeneration);
    }

    const goalCount = fresh.database.connection.prepare('SELECT COUNT(*) AS count FROM goals').get() as { count: number };
    const continuationCount = fresh.database.connection.prepare(
      'SELECT COUNT(*) AS count FROM goal_scheduled_continuations WHERE goal_id = ?',
    ).get(fixture.started.goalId) as { count: number };
    const runCount = fresh.database.connection.prepare(
      'SELECT COUNT(*) AS count FROM goal_scheduled_continuation_runs WHERE continuation_id = ?',
    ).get(fixture.continuationId) as { count: number };
    expect(goalCount.count).toBe(1);
    expect(continuationCount.count).toBe(1);
    expect(runCount.count).toBe(sessions.length);
  });
});
