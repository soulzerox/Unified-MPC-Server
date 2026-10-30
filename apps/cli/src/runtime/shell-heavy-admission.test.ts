import { describe, expect, it } from 'vitest';
import { DEFAULT_HEAVY_JOB_AGING_MS, ResourceAdmissionController } from '@unified-mpc/workspace';
import type {
  HeavyJobClaimResult,
  HeavyJobLiveEntry,
  HeavyJobQueueStore,
  HeavyJobReattachResult,
  HeavyJobSupersedeStoreResult,
} from '@unified-mpc/workspace';
import type { ShellHeavyAdmissionLease } from '@unified-mpc/capabilities';
import {
  createShellHeavyAdmissionPort,
  resolveShellHeavyAdmissionPerWorkspaceLimit,
  SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV,
  SHELL_HEAVY_ADMISSION_QUEUE_LIMIT,
} from './shell-heavy-admission.js';

function controller(): ResourceAdmissionController {
  return new ResourceAdmissionController({ globalCost: 16, workspaceCost: 8, sessionCost: 8, maxOperations: 8 });
}

describe('shell heavy admission port (#145)', () => {
  it('queues a declared run and admits it only on pump', () => {
    const admission = controller();
    const port = createShellHeavyAdmissionPort(() => admission);

    const enqueued = port.enqueue({
      operationId: 'shell:a', workspaceId: 'workspace-a', sessionId: 'session-a', resourceClass: 'verification_heavy',
    });

    expect(enqueued).toMatchObject({ status: 'queued', position: 1, cost: 8 });
    expect(admission.snapshot().activeHeavyOperations).toBe(0);

    const grants = port.pump();
    expect(grants.map((grant) => grant.operationId)).toEqual(['shell:a']);
    expect(admission.snapshot().activeHeavyOperations).toBe(1);

    grants[0]?.lease.settle('completed');
    grants[0]?.lease.settle('failed');
    expect(admission.snapshot().activeHeavyOperations).toBe(0);
  });

  it('keeps a second run queued until the first settles, then wakes the listener', () => {
    const admission = controller();
    const port = createShellHeavyAdmissionPort(() => admission);
    port.enqueue({ operationId: 'shell:a', sessionId: 'session-a', resourceClass: 'verification_heavy' });
    const first = port.pump()[0];
    expect(first).toBeDefined();

    const woke: string[] = [];
    let secondLease: ShellHeavyAdmissionLease | undefined;
    port.onAdmitted((grant) => {
      woke.push(grant.operationId);
      secondLease = grant.lease;
    });

    const second = port.enqueue({ operationId: 'shell:b', sessionId: 'session-b', resourceClass: 'verification_heavy' });
    // Positions are monotonic ordering tokens, not a contiguous index: the
    // first job already consumed position 1.
    expect(second).toMatchObject({ status: 'queued', position: 2 });
    expect(port.pump()).toEqual([]);
    expect(port.position('shell:b')).toBe(2);

    first?.lease.settle('completed');

    expect(woke).toEqual(['shell:b']);
    expect(admission.snapshot().activeHeavyOperations).toBe(1);
    secondLease?.settle('completed');
    expect(admission.snapshot().activeHeavyOperations).toBe(0);
  });

  it('cancels a queued run without taking capacity', () => {
    const admission = controller();
    const port = createShellHeavyAdmissionPort(() => admission);
    port.enqueue({ operationId: 'shell:c', resourceClass: 'verification_heavy' });

    expect(port.cancel('shell:c')).toBe(true);
    expect(port.position('shell:c')).toBeUndefined();
    expect(port.pump()).toEqual([]);
    expect(admission.snapshot().activeHeavyOperations).toBe(0);
  });

  it('does not wake the listener for a run cancelled before the release', () => {
    const admission = controller();
    const port = createShellHeavyAdmissionPort(() => admission);
    port.enqueue({ operationId: 'shell:a', sessionId: 'session-a', resourceClass: 'verification_heavy' });
    const first = port.pump()[0];
    port.enqueue({ operationId: 'shell:b', sessionId: 'session-b', resourceClass: 'verification_heavy' });
    expect(port.cancel('shell:b')).toBe(true);

    const woke: string[] = [];
    port.onAdmitted((grant) => woke.push(grant.operationId));
    first?.lease.settle('completed');

    expect(woke).toEqual([]);
    expect(admission.snapshot().activeHeavyOperations).toBe(0);
  });

  it('treats an adopted durable row as queued instead of a foreign duplicate', () => {
    const admission = controller();
    let claims = 0;
    const store: HeavyJobQueueStore = {
      claim: (entry): HeavyJobClaimResult => (claims++ === 0
        ? { status: 'queued', operationId: entry.operationId, position: 3, depth: 1 }
        : { status: 'coalesced', operationId: entry.operationId, depth: 1 }),
      claimExisting: (entry): HeavyJobReattachResult => ({
        status: 'missing', operationId: entry.operationId, depth: 0,
      }),
      promote: (): number | undefined => 3,
      cancel: (): boolean => true,
      supersede: (): HeavyJobSupersedeStoreResult => ({ status: 'full', operationId: 'unused', depth: 0 }),
      start: (): boolean => true,
      settle: (): boolean => true,
      recover: (): boolean => true,
      depth: (): number => 1,
      listLive: (): readonly HeavyJobLiveEntry[] => [],
    };
    const port = createShellHeavyAdmissionPort(() => admission, () => store);

    expect(port.enqueue({ operationId: 'shell:reattached', resourceClass: 'verification_heavy' }))
      .toMatchObject({ status: 'queued', position: 3 });
    // The second claim coalesces, but this queue already owns the local row:
    // that is an adopted row for restart re-attachment, not a foreign duplicate.
    expect(port.enqueue({ operationId: 'shell:reattached', resourceClass: 'verification_heavy' }))
      .toMatchObject({ status: 'queued', position: 3 });

    const grant = port.pump()[0];
    expect(grant?.operationId).toBe('shell:reattached');
    grant?.lease.settle('completed');
    expect(admission.snapshot().activeHeavyOperations).toBe(0);
  });

  it('re-attaches only an existing live row and never creates work', () => {
    const admission = controller();
    const live = new Set(['shell:live']);
    const store: HeavyJobQueueStore = {
      claim: (): HeavyJobClaimResult => ({ status: 'full', operationId: 'unused', depth: 0 }),
      claimExisting: (entry): HeavyJobReattachResult => (live.has(entry.operationId)
        ? { status: 'queued', operationId: entry.operationId, position: 3, depth: 1 }
        : { status: 'missing', operationId: entry.operationId, depth: 0 }),
      promote: (): number | undefined => 3,
      cancel: (): boolean => true,
      supersede: (): HeavyJobSupersedeStoreResult => ({ status: 'full', operationId: 'unused', depth: 0 }),
      start: (): boolean => true,
      settle: (): boolean => true,
      recover: (): boolean => true,
      depth: (): number => live.size,
      listLive: (): readonly HeavyJobLiveEntry[] => [],
    };
    const port = createShellHeavyAdmissionPort(() => admission, () => store);

    expect(port.reattach({ operationId: 'shell:live', resourceClass: 'verification_heavy' }))
      .toMatchObject({ status: 'queued', position: 3 });
    expect(port.reattach({ operationId: 'shell:gone', resourceClass: 'verification_heavy' }))
      .toMatchObject({ status: 'missing' });
    expect(live.has('shell:gone')).toBe(false);
    expect(admission.snapshot().activeHeavyOperations).toBe(0);
  });

  it('rejects over the bounded queue', () => {
    const admission = controller();
    const port = createShellHeavyAdmissionPort(() => admission);
    for (let index = 0; index < SHELL_HEAVY_ADMISSION_QUEUE_LIMIT; index += 1) {
      expect(port.enqueue({ operationId: `shell:q${index}`, resourceClass: 'verification_heavy' }))
        .toMatchObject({ status: 'queued' });
    }
    expect(port.enqueue({ operationId: 'shell:overflow', resourceClass: 'verification_heavy' }))
      .toMatchObject({ status: 'full' });
  });

  it('projects an empty local queue before any shell work is queued', () => {
    const port = createShellHeavyAdmissionPort(() => controller());

    expect(port.fairnessSnapshot()).toEqual({
      agingMs: DEFAULT_HEAVY_JOB_AGING_MS,
      entries: [],
    });
  });

  it('projects the fair order of queued shell runs', () => {
    const port = createShellHeavyAdmissionPort(() => controller());
    port.enqueue({ operationId: 'shell:a', workspaceId: 'workspace-a', resourceClass: 'verification_heavy' });
    port.enqueue({ operationId: 'shell:b', workspaceId: 'workspace-b', resourceClass: 'verification_heavy' });

    expect(port.fairnessSnapshot()).toEqual({
      agingMs: DEFAULT_HEAVY_JOB_AGING_MS,
      entries: [
        { operationId: 'shell:a', effectiveRank: 0, aged: false },
        { operationId: 'shell:b', effectiveRank: 1, aged: false },
      ],
    });
  });
});

describe('per-workspace queue bound (#543)', () => {
  it('defaults to the global queue bound', () => {
    expect(resolveShellHeavyAdmissionPerWorkspaceLimit({})).toBe(SHELL_HEAVY_ADMISSION_QUEUE_LIMIT);
    expect(resolveShellHeavyAdmissionPerWorkspaceLimit({
      [SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV]: '   ',
    })).toBe(SHELL_HEAVY_ADMISSION_QUEUE_LIMIT);
  });

  it('accepts a narrower bound', () => {
    expect(resolveShellHeavyAdmissionPerWorkspaceLimit({
      [SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV]: '2',
    })).toBe(2);
  });

  it('fails closed on a malformed or oversized bound', () => {
    for (const raw of ['0', '-1', 'x', '1.5', '17']) {
      expect(() => resolveShellHeavyAdmissionPerWorkspaceLimit({
        [SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV]: raw,
      })).toThrow(RangeError);
    }
  });

  it('keeps the port factory independent of the ambient environment', () => {
    const previous = process.env[SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV];
    process.env[SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV] = '1';
    try {
      const admission = controller();
      const port = createShellHeavyAdmissionPort(() => admission);
      // The runtime passes the resolved value; the factory keeps the global
      // bound, so a developer's exported variable cannot rewrite these tests.
      expect(port.enqueue({
        operationId: 'shell:a', workspaceId: 'workspace-a', resourceClass: 'verification_heavy',
      })).toMatchObject({ status: 'queued' });
      expect(port.enqueue({
        operationId: 'shell:b', workspaceId: 'workspace-a', resourceClass: 'verification_heavy',
      })).toMatchObject({ status: 'queued' });
    } finally {
      if (previous === undefined) delete process.env[SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV];
      else process.env[SHELL_HEAVY_ADMISSION_PER_WORKSPACE_ENV] = previous;
    }
  });

  it('rejects a workspace over an explicit bound while another still queues', () => {
    const port = createShellHeavyAdmissionPort(() => controller(), undefined, 1);
    expect(port.enqueue({
      operationId: 'shell:a', workspaceId: 'workspace-a', resourceClass: 'verification_heavy',
    })).toMatchObject({ status: 'queued' });
    expect(port.enqueue({
      operationId: 'shell:a2', workspaceId: 'workspace-a', resourceClass: 'verification_heavy',
    })).toMatchObject({ status: 'full' });
    expect(port.enqueue({
      operationId: 'shell:b', workspaceId: 'workspace-b', resourceClass: 'verification_heavy',
    })).toMatchObject({ status: 'queued' });
  });

  it('forwards both bounds to the durable claim', () => {
    const admission = controller();
    const calls: Array<{ maxQueued: number; maxQueuedPerWorkspace?: number }> = [];
    const store: HeavyJobQueueStore = {
      claim: (entry, maxQueued, maxQueuedPerWorkspace): HeavyJobClaimResult => {
        calls.push({ maxQueued, ...(maxQueuedPerWorkspace === undefined ? {} : { maxQueuedPerWorkspace }) });
        return { status: 'queued', operationId: entry.operationId, position: 1, depth: 1 };
      },
      claimExisting: (entry): HeavyJobReattachResult => ({
        status: 'missing', operationId: entry.operationId, depth: 0,
      }),
      promote: (): number | undefined => undefined,
      cancel: (): boolean => true,
      supersede: (): HeavyJobSupersedeStoreResult => ({ status: 'full', operationId: 'unused', depth: 0 }),
      start: (): boolean => true,
      settle: (): boolean => true,
      recover: (): boolean => true,
      depth: (): number => 1,
      listLive: (): readonly HeavyJobLiveEntry[] => [],
    };
    const port = createShellHeavyAdmissionPort(() => admission, () => store, 3);

    expect(port.enqueue({
      operationId: 'shell:a', workspaceId: 'workspace-a', resourceClass: 'verification_heavy',
    })).toMatchObject({ status: 'queued' });
    // Dropping either argument would leave every other suite green while the
    // bound silently stopped applying to durable rows.
    expect(calls).toEqual([{
      maxQueued: SHELL_HEAVY_ADMISSION_QUEUE_LIMIT,
      maxQueuedPerWorkspace: 3,
    }]);
  });
});
