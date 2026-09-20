import { describe, expect, it } from 'vitest';
import { ProcessMemoryPressureProbe } from './resource-pressure.js';

describe('process memory pressure probe', () => {
  it('classifies normal, elevated and critical available-memory ratios with configurable thresholds', () => {
    let availableMemoryBytes = 500;
    let now = 1;
    const probe = new ProcessMemoryPressureProbe({
      elevatedAvailableRatio: 0.2,
      criticalAvailableRatio: 0.1,
      sampleTtlMs: 0,
      memoryReader: (): { totalMemoryBytes: number; availableMemoryBytes: number } => ({
        totalMemoryBytes: 1_000,
        availableMemoryBytes,
      }),
      processRssReader: (): number => 123,
      now: (): number => now++,
    });

    expect(probe.sample()).toMatchObject({ state: 'normal', availableRatio: 0.5, processRssBytes: 123 });
    availableMemoryBytes = 150;
    expect(probe.sample()).toMatchObject({ state: 'elevated', availableRatio: 0.15 });
    availableMemoryBytes = 50;
    expect(probe.sample()).toMatchObject({ state: 'critical', availableRatio: 0.05 });
  });

  it('caches the lightweight OS sample for the configured TTL', () => {
    let reads = 0;
    let now = 1_000;
    const probe = new ProcessMemoryPressureProbe({
      sampleTtlMs: 500,
      memoryReader: (): { totalMemoryBytes: number; availableMemoryBytes: number } => {
        reads += 1;
        return { totalMemoryBytes: 1_000, availableMemoryBytes: 500 };
      },
      processRssReader: (): number => 123,
      now: (): number => now,
    });

    const first = probe.sample();
    now = 1_200;
    const cached = probe.sample();
    now = 1_501;
    const refreshed = probe.sample();

    expect(cached).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(reads).toBe(2);
  });
});
