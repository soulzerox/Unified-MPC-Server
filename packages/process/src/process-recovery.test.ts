import { describe, expect, it } from 'vitest';
import { PosixProcessRecoveryProbe } from './process-recovery.js';

const EXPECTED = { pid: 4242, startedAt: '2026-09-21T00:00:00.000Z' } as const;

describe('PosixProcessRecoveryProbe', () => {
  it('verifies the same live detached process group', async () => {
    const probe = new PosixProcessRecoveryProbe({
      platform: 'linux',
      processIsAlive: (): boolean => true,
      processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<string> => EXPECTED.startedAt,
    });

    await expect(probe.inspect(EXPECTED)).resolves.toEqual({
      state: 'verified_live',
      pid: EXPECTED.pid,
      startedAt: EXPECTED.startedAt,
    });
  });

  it('releases only when both root and detached process group are verified gone', async () => {
    const probe = new PosixProcessRecoveryProbe({
      platform: 'linux',
      processIsAlive: (): boolean => false,
      processGroupIsAlive: (): boolean => false,
      processStartedAt: async (): Promise<null> => null,
    });

    await expect(probe.inspect(EXPECTED)).resolves.toEqual({ state: 'verified_gone', pid: EXPECTED.pid });
  });

  it('fails closed when descendants survive after the persisted root disappears', async () => {
    const probe = new PosixProcessRecoveryProbe({
      platform: 'linux',
      processIsAlive: (): boolean => false,
      processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<null> => null,
    });

    await expect(probe.inspect(EXPECTED)).resolves.toEqual({
      state: 'termination_unverified',
      pid: EXPECTED.pid,
      reason: 'orphan_group',
    });
  });

  it('does not attach a reused PID to the persisted process identity', async () => {
    const probe = new PosixProcessRecoveryProbe({
      platform: 'darwin',
      processIsAlive: (): boolean => true,
      processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<string> => '2026-09-21T00:00:01.000Z',
    });

    await expect(probe.inspect(EXPECTED)).resolves.toEqual({
      state: 'identity_mismatch',
      pid: EXPECTED.pid,
      expectedStartedAt: EXPECTED.startedAt,
      observedStartedAt: '2026-09-21T00:00:01.000Z',
    });
  });

  it('fails closed when process identity probing is unavailable', async () => {
    const probe = new PosixProcessRecoveryProbe({
      platform: 'linux',
      processIsAlive: (): boolean => true,
      processGroupIsAlive: (): boolean => true,
      processStartedAt: async (): Promise<never> => { throw new Error('ps unavailable'); },
    });

    await expect(probe.inspect(EXPECTED)).resolves.toEqual({
      state: 'termination_unverified',
      pid: EXPECTED.pid,
      reason: 'probe_failed',
    });
  });

  it('rechecks disappearance when identity vanishes between liveness and identity probes', async () => {
    let rootChecks = 0;
    let groupChecks = 0;
    const probe = new PosixProcessRecoveryProbe({
      platform: 'linux',
      processIsAlive: (): boolean => {
        rootChecks += 1;
        return rootChecks === 1;
      },
      processGroupIsAlive: (): boolean => {
        groupChecks += 1;
        return groupChecks === 1;
      },
      processStartedAt: async (): Promise<null> => null,
    });

    await expect(probe.inspect(EXPECTED)).resolves.toEqual({ state: 'verified_gone', pid: EXPECTED.pid });
  });
});
