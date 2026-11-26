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
    // A verified stop reports no failure: the field describes the last stop, and
    // that one succeeded.
    expect(registry.health('a')?.lastStopFailure).toBeUndefined();
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
    // The shared reason is what the plan and the supervisor compare; the hook's
    // own account of the failure is kept beside it instead of being dropped with
    // the unawaited `Result`.
    expect(registry.health('a')?.lastStopFailure).toBe('capability a failed to stop: kill refused');
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
    expect(registry.health('a')?.lastStopFailure).toBe('worker already gone');
  });

  it('reports the hook message for a reclaim that waited on the last release', async () => {
    const registry = new CapabilityRegistry({
      stop: async (): Promise<Result<void>> => {
        throw new Error('kill refused');
      },
    });
    await registry.register({ id: 'a', provides: ['t'] });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');
    // A leased id only gets the mark; the release is what runs the stop.
    expect((await registry.reclaim('a')).ok).toBe(true);
    expect(registry.health('a')?.pendingStop).toBe('reclaimed while leased');

    lease.value.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('FAILED');
    expect(registry.health('a')?.lastStopFailure).toBe('capability a failed to stop: kill refused');
  });
});
