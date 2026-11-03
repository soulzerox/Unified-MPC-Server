import type { SqlitePhysicalMetrics } from '@unified-mpc/storage';

/**
 * Operator surface for the #210 SQLite physical-space boundary.
 *
 * Logical GC removes rows; it never shrinks the database file. These metrics
 * keep that distinction visible, and they are evidence only: nothing here
 * checkpoints destructively, vacuums, or truncates. A caller that wants
 * compaction runs the bounded maintenance cycle under the existing owner fence.
 */
export interface StorageMetricsRunner {
  metrics(): Promise<SqlitePhysicalMetrics>;
}

export function formatStorageMetrics(metrics: SqlitePhysicalMetrics): string {
  const checkpoint = metrics.checkpoint;
  return [
    `database\t${metrics.databasePath ?? 'in-memory'}`,
    `bytes\tdb=${metrics.databaseBytes} wal=${metrics.walBytes} shm=${metrics.shmBytes} live=${metrics.liveBytes}`,
    `pages\tsize=${metrics.pageSizeBytes} count=${metrics.pageCount} freelist=${metrics.freelistCount} (${metrics.freelistBytes} bytes, ${metrics.freelistRatio.toFixed(4)})`,
    `checkpoint\tmode=${checkpoint.mode} busy=${String(checkpoint.busy)} walPages=${checkpoint.walPages} checkpointedPages=${checkpoint.checkpointedPages} truncated=${String(checkpoint.truncated)}`,
    `compaction\trecommended=${String(metrics.compactionRecommended)} reason=${metrics.compactionReason ?? 'none'}`,
  ].join('\n');
}

export async function runStorageMetricsCommand(
  service: StorageMetricsRunner | undefined,
  json: boolean,
  write: (text: string) => void,
  writeError: (text: string) => void,
): Promise<number> {
  if (service === undefined) {
    writeError('Storage metrics service is not available');
    return 1;
  }
  try {
    const metrics = await service.metrics();
    if (json) {
      write(JSON.stringify(metrics));
    } else {
      // One `write` per line matches the other CLI reports and keeps a caller's
      // line-oriented assertions honest.
      for (const line of formatStorageMetrics(metrics).split('\n')) write(line);
    }
    return 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
