export interface McpProcessMemorySnapshot {
  readonly rssBytes: number;
  readonly heapTotalBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
}

export interface McpRuntimeRetentionSnapshot {
  /** null means no process-authoritative owner is exposed for this counter. */
  readonly tasks: number | null;
  readonly checkpoints: number | null;
  readonly hooks: number | null;
  readonly plugins: number | null;
  readonly sessionEntries: number | null;
  readonly worktrees: number | null;
  readonly activityInflight: number | null;
  readonly activityCompletedEntries: number | null;
  readonly activityCompletedEntryLimit: number | null;
  readonly incrementalVerificationEntries: number | null;
  readonly contextLedgerEntries: number | null;
  readonly toolAvailabilitySubscriptions: number | null;
}

export interface McpRuntimeDiagnosticsSnapshot {
  readonly source: string;
  readonly processMemory: McpProcessMemorySnapshot;
  readonly runtimeRetention: McpRuntimeRetentionSnapshot;
}

export function isMcpRuntimeDiagnosticsSnapshot(value: unknown): value is McpRuntimeDiagnosticsSnapshot {
  if (!isRecord(value) || typeof value.source !== 'string') return false;
  if (!isRecord(value.processMemory) || !isRecord(value.runtimeRetention)) return false;

  for (const key of ['rssBytes', 'heapTotalBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes'] as const) {
    if (!isCounter(value.processMemory[key])) return false;
  }

  for (const key of [
    'tasks',
    'checkpoints',
    'hooks',
    'plugins',
    'sessionEntries',
    'worktrees',
    'activityInflight',
    'activityCompletedEntries',
    'activityCompletedEntryLimit',
    'incrementalVerificationEntries',
    'contextLedgerEntries',
    'toolAvailabilitySubscriptions',
  ] as const) {
    if (!isCounterOrUnavailable(value.runtimeRetention[key])) return false;
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isCounterOrUnavailable(value: unknown): value is number | null {
  return value === null || isCounter(value);
}
