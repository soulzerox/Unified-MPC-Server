import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';

export type ResourcePressureState = 'normal' | 'elevated' | 'critical';

export interface ResourcePressureSample {
  readonly state: ResourcePressureState;
  readonly totalMemoryBytes: number;
  readonly availableMemoryBytes: number;
  readonly availableRatio: number;
  readonly processRssBytes: number;
  readonly sampledAtMs: number;
}

export interface ResourcePressureProbe {
  sample(): ResourcePressureSample;
}

export interface ProcessMemoryPressureProbeOptions {
  readonly elevatedAvailableRatio?: number;
  readonly criticalAvailableRatio?: number;
  readonly sampleTtlMs?: number;
  readonly memoryReader?: () => {
    readonly totalMemoryBytes: number;
    readonly availableMemoryBytes: number;
  };
  readonly processRssReader?: () => number;
  readonly now?: () => number;
}

const DEFAULT_ELEVATED_AVAILABLE_RATIO = 0.2;
const DEFAULT_CRITICAL_AVAILABLE_RATIO = 0.1;
const DEFAULT_SAMPLE_TTL_MS = 1_000;

/**
 * Lightweight cached process/OS memory pressure signal.
 *
 * Linux prefers /proc/meminfo MemAvailable so reclaimable page cache is not
 * mistaken for exhausted memory. Other platforms, or unreadable /proc, fall
 * back to Node's portable OS counters. The sample is cached so hot admission
 * paths do not repeatedly query the OS.
 */
export class ProcessMemoryPressureProbe implements ResourcePressureProbe {
  private readonly elevatedAvailableRatio: number;
  private readonly criticalAvailableRatio: number;
  private readonly sampleTtlMs: number;
  private readonly memoryReader: NonNullable<ProcessMemoryPressureProbeOptions['memoryReader']>;
  private readonly processRssReader: NonNullable<ProcessMemoryPressureProbeOptions['processRssReader']>;
  private readonly now: NonNullable<ProcessMemoryPressureProbeOptions['now']>;
  private cached: ResourcePressureSample | undefined;

  public constructor(options: ProcessMemoryPressureProbeOptions = {}) {
    this.elevatedAvailableRatio = options.elevatedAvailableRatio ?? DEFAULT_ELEVATED_AVAILABLE_RATIO;
    this.criticalAvailableRatio = options.criticalAvailableRatio ?? DEFAULT_CRITICAL_AVAILABLE_RATIO;
    this.sampleTtlMs = options.sampleTtlMs ?? DEFAULT_SAMPLE_TTL_MS;
    validateRatio(this.elevatedAvailableRatio, 'elevatedAvailableRatio');
    validateRatio(this.criticalAvailableRatio, 'criticalAvailableRatio');
    if (this.criticalAvailableRatio > this.elevatedAvailableRatio) {
      throw new Error('criticalAvailableRatio must be <= elevatedAvailableRatio');
    }
    if (!Number.isFinite(this.sampleTtlMs) || this.sampleTtlMs < 0) {
      throw new Error('sampleTtlMs must be a non-negative finite number');
    }

    this.memoryReader = options.memoryReader ?? defaultMemoryReader;
    this.processRssReader = options.processRssReader ?? ((): number => process.memoryUsage().rss);
    this.now = options.now ?? Date.now;
  }

  public sample(): ResourcePressureSample {
    const sampledAtMs = this.now();
    const cached = this.cached;
    if (
      cached !== undefined
      && sampledAtMs >= cached.sampledAtMs
      && sampledAtMs - cached.sampledAtMs <= this.sampleTtlMs
    ) {
      return cached;
    }

    const memory = this.memoryReader();
    validateMemory(memory.totalMemoryBytes, memory.availableMemoryBytes);
    const totalMemoryBytes = memory.totalMemoryBytes;
    const availableMemoryBytes = Math.min(memory.availableMemoryBytes, totalMemoryBytes);
    const availableRatio = totalMemoryBytes === 0 ? 0 : availableMemoryBytes / totalMemoryBytes;
    const processRssBytes = this.processRssReader();
    if (!Number.isFinite(processRssBytes) || processRssBytes < 0) {
      throw new Error('process RSS must be a non-negative finite number');
    }

    const state: ResourcePressureState = availableRatio <= this.criticalAvailableRatio
      ? 'critical'
      : availableRatio <= this.elevatedAvailableRatio
        ? 'elevated'
        : 'normal';

    const sample: ResourcePressureSample = Object.freeze({
      state,
      totalMemoryBytes,
      availableMemoryBytes,
      availableRatio,
      processRssBytes,
      sampledAtMs,
    });
    this.cached = sample;
    return sample;
  }
}

function defaultMemoryReader(): { readonly totalMemoryBytes: number; readonly availableMemoryBytes: number } {
  if (process.platform === 'linux') {
    const linuxMemory = tryReadLinuxAvailableMemory();
    if (linuxMemory !== undefined) return linuxMemory;
  }
  return {
    totalMemoryBytes: totalmem(),
    availableMemoryBytes: freemem(),
  };
}

function tryReadLinuxAvailableMemory(): { readonly totalMemoryBytes: number; readonly availableMemoryBytes: number } | undefined {
  try {
    return parseLinuxMeminfo(readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return undefined;
  }
}

function parseLinuxMeminfo(value: string): { readonly totalMemoryBytes: number; readonly availableMemoryBytes: number } | undefined {
  const totalMatch = /^MemTotal:\s+(\d+)\s+kB$/mu.exec(value);
  const availableMatch = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(value);
  if (totalMatch === null || availableMatch === null) return undefined;

  const totalKiB = Number.parseInt(totalMatch[1] ?? '', 10);
  const availableKiB = Number.parseInt(availableMatch[1] ?? '', 10);
  if (!Number.isFinite(totalKiB) || totalKiB <= 0 || !Number.isFinite(availableKiB) || availableKiB < 0) {
    return undefined;
  }

  return {
    totalMemoryBytes: totalKiB * 1024,
    availableMemoryBytes: availableKiB * 1024,
  };
}

function validateRatio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite ratio between 0 and 1`);
  }
}

function validateMemory(totalMemoryBytes: number, availableMemoryBytes: number): void {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new Error('total memory must be a positive finite number');
  }
  if (!Number.isFinite(availableMemoryBytes) || availableMemoryBytes < 0) {
    throw new Error('available memory must be a non-negative finite number');
  }
}
