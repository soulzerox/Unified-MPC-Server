import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';

import {
  CapabilityRegistry,
  normalizeCapabilityManifest,
  type CapabilityManifest,
  type CapabilityRegistryOptions,
  type CapabilityState,
} from './capability-registry.js';

function states(registry: CapabilityRegistry, id: string): readonly CapabilityState[] {
  return registry.transitions(id).map((transition) => transition.to);
}

describe('capability manifest', () => {
  it('rejects an empty id, empty provides and a blank token', () => {
    expect(normalizeCapabilityManifest({ id: ' ', provides: ['t'] }).ok).toBe(false);
    expect(normalizeCapabilityManifest({ id: 'a', provides: [] }).ok).toBe(false);
    expect(normalizeCapabilityManifest({ id: 'a', provides: ['t', ' '] }).ok).toBe(false);
  });

  it('rejects a self dependency with the edge named', () => {
    const result = normalizeCapabilityManifest({ id: 'a', provides: ['t'], requires: ['a'] });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.message).toContain('a -> a');
  });

  it('rejects negative or fractional timings and a non-positive version', () => {
    expect(normalizeCapabilityManifest({ id: 'a', provides: ['t'], idleTtlMs: -1 }).ok).toBe(false);
    expect(normalizeCapabilityManifest({ id: 'a', provides: ['t'], startupTimeoutMs: 1.5 }).ok).toBe(false);
    expect(normalizeCapabilityManifest({ id: 'a', provides: ['t'], shutdownTimeoutMs: -1 }).ok).toBe(false);
    expect(normalizeCapabilityManifest({ id: 'a', provides: ['t'], version: 0 }).ok).toBe(false);
  });

  it('fills every documented default', () => {
    const result = normalizeCapabilityManifest({ id: 'a', provides: ['t'] });

    expect(result.ok && result.value).toEqual({
      id: 'a',
      version: 1,
      provides: ['t'],
      requires: [],
      externalRequires: [],
      runtimeKind: 'in-process',
      activation: 'on-demand',
      costClass: 'small',
      idleTtlMs: 60_000,
      startupTimeoutMs: 10_000,
      shutdownTimeoutMs: 5_000,
      recyclable: true,
      generationFenced: false,
    });
  });
});

describe('capability registry', () => {
  it('refuses a duplicate id and an unregistered requirement', async () => {
    const registry = new CapabilityRegistry();

    expect((await registry.register({ id: 'a', provides: ['t'] })).ok).toBe(true);
    expect((await registry.register({ id: 'a', provides: ['t'] })).ok).toBe(false);
    expect((await registry.register({ id: 'b', provides: ['t'], requires: ['missing'] })).ok).toBe(false);
  });

  it('walks COLD -> STARTING -> ACTIVE -> WARM_IDLE -> ACTIVE -> STOPPING -> COLD', async () => {
    let now = 1_000;
    const started: string[] = [];
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (manifest): Result<void> => {
        started.push(manifest.id);
        return ok(undefined);
      },
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 5_000 });

    expect(registry.health('a')).toMatchObject({ state: 'COLD', leaseCount: 0 });

    const first = await registry.acquire('a');
    expect(first.ok).toBe(true);
    expect(registry.health('a')).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });

    expect(first.ok && first.value.release().ok).toBe(true);
    expect(registry.health('a')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });

    const second = await registry.acquire('a');
    expect(second.ok).toBe(true);
    expect(registry.health('a')).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });
    expect(second.ok && second.value.release().ok).toBe(true);

    now += 5_000;
    await registry.sweep();
    expect(registry.health('a')).toMatchObject({ state: 'COLD', leaseCount: 0 });
    expect(states(registry, 'a')).toEqual(['COLD', 'STARTING', 'ACTIVE', 'WARM_IDLE', 'ACTIVE', 'WARM_IDLE', 'STOPPING', 'COLD']);
    expect(started).toEqual(['a']);
  });

  it('does not restart a capability that is already warm', async () => {
    let now = 0;
    const started: string[] = [];
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (manifest): Result<void> => {
        started.push(manifest.id);
        return ok(undefined);
      },
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 5_000 });

    const first = await registry.acquire('a');
    if (first.ok) first.value.release();
    now += 1_000;
    const second = await registry.acquire('a');

    expect(second.ok).toBe(true);
    expect(started).toEqual(['a']);
  });

  it('refuses to acquire a FAILED capability until it is recycled', async () => {
    let attempts = 0;
    const registry = new CapabilityRegistry({
      start: (): Result<void> => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        return ok(undefined);
      },
    });
    await registry.register({ id: 'a', provides: ['t'] });

    expect((await registry.acquire('a')).ok).toBe(false);
    expect(registry.health('a')?.state).toBe('FAILED');
    expect((await registry.acquire('a')).ok).toBe(false);
    expect(registry.recycle('a').ok).toBe(true);
    expect((await registry.acquire('a')).ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it('fails a start that outlives its startup timeout', async () => {
    const registry = new CapabilityRegistry({
      start: (): Promise<Result<void>> => new Promise<Result<void>>(() => undefined),
    });
    await registry.register({ id: 'a', provides: ['t'], startupTimeoutMs: 25 });

    const result = await registry.acquire('a');

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe('PROCESS_TIMEOUT');
    expect(registry.health('a')?.state).toBe('FAILED');
  });

  it('fails a start that returns err and keeps the caller error code', async () => {
    const refused = appError('EXECUTABLE_NOT_FOUND', 'worker binary is missing', true);
    const registry = new CapabilityRegistry({
      start: (): Result<void> => err(refused),
    });
    await registry.register({ id: 'a', provides: ['t'] });

    const result = await registry.acquire('a');

    expect(result.ok).toBe(false);
    // The caller's own error survives: wrapping it as `INTERNAL_ERROR` would
    // hide why the worker stayed down.
    expect(result.ok ? undefined : result.error).toEqual(refused);
    expect(states(registry, 'a')).toEqual(['COLD', 'STARTING', 'FAILED']);
    expect(registry.transitions('a').at(-1)?.reason).toBe('startup failed: worker binary is missing');
  });

  it('returns a started dependency to the idle path when the acquire that needed it fails', async () => {
    let now = 0;
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (manifest): Result<void> => {
        if (manifest.id === 'top') throw new Error('boom');
        return ok(undefined);
      },
    });
    await registry.register({ id: 'base', provides: ['base'], idleTtlMs: 5_000 });
    await registry.register({ id: 'top', provides: ['top'], requires: ['base'] });

    expect((await registry.acquire('top')).ok).toBe(false);
    expect(registry.health('base')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });

    now += 5_000;
    await registry.sweep();
    expect(registry.health('base')?.state).toBe('COLD');
  });

  it('refuses a FAILED capability without starting its dependency path', async () => {
    let now = 0;
    const starts: string[] = [];
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (manifest): Result<void> => {
        starts.push(manifest.id);
        if (manifest.id === 'top') throw new Error('boom');
        return ok(undefined);
      },
    });
    await registry.register({ id: 'base', provides: ['base'], idleTtlMs: 1_000 });
    await registry.register({ id: 'top', provides: ['top'], requires: ['base'] });

    expect((await registry.acquire('top')).ok).toBe(false);
    now += 1_000;
    await registry.sweep();
    // The dependency is cold again, so a second attempt that walked `requires`
    // would show up as a real start.
    expect(registry.health('base')?.state).toBe('COLD');
    starts.length = 0;

    const refused = await registry.acquire('top');

    expect(refused.ok).toBe(false);
    expect(refused.ok ? undefined : refused.error.code).toBe('CONFLICT');
    expect(starts).toEqual([]);
    expect(registry.health('base')?.state).toBe('COLD');
  });

  it('keeps only the newest transitions when the history is capped', async () => {
    const registry = new CapabilityRegistry({ maxTransitions: 3 });
    await registry.register({ id: 'a', provides: ['t'] });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');
    lease.value.release();

    const history = registry.transitions('a');

    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.to)).toEqual(['STARTING', 'ACTIVE', 'WARM_IDLE']);
  });

  it('clamps a zero, negative or fractional cap to a whole positive count', async () => {
    // Four transitions happen (COLD, STARTING, ACTIVE, WARM_IDLE), so a cap of 1
    // and of 3 both bind: an unclamped `0`/`-1` empties the history and `3.5`
    // truncates the splice count to zero, leaving all four.
    for (const [maxTransitions, kept] of [[0, 1], [-1, 1], [3.5, 3]] as const) {
      const registry = new CapabilityRegistry({ maxTransitions });
      await registry.register({ id: 'a', provides: ['t'] });
      const lease = await registry.acquire('a');
      if (!lease.ok) throw new Error('expected a lease');
      lease.value.release();

      expect(registry.transitions('a')).toHaveLength(kept);
      expect(registry.health('a')?.lastTransition?.to).toBe('WARM_IDLE');
    }
  });

  it('does not start a capability below a dependency that is already failed', async () => {
    const starts: string[] = [];
    const registry = new CapabilityRegistry({
      start: (manifest): Result<void> => {
        starts.push(manifest.id);
        if (manifest.id === 'middle') throw new Error('boom');
        return ok(undefined);
      },
    });
    // `idleTtlMs: 0` sends `leaf` back to COLD when the failed acquire hands it
    // to the idle path, so a start below `middle` would be visible in `starts`.
    await registry.register({ id: 'leaf', provides: ['leaf'], idleTtlMs: 0 });
    await registry.register({ id: 'middle', provides: ['middle'], requires: ['leaf'] });
    await registry.register({ id: 'top', provides: ['top'], requires: ['middle'] });
    expect((await registry.acquire('middle')).ok).toBe(false);
    expect(registry.health('leaf')?.state).toBe('COLD');
    starts.length = 0;

    expect((await registry.acquire('top')).ok).toBe(false);

    expect(starts).toEqual([]);
    expect(registry.health('leaf')?.state).toBe('COLD');
  });

  it('re-acquiring a warm dependency path wakes the dependency back to ACTIVE', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'base', provides: ['base'] });
    await registry.register({ id: 'top', provides: ['top'], requires: ['base'] });

    const first = await registry.acquire('top');
    if (!first.ok) throw new Error('expected a lease');
    first.value.release();
    expect(registry.health('base')?.state).toBe('WARM_IDLE');

    const second = await registry.acquire('top');
    expect(second.ok).toBe(true);
    expect(registry.health('base')).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });
  });

  it('returns a started dependency to the idle path when a boot fails', async () => {
    let now = 0;
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (manifest): Result<void> => {
        if (manifest.id === 'resident') throw new Error('boom');
        return ok(undefined);
      },
    });
    await registry.register({ id: 'base', provides: ['base'], idleTtlMs: 5_000 });

    expect((await registry.register({ id: 'resident', provides: ['t'], requires: ['base'], activation: 'always' })).ok)
      .toBe(false);
    expect(registry.health('resident')).toBeUndefined();
    expect(registry.health('base')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });

    now += 5_000;
    await registry.sweep();
    expect(registry.health('base')?.state).toBe('COLD');
  });

  it('leaves a resident always capability alone when a dependent boot fails', async () => {
    let now = 0;
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (manifest): Result<void> => {
        if (manifest.id === 'resident') throw new Error('boom');
        return ok(undefined);
      },
    });
    // `activation: 'always'` boots at registration: ACTIVE with no lease is its
    // resting state, so a failed boot elsewhere must not hand it to the sweep.
    await registry.register({ id: 'base', provides: ['base'], activation: 'always', idleTtlMs: 5_000 });
    expect(registry.health('base')).toMatchObject({ state: 'ACTIVE', leaseCount: 0 });

    expect((await registry.register({ id: 'resident', provides: ['t'], requires: ['base'], activation: 'always' })).ok)
      .toBe(false);
    expect(registry.health('base')).toMatchObject({ state: 'ACTIVE', leaseCount: 0 });

    now += 5_000;
    await registry.sweep();
    expect(registry.health('base')?.state).toBe('ACTIVE');
  });

  it('leaves a resident always capability alone when a dependent acquire fails', async () => {
    let now = 0;
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (manifest): Result<void> => {
        if (manifest.id === 'dependent') throw new Error('boom');
        return ok(undefined);
      },
    });
    await registry.register({ id: 'base', provides: ['base'], activation: 'always', idleTtlMs: 5_000 });
    await registry.register({ id: 'dependent', provides: ['t'], requires: ['base'] });

    expect((await registry.acquire('dependent')).ok).toBe(false);
    expect(registry.health('base')).toMatchObject({ state: 'ACTIVE', leaseCount: 0 });

    now += 5_000;
    await registry.sweep();
    expect(registry.health('base')?.state).toBe('ACTIVE');
  });

  it('unregisters a capability whose always boot failed so registration can retry', async () => {
    let failing = true;
    const registry = new CapabilityRegistry({
      start: (): Result<void> => {
        if (failing) throw new Error('boom');
        return ok(undefined);
      },
    });

    expect((await registry.register({ id: 'resident', provides: ['t'], activation: 'always' })).ok).toBe(false);
    expect(registry.health('resident')).toBeUndefined();

    failing = false;
    expect((await registry.register({ id: 'resident', provides: ['t'], activation: 'always' })).ok).toBe(true);
    expect(registry.health('resident')?.state).toBe('ACTIVE');
  });

  it('starts the requires path of an always capability at registration', async () => {
    const started: string[] = [];
    const registry = new CapabilityRegistry({
      start: (manifest): Result<void> => {
        started.push(manifest.id);
        return ok(undefined);
      },
    });
    await registry.register({ id: 'base', provides: ['base'] });
    await registry.register({ id: 'resident', provides: ['t'], requires: ['base'], activation: 'always' });

    expect(started).toEqual(['base', 'resident']);
    expect(registry.health('base')?.state).toBe('ACTIVE');
  });

  it('refuses a double release and leaves leaseCount unchanged', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'a', provides: ['t'] });
    const first = await registry.acquire('a');
    const second = await registry.acquire('a');
    if (!first.ok || !second.ok) throw new Error('expected two leases');

    expect(first.value.release().ok).toBe(true);
    expect(first.value.release().ok).toBe(false);
    expect(registry.health('a')).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });

    second.value.release();
    expect(registry.health('a')?.leaseCount).toBe(0);
  });

  it('keeps a capability alive while a lease is held even after its TTL elapsed', async () => {
    let now = 0;
    const registry = new CapabilityRegistry({ now: (): number => now });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 5_000 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    now += 60_000;
    await registry.sweep();
    expect(registry.health('a')).toMatchObject({ state: 'ACTIVE', leaseCount: 1 });

    lease.value.release();
    expect(registry.health('a')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });

    now += 5_000;
    await registry.sweep();
    expect(registry.health('a')?.state).toBe('COLD');
  });

  it('stops on the last release without an idle window when the TTL is zero', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');

    lease.value.release();
    expect(registry.health('a')).toMatchObject({ state: 'COLD', leaseCount: 0 });
    expect(states(registry, 'a')).not.toContain('WARM_IDLE');
  });

  it('waits for the stop hook before writing COLD', async () => {
    let now = 0;
    let confirm!: () => void;
    const stopped: string[] = [];
    const registry = new CapabilityRegistry({
      now: (): number => now,
      stop: async (manifest): Promise<Result<void>> => {
        stopped.push(manifest.id);
        await new Promise<void>((resolve) => {
          confirm = resolve;
        });
        return ok(undefined);
      },
    });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 10 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');
    lease.value.release();
    now += 10;

    const swept = registry.sweep();
    expect(stopped).toEqual(['a']);
    // Ordered is not stopped: a `COLD` record would let the next acquire reuse a
    // worker that has not confirmed its exit.
    expect(registry.health('a')?.state).toBe('STOPPING');
    expect((await registry.acquire('a')).ok).toBe(false);

    confirm();
    await swept;
    expect(registry.health('a')?.state).toBe('COLD');
  });

  it('records stop-unverified when the stop hook reports err or rejects', async () => {
    const sweepOnce = async (stop: CapabilityRegistryOptions['stop']): Promise<CapabilityRegistry> => {
      const registry = new CapabilityRegistry({ stop });
      await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 0 });
      const lease = await registry.acquire('a');
      if (!lease.ok) throw new Error('expected a lease');
      lease.value.release();
      await registry.sweep();
      return registry;
    };

    const refused = await sweepOnce(() => err(appError('PROCESS_NOT_FOUND', 'worker already gone')));
    const thrown = await sweepOnce(() => {
      throw new Error('kill refused');
    });

    for (const registry of [refused, thrown]) {
      expect(registry.health('a')?.state).toBe('FAILED');
      expect(registry.transitions('a').at(-1)?.reason).toBe('stop-unverified');
      // `FAILED` is recyclable, `COLD` is not reachable from an unverified stop.
      expect(registry.recycle('a').ok).toBe(true);
      expect((await registry.acquire('a')).ok).toBe(true);
    }
  });

  it('fences a stale generation on acquire and publish but still releases it', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'a', provides: ['t'], generationFenced: true, idleTtlMs: 0 });

    expect((await registry.acquire('a')).ok).toBe(false);

    const first = await registry.acquire('a', { generation: 1 });
    const second = await registry.acquire('a', { generation: 2 });
    if (!first.ok || !second.ok) throw new Error('expected two fenced leases');

    expect((await registry.acquire('a', { generation: 1 })).ok).toBe(false);
    expect(first.value.publish().ok).toBe(false);
    expect(second.value.publish().ok).toBe(true);

    expect(first.value.release().ok).toBe(true);
    expect(registry.health('a')).toMatchObject({ state: 'ACTIVE', leaseCount: 1, highestGeneration: 2 });

    second.value.release();
    expect(registry.health('a')).toMatchObject({ state: 'COLD', leaseCount: 0 });
  });

  it('emits exactly one transition per move and reports the last one as health', async () => {
    let now = 0;
    const registry = new CapabilityRegistry({ now: (): number => now });
    await registry.register({ id: 'a', provides: ['t'], idleTtlMs: 5_000 });
    const lease = await registry.acquire('a');
    if (!lease.ok) throw new Error('expected a lease');
    now += 10;
    lease.value.release();

    const transitions = registry.transitions('a');
    expect(transitions.map((transition) => `${transition.from}->${transition.to}`)).toEqual([
      'REGISTERED->COLD',
      'COLD->STARTING',
      'STARTING->ACTIVE',
      'ACTIVE->WARM_IDLE',
    ]);
    expect(transitions.every((transition) => transition.reason.length > 0)).toBe(true);
    expect(transitions.every((transition) => transition.id === 'a')).toBe(true);
    expect(registry.health('a')?.lastTransition).toEqual(transitions.at(-1));
    expect(registry.transitions('missing')).toEqual([]);
  });

  it('pins a non-recyclable capability for the process lifetime', async () => {
    let now = 0;
    const registry = new CapabilityRegistry({
      now: (): number => now,
      start: (): Result<void> => ok(undefined),
    });
    await registry.register({ id: 'resident', provides: ['t'], idleTtlMs: 1, recyclable: false });
    const lease = await registry.acquire('resident');
    if (!lease.ok) throw new Error('expected a lease');

    lease.value.release();
    now += 1_000_000;
    await registry.sweep();
    expect(registry.health('resident')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });

    let failing = true;
    const failingRegistry = new CapabilityRegistry({
      start: (): Result<void> => {
        if (failing) throw new Error('boom');
        return ok(undefined);
      },
    });
    await failingRegistry.register({ id: 'broken', provides: ['t'], recyclable: false });
    expect((await failingRegistry.acquire('broken')).ok).toBe(false);
    failing = false;
    expect((await failingRegistry.acquire('broken')).ok).toBe(false);
    expect(failingRegistry.health('broken')?.state).toBe('FAILED');
  });

  it('records an external requirement without starting or owning it', async () => {
    const started: string[] = [];
    const registry = new CapabilityRegistry({
      start: (manifest): Result<void> => {
        started.push(manifest.id);
        return ok(undefined);
      },
    });

    expect((await registry.register({ id: 'a', provides: ['t'], externalRequires: ['host-cdp'] })).ok).toBe(true);
    const lease = await registry.acquire('a');

    expect(lease.ok).toBe(true);
    expect(started).toEqual(['a']);
    expect(registry.manifest('a')?.externalRequires).toEqual(['host-cdp']);
    expect(registry.health('host-cdp')).toBeUndefined();
  });

  it('starts only the requires path of an acquire', async () => {
    const started: string[] = [];
    const registry = new CapabilityRegistry({
      start: (manifest): Result<void> => {
        started.push(manifest.id);
        return ok(undefined);
      },
    });
    await registry.register({ id: 'base', provides: ['base'] });
    await registry.register({ id: 'middle', provides: ['middle'], requires: ['base'] });
    await registry.register({ id: 'top', provides: ['top'], requires: ['middle'] });
    await registry.register({ id: 'unrelated', provides: ['other'] });

    const lease = await registry.acquire('top');

    expect(lease.ok).toBe(true);
    expect(started).toEqual(['base', 'middle', 'top']);
    expect(registry.health('unrelated')?.state).toBe('COLD');
    expect(states(registry, 'top')).toEqual(['COLD', 'STARTING', 'ACTIVE']);
    // The lease that needed them keeps the path resident, and its release hands
    // the whole path back so the warm-idle sweep can reclaim it.
    expect(registry.health('base')?.leaseCount).toBe(1);
    expect(registry.health('middle')?.leaseCount).toBe(1);
    if (!lease.ok) throw new Error('expected a lease');

    lease.value.release();
    expect(registry.health('base')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });
    expect(registry.health('middle')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });
    expect(registry.health('top')).toMatchObject({ state: 'WARM_IDLE', leaseCount: 0 });
  });

  it('starts an always capability at registration', async () => {
    const manifests: CapabilityManifest[] = [];
    const registry = new CapabilityRegistry({
      start: (manifest): Result<void> => {
        manifests.push(manifest);
        return ok(undefined);
      },
    });

    await registry.register({ id: 'resident', provides: ['t'], activation: 'always', recyclable: false });

    expect(registry.health('resident')?.state).toBe('ACTIVE');
    expect(manifests.map((manifest) => manifest.id)).toEqual(['resident']);
  });
});
