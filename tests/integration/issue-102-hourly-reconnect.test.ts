import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GoalTrackedTask,
  ScheduledContinuationWorkerLiveness,
  ScheduledContinuationWorkerLivenessPort,
} from '@unified-mpc/domain';
import { GatewayService, type TunnelHandle } from '../../apps/cf-gateway/src/gateway-service.js';
import type { FileActor } from '../../packages/application/src/file-service.js';
import { GoalContinuationService, type RunGoalResult } from '../../packages/application/src/goal-continuation-service.js';
import { ScheduledContinuationService } from '../../packages/application/src/scheduled-continuation-service.js';
import { BoundedRetentionMap } from '../../packages/mcp-server/src/bounded-retention-map.js';
import { SqliteDatabase } from '../../packages/storage/src/database.js';
import { SqliteGoalRepository } from '../../packages/storage/src/goal-repository.js';
import { SqliteWorkspaceRepository } from '../../packages/storage/src/workspace-repository.js';

/**
 * Deterministic service-level proof for the #44 / #102 recovery contract:
 * a gateway/tunnel reconnect and a durable-store restart must not lose the
 * hourly scheduled continuation, its goal, or its lease fencing. The harness
 * stands in for the host boundary with fake clocks, tunnel health, and worker
 * liveness; it never waits for a real hour. Full HTTP transport TTL and
 * retention are covered by the existing #44 suites.
 */

const temporaryRoots: string[] = [];
const openDatabases: SqliteDatabase[] = [];
const gateways: GatewayService[] = [];

afterEach(async () => {
  await Promise.allSettled(gateways.splice(0).map(async (gateway) => { await gateway.stop(); }));
  for (const database of openDatabases.splice(0)) database.close();
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

async function reopen(
  fixture: GoalFixture,
  options: {
    readonly liveness?: (repository: SqliteGoalRepository) => ScheduledContinuationWorkerLivenessPort;
  } = {},
): Promise<GoalRuntime> {
  return openRuntime(fixture.filename, fixture.root, fixture.clock, options);
}

function countRows(database: SqliteDatabase, sql: string, ...params: string[]): number {
  const row = database.connection.prepare(sql).get(...params) as { count: number };
  return row.count;
}

type BlockingTaskState = 'running' | 'terminal' | 'absent' | 'unknown';

function livenessFor(
  clock: TestClock,
  options: {
    readonly taskStates?: Readonly<Record<string, BlockingTaskState>>;
    readonly overrides?: Partial<ScheduledContinuationWorkerLiveness>;
  } = {},
): (repository: SqliteGoalRepository) => ScheduledContinuationWorkerLivenessPort {
  return (repository) => ({
    observe: async (
      goalId: string,
      trackedTasks: readonly GoalTrackedTask[],
    ): Promise<ScheduledContinuationWorkerLiveness> => {
      const goal = await repository.getById(goalId);
      if (goal === null) throw new Error('goal disappeared during liveness observation');
      const taskStates = options.taskStates ?? {};
      return {
        trustworthy: true,
        observedAt: clock.now().toISOString(),
        leaseGeneration: goal.leaseGeneration,
        leaseActivitySeq: goal.leaseActivitySeq,
        liveFencedCallCount: 0,
        blockingTaskStates: trackedTasks
          .filter((task) => task.role === 'blocking_job')
          .map((task) => ({
            taskId: task.taskId,
            provider: task.provider,
            state: taskStates[task.taskId] ?? 'absent',
          })),
        ...options.overrides,
      };
    },
  });
}

async function createGoalFixture(options: {
  readonly leaseExpiresAt?: string;
  readonly blockingTaskId?: string;
  readonly supportingTaskId?: string;
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

  const trackedTasks: GoalTrackedTask[] = [
    ...(options.blockingTaskId === undefined ? [] : [{
      taskId: options.blockingTaskId,
      provider: 'shell' as const,
      role: 'blocking_job' as const,
      cancelWithGoal: true,
    }]),
    ...(options.supportingTaskId === undefined ? [] : [{
      taskId: options.supportingTaskId,
      provider: 'process' as const,
      role: 'supporting_service' as const,
      cancelWithGoal: false,
    }]),
  ];

  let revision = goal.revision;
  if (trackedTasks.length > 0) {
    const checkpoint = await runtime.goals.checkpointGoal(actor, {
      goalId: goal.goalId,
      leaseToken: goal.leaseToken!,
      expectedRevision: revision,
      currentPhase: 'waiting-on-blocking-job',
      summary: 'A tracked task still owns the goal lease.',
      stepUpdates: [],
      nextAction: 'Wait for the tracked task before resuming.',
      blockers: [],
      evidence: [],
      trackedTasks,
      releaseLease: false,
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) throw new Error('failed to attach the tracked task');
    revision = checkpoint.value.revision;
  }

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
    ...(trackedTasks.length === 0 ? { activeTaskIds: [] } : { trackedTasks }),
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
    // The harness stands in for a host that confirmed cloud execution; no real host is contacted.
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
  setBackendHealthy(value: boolean): void;
  setTunnelHealthy(value: boolean): void;
  tunnelStarts(): number;
} {
  let backendHealthy = true;
  let tunnelHealthy = true;
  let starts = 0;
  const gateway = new GatewayService({
    localPort: 18769,
    healthAttempts: 1,
    healthTimeoutMs: 50,
    healthMonitorIntervalMs: 10,
    healthFailureThreshold: 1,
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 40,
    reconnectJitterRatio: 0,
    tunnelProviderFactory: (): (() => Promise<TunnelHandle>) => async (): Promise<TunnelHandle> => {
      starts += 1;
      if (!tunnelHealthy) throw new Error('tunnel provider unavailable');
      return { url: 'https://mcp.issue-102.test', stop: async (): Promise<void> => {} };
    },
    healthProbe: async (): Promise<number> => (backendHealthy && tunnelHealthy ? 200 : 530),
  });
  gateways.push(gateway);
  return {
    gateway,
    setBackendHealthy: (value: boolean): void => { backendHealthy = value; },
    setTunnelHealthy: (value: boolean): void => { tunnelHealthy = value; },
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
  it('resumes the same durable goal after backend loss, bounded reconnect, and the hourly wake', async () => {
    const fixture = await createGoalFixture();
    const { gateway, setBackendHealthy, tunnelStarts } = createGateway();

    const started = await gateway.start();
    expect(started.ok).toBe(true);
    const connected = await gateway.connectSession();
    expect(connected.ok).toBe(true);
    expect(gateway.status()).toMatchObject({
      state: 'SESSION_CONNECTED',
      connectorRegistration: { state: 'unverified' },
    });

    setBackendHealthy(false);
    await expect.poll(() => gateway.status().state, { timeout: 2_000 }).toBe('ERROR');
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
    });

    setBackendHealthy(true);
    await expect.poll(() => gateway.status().state, { timeout: 3_000 }).toBe('SESSION_CONNECTED');
    const settledStarts = tunnelStarts();
    expect(settledStarts).toBeGreaterThanOrEqual(2);
    expect(settledStarts).toBeLessThanOrEqual(20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tunnelStarts()).toBe(settledStarts);
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
    });

    const beforeRestart = await fixture.runtime.repository.getById(fixture.started.goalId);
    const checkpointIdsBefore = beforeRestart?.checkpoints.map((checkpoint) => checkpoint.id) ?? [];
    expect(checkpointIdsBefore.length).toBeGreaterThanOrEqual(1);

    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await reopen(fixture, {
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
    expect(resumed.value.leaseGeneration).toBe(fixture.started.leaseGeneration + 1);

    const recoveredGoal = await fresh.repository.getById(fixture.started.goalId);
    expect(recoveredGoal).not.toBeNull();
    expect(recoveredGoal?.goalKey).toBe(GOAL_KEY);
    expect(recoveredGoal?.workspaceId).toBe('workspace-1');
    expect(recoveredGoal?.plan).toEqual(fixture.started.plan);
    expect(recoveredGoal?.checkpoints.map((checkpoint) => checkpoint.id))
      .toEqual(expect.arrayContaining(checkpointIdsBefore));
    const recoveredWorkspace = await new SqliteWorkspaceRepository(fresh.database).get('workspace-1');
    expect(recoveredWorkspace).toMatchObject({ id: 'workspace-1', rootPath: fixture.root, realRootPath: fixture.root });

    expect(countRows(fresh.database, 'SELECT COUNT(*) AS count FROM goals')).toBe(1);
    expect(countRows(fresh.database, 'SELECT COUNT(*) AS count FROM goal_scheduled_continuations WHERE goal_id = ?', fixture.started.goalId)).toBe(1);

    const continued = await fresh.goals.checkpointGoal(
      { ...actor, sessionId: 'issue-102-post-reconnect-session' },
      {
        goalId: fixture.started.goalId,
        leaseToken: resumed.value.leaseToken!,
        expectedRevision: resumed.value.goal.revision,
        currentPhase: 'resumed-after-reconnect',
        summary: 'The replacement session can continue the recovered goal.',
        stepUpdates: [{ stepId: 'continue', status: 'in_progress' }],
        nextAction: 'Continue the real work.',
        blockers: [],
        evidence: [],
        activeTaskIds: [],
      },
    );
    expect(continued.ok).toBe(true);
    if (!continued.ok) throw new Error('the rotated lease token could not checkpoint the goal');

    const fenced = await fresh.goals.checkpointGoal(
      { ...actor, sessionId: 'issue-102-post-reconnect-session' },
      {
        goalId: fixture.started.goalId,
        leaseToken: fixture.started.leaseToken!,
        expectedRevision: continued.value.revision,
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
    });
  });

  it('reconnects after tunnel/provider loss while the backend stays healthy', async () => {
    const { gateway, setTunnelHealthy, tunnelStarts } = createGateway();

    expect((await gateway.start()).ok).toBe(true);
    expect((await gateway.connectSession()).ok).toBe(true);
    setTunnelHealthy(false);
    await expect.poll(() => gateway.status().state, { timeout: 2_000 }).toBe('ERROR');
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
    });

    setTunnelHealthy(true);
    await expect.poll(() => gateway.status().state, { timeout: 3_000 }).toBe('SESSION_CONNECTED');
    const settledStarts = tunnelStarts();
    expect(settledStarts).toBeGreaterThanOrEqual(2);
    expect(settledStarts).toBeLessThanOrEqual(20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tunnelStarts()).toBe(settledStarts);
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
    });
  });

  it('resumes the hourly wake while tunnel reconnection is still in progress', async () => {
    const fixture = await createGoalFixture();
    const { gateway, setBackendHealthy } = createGateway();

    expect((await gateway.start()).ok).toBe(true);
    expect((await gateway.connectSession()).ok).toBe(true);
    setBackendHealthy(false);
    await expect.poll(() => gateway.status().state, { timeout: 2_000 }).toBe('ERROR');

    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await reopen(fixture, {
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
    });

    setBackendHealthy(true);
    await expect.poll(() => gateway.status().state, { timeout: 3_000 }).toBe('SESSION_CONNECTED');
    expect(gateway.status()).toMatchObject({
      connectorRegistration: { state: 'stale' },
    });
  });

  it('recovers an unexpired orphan lease only after the bounded stale-recovery grace', async () => {
    const fixture = await createGoalFixture({ leaseExpiresAt: '2026-10-29T12:00:00.000Z' });
    fixture.runtime.database.connection.prepare('UPDATE goals SET lease_heartbeat_at = ? WHERE id = ?')
      .run('2026-10-29T10:59:30.000Z', fixture.started.goalId);
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await reopen(fixture, {
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
    const fresh = await reopen(fixture, {
      liveness: livenessFor(fixture.clock, { taskStates: { 'job-blocking-1': 'running' } }),
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

  it('preserves supporting-service identity across recovery without treating it as blocking', async () => {
    const fixture = await createGoalFixture({ supportingTaskId: 'supporting-indexer' });
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await reopen(fixture, {
      liveness: livenessFor(fixture.clock),
    });

    const recovered = await claim(fresh, fixture.continuationId, 'issue-102-supporting-service-wake');
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        outcome: 'recurring_acquired',
        acquisition: 'expired_lease',
        goal: { goalId: fixture.started.goalId },
      },
    });

    const goal = await fresh.repository.getById(fixture.started.goalId);
    expect(goal?.trackedTasks).toEqual([
      { taskId: 'supporting-indexer', provider: 'process', role: 'supporting_service', cancelWithGoal: false },
    ]);
    expect(goal?.activeTaskIds).toEqual([]);
  });

  it('fails closed when worker liveness is not trustworthy', async () => {
    const fixture = await createGoalFixture({ leaseExpiresAt: '2026-10-29T13:00:00.000Z' });
    fixture.runtime.database.close();
    fixture.clock.set(HOURLY_DUE);
    const fresh = await reopen(fixture, {
      liveness: livenessFor(fixture.clock, { overrides: { trustworthy: false } }),
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
    const fresh = await reopen(fixture, {
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
    const fresh = await reopen(fixture);
    const beforeRace = await fresh.repository.getById(fixture.started.goalId);
    if (beforeRace === null) throw new Error('goal missing before the race');
    const staticLiveness = (): ScheduledContinuationWorkerLivenessPort => ({
      observe: async (): Promise<ScheduledContinuationWorkerLiveness> => ({
        trustworthy: true,
        observedAt: fixture.clock.now().toISOString(),
        leaseGeneration: beforeRace.leaseGeneration,
        leaseActivitySeq: beforeRace.leaseActivitySeq,
        liveFencedCallCount: 0,
        blockingTaskStates: [],
      }),
    });
    const serviceA = new ScheduledContinuationService(fresh.repository, {
      now: fixture.clock.now,
      hostTimeZone: 'Asia/Bangkok',
      workerLiveness: staticLiveness(),
    });
    const competingDatabase = new SqliteDatabase(fixture.filename);
    openDatabases.push(competingDatabase);
    const competingRepository = new SqliteGoalRepository(competingDatabase);
    const serviceB = new ScheduledContinuationService(competingRepository, {
      now: fixture.clock.now,
      hostTimeZone: 'Asia/Bangkok',
      workerLiveness: staticLiveness(),
    });

    const [first, second] = await Promise.all([
      serviceA.claimScheduledContinuation(
        { ...actor, sessionId: 'issue-102-racing-wake-a' },
        { continuationId: fixture.continuationId },
      ),
      serviceB.claimScheduledContinuation(
        { ...actor, sessionId: 'issue-102-racing-wake-b' },
        { continuationId: fixture.continuationId },
      ),
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

    const runCount = countRows(fresh.database, 'SELECT COUNT(*) AS count FROM goal_scheduled_continuation_runs WHERE continuation_id = ?', fixture.continuationId);
    expect(runCount).toBe(1);
  });

  it('reclaims transient session-ledger entries within bounded retention while the goal survives', async () => {
    const fixture = await createGoalFixture();
    const sessions = new BoundedRetentionMap<string, { readonly sessionId: string }>({
      maxEntries: 2,
      ttlMs: 60 * 60_000,
      now: (): number => fixture.clock.now().getTime(),
    });

    expect(sessions.setWithEvictions('session-1', { sessionId: 'session-1' })).toHaveLength(0);
    expect(sessions.setWithEvictions('session-2', { sessionId: 'session-2' })).toHaveLength(0);
    expect(sessions.setWithEvictions('session-3', { sessionId: 'session-3' }))
      .toMatchObject([{ key: 'session-1', reason: 'capacity' }]);
    expect(sessions.size).toBe(2);

    fixture.clock.set(HOURLY_DUE);
    expect(sessions.getWithEviction('session-2')).toMatchObject({
      state: 'evicted',
      eviction: { key: 'session-2', reason: 'ttl' },
    });
    expect(sessions.size).toBe(1);

    const goal = await fixture.runtime.repository.getById(fixture.started.goalId);
    expect(goal?.status).toBe('active');
    expect(goal?.leaseGeneration).toBe(fixture.started.leaseGeneration);
  });

  it('keeps repeated hourly lease rotations bounded without duplicate goals or continuations', async () => {
    const fixture = await createGoalFixture();
    fixture.runtime.database.close();
    const fresh = await reopen(fixture, {
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
    const runCount = countRows(fresh.database, 'SELECT COUNT(*) AS count FROM goal_scheduled_continuation_runs WHERE continuation_id = ?', fixture.continuationId);
    expect(goalCount.count).toBe(1);
    expect(continuationCount.count).toBe(1);
    expect(runCount).toBe(sessions.length);
  });
});
