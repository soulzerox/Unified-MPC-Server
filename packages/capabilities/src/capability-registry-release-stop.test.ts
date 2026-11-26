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

  it('keeps the message when the supervisor settled the record first', async () => {
    let settle!: (result: Result<void>) => void;
    const registry = new CapabilityRegistry({
      stop: (): Promise<Result<void>> => new Promise<Result<void>>((resolve): void => { settle = resolve; }),
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    lease.value.release();
    // The supervisor's deadline writes `FAILED` while the hook is still out; the
    // attempt itself has not changed, so its verdict still belongs to the record.
    expect(registry.fail('a', 'stop-unverified').ok).toBe(true);
    settle(err(appError('PROCESS_NOT_FOUND', 'kill refused')));
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('FAILED');
    expect(registry.health('a')?.lastStopFailure).toBe('kill refused');
  });

  it('does not let a stale hook message land on a newer stop attempt', async () => {
    const settles: Array<(result: Result<void>) => void> = [];
    const registry = new CapabilityRegistry({
      stop: (): Promise<Result<void>> => new Promise<Result<void>>((resolve): void => { settles.push(resolve); }),
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });

    const first = await registry.acquire('a');
    if (!first.ok) throw new Error('expected a lease');
    first.value.release();
    expect(registry.health('a')?.state).toBe('STOPPING');
    // Deadline first, then the record is recycled and a second attempt begins.
    expect(registry.fail('a', 'stop-unverified').ok).toBe(true);
    expect(registry.recycle('a').ok).toBe(true);

    const second = await registry.acquire('a');
    if (!second.ok) throw new Error('expected a second lease');
    second.value.release();
    expect(registry.health('a')?.state).toBe('STOPPING');
    settles[1]?.(ok(undefined));
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('COLD');

    // The first hook reports now. It speaks for the attempt that already ended,
    // so it must not overwrite the verdict of the one that verified cleanly.
    settles[0]?.(err(appError('PROCESS_NOT_FOUND', 'kill refused')));
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('COLD');
    expect(registry.health('a')?.lastStopFailure).toBeUndefined();
  });

  it('drops the previous incarnation message once a new one starts', async () => {
    const registry = new CapabilityRegistry({
      stop: async (): Promise<Result<void>> => err(appError('PROCESS_NOT_FOUND', 'worker already gone')),
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });
    const first = await registry.acquire('a');
    if (!first.ok) throw new Error('expected a lease');
    first.value.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.health('a')?.state).toBe('FAILED');
    expect(registry.health('a')?.lastStopFailure).toBe('worker already gone');

    // Recycling is what lets the next acquire retry; the old message described a
    // worker that is no longer this record's live incarnation.
    expect(registry.recycle('a').ok).toBe(true);
    const second = await registry.acquire('a');
    if (!second.ok) throw new Error('expected a second lease');
    expect(registry.health('a')?.state).toBe('ACTIVE');
    expect(registry.health('a')?.lastStopFailure).toBeUndefined();
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
