import type { Result } from '@unified-mpc/domain';
import type { ResourceAdmissionController, ResourceAdmissionLease } from '@unified-mpc/workspace';

const TERMINAL_PROCESS_STATES = new Set(['exited', 'failed', 'stopped', 'timed_out']);

export interface GoalProcessAdmissionBinding {
  readonly workspaceId: string;
  readonly processId: string;
  readonly lease: ResourceAdmissionLease;
  readonly readStatus: () => Result<unknown> | Promise<Result<unknown>>;
  /** Persist release before in-memory capacity is returned. False/throw keeps debt fail-closed. */
  readonly releaseDurable?: () => boolean;
  readonly initialStatus?: unknown;
}

export interface GoalProcessAdmissionTrackerOptions {
  readonly pollIntervalMs?: number;
}

/**
 * Process-owned bridge between Goal request admission and the actual managed
 * process lifetime. Bindings are shared by the process-level admission
 * controller so transient ToolRegistry instances cannot release capacity early.
 */
export class GoalProcessAdmissionTracker {
  private readonly processes = new Map<string, GoalProcessAdmissionBinding>();
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly controller: ResourceAdmissionController,
    options: GoalProcessAdmissionTrackerOptions = {},
  ) {
    this.pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
  }

  public bind(binding: GoalProcessAdmissionBinding): boolean {
    const key = processKey(binding.workspaceId, binding.processId);
    if (this.processes.has(key)) return false;
    this.processes.set(key, binding);
    if (isTerminalGoalProcessStatus(binding.initialStatus)) {
      if (!this.releaseBinding(key, binding)) this.schedulePoll();
      return true;
    }
    this.schedulePoll();
    return true;
  }

  public reconcile(workspaceId: string, processId: string, value: unknown): boolean {
    if (!isTerminalGoalProcessStatus(value)) return false;
    const key = processKey(workspaceId, processId);
    const binding = this.processes.get(key);
    return binding === undefined ? false : this.releaseBinding(key, binding);
  }

  public has(workspaceId: string, processId: string): boolean {
    return this.processes.has(processKey(workspaceId, processId));
  }

  private schedulePoll(): void {
    if (this.timer !== undefined || this.processes.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    const snapshot = [...this.processes.entries()];
    for (const [key, binding] of snapshot) {
      if (this.processes.get(key) !== binding) continue;
      try {
        const status = await binding.readStatus();
        if (status.ok) this.reconcile(binding.workspaceId, binding.processId, status.value);
      } catch {
        // Fail closed: unreadable process state keeps capacity reserved.
      }
    }
    this.schedulePoll();
  }

  private releaseBinding(key: string, binding: GoalProcessAdmissionBinding): boolean {
    if (this.processes.get(key) !== binding) return false;
    try {
      if (binding.releaseDurable?.() === false) return false;
    } catch {
      return false;
    }
    this.processes.delete(key);
    this.controller.release(binding.lease);
    return true;
  }
}

const sharedTrackers = new WeakMap<ResourceAdmissionController, GoalProcessAdmissionTracker>();

export function sharedProcessGoalProcessAdmissionTracker(
  controller: ResourceAdmissionController,
): GoalProcessAdmissionTracker {
  let tracker = sharedTrackers.get(controller);
  if (tracker === undefined) {
    tracker = new GoalProcessAdmissionTracker(controller);
    sharedTrackers.set(controller, tracker);
  }
  return tracker;
}

export function isTerminalGoalProcessStatus(value: unknown): boolean {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  return TERMINAL_PROCESS_STATES.has(value.state);
}

function processKey(workspaceId: string, processId: string): string {
  return `${workspaceId}\u0000${processId}`;
}

function normalizePollInterval(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : 250;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
