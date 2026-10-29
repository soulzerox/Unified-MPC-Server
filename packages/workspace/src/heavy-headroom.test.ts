import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAVY_BYTES_PER_EXTRA_JOB,
  DEFAULT_HEAVY_HEADROOM_RESERVE_BYTES,
  DEFAULT_HEAVY_MAX_EXTRA_JOBS,
  DEFAULT_HEAVY_MAX_LOAD_PER_CORE,
  effectiveHeavyCapacity,
  heavyHeadroomFromEnv,
  normalizeHeavyHeadroom,
  type HeavyHeadroomLimits,
  type HeavyHeadroomSample,
} from './heavy-headroom.js';

const GIB = 1024 ** 3;

function limits(overrides: Partial<HeavyHeadroomLimits> = {}): HeavyHeadroomLimits {
  return { ...normalizeHeavyHeadroom(), ...overrides };
}

function sample(
  state: 'normal' | 'elevated' | 'critical',
  availableMemoryBytes: number,
  loadAverage1m = 0.5,
  cpuCount = 8,
): HeavyHeadroomSample {
  return { state, availableMemoryBytes, loadAverage1m, cpuCount };
}

describe('heavy headroom policy (#145)', () => {
  it('defaults to one base slot and one bounded extra slot', () => {
    expect(normalizeHeavyHeadroom()).toEqual({
      maxExtraHeavyJobs: DEFAULT_HEAVY_MAX_EXTRA_JOBS,
      bytesPerExtraHeavyJob: DEFAULT_HEAVY_BYTES_PER_EXTRA_JOB,
      reserveBytes: DEFAULT_HEAVY_HEADROOM_RESERVE_BYTES,
      maxLoadPerCore: DEFAULT_HEAVY_MAX_LOAD_PER_CORE,
    });
  });

  it('keeps the base cap when extra slots are disabled', () => {
    expect(effectiveHeavyCapacity(
      1,
      limits({ maxExtraHeavyJobs: 0 }),
      sample('normal', 64 * GIB),
    )).toBe(1);
  });

  it('adds the bounded extra slot when normal pressure leaves enough memory', () => {
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', 16 * GIB))).toBe(2);
  });

  it('never exceeds maxExtraHeavyJobs even with abundant memory', () => {
    expect(effectiveHeavyCapacity(
      1,
      limits({ maxExtraHeavyJobs: 2 }),
      sample('normal', 128 * GIB),
    )).toBe(3);
  });

  it('denies extra slots when the CPU load exceeds the per-core ceiling', () => {
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', 16 * GIB, 4.1, 8))).toBe(1);
  });

  it('allows extra slots at exactly the per-core ceiling', () => {
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', 16 * GIB, 4, 8))).toBe(2);
  });

  it('fails closed when the CPU sample is missing or malformed', () => {
    expect(effectiveHeavyCapacity(1, limits(), { state: 'normal', availableMemoryBytes: 16 * GIB })).toBe(1);
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', 16 * GIB, Number.NaN))).toBe(1);
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', 16 * GIB, 0, 0))).toBe(1);
  });

  it('treats maxLoadPerCore=0 as a disabled CPU gate', () => {
    expect(effectiveHeavyCapacity(1, limits({ maxLoadPerCore: 0 }), sample('normal', 16 * GIB, 64, 8))).toBe(2);
  });

  it('requires the full per-job estimate before each extra slot', () => {
    // 2 GiB usable by the formula is less than the 4 GiB estimate: no extra.
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', 4 * GIB))).toBe(1);
    // Exactly one estimate after the reserve: one extra slot.
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', 6 * GIB))).toBe(2);
  });

  it('treats the reserve as unusable memory', () => {
    expect(effectiveHeavyCapacity(
      1,
      limits({ reserveBytes: 2 * GIB }),
      sample('normal', 2 * GIB),
    )).toBe(1);
  });

  it('drops extra slots under elevated or critical pressure', () => {
    expect(effectiveHeavyCapacity(1, limits(), sample('elevated', 64 * GIB))).toBe(1);
    expect(effectiveHeavyCapacity(1, limits(), sample('critical', 64 * GIB))).toBe(1);
  });

  it('fails closed without a pressure sample', () => {
    expect(effectiveHeavyCapacity(1, limits(), undefined)).toBe(1);
  });

  it('fails closed on malformed available memory', () => {
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', Number.NaN))).toBe(1);
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', -1))).toBe(1);
    expect(effectiveHeavyCapacity(1, limits(), sample('normal', Number.POSITIVE_INFINITY))).toBe(1);
  });

  it('keeps a larger configured base cap', () => {
    expect(effectiveHeavyCapacity(2, limits(), sample('normal', 6 * GIB))).toBe(3);
  });

  it('rejects invalid policy values', () => {
    expect(() => normalizeHeavyHeadroom({ maxExtraHeavyJobs: -1 })).toThrow(RangeError);
    expect(() => normalizeHeavyHeadroom({ maxExtraHeavyJobs: 1.5 })).toThrow(RangeError);
    expect(() => normalizeHeavyHeadroom({ bytesPerExtraHeavyJob: 0 })).toThrow(RangeError);
    expect(() => normalizeHeavyHeadroom({ reserveBytes: -1 })).toThrow(RangeError);
    expect(() => normalizeHeavyHeadroom({ maxLoadPerCore: -1 })).toThrow(RangeError);
    expect(() => normalizeHeavyHeadroom({ maxLoadPerCore: Number.NaN })).toThrow(RangeError);
  });

  it('rejects an invalid base cap', () => {
    expect(() => effectiveHeavyCapacity(0, limits(), sample('normal', 64 * GIB))).toThrow(RangeError);
  });
});

describe('heavy headroom environment (#145)', () => {
  it('uses the defaults when the environment is empty', () => {
    expect(heavyHeadroomFromEnv({})).toEqual(normalizeHeavyHeadroom());
  });

  it('treats blank values as unset', () => {
    expect(heavyHeadroomFromEnv({
      UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS: '  ',
      UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES: '',
      UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES: ' ',
      UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE: ' ',
    })).toEqual(normalizeHeavyHeadroom());
  });

  it('reads valid overrides', () => {
    expect(heavyHeadroomFromEnv({
      UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS: '2',
      UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES: String(6 * GIB),
      UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES: '0',
      UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE: '0.75',
    })).toEqual({
      maxExtraHeavyJobs: 2,
      bytesPerExtraHeavyJob: 6 * GIB,
      reserveBytes: 0,
      maxLoadPerCore: 0.75,
    });
  });

  it('rejects invalid values with the variable name', () => {
    expect(() => heavyHeadroomFromEnv({ UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS: '-1' }))
      .toThrow(/UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS/);
    expect(() => heavyHeadroomFromEnv({ UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES: '1.5' }))
      .toThrow(/UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES/);
    expect(() => heavyHeadroomFromEnv({ UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES: 'abc' }))
      .toThrow(/UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES/);
    expect(() => heavyHeadroomFromEnv({ UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE: 'abc' }))
      .toThrow(/UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE/);
    expect(() => heavyHeadroomFromEnv({ UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE: '-0.1' }))
      .toThrow(/UNIFIED_MPC_HEAVY_MAX_LOAD_PER_CORE/);
  });
});
