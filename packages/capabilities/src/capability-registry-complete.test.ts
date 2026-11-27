import { ok, type Result } from '@unified-mpc/domain';
import { describe, expect, it } from 'vitest';

import { CapabilityRegistry } from './capability-registry.js';

describe('capability registry burst completion', () => {
  it('writes COLD and keeps the exit code a burst run ended with', async () => {
    const registry = new CapabilityRegistry({ start: async (): Promise<Result<void>> => ok(undefined) });
    await registry.register({ id: 'gate', provides: ['check'], runtimeKind: 'native-worker', activation: 'burst' });
    const lease = await registry.acquire('gate');
    if (!lease.ok) throw new Error('expected a lease');
    expect(registry.health('gate')?.state).toBe('ACTIVE');

    registry.complete('gate', 0);

    expect(registry.health('gate')?.state).toBe('COLD');
    expect(registry.health('gate')?.lastExitCode).toBe(0);
    // A completion is not a death, so the crash-loop writer never runs.
    expect(registry.transitions('gate').at(-1)?.reason).toBe('completed');
    lease.value.release();
  });

  it('keeps a missing exit code distinct from a successful one', async () => {
    const registry = new CapabilityRegistry({ start: async (): Promise<Result<void>> => ok(undefined) });
    await registry.register({ id: 'gate', provides: ['check'], runtimeKind: 'native-worker', activation: 'burst' });
    const lease = await registry.acquire('gate');
    if (!lease.ok) throw new Error('expected a lease');

    registry.complete('gate', null);

    expect(registry.health('gate')?.lastExitCode).toBeNull();
    lease.value.release();
  });

  it('ignores a completion for an id that is not ACTIVE or WARM_IDLE', async () => {
    const registry = new CapabilityRegistry();
    await registry.register({ id: 'gate', provides: ['check'], runtimeKind: 'native-worker', activation: 'burst' });

    expect(registry.complete('gate', 0).ok).toBe(true);
    expect(registry.health('gate')?.state).toBe('COLD');
    expect(registry.health('gate')?.lastExitCode).toBeUndefined();
  });
});
