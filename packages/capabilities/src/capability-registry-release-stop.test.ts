import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';

import { CapabilityRegistry } from './capability-registry.js';

/**
 * `release()` is synchronous and cannot await the `stop` hook, so the zero-TTL
 * path starts the stop without awaiting it. These tests pin what the releaser
 * observes through `health(id)` while that hook is still in flight, and that a
 * hook which rejects never turns into an unhandled rejection.
 */
describe('capability registry release stop', () => {
  it('reports STOPPING from release() and COLD once the hook confirms the stop', async () => {
    let confirm!: () => void;
    const registry = new CapabilityRegistry({
      stop: async (): Promise<Result<void>> => {
        await new Promise<void>((resolve) => {
          confirm = resolve;
        });
        return ok(undefined);
      },
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    lease.value.release();
    // Released, not stopped: the hook has not confirmed the worker is gone.
    expect(registry.health('a')?.state).toBe('STOPPING');
    expect(registry.health('a')?.leaseCount).toBe(0);

    confirm();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('COLD');
  });

  it('writes stop-unverified from release() when the hook rejects', async () => {
    const registry = new CapabilityRegistry({
      stop: async (): Promise<Result<void>> => {
        throw new Error('kill refused');
      },
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    lease.value.release();
    expect(registry.health('a')?.state).toBe('STOPPING');

    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('FAILED');
    expect(registry.transitions('a').at(-1)?.reason).toBe('stop-unverified');
  });

  it('writes stop-unverified from release() when the hook resolves err', async () => {
    const registry = new CapabilityRegistry({
      stop: (): Result<void> => err(appError('PROCESS_NOT_FOUND', 'worker already gone')),
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    lease.value.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('FAILED');
  });
});
