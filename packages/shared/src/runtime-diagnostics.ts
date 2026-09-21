export interface McpProcessMemorySnapshot {
  readonly rssBytes: number;
  readonly heapTotalBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
}

export interface McpRuntimeRetentionSnapshot {
  readonly tasks: number;
  readonly checkpoints: number;
  readonly hooks: number;
  readonly plugins: number;
  readonly sessionEntries: number;
  readonly worktrees: number;
  readonly activityInflight: number;
  readonly activityCompletedEntries: number;
  readonly activityCompletedEntryLimit: number;
  readonly incrementalVerificationEntries: number;
  readonly contextLedgerEntries: number;
  readonly toolAvailabilitySubscriptions: number;
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
    if (!isCounter(value.runtimeRetention[key])) return false;
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
