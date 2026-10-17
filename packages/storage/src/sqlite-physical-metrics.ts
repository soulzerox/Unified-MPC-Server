import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Physical SQLite space metrics (#210 SQLite physical-space boundary, §2-§3).
 *
 * Logical GC (revision prune / artifact GC) deletes rows but never shrinks the
 * database file. These metrics keep that distinction visible: logical counts
 * come from the canonical stores, physical bytes come from here. Nothing in
 * this module compacts, truncates, or forces a checkpoint — `PASSIVE`
 * checkpointing is bounded and non-destructive, and compaction stays an
 * explicit, evidence-driven decision by an existing owner (#145 scheduling),
 * never a side effect of pruning or GC.
 */

export type SqliteCheckpointMode = 'passive' | 'none';

export interface SqliteCheckpointReport {
  /** `passive` runs a bounded, non-blocking checkpoint; `none` only reports. */
  readonly mode: SqliteCheckpointMode;
  /** True when another reader/writer blocked the checkpoint. */
  readonly busy: boolean;
  /** WAL frames in the log at checkpoint time (-1 when unavailable). */
  readonly walPages: number;
  /** WAL frames copied back into the database (-1 when unavailable). */
  readonly checkpointedPages: number;
  /** Never true: this module does not truncate the WAL. */
  readonly truncated: false;
}

export interface SqlitePhysicalMetrics {
  readonly measuredAt: string;
  readonly inMemory: boolean;
  readonly databasePath: string | null;
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly shmBytes: number;
  readonly pageSizeBytes: number;
  readonly pageCount: number;
  readonly freelistCount: number;
  readonly freelistBytes: number;
  readonly liveBytes: number;
  /** Freelist share of the database file, 0..1. */
  readonly freelistRatio: number;
  readonly checkpoint: SqliteCheckpointReport;
  /**
   * Evidence only. Never an action: a caller that wants compaction must run a
   * real maintenance step under the existing owner fence.
   */
  readonly compactionRecommended: boolean;
  readonly compactionReason: string | null;
}

export interface SqlitePhysicalMetricsOptions {
  /** Freelist share of the file required before compaction is suggested. */
  readonly compactionFreelistRatio?: number;
  /** Absolute freelist size that must also be exceeded before suggesting. */
  readonly compactionMinFreelistBytes?: number;
  /** Bounded, non-blocking checkpoint reporting. Default `passive`. */
  readonly checkpointMode?: SqliteCheckpointMode;
}

const DEFAULT_COMPACTION_FREELIST_RATIO = 0.25;
const DEFAULT_COMPACTION_MIN_FREELIST_BYTES = 64 * 1024 * 1024;

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function readNumber(connection: DatabaseSync, pragma: string, column: string): number {
  try {
    const row = connection.prepare(`PRAGMA ${pragma};`).get() as Record<string, unknown> | undefined;
    const value = row?.[column];
    return typeof value === 'number' && Number.isFinite(value) ? value : -1;
  } catch {
    return -1;
  }
}

export function readSqlitePhysicalMetrics(
  connection: DatabaseSync,
  databasePath: string | null,
  options: SqlitePhysicalMetricsOptions = {},
): SqlitePhysicalMetrics {
  const ratioThreshold = options.compactionFreelistRatio ?? DEFAULT_COMPACTION_FREELIST_RATIO;
  const bytesThreshold = options.compactionMinFreelistBytes ?? DEFAULT_COMPACTION_MIN_FREELIST_BYTES;
  const checkpointMode: SqliteCheckpointMode = options.checkpointMode ?? 'passive';
  const inMemory = databasePath === null || databasePath === ':memory:';

  const pageSizeBytes = readNumber(connection, 'page_size', 'page_size');
  const pageCount = readNumber(connection, 'page_count', 'page_count');
  const freelistCount = readNumber(connection, 'freelist_count', 'freelist_count');

  const knownPages = pageSizeBytes >= 0 && pageCount >= 0 && freelistCount >= 0;
  const freelistBytes = knownPages ? freelistCount * pageSizeBytes : -1;
  const liveBytes = knownPages ? (pageCount - freelistCount) * pageSizeBytes : -1;
  const freelistRatio = knownPages && pageCount > 0 ? freelistCount / pageCount : 0;

  const checkpoint = readCheckpoint(connection, checkpointMode);

  const databaseBytes = inMemory ? -1 : fileSize(databasePath as string);
  const walBytes = inMemory ? -1 : fileSize(`${databasePath as string}-wal`);
  const shmBytes = inMemory ? -1 : fileSize(`${databasePath as string}-shm`);

  const compactionRecommended = knownPages
    && freelistBytes >= bytesThreshold
    && freelistRatio >= ratioThreshold;
  const compactionReason = compactionRecommended
    ? `freelist ${freelistBytes} bytes (${(freelistRatio * 100).toFixed(1)}%) exceeds ${bytesThreshold} bytes / ${(ratioThreshold * 100).toFixed(0)}% thresholds`
    : null;

  return {
    measuredAt: new Date().toISOString(),
    inMemory,
    databasePath: inMemory ? null : databasePath,
    databaseBytes,
    walBytes,
    shmBytes,
    pageSizeBytes,
    pageCount,
    freelistCount,
    freelistBytes,
    liveBytes,
    freelistRatio,
    checkpoint,
    compactionRecommended,
    compactionReason,
  };
}

function readCheckpoint(connection: DatabaseSync, mode: SqliteCheckpointMode): SqliteCheckpointReport {
  if (mode === 'none') {
    return { mode: 'none', busy: false, walPages: -1, checkpointedPages: -1, truncated: false };
  }
  try {
    // PASSIVE never blocks readers and never truncates the WAL.
    const row = connection.prepare('PRAGMA wal_checkpoint(PASSIVE);').get() as Record<string, unknown> | undefined;
    const number = (key: string): number => {
      const value = row?.[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : -1;
    };
    return {
      mode: 'passive',
      busy: number('busy') === 1,
      walPages: number('log'),
      checkpointedPages: number('checkpointed'),
      truncated: false,
    };
  } catch {
    return { mode: 'passive', busy: false, walPages: -1, checkpointedPages: -1, truncated: false };
  }
}