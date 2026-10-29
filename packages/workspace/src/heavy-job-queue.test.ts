import { describe, expect, it } from 'vitest';
import {
  ResourceAdmissionController,
  tryAdmitGoalProcess,
} from './resource-admission.js';
import { HeavyJobWaiterQueue } from './heavy-job-queue.js';

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

    if (first.admitted) controller.release(first.lease);
    const admitted = queue.drain();
    expect(admitted.map((a) => a.lease.operationId)).toEqual(['heavy-b']);
    expect(queue.depth()).toBe(1);
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
