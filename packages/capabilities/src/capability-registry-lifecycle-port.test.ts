import { ok, type Result } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';

import {
  CapabilityRegistry,
  normalizeCapabilityManifest,
  type CapabilityState,
} from './capability-registry.js';

function states(registry: CapabilityRegistry, id: string): readonly CapabilityState[] {
  return registry.transitions(id).map((transition) => transition.to);
}

/**
 * A release cannot await a stop hook, so it writes the terminal transition when
 * that promise settles. One macrotask is enough for the continuation the
 * registry started.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe('capability registry lifecycle port', () => {
  it('defaults a burst capability to an idle TTL of zero', () => {
    const result = normalizeCapabilityManifest({ id: 'b', provides: ['t'], activation: 'burst' });

    expect(result.ok && result.value.idleTtlMs).toBe(0);
  });

  it('leaves the idle TTL of an on-demand capability at its own default', () => {
    const result = normalizeCapabilityManifest({ id: 'o', provides: ['t'] });

    expect(result.ok && result.value.idleTtlMs).toBe(60_000);
  });

  it('stops a burst capability on its last release', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'b', provides: ['t'], activation: 'burst' });
    const lease = await registry.acquire('b');
    if (!lease.ok) throw new Error('expected a lease');

    expect(lease.value.release().ok).toBe(true);
    await settle();

    expect(states(registry, 'b')).toEqual(['COLD', 'STARTING', 'ACTIVE', 'STOPPING', 'COLD']);
  });

  it('marks a leased id for a pending stop instead of stopping it', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'a', provides: ['t'] });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    expect((await registry.reclaim('a')).ok).toBe(true);
    expect(registry.health('a')).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });

    expect(lease.value.release().ok).toBe(true);
    await settle();

    expect(registry.health('a')).toMatchObject({ state: 'COLD', leaseCount: 0 });
  });

  it('reclaims a warm id through the stop hook', async () => {
    const stopped: string[] = [];
    const registry = new CapabilityRegistry({
      stop: (manifest): Result<void> => {
        stopped.push(manifest.id);
        return ok(undefined);
      },
    });
    await registry.register({ id: 'a', provides: ['t'] });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');
    lease.value.release();
    expect(registry.health('a')?.state).toBe('WARM_IDLE');

    expect((await registry.reclaim('a')).ok).toBe(true);

    expect(stopped).toEqual(['a']);
    expect(registry.health('a')?.state).toBe('COLD');
  });

  it('refuses to reclaim a resident capability and an unregistered id', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'r', provides: ['t'], recyclable: false });
    await registry.acquire('r');

    expect((await registry.reclaim('r')).ok).toBe(true);
    expect(registry.health('r')?.state).toBe('ACTIVE');
    expect((await registry.reclaim('nobody')).ok).toBe(false);
  });

  it('ignores a late ok stop after the supervisor already wrote FAILED', async () => {
    let releaseHook: (() => void) | undefined;
    const registry = new CapabilityRegistry({
      stop: (): Promise<Result<void>> => new Promise((resolve) => {
        releaseHook = (): void => resolve(ok(undefined));
      }),
    });
    await registry.register({ id: 'a', provides: ['t'] });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');
    lease.value.release();

    const pending = registry.reclaim('a');
    await settle();
    expect(registry.health('a')?.state).toBe('STOPPING');
    expect(registry.fail('a', 'stop-unverified').ok).toBe(true);
    releaseHook?.();
    await pending;
    await settle();

    // `FAILED -> COLD` is reachable through `recycle`, never through a stop the
    // supervisor already reported unverified.
    expect(registry.health('a')?.state).toBe('FAILED');
    expect(states(registry, 'a')).toEqual(['COLD', 'STARTING', 'ACTIVE', 'WARM_IDLE', 'STOPPING', 'FAILED']);
  });

  it('writes the worker-exit edge from ACTIVE and WARM_IDLE and keeps the lease count', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'a', provides: ['t'] });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    expect(registry.fail('a', 'worker-exited').ok).toBe(true);
    expect(registry.health('a')).toMatchObject({ state: 'FAILED', leaseCount: 1 });
    expect((await registry.acquire('a')).ok).toBe(false);
    expect(lease.value.release().ok).toBe(true);

    const warm = new CapabilityRegistry();
    await warm.register({ id: 'w', provides: ['t'] });
    const first = await warm.acquire('w');
    if (!first.ok) throw new Error('expected a lease');
    first.value.release();
    expect(warm.health('w')?.state).toBe('WARM_IDLE');

    expect(warm.fail('w', 'worker-exited').ok).toBe(true);
    expect(warm.health('w')?.state).toBe('FAILED');
  });

  it('writes no second death and refuses an unregistered id', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'a', provides: ['t'] });
    expect((await registry.acquire('a')).ok).toBe(true);

    expect(registry.fail('a', 'worker-exited').ok).toBe(true);
    expect(registry.health('a')?.state).toBe('FAILED');
    const written = registry.transitions('a').length;

    // A second writer for the same death writes nothing: `FAILED -> FAILED` is not
    // in the table, so a guard rather than a throw keeps the loser quiet.
    expect(registry.fail('a', 'stop-unverified').ok).toBe(true);
    expect(registry.transitions('a')).toHaveLength(written);

    // A `COLD` id has no death to record, so the same call is a no-op, not an error.
    await registry.register({ id: 'cold', provides: ['t'] });
    expect(registry.fail('cold', 'worker-exited').ok).toBe(true);
    expect(registry.health('cold')?.state).toBe('COLD');

    expect(registry.fail('nobody', 'worker-exited').ok).toBe(false);
  });

  it('snapshots one entry per registered capability with its own TTL', async () => {
    let now = 100;
    const registry = new CapabilityRegistry({ now: (): number => now });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 60_000 });
    await registry.register({ id: 'b', provides: ['t'], activation: 'burst' });
    const warm = await registry.acquire('a');
    if (!warm.ok) throw new Error('expected a lease');
    warm.value.release();
    const burst = await registry.acquire('b');
    if (!burst.ok) throw new Error('expected a lease');
    burst.value.release();
    now = 200;

    const snapshot = registry.snapshot();

    expect(snapshot).toHaveLength(2);
    expect(snapshot).toContainEqual({
      id: 'a',
      state: 'WARM_IDLE',
      leaseCount: 0,
      idleSince: 100,
      idleTtlMs: 60_000,
      recyclable: true,
    });
    // No `stop` hook is configured, so the zero TTL reaches COLD in the same tick;
    // what the snapshot must carry is the burst capability's own TTL.
    expect(snapshot.find((candidate) => candidate.id === 'b')).toMatchObject({ state: 'COLD', idleTtlMs: 0 });
  });

});
