import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS,
  startPublishCredentialSweep,
  type PublishCredentialLeaseSweeper,
} from './publish-credential-sweep.js';

const NOW = 1_780_000_000_000;

interface RecordedSweeper extends PublishCredentialLeaseSweeper {
  readonly calls: number[];
  fail: boolean;
  result: number;
}

function createSweeper(): RecordedSweeper {
  const sweeper: RecordedSweeper = {
    calls: [],
    fail: false,
    result: 0,
    async sweepExpired(now: number): Promise<number> {
      sweeper.calls.push(now);
      if (sweeper.fail) throw new Error('Secret Service unavailable');
      return sweeper.result;
    },
  };
  return sweeper;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startPublishCredentialSweep', () => {
  it('sweeps once on start and then hourly', async () => {
    vi.useFakeTimers();
    const sweeper = createSweeper();
    let clock = NOW;
    const handle = startPublishCredentialSweep({
      leases: sweeper,
      now: () => clock,
      intervalMs: PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS,
    });

    await expect(handle.ready).resolves.toBe(0);
    expect(sweeper.calls).toEqual([NOW]);

    clock = NOW + PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS);
    expect(sweeper.calls).toEqual([NOW, NOW + PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS]);

    handle.stop();
    await vi.advanceTimersByTimeAsync(PUBLISH_CREDENTIAL_SWEEP_INTERVAL_MS * 3);
    expect(sweeper.calls).toHaveLength(2);
  });

  it('reports the reclaimed count and keeps sweeping after a failure', async () => {
    vi.useFakeTimers();
    const sweeper = createSweeper();
    const counts: number[] = [];
    const errors: unknown[] = [];
    const handle = startPublishCredentialSweep({
      leases: sweeper,
      now: () => NOW,
      intervalMs: 1_000,
      onSwept: (count) => counts.push(count),
      onError: (error) => errors.push(error),
    });
    await expect(handle.ready).resolves.toBe(0);

    sweeper.result = 2;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(counts).toEqual([0, 2]);

    sweeper.fail = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors).toHaveLength(1);

    sweeper.fail = false;
    sweeper.result = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(counts).toEqual([0, 2, 1]);

    handle.stop();
  });

  it('never rejects when the startup sweep fails', async () => {
    const sweeper = createSweeper();
    sweeper.fail = true;
    const errors: unknown[] = [];
    const handle = startPublishCredentialSweep({
      leases: sweeper,
      now: () => NOW,
      onError: (error) => errors.push(error),
    });
    await expect(handle.ready).resolves.toBe(0);
    expect(errors).toHaveLength(1);
    handle.stop();
  });
});
