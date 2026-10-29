import { describe, expect, it } from 'vitest';
import {
  ResourceAdmissionController,
  type HeavyJobClaimResult,
  type HeavyJobLiveEntry,
  type HeavyJobQueueEntry,
  type HeavyJobQueueStore,
  type HeavyJobRecoveryAction,
  type HeavyJobSupersedeStoreResult,
} from '@unified-mpc/workspace';
import { PRE_EDIT_DELTA_JOB_KIND, PreEditDemandRuntime, preEditOperationId } from './pre-edit-demand.js';

describe('PreEditDemandRuntime bounded wait + supersedence (#346 Slice B)', () => {
  interface RuntimeHarness {
    runtime: PreEditDemandRuntime;
    readonly executedStates: string[];
    readonly settleAll: () => void;
  }

  function createRuntimeHarness(options: { cost: number; queueLimit?: number } = { cost: 8 }): RuntimeHarness {
    const controller = new ResourceAdmissionController({
      globalCost: options.cost,
      workspaceCost: options.cost,
      sessionCost: options.cost,
      maxOperations: 4,
      resourceClassCost: { rag_indexing: options.cost },
    });
    const executedStates: string[] = [];
    const resolvers: Array<(value: unknown) => void> = [];
    const runtime = new PreEditDemandRuntime({
      controller,
      cost: options.cost,
      ...(options.queueLimit === undefined ? {} : { queueLimit: options.queueLimit }),
      executor: (job): Promise<unknown> => {
        executedStates.push(job.evidenceState);
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    });
    return {
      runtime,
      executedStates,
      settleAll: (): void => {
        for (const resolve of resolvers.splice(0)) resolve({ ok: true });
      },
    };
  }

  it('resolves waitFor when the target delta settles, and reports unknown ops as not-waited', async () => {
    const harness = createRuntimeHarness({ cost: 4 });
    const submitted = harness.runtime.submit({
      workspaceId: 'workspace-1',
      filePath: 'src/target.ts',
      evidenceState: 'semantic_missing',
      demandable: true,
    });
    expect(submitted?.queueState).toBe('admitted');
    expect(harness.executedStates).toEqual(['semantic_missing']);

    const wait = harness.runtime.waitFor(submitted!.operationId, { timeoutMs: 1000 });
    harness.settleAll();
    await expect(wait).resolves.toMatchObject({ waited: true, timedOut: false, aborted: false });

    // A settled (or never-seen) operation is not pending anymore: no wait.
    await expect(harness.runtime.waitFor(submitted!.operationId, { timeoutMs: 50 }))
      .resolves.toMatchObject({ waited: false, timedOut: false, aborted: false });
  });

  it('times out bounded when the delta never settles', async () => {
    const harness = createRuntimeHarness({ cost: 4 });
    const submitted = harness.runtime.submit({
      workspaceId: 'workspace-1',
      filePath: 'src/hung.ts',
      evidenceState: 'semantic_missing',
      demandable: true,
    });
    const wait = harness.runtime.waitFor(submitted!.operationId, { timeoutMs: 25 });
    await expect(wait).resolves.toMatchObject({ waited: true, timedOut: true, aborted: false });
    harness.settleAll();
  });

  it('supersedes a queued-not-started same-path requirement when a newer one arrives (D4)', async () => {
    const harness = createRuntimeHarness({ cost: 1, queueLimit: 4 });
    const first = harness.runtime.submit({
      workspaceId: 'workspace-1',
      filePath: 'src/live.ts',
      evidenceState: 'semantic_missing',
      demandable: true,
    });
    expect(first?.queueState).toBe('admitted'); // running: holds the only cost slot

    const second = harness.runtime.submit({
      workspaceId: 'workspace-1',
      filePath: 'src/live.ts',
      evidenceState: 'vector_stale',
      demandable: true,
    });
    expect(second?.queueState).toBe('queued'); // queued-not-started under pressure

    const secondWait = harness.runtime.waitFor(second!.operationId, { timeoutMs: 2000 });
    const third = harness.runtime.submit({
      workspaceId: 'workspace-1',
      filePath: 'src/live.ts',
      evidenceState: 'lexical_stale',
      demandable: true,
    });
    // The newer requirement replaces the older queued generation in place; the
    // single cost slot is still held by the running job, so it stays queued.
    expect(third?.queueState).toBe('queued');
    expect(harness.executedStates).toEqual(['semantic_missing']);
    // The retired generation's waiter is released promptly, not left to timeout.
    await expect(secondWait).resolves.toMatchObject({ waited: true, timedOut: false, aborted: false });

    harness.settleAll();
    await new Promise((resolve) => setImmediate(resolve));
    // Exactly the running generation and the successor ran; the retired middle
    // generation never consumed an execution slot.
    expect([...harness.executedStates].sort()).toEqual(['lexical_stale', 'semantic_missing']);
    harness.settleAll();
  });
});

/**
 * Scripted durable authority (#145 U5): the runtime must treat the store's
 * decision as final instead of assuming it always owns the work.
 */
class RecordingHeavyJobStore implements HeavyJobQueueStore {
  public readonly claims: HeavyJobQueueEntry[] = [];
  public readonly promoted: string[] = [];
  public readonly started: string[] = [];
  public readonly settled: Array<{ operationId: string; outcome: string; detail?: string }> = [];
  public readonly superseded: Array<{ stale: string; replacement: string }> = [];
  public nextClaim: HeavyJobClaimResult = { status: 'queued', operationId: 'unset', position: 1, depth: 1 };
  public nextSupersede: HeavyJobSupersedeStoreResult = { status: 'queued', operationId: 'unset', position: 1, depth: 1 };
  public startResult = true;
  public promoteResult: number | undefined = 0;
  public failClaim = false;
  public failSettle = false;

  public claim(entry: HeavyJobQueueEntry): HeavyJobClaimResult {
    if (this.failClaim) throw new Error('database is locked');
    this.claims.push(entry);
    return this.nextClaim;
  }

  public promote(operationId: string): number | undefined {
    this.promoted.push(operationId);
    return this.promoteResult;
  }

  public cancel(): boolean {
    return true;
  }

  public supersede(staleOperationId: string, entry: HeavyJobQueueEntry): HeavyJobSupersedeStoreResult {
    this.superseded.push({ stale: staleOperationId, replacement: entry.operationId });
    return this.nextSupersede;
  }

  public start(operationId: string): boolean {
    this.started.push(operationId);
    return this.startResult;
  }

  public settle(
    operationId: string,
    outcome: 'completed' | 'failed',
    _finishedAt: string,
    detail?: string,
  ): boolean {
    if (this.failSettle) throw new Error('database is locked');
    this.settled.push({ operationId, outcome, ...(detail === undefined ? {} : { detail }) });
    return true;
  }

  public recover(_operationId: string, _action: HeavyJobRecoveryAction): boolean {
    return false;
  }

  public depth(): number {
    return this.nextClaim.depth;
  }

  public listLive(): readonly HeavyJobLiveEntry[] {
    return [];
  }
}

describe('PreEditDemandRuntime durable queue authority (#145 U5)', () => {
  function createHarness(options: {
    store: RecordingHeavyJobStore;
    cost?: number;
    globalCost?: number;
    executor?: (job: { filePath: string }) => Promise<unknown> | unknown;
  }): { runtime: PreEditDemandRuntime; readonly executed: string[] } {
    const cost = options.cost ?? 8;
    const controller = new ResourceAdmissionController({
      globalCost: options.globalCost ?? cost,
      workspaceCost: options.globalCost ?? cost,
      sessionCost: options.globalCost ?? cost,
      maxOperations: 4,
      resourceClassCost: { rag_indexing: cost },
    });
    const executed: string[] = [];
    const runtime = new PreEditDemandRuntime({
      controller,
      cost,
      queueLimit: 4,
      store: options.store,
      executor: options.executor ?? ((job): Promise<unknown> => {
        executed.push(job.filePath);
        return Promise.resolve({ ok: true });
      }),
    });
    return { runtime, executed };
  }

  function submit(
    runtime: PreEditDemandRuntime,
    filePath = 'src/target.ts',
    evidenceState = 'semantic_missing',
  ): ReturnType<PreEditDemandRuntime['submit']> {
    return runtime.submit({ workspaceId: 'workspace-1', filePath, evidenceState, demandable: true });
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('claims the durable entry with the pre-edit job identity and settles it completed', async () => {
    const store = new RecordingHeavyJobStore();
    const harness = createHarness({ store });
    const submitted = submit(harness.runtime);
    expect(submitted?.queueState).toBe('admitted');

    await flush();

    const operationId = preEditOperationId('workspace-1', 'src/target.ts', 'semantic_missing');
    expect(submitted?.operationId).toBe(operationId);
    expect(store.claims).toEqual([expect.objectContaining({
      operationId,
      workspaceId: 'workspace-1',
      jobKind: PRE_EDIT_DELTA_JOB_KIND,
      resourceClass: 'rag_indexing',
      blocking: true,
      cost: 8,
    })]);
    expect(store.started).toEqual([operationId]);
    expect(store.settled).toEqual([{ operationId, outcome: 'completed' }]);
    expect(harness.executed).toEqual(['src/target.ts']);
  });

  it('coalesces a live foreign owner without starting or settling its work', async () => {
    const store = new RecordingHeavyJobStore();
    store.nextClaim = { status: 'coalesced', operationId: 'shared', depth: 1 };
    const harness = createHarness({ store });

    expect(submit(harness.runtime)?.queueState).toBe('coalesced');
    await flush();

    expect(harness.executed).toEqual([]);
    expect(store.started).toEqual([]);
    expect(store.settled).toEqual([]);
    expect(store.promoted).toEqual([]);
  });

  it('coalesces a still-running generation instead of executing a duplicate', async () => {
    const store = new RecordingHeavyJobStore();
    store.nextClaim = { status: 'running', operationId: 'shared', depth: 0 };
    const harness = createHarness({ store });

    expect(submit(harness.runtime)?.queueState).toBe('coalesced');
    await flush();

    expect(harness.executed).toEqual([]);
    expect(store.started).toEqual([]);
  });

  it('fails closed with a rejected echo when the durable queue is full', async () => {
    const store = new RecordingHeavyJobStore();
    store.nextClaim = { status: 'full', operationId: 'overflow', depth: 4 };
    const harness = createHarness({ store });

    expect(submit(harness.runtime)?.queueState).toBe('rejected');
    await flush();

    expect(harness.executed).toEqual([]);
    expect(store.settled).toEqual([]);
  });

  it('rejects instead of tracking work whose durable slot vanished before promotion', async () => {
    const store = new RecordingHeavyJobStore();
    store.promoteResult = undefined;
    const harness = createHarness({ store });

    const submitted = submit(harness.runtime);
    expect(submitted?.queueState).toBe('rejected');
    expect(harness.runtime.pendingState(submitted!.operationId)).toBeUndefined();
    await flush();

    expect(harness.executed).toEqual([]);
    expect(store.started).toEqual([]);
  });

  it('keeps the refusal fail-closed when the durable store is unavailable', async () => {
    const store = new RecordingHeavyJobStore();
    store.failClaim = true;
    const harness = createHarness({ store });

    expect(submit(harness.runtime)).toMatchObject({ queueState: 'rejected', depth: 0 });
    await flush();

    expect(harness.executed).toEqual([]);
    expect(store.started).toEqual([]);
  });

  it('releases the admission lease even when recording the durable outcome fails', async () => {
    const store = new RecordingHeavyJobStore();
    store.failSettle = true;
    const harness = createHarness({
      store,
      executor: (): Promise<unknown> => Promise.reject(new Error('indexer crashed')),
    });

    submit(harness.runtime);
    await flush();

    // The failing settle must not strand the single admission slot.
    expect(submit(harness.runtime, 'src/next.ts')?.queueState).toBe('admitted');
    expect(store.claims.map((claim) => claim.operationId)).toContain(
      preEditOperationId('workspace-1', 'src/next.ts', 'semantic_missing'),
    );
  });

  it('records the truthfully failed outcome with a bounded reason when the executor rejects', async () => {
    const store = new RecordingHeavyJobStore();
    const harness = createHarness({
      store,
      executor: (): Promise<unknown> => Promise.reject(new Error('indexer crashed')),
    });

    submit(harness.runtime);
    await flush();

    expect(store.settled).toEqual([{
      operationId: preEditOperationId('workspace-1', 'src/target.ts', 'semantic_missing'),
      outcome: 'failed',
      detail: 'indexer crashed',
    }]);
  });

  it('records a failed outcome instead of leaving a claim running when no executor exists', async () => {
    const store = new RecordingHeavyJobStore();
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { rag_indexing: 8 },
    });
    const runtime = new PreEditDemandRuntime({ controller, cost: 8, queueLimit: 4, store });

    submit(runtime);
    await flush();

    expect(store.started).toHaveLength(1);
    expect(store.settled).toEqual([{
      operationId: preEditOperationId('workspace-1', 'src/target.ts', 'semantic_missing'),
      outcome: 'failed',
      detail: 'no executor configured',
    }]);
  });

  it('starts a queued delta when another heavy lease releases, without a new submit (#145 wake-on-release)', () => {
    const controller = new ResourceAdmissionController({
      globalCost: 8,
      workspaceCost: 8,
      sessionCost: 8,
      maxOperations: 4,
      resourceClassCost: { rag_indexing: 8 },
    });
    // A heavy verification holds the only slot, exactly like a local CI run.
    const foreign = controller.tryAcquire({
      operationId: 'verification-a',
      workspaceId: 'workspace-1',
      sessionId: 'system',
      resourceClass: 'verification_heavy',
      cost: 8,
    });
    if (!foreign.admitted) throw new Error('expected the foreign lease to be admitted');
    const executed: string[] = [];
    const runtime = new PreEditDemandRuntime({
      controller,
      cost: 8,
      queueLimit: 4,
      executor: (job): Promise<unknown> => {
        executed.push(job.filePath);
        return Promise.resolve({ ok: true });
      },
    });

    const submitted = submit(runtime);
    expect(submitted?.queueState).toBe('queued');
    expect(executed).toEqual([]);

    // No further submit: freeing capacity must wake the waiter queue itself,
    // otherwise a delta queued behind a finished verification waits forever.
    expect(controller.release(foreign.lease)).toBe(true);
    expect(executed).toEqual(['src/target.ts']);
  });

  it('supersedes the queued durable generation in place', async () => {
    const store = new RecordingHeavyJobStore();
    // The single admission slot cannot fit the job, so it stays queued.
    const harness = createHarness({ store, cost: 8, globalCost: 1 });

    const first = submit(harness.runtime, 'src/live.ts', 'semantic_missing');
    expect(first?.queueState).toBe('queued');
    const second = submit(harness.runtime, 'src/live.ts', 'vector_stale');
    expect(second?.queueState).toBe('queued');

    expect(store.superseded).toEqual([{
      stale: first!.operationId,
      replacement: second!.operationId,
    }]);
  });
});
