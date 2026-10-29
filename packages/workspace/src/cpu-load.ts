import { cpus, loadavg } from 'node:os';

/** Live CPU signal used by measured heavy-job headroom (#145). */
export interface CpuLoadSample {
  /** 1-minute load average (runnable + uninterruptible tasks). */
  readonly loadAverage1m: number;
  /** Online CPU count used to normalize the load average. */
  readonly cpuCount: number;
  readonly sampledAtMs: number;
}

export interface CpuLoadProbe {
  sample(): CpuLoadSample;
}

export interface ProcessCpuLoadProbeOptions {
  readonly loadAverageReader?: () => number;
  readonly cpuCountReader?: () => number;
  readonly sampleTtlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_SAMPLE_TTL_MS = 1_000;

/**
 * Lightweight cached process CPU sample.
 *
 * The load average is the cheapest cross-platform signal Node exposes. It is
 * deliberately sampled once per TTL so hot admission paths do not repeatedly
 * query the OS, and a malformed reading throws: the admission caller fails
 * closed instead of widening capacity from a bad sample.
 */
export class ProcessCpuLoadProbe implements CpuLoadProbe {
  private readonly loadAverageReader: NonNullable<ProcessCpuLoadProbeOptions['loadAverageReader']>;
  private readonly cpuCountReader: NonNullable<ProcessCpuLoadProbeOptions['cpuCountReader']>;
  private readonly sampleTtlMs: number;
  private readonly now: NonNullable<ProcessCpuLoadProbeOptions['now']>;
  private cached: CpuLoadSample | undefined;

  public constructor(options: ProcessCpuLoadProbeOptions = {}) {
    this.loadAverageReader = options.loadAverageReader ?? ((): number => loadavg()[0] ?? Number.NaN);
    this.cpuCountReader = options.cpuCountReader ?? ((): number => cpus().length);
    this.sampleTtlMs = options.sampleTtlMs ?? DEFAULT_SAMPLE_TTL_MS;
    if (!Number.isFinite(this.sampleTtlMs) || this.sampleTtlMs < 0) {
      throw new Error('sampleTtlMs must be a non-negative finite number');
    }
    this.now = options.now ?? Date.now;
  }

  public sample(): CpuLoadSample {
    const sampledAtMs = this.now();
    const cached = this.cached;
    if (
      cached !== undefined
      && sampledAtMs >= cached.sampledAtMs
      && sampledAtMs - cached.sampledAtMs <= this.sampleTtlMs
    ) {
      return cached;
    }

    const loadAverage1m = this.loadAverageReader();
    if (!Number.isFinite(loadAverage1m) || loadAverage1m < 0) {
      throw new Error('1-minute load average must be a non-negative finite number');
    }
    const cpuCount = this.cpuCountReader();
    if (!Number.isSafeInteger(cpuCount) || cpuCount < 1) {
      throw new Error('CPU count must be a positive safe integer');
    }

    const sample: CpuLoadSample = Object.freeze({ loadAverage1m, cpuCount, sampledAtMs });
    this.cached = sample;
    return sample;
  }
}
