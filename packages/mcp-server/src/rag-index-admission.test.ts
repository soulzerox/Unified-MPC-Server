import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@unified-mpc/domain';
import { ResourceAdmissionController, type ResourceAdmissionLease } from '@unified-mpc/workspace';
import { RagIndexAdmissionTracker } from './rag-index-admission.js';

function controller(): ResourceAdmissionController {
  return new ResourceAdmissionController({
    globalCost: 8,
    workspaceCost: 8,
    sessionCost: 8,
    maxOperations: 1,
    resourceClassCost: { rag_indexing: 8 },
  });
}

function lease(admission: ResourceAdmissionController): ResourceAdmissionLease {
  const acquired = admission.tryAcquire({
    operationId: 'rag-background',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    resourceClass: 'rag_indexing',
    cost: 8,
  });
  if (!acquired.admitted) throw new Error('expected admission');
  return acquired.lease;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RagIndexAdmissionTracker', () => {
  it('holds a transferred lease until the durable local job becomes terminal', async () => {
    vi.useFakeTimers();
    const admission = controller();
    let polls = 0;
    const tracker = new RagIndexAdmissionTracker(admission, { pollIntervalMs: 10 });

    expect(tracker.bind({
      workspaceId: 'workspace-1',
      jobId: 'idx-1',
      lease: lease(admission),
      readStatus: async () => ok({ status: ++polls < 2 ? 'running' : 'completed' }),
      initialStatus: { status: 'running' },
    })).toBe(true);

    expect(admission.snapshot()).toMatchObject({ activeCost: 8, activeOperations: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(admission.snapshot()).toMatchObject({ activeCost: 8, activeOperations: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(admission.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
  });

  it('releases immediately when another request observes cancellation terminal state', () => {
    const admission = controller();
    const tracker = new RagIndexAdmissionTracker(admission, { pollIntervalMs: 60_000 });
    expect(tracker.bind({
      workspaceId: 'workspace-1',
      jobId: 'idx-2',
      lease: lease(admission),
      readStatus: async () => ok({ status: 'running' }),
      initialStatus: { status: 'running' },
    })).toBe(true);

    expect(tracker.reconcile('workspace-1', 'idx-2', { status: 'cancelled' })).toBe(true);
    expect(admission.snapshot()).toMatchObject({ activeCost: 0, activeOperations: 0 });
  });

  it('fails closed on status-read errors instead of releasing active capacity', async () => {
    vi.useFakeTimers();
    const admission = controller();
    const tracker = new RagIndexAdmissionTracker(admission, { pollIntervalMs: 10 });
    expect(tracker.bind({
      workspaceId: 'workspace-1',
      jobId: 'idx-3',
      lease: lease(admission),
      readStatus: async () => { throw new Error('temporary status failure'); },
    })).toBe(true);

    await vi.advanceTimersByTimeAsync(30);
    expect(admission.snapshot()).toMatchObject({ activeCost: 8, activeOperations: 1 });
  });
});
