import { describe, expect, it } from 'vitest';
import {
  ResourceAdmissionController,
  tryAdmitGoalProcess,
} from './resource-admission.js';
import {
  DEFAULT_HEAVY_JOB_AGING_MS,
  HeavyJobWaiterQueue,
  type HeavyJobClaimResult,
  type HeavyJobLiveEntry,
  type HeavyJobQueueStore,
  type HeavyJobReattachResult,
  type HeavyJobSupersedeStoreResult,
} from './heavy-job-queue.js';

function makeController(): ResourceAdmissionController {
  return new ResourceAdmissionController({ globalCost: 8, workspaceCost: 8, maxOperations: 4 });
}

describe('heavy job waiter queue (#145 U3)', () => {
  it('queues on RESOURCE_PRESSURE and admits FIFO on release', () => {
    const controller = makeController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    const first = tryAdmitGoalProcess(controller, {
      operationId: 'heavy-a',
      workspaceId: 'ws-a',
      cost: 8,
    });
    expect(first.admitted).toBe(true);

    const queuedB = queue.enqueue({ operationId: 'heavy-b', workspaceId: 'ws-b', resourceClass: 'goal_process', cost: 8 });
    const queuedC = queue.enqueue({ operationId: 'heavy-c', workspaceId: 'ws-c', resourceClass: 'goal_process', cost: 8 });
    expect(queuedB).toMatchObject({ status: 'queued' });
    expect(queuedC).toMatchObject({ status: 'queued' });
    expect(queue.depth()).toBe(2);
    expect(queue.position('heavy-b')).toBe(1);
    expect(queue.position('heavy-c')).toBe(2);
    expect(queue.position('missing')).toBeUndefined();

    if (first.admitted) controller.release(first.lease);
    const admitted = queue.drain();
    expect(admitted.map((a) => a.lease.operationId)).toEqual(['heavy-b']);
    expect(queue.depth()).toBe(1);
    expect(queue.position('heavy-b')).toBeUndefined();
    expect(queue.position('heavy-c')).toBe(2);
  });

  it('coalesces duplicate exact-input work instead of queueing twice', () => {
    const controller = makeController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    const first = queue.enqueue({ operationId: 'dup', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 8 });
    const second = queue.enqueue({ operationId: 'dup', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 8 });
    expect(first).toMatchObject({ status: 'queued' });
    expect(second).toMatchObject({ status: 'coalesced' });
    expect(queue.depth()).toBe(1);
  });

  it('rejects with a bounded error when the queue is full', () => {
    const controller = makeController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 1 });
    expect(queue.enqueue({ operationId: 'q1', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 1 }))
      .toMatchObject({ status: 'queued' });
    expect(queue.enqueue({ operationId: 'q2', workspaceId: 'ws-b', resourceClass: 'goal_process', cost: 1 }))
      .toMatchObject({ status: 'rejected', code: 'QUEUE_FULL' });
  });

  it('cancels queued work immediately without touching running leases', () => {
    const controller = makeController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    queue.enqueue({ operationId: 'q1', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 1 });
    expect(queue.cancel('q1')).toBe(true);
    expect(queue.cancel('missing')).toBe(false);
    expect(queue.depth()).toBe(0);
    expect(controller.snapshot()).toMatchObject({ activeOperations: 0 });
  });
});

describe('heavy job queue scoped backfill (#145 fairness)', () => {
  it('backfills another workspace when the queue head is blocked by its own workspace ceiling', () => {
    // dependency_bootstrap stays outside HEAVY_ADMISSION_CLASSES (#145), so this
    // case is about workspace-scoped denial only, not the one-heavy-at-a-time cap.
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 4,
      sessionCost: 4,
      maxOperations: 4,
    });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    const running = controller.tryAcquire({
      operationId: 'running-a',
      workspaceId: 'ws-a',
      sessionId: 'session-a',
      resourceClass: 'dependency_bootstrap',
      cost: 4,
    });
    expect(running.admitted).toBe(true);

    queue.enqueue({
      operationId: 'head-a',
      workspaceId: 'ws-a',
      sessionId: 'session-a',
      resourceClass: 'dependency_bootstrap',
      cost: 4,
    });
    queue.enqueue({
      operationId: 'backfill-b',
      workspaceId: 'ws-b',
      sessionId: 'session-b',
      resourceClass: 'dependency_bootstrap',
      cost: 4,
    });

    const first = queue.drain();
    expect(first.map((admission) => admission.lease.operationId)).toEqual(['backfill-b']);
    expect(queue.depth()).toBe(1);

    for (const admission of first) controller.release(admission.lease);
    if (running.admitted) controller.release(running.lease);
    const second = queue.drain();
    expect(second.map((admission) => admission.lease.operationId)).toEqual(['head-a']);
    for (const admission of second) controller.release(admission.lease);
  });

  it('keeps draining past a heavy-capacity denial so a light job still runs (#145)', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 8,
    });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    const running = controller.tryAcquire({
      operationId: 'running-verification',
      workspaceId: 'ws-a',
      sessionId: 'session-a',
      resourceClass: 'verification_heavy',
      cost: 8,
    });
    expect(running.admitted).toBe(true);

    queue.enqueue({ operationId: 'queued-index', workspaceId: 'ws-b', sessionId: 'session-b', resourceClass: 'rag_indexing', cost: 8 });
    queue.enqueue({ operationId: 'queued-scan', workspaceId: 'ws-c', sessionId: 'session-c', resourceClass: 'context_scan', cost: 4 });

    // The index job is denied by the heavy slot only, so the light job behind
    // it is backfilled instead of stalling the whole queue.
    expect(queue.drain().map((admission) => admission.lease.operationId)).toEqual(['queued-scan']);
    expect(queue.depth()).toBe(1);
    if (running.admitted) controller.release(running.lease);
  });

  it('stops at a global denial instead of probing every later job', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
    });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    const running = controller.tryAcquire({
      operationId: 'running-a',
      workspaceId: 'ws-a',
      sessionId: 'session-a',
      resourceClass: 'rag_indexing',
      cost: 8,
    });
    expect(running.admitted).toBe(true);
    queue.enqueue({
      operationId: 'queued-b',
      workspaceId: 'ws-b',
      sessionId: 'session-b',
      resourceClass: 'rag_indexing',
      cost: 8,
    });
    queue.enqueue({
      operationId: 'queued-c',
      workspaceId: 'ws-c',
      sessionId: 'session-c',
      resourceClass: 'rag_indexing',
      cost: 8,
    });

    expect(queue.drain()).toEqual([]);
    expect(queue.depth()).toBe(2);
    expect(controller.snapshot().rejected).toBe(1);
    if (running.admitted) controller.release(running.lease);
  });
});

describe('heavy job queue supersede (#145 U4)', () => {
  it('supersedes a stale queued generation when a newer head arrives', async () => {
    const { HeavyJobWaiterQueue } = await import('./heavy-job-queue.js');
    const { ResourceAdmissionController } = await import('./resource-admission.js');
    const controller = new ResourceAdmissionController({ globalCost: 8, workspaceCost: 8, maxOperations: 4 });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    queue.enqueue({ operationId: 'verify-h1', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2 });
    const res = queue.supersede('verify-h1', 'verify-h2', { workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2 });
    expect(res).toMatchObject({ status: 'superseded', retired: 'verify-h1', queued: 'verify-h2' });
    expect(queue.depth()).toBe(1);
    const drained = queue.drain();
    expect(drained.map((a) => a.lease.operationId)).toEqual(['verify-h2']);
  });

  it('supersede of a missing operation queues the replacement', async () => {
    const { HeavyJobWaiterQueue } = await import('./heavy-job-queue.js');
    const { ResourceAdmissionController } = await import('./resource-admission.js');
    const controller = new ResourceAdmissionController({ globalCost: 8, workspaceCost: 8, maxOperations: 4 });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    const res = queue.supersede('missing-h1', 'verify-h2', { workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2 });
    expect(res).toMatchObject({ status: 'queued', queued: 'verify-h2' });
    expect(queue.depth()).toBe(1);
  });
});

describe('heavy job queue durable retirement (#145)', () => {
  it('reports a dropped local row so its owner can retire the parked work', () => {
    const controller = makeController();
    const retired: string[] = [];
    const store: HeavyJobQueueStore = {
      claim: (entry): HeavyJobClaimResult => ({ status: 'queued', operationId: entry.operationId, position: 1, depth: 1 }),
      claimExisting: (entry): HeavyJobReattachResult => ({
        status: 'missing', operationId: entry.operationId, depth: 0,
      }),
      promote: (): number | undefined => 1,
      cancel: (): boolean => true,
      supersede: (): HeavyJobSupersedeStoreResult => ({ status: 'full', operationId: 'unused', depth: 0 }),
      start: (): boolean => false,
      settle: (): boolean => true,
      recover: (): boolean => true,
      depth: (): number => 1,
      listLive: (): readonly HeavyJobLiveEntry[] => [],
    };
    const queue = new HeavyJobWaiterQueue(controller, {
      store,
      onRetired: (operationId): void => { retired.push(operationId); },
    });

    queue.enqueue({ operationId: 'shell:x', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 1 });
    expect(queue.drain()).toEqual([]);

    expect(retired).toEqual(['shell:x']);
    expect(queue.position('shell:x')).toBeUndefined();
    expect(controller.snapshot()).toMatchObject({ activeOperations: 0 });
  });
});

describe('heavy job queue reattach (#145 restart)', () => {
  it('never creates a row for missing work and adopts an existing one', () => {
    const controller = makeController();
    const rows = new Set<string>();
    const store: HeavyJobQueueStore = {
      claim: (entry): HeavyJobClaimResult => {
        rows.add(entry.operationId);
        return { status: 'queued', operationId: entry.operationId, position: 1, depth: rows.size };
      },
      claimExisting: (entry): HeavyJobReattachResult => (rows.has(entry.operationId)
        ? { status: 'queued', operationId: entry.operationId, position: 1, depth: 1 }
        : { status: 'missing', operationId: entry.operationId, depth: 0 }),
      promote: (): number | undefined => 1,
      cancel: (): boolean => true,
      supersede: (): HeavyJobSupersedeStoreResult => ({ status: 'full', operationId: 'unused', depth: 0 }),
      start: (): boolean => true,
      settle: (): boolean => true,
      recover: (): boolean => true,
      depth: (): number => rows.size,
      listLive: (): readonly HeavyJobLiveEntry[] => [],
    };
    const queue = new HeavyJobWaiterQueue(controller, { store });

    expect(queue.reattach({ operationId: 'shell:gone', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 1 }))
      .toMatchObject({ status: 'missing' });
    expect(rows.has('shell:gone')).toBe(false);
    expect(queue.depth()).toBe(0);

    rows.add('shell:live');
    expect(queue.reattach({ operationId: 'shell:live', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 1 }))
      .toMatchObject({ status: 'queued' });
    expect(queue.position('shell:live')).toBe(1);
    const grants = queue.drain();
    expect(grants.map((grant) => grant.lease.operationId)).toEqual(['shell:live']);
    queue.settle('shell:live', 'completed');
    controller.release(grants[0]!.lease);
  });
});

describe('heavy job queue promote (#145 U12)', () => {
  it('promotes a queued blocking operation to the head without disturbing order otherwise', async () => {
    const { HeavyJobWaiterQueue } = await import('./heavy-job-queue.js');
    const { ResourceAdmissionController } = await import('./resource-admission.js');
    const controller = new ResourceAdmissionController({ globalCost: 8, workspaceCost: 8, maxOperations: 4 });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    queue.enqueue({ operationId: 'bg-1', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2 });
    queue.enqueue({ operationId: 'block-x', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2, blocking: true } as never);
    queue.enqueue({ operationId: 'bg-2', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2 });
    const promoted = queue.promote('block-x');
    expect(promoted).toBe(true);
    const drained = queue.drain();
    expect(drained.map((a) => a.lease.operationId)).toEqual(['block-x', 'bg-1', 'bg-2']);
  });

  it('returns false for unknown or already-running operations', async () => {
    const { HeavyJobWaiterQueue } = await import('./heavy-job-queue.js');
    const { ResourceAdmissionController } = await import('./resource-admission.js');
    const controller = new ResourceAdmissionController({ globalCost: 8, workspaceCost: 8, maxOperations: 4 });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    expect(queue.promote('missing')).toBe(false);
    queue.enqueue({ operationId: 'only', workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2 });
    expect(queue.promote('only')).toBe(true);
    expect(queue.promote('only')).toBe(true);
  });
});

describe('heavy job queue fairness wiring (#145 step 2)', () => {
  function heavyController(): ResourceAdmissionController {
    return new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 8,
    });
  }

  function drainAndRelease(
    controller: ResourceAdmissionController,
    queue: HeavyJobWaiterQueue,
  ): string[] {
    const grants = queue.drain();
    for (const grant of grants) controller.release(grant.lease);
    return grants.map((grant) => grant.lease.operationId);
  }

  it('alternates workspaces across separate drains on one heavy slot', () => {
    const controller = heavyController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    const jobs = [
      ['a1', 'ws-a'],
      ['a2', 'ws-a'],
      ['b1', 'ws-b'],
      ['b2', 'ws-b'],
    ] as const;
    for (const [operationId, workspaceId] of jobs) {
      // Declared heavy shell runs are blocking (#145 U12), so this is the
      // production shape: rotation has to apply inside the blocking tier.
      queue.enqueue({ operationId, workspaceId, resourceClass: 'verification_heavy', cost: 8, blocking: true });
    }

    // One heavy slot: each drain admits one job, and the next drain must give
    // the other workspace its turn instead of draining ws-a's burst first.
    expect([
      drainAndRelease(controller, queue),
      drainAndRelease(controller, queue),
      drainAndRelease(controller, queue),
      drainAndRelease(controller, queue),
    ]).toEqual([['a1'], ['b1'], ['a2'], ['b2']]);
  });

  it('records a workspace as served only when its durable row starts', () => {
    let nowMs = Date.parse('2026-10-30T12:00:00.000Z');
    const controller = new ResourceAdmissionController({
      globalCost: 16,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 8,
    });
    const started: string[] = [];
    let position = 0;
    const store: HeavyJobQueueStore = {
      claim: (entry): HeavyJobClaimResult => {
        position += 1;
        return { status: 'queued', operationId: entry.operationId, position, depth: position };
      },
      claimExisting: (entry): HeavyJobReattachResult => ({
        status: 'missing', operationId: entry.operationId, depth: 0,
      }),
      promote: (): number | undefined => 1,
      cancel: (): boolean => true,
      supersede: (): HeavyJobSupersedeStoreResult => ({ status: 'full', operationId: 'unused', depth: 0 }),
      start: (operationId): boolean => {
        if (operationId === 'a1') return false;
        started.push(operationId);
        return true;
      },
      settle: (): boolean => true,
      recover: (): boolean => true,
      depth: (): number => position,
      listLive: (): readonly HeavyJobLiveEntry[] => [],
    };
    const queue = new HeavyJobWaiterQueue(controller, {
      maxQueued: 8,
      store,
      now: (): Date => new Date(nowMs),
    });

    // b1 is admitted; b2 waits behind b's workspace ceiling so the ws-b
    // fairness history stays alive while ws-a is still never served.
    queue.enqueue({
      operationId: 'b1', workspaceId: 'ws-b', sessionId: 'session-b',
      resourceClass: 'verification_heavy', cost: 8,
    });
    queue.enqueue({
      operationId: 'b2', workspaceId: 'ws-b', sessionId: 'session-b',
      resourceClass: 'verification_heavy', cost: 8,
    });
    expect(drainAndRelease(controller, queue)).toEqual(['b1']);

    // At t+10 the never-served ws-a is tried first. Its durable row refuses to
    // start, so it must not count as served; b2 is denied by b's ceiling.
    nowMs += 10 * 60_000;
    const blocker = controller.tryAcquire({
      operationId: 'running-b',
      workspaceId: 'ws-b',
      sessionId: 'session-b',
      resourceClass: 'dependency_bootstrap',
      cost: 8,
    });
    expect(blocker.admitted).toBe(true);
    queue.enqueue({
      operationId: 'a1', workspaceId: 'ws-a', sessionId: 'session-a',
      resourceClass: 'verification_heavy', cost: 8,
    });
    expect(queue.drain()).toEqual([]);

    // At t+20 ws-a still has no service history, so a2 must outrank the ws-b
    // row that was served at t0. The heavy slot keeps the drain to one job.
    nowMs += 10 * 60_000;
    if (blocker.admitted) controller.release(blocker.lease);
    queue.enqueue({
      operationId: 'a2', workspaceId: 'ws-a', sessionId: 'session-a',
      resourceClass: 'verification_heavy', cost: 8,
    });
    expect(drainAndRelease(controller, queue)).toEqual(['a2']);
    expect(started).toEqual(['b1', 'a2']);
  });

  it('tries aged work before rotation but never before blocking work', () => {
    const nowMs = Date.parse('2026-10-30T12:00:00.000Z');
    const controller = heavyController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8, now: (): Date => new Date(nowMs) });
    const longAgo = new Date(nowMs - 40 * 60_000).toISOString();
    const recent = new Date(nowMs - 5 * 60_000).toISOString();

    queue.enqueue({
      operationId: 'block-old', workspaceId: 'ws-a', resourceClass: 'verification_heavy',
      cost: 8, blocking: true, requestedAt: longAgo,
    });
    queue.enqueue({
      operationId: 'aged-b', workspaceId: 'ws-b', resourceClass: 'verification_heavy',
      cost: 8, requestedAt: longAgo,
    });
    queue.enqueue({
      operationId: 'fresh-c', workspaceId: 'ws-c', resourceClass: 'verification_heavy',
      cost: 8, requestedAt: recent,
    });

    expect([
      drainAndRelease(controller, queue),
      drainAndRelease(controller, queue),
      drainAndRelease(controller, queue),
    ]).toEqual([['block-old'], ['aged-b'], ['fresh-c']]);
  });

  it('keeps blocking work ahead of aged background work', () => {
    const nowMs = Date.parse('2026-10-30T12:00:00.000Z');
    const controller = heavyController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8, now: (): Date => new Date(nowMs) });

    queue.enqueue({
      operationId: 'bg-old', workspaceId: 'ws-a', sessionId: 'session-a',
      resourceClass: 'verification_heavy', cost: 8,
      requestedAt: new Date(nowMs - 40 * 60_000).toISOString(),
    });
    queue.enqueue({
      operationId: 'gate', workspaceId: 'ws-b', sessionId: 'session-b',
      resourceClass: 'verification_heavy', cost: 8, blocking: true,
      requestedAt: new Date(nowMs - 60_000).toISOString(),
    });

    expect(drainAndRelease(controller, queue)).toEqual(['gate']);
  });

  it('keeps FIFO for a single workspace', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
    });
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    for (const operationId of ['first', 'second', 'third']) {
      queue.enqueue({ operationId, workspaceId: 'ws-a', resourceClass: 'goal_process', cost: 2 });
    }

    expect(drainAndRelease(controller, queue)).toEqual(['first', 'second', 'third']);
  });

  it('projects the same order drain will try without rewriting positions', () => {
    const controller = heavyController();
    const queue = new HeavyJobWaiterQueue(controller, { maxQueued: 8 });
    for (const [operationId, workspaceId] of [['a1', 'ws-a'], ['a2', 'ws-a'], ['b1', 'ws-b']] as const) {
      queue.enqueue({ operationId, workspaceId, resourceClass: 'verification_heavy', cost: 8, blocking: true });
    }

    const snapshot = queue.fairnessSnapshot();
    expect(snapshot).toEqual({
      agingMs: DEFAULT_HEAVY_JOB_AGING_MS,
      entries: [
        { operationId: 'a1', effectiveRank: 0, aged: false },
        { operationId: 'b1', effectiveRank: 1, aged: false },
        { operationId: 'a2', effectiveRank: 2, aged: false },
      ],
    });
    // The projection is an overlay: the durable/local position is unchanged.
    expect(queue.position('a1')).toBe(1);
    expect(queue.position('a2')).toBe(2);

    const drained: string[] = [];
    while (queue.depth() > 0) drained.push(...drainAndRelease(controller, queue));
    expect(drained).toEqual(snapshot.entries.map((entry) => entry.operationId));
  });

  it('marks aged background work while keeping blocking work ahead of it', () => {
    let nowMs = Date.parse('2026-10-30T12:00:00.000Z');
    const controller = heavyController();
    const queue = new HeavyJobWaiterQueue(controller, {
      maxQueued: 8,
      now: (): Date => new Date(nowMs),
    });
    queue.enqueue({ operationId: 'background', workspaceId: 'ws-a', resourceClass: 'rag_indexing', cost: 4 });
    queue.enqueue({ operationId: 'gate', workspaceId: 'ws-b', resourceClass: 'verification_heavy', cost: 8, blocking: true });
    nowMs += DEFAULT_HEAVY_JOB_AGING_MS;

    expect(queue.fairnessSnapshot().entries).toEqual([
      { operationId: 'gate', effectiveRank: 0, aged: false },
      { operationId: 'background', effectiveRank: 1, aged: true },
    ]);
  });

  it('rejects a non-positive aging window', () => {
    const controller = heavyController();
    expect(() => new HeavyJobWaiterQueue(controller, { agingMs: 0 })).toThrow(RangeError);
  });
});
