import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
  ResourceAdmissionController,
  tryAdmitVerificationHeavy,
} from '@unified-mpc/workspace';
import { createShellHeavyAdmissionPort } from './shell-heavy-admission.js';

function controller(): ResourceAdmissionController {
  return new ResourceAdmissionController({ globalCost: 16, workspaceCost: 8, sessionCost: 8, maxOperations: 8 });
}

describe('shell heavy admission port (#145)', () => {
  it('admits a declared run into the shared controller and releases the slot on settle', async () => {
    const admission = controller();
    const port = createShellHeavyAdmissionPort(() => admission);

    const acquired = await port.acquire({ operationId: 'shell:a', workspaceId: 'workspace-a', sessionId: 'session-a', resourceClass: 'verification_heavy', waitMs: 0 });

    expect(acquired.admitted).toBe(true);
    expect(admission.snapshot()).toMatchObject({ activeOperations: 1, activeHeavyOperations: 1 });
    if (!acquired.admitted) return;
    acquired.lease.settle('completed');
    acquired.lease.settle('failed');
    expect(admission.snapshot()).toMatchObject({ activeOperations: 0, activeHeavyOperations: 0 });
  });

  it('refuses a declared run while the heavy slot is taken and reports the reason', async () => {
    const admission = controller();
    const running = tryAdmitVerificationHeavy(admission, {
      operationId: 'verification-running',
      workspaceId: 'workspace-a',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });
    if (!running.admitted) throw new Error('expected admission');
    const port = createShellHeavyAdmissionPort(() => admission);

    const acquired = await port.acquire({ operationId: 'shell:b', workspaceId: 'workspace-b', sessionId: 'session-b', resourceClass: 'rag_indexing', waitMs: 0 });

    expect(acquired).toEqual({ admitted: false, reason: 'heavy_capacity_exhausted' });
    admission.release(running.lease);
  });

  it('waits for a bounded budget and admits when the slot frees', async () => {
    const admission = controller();
    const running = tryAdmitVerificationHeavy(admission, {
      operationId: 'verification-running',
      workspaceId: 'workspace-a',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });
    if (!running.admitted) throw new Error('expected admission');
    const port = createShellHeavyAdmissionPort(() => admission);

    const pending = port.acquire({ operationId: 'shell:c', sessionId: 'session-c', resourceClass: 'verification_heavy', waitMs: 5_000 });
    setTimeout(() => admission.release(running.lease), 120);

    await expect(pending).resolves.toMatchObject({ admitted: true });
    expect(admission.snapshot().activeHeavyOperations).toBe(1);
  });

  it('gives up at the budget with the last reason when nothing frees', async () => {
    const admission = controller();
    const running = tryAdmitVerificationHeavy(admission, {
      operationId: 'verification-running',
      workspaceId: 'workspace-a',
      cost: DEFAULT_VERIFICATION_HEAVY_ADMISSION_COST,
    });
    if (!running.admitted) throw new Error('expected admission');
    const port = createShellHeavyAdmissionPort(() => admission);

    const acquired = await port.acquire({ operationId: 'shell:d', sessionId: 'session-c', resourceClass: 'verification_heavy', waitMs: 150 });

    expect(acquired).toEqual({ admitted: false, reason: 'heavy_capacity_exhausted' });
    admission.release(running.lease);
  });
});
