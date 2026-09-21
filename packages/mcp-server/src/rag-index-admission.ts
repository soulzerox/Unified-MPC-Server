import type { Result } from '@unified-mpc/domain';
import type { ResourceAdmissionController, ResourceAdmissionLease } from '@unified-mpc/workspace';

const TERMINAL_INDEX_JOB_STATUSES = new Set([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
  'legacy-unavailable',
  'done',
  'error',
]);

export interface RagIndexAdmissionBinding {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly lease: ResourceAdmissionLease;
  readonly readStatus: () => Promise<Result<unknown>>;
  readonly initialStatus?: unknown;
}

export interface RagIndexAdmissionTrackerOptions {
  readonly pollIntervalMs?: number;
}

/**
 * Process-owned bridge between request-time admission and durable RAG job
 * lifetime. Shared trackers are keyed by the process-owned admission controller,
 * so bindings survive transient ToolRegistry instances.
 */
export class RagIndexAdmissionTracker {
  private readonly jobs = new Map<string, RagIndexAdmissionBinding>();
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly controller: ResourceAdmissionController,
    options: RagIndexAdmissionTrackerOptions = {},
  ) {
    this.pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
  }

  /**
   * Takes ownership of an already-acquired lease. False means the same durable
   * job is already tracked and the caller still owns the supplied lease.
   */
  public bind(binding: RagIndexAdmissionBinding): boolean {
    const key = jobKey(binding.workspaceId, binding.jobId);
    if (this.jobs.has(key)) return false;
    this.jobs.set(key, binding);
    if (isTerminalRagIndexJobStatus(binding.initialStatus)) {
      this.releaseBinding(key, binding);
      return true;
    }
    this.schedulePoll();
    return true;
  }

  public reconcile(workspaceId: string, jobId: string, value: unknown): boolean {
    if (!isTerminalRagIndexJobStatus(value)) return false;
    const key = jobKey(workspaceId, jobId);
    const binding = this.jobs.get(key);
    return binding === undefined ? false : this.releaseBinding(key, binding);
  }

  public has(workspaceId: string, jobId: string): boolean {
    return this.jobs.has(jobKey(workspaceId, jobId));
  }

  private schedulePoll(): void {
    if (this.timer !== undefined || this.jobs.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    const snapshot = [...this.jobs.entries()];
    for (const [key, binding] of snapshot) {
      if (this.jobs.get(key) !== binding) continue;
      try {
        const status = await binding.readStatus();
        if (status.ok) this.reconcile(binding.workspaceId, binding.jobId, status.value);
      } catch {
        // Fail closed: unreadable status keeps its admission lease.
      }
    }
    this.schedulePoll();
  }

  private releaseBinding(key: string, binding: RagIndexAdmissionBinding): boolean {
    if (this.jobs.get(key) !== binding) return false;
    this.jobs.delete(key);
    this.controller.release(binding.lease);
    return true;
  }
}

const sharedTrackers = new WeakMap<ResourceAdmissionController, RagIndexAdmissionTracker>();

export function sharedProcessRagIndexAdmissionTracker(
  controller: ResourceAdmissionController,
): RagIndexAdmissionTracker {
  let tracker = sharedTrackers.get(controller);
  if (tracker === undefined) {
    tracker = new RagIndexAdmissionTracker(controller);
    sharedTrackers.set(controller, tracker);
  }
  return tracker;
}

export function isTerminalRagIndexJobStatus(value: unknown): boolean {
  const status = readStatus(value);
  return status !== undefined && TERMINAL_INDEX_JOB_STATUSES.has(status);
}

function readStatus(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status === 'string') return value.status;
  if (isRecord(value.data) && typeof value.data.status === 'string') return value.data.status;
  return undefined;
}

function jobKey(workspaceId: string, jobId: string): string {
  return `${workspaceId}\u0000${jobId}`;
}

function normalizePollInterval(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : 250;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
