import { describe, expect, it } from 'vitest';
import { ProcessCpuLoadProbe } from './cpu-load.js';

describe('ProcessCpuLoadProbe', () => {
  it('samples the 1-minute load average and CPU count', () => {
    const probe = new ProcessCpuLoadProbe({
      loadAverageReader: (): number => 1.25,
      cpuCountReader: (): number => 4,
      now: (): number => 10,
    });

    expect(probe.sample()).toEqual({ loadAverage1m: 1.25, cpuCount: 4, sampledAtMs: 10 });
  });

  it('reuses a sample inside the TTL and refreshes after it', () => {
    let now = 1_000;
    let loads = 0;
    const probe = new ProcessCpuLoadProbe({
      loadAverageReader: (): number => {
        loads += 1;
        return loads;
      },
      cpuCountReader: (): number => 8,
      sampleTtlMs: 1_000,
      now: (): number => now,
    });

    expect(probe.sample().loadAverage1m).toBe(1);
    now = 1_500;
    expect(probe.sample().loadAverage1m).toBe(1);
    expect(loads).toBe(1);
    now = 2_001;
    expect(probe.sample().loadAverage1m).toBe(2);
    expect(loads).toBe(2);
  });

  it('rejects malformed load averages', () => {
    for (const load of [Number.NaN, Number.POSITIVE_INFINITY, -0.1]) {
      const probe = new ProcessCpuLoadProbe({ loadAverageReader: (): number => load, cpuCountReader: (): number => 4 });
      expect(() => probe.sample()).toThrow(/load average/);
    }
  });

  it('rejects malformed CPU counts', () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      const probe = new ProcessCpuLoadProbe({ loadAverageReader: (): number => 0.5, cpuCountReader: (): number => count });
      expect(() => probe.sample()).toThrow(/CPU count/);
    }
  });

  it('rejects a malformed TTL', () => {
    expect(() => new ProcessCpuLoadProbe({ sampleTtlMs: -1 })).toThrow(/sampleTtlMs/);
    expect(() => new ProcessCpuLoadProbe({ sampleTtlMs: Number.NaN })).toThrow(/sampleTtlMs/);
  });
});
