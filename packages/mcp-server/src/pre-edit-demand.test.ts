import { describe, expect, it } from 'vitest';
import { ResourceAdmissionController } from '@unified-mpc/workspace';
import { PreEditDemandRuntime } from './pre-edit-demand.js';

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
