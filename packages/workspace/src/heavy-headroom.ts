/**
 * Measured headroom for extra heavy-job slots (#145).
 *
 * The configured heavy cap is the floor and the hard ceiling. This module only
 * decides how many extra slots the *current* memory sample can support; it
 * never overrides class, workspace, session, global-cost or operation limits.
 *
 * The estimate is deliberately conservative: one extra heavy job needs
 * `bytesPerExtraHeavyJob` after `reserveBytes` is kept free for the OS and the
 * unified runtime. Total RAM is never an input, so a machine with 16 GiB total
 * and 3 GiB available is not treated as a two-job host.
 */
import type { ResourcePressureState } from './resource-pressure.js';

/** Headroom policy for extra heavy slots. */
export interface HeavyHeadroomLimits {
  /** Extra heavy slots allowed above the configured cap; `0` disables. */
  readonly maxExtraHeavyJobs: number;
  /** Conservative memory estimate for one extra heavy job. */
  readonly bytesPerExtraHeavyJob: number;
  /** Memory kept free for the OS/runtime before extra slots count. */
  readonly reserveBytes: number;
}

export interface NormalizedHeavyHeadroom {
  readonly maxExtraHeavyJobs: number;
  readonly bytesPerExtraHeavyJob: number;
  readonly reserveBytes: number;
}

/** Minimal live sample the policy needs; `ResourcePressureSample` satisfies it. */
export interface HeavyHeadroomSample {
  readonly state: ResourcePressureState;
  readonly availableMemoryBytes: number;
}

export const DEFAULT_HEAVY_MAX_EXTRA_JOBS = 1;
export const DEFAULT_HEAVY_BYTES_PER_EXTRA_JOB = 4 * 1024 ** 3;
export const DEFAULT_HEAVY_HEADROOM_RESERVE_BYTES = 2 * 1024 ** 3;

export const HEAVY_HEADROOM_ENV_KEYS = {
  maxExtraHeavyJobs: 'UNIFIED_MPC_HEAVY_MAX_EXTRA_JOBS',
  bytesPerExtraHeavyJob: 'UNIFIED_MPC_HEAVY_JOB_MEMORY_BYTES',
  reserveBytes: 'UNIFIED_MPC_HEAVY_HEADROOM_RESERVE_BYTES',
} as const;

/** Fill defaults and reject malformed policy values at construction time. */
export function normalizeHeavyHeadroom(limits: Partial<HeavyHeadroomLimits> = {}): NormalizedHeavyHeadroom {
  const maxExtraHeavyJobs = limits.maxExtraHeavyJobs ?? DEFAULT_HEAVY_MAX_EXTRA_JOBS;
  const bytesPerExtraHeavyJob = limits.bytesPerExtraHeavyJob ?? DEFAULT_HEAVY_BYTES_PER_EXTRA_JOB;
  const reserveBytes = limits.reserveBytes ?? DEFAULT_HEAVY_HEADROOM_RESERVE_BYTES;
  if (!Number.isSafeInteger(maxExtraHeavyJobs) || maxExtraHeavyJobs < 0) {
    throw new RangeError('maxExtraHeavyJobs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(bytesPerExtraHeavyJob) || bytesPerExtraHeavyJob < 1) {
    throw new RangeError('bytesPerExtraHeavyJob must be a positive safe integer');
  }
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new RangeError('reserveBytes must be a non-negative safe integer');
  }
  return { maxExtraHeavyJobs, bytesPerExtraHeavyJob, reserveBytes };
}

/**
 * Effective heavy cap for one admission decision. A missing, malformed, or
 * non-normal sample fails closed to the configured base cap.
 */
export function effectiveHeavyCapacity(
  baseMaxHeavyOperations: number,
  limits: NormalizedHeavyHeadroom,
  sample: HeavyHeadroomSample | undefined,
): number {
  if (!Number.isSafeInteger(baseMaxHeavyOperations) || baseMaxHeavyOperations < 1) {
    throw new RangeError('baseMaxHeavyOperations must be a positive safe integer');
  }
  if (limits.maxExtraHeavyJobs === 0) return baseMaxHeavyOperations;
  if (sample === undefined || sample.state !== 'normal') return baseMaxHeavyOperations;
  const available = sample.availableMemoryBytes;
  if (!Number.isFinite(available) || available < 0) return baseMaxHeavyOperations;
  const usable = available - limits.reserveBytes;
  if (usable <= 0) return baseMaxHeavyOperations;
  const extraByMemory = Math.floor(usable / limits.bytesPerExtraHeavyJob);
  if (!Number.isFinite(extraByMemory) || extraByMemory < 1) return baseMaxHeavyOperations;
  return baseMaxHeavyOperations + Math.min(limits.maxExtraHeavyJobs, extraByMemory);
}

/**
 * Process-wide headroom policy. Blank values are unset; malformed values fail
 * controller creation with the variable name instead of silently changing the
 * cap.
 */
export function heavyHeadroomFromEnv(env: NodeJS.ProcessEnv = process.env): NormalizedHeavyHeadroom {
  return normalizeHeavyHeadroom({
    maxExtraHeavyJobs: readEnvInteger(
      env,
      HEAVY_HEADROOM_ENV_KEYS.maxExtraHeavyJobs,
      DEFAULT_HEAVY_MAX_EXTRA_JOBS,
      0,
    ),
    bytesPerExtraHeavyJob: readEnvInteger(
      env,
      HEAVY_HEADROOM_ENV_KEYS.bytesPerExtraHeavyJob,
      DEFAULT_HEAVY_BYTES_PER_EXTRA_JOB,
      1,
    ),
    reserveBytes: readEnvInteger(
      env,
      HEAVY_HEADROOM_ENV_KEYS.reserveBytes,
      DEFAULT_HEAVY_HEADROOM_RESERVE_BYTES,
      0,
    ),
  });
}

function readEnvInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${key} must be a ${minimum === 0 ? 'non-negative' : 'positive'} integer`);
  }
  return value;
}
