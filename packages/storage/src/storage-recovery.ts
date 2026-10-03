import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  applyPendingSqliteRestoreSync,
  createPreMigrationBackupSync,
  SqliteBackupService,
} from './backup-service.js';
import { SqliteDatabase } from './database.js';
import {
  inspectStorageIdentity,
  type StorageIdentityOptions,
  type StorageIdentityInspection,
} from './storage-identity.js';

export type StorageRecoveryErrorCode =
  | 'STORAGE_RECOVERY_AMBIGUOUS'
  | 'STORAGE_RECOVERY_CONFLICT'
  | 'STORAGE_RECOVERY_SOURCE_UNAVAILABLE'
  | 'STORAGE_RECOVERY_FAILED';

export interface StorageRecoveryOptions extends StorageIdentityOptions {
  readonly arch?: string;
  readonly now?: () => Date;
}

export interface StorageRecoveryResult {
  readonly status: 'recovered' | 'not_needed';
  readonly sourcePath: string | null;
  readonly destinationPath: string;
  readonly canonicalBackupId: string | null;
  readonly sourceBackupId: string | null;
  readonly migratedBackupId: string | null;
  readonly provenancePath: string | null;
}

export interface StorageRecoveryProvenance {
  readonly schemaVersion: 1;
  readonly status: 'prepared' | 'completed';
  readonly method: 'sqlite_backup_restore';
  readonly recoveredAt: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceBackupId: string;
  readonly migratedBackupId: string;
  readonly canonicalBackupId: string | null;
}

export class StorageRecoveryError extends Error {
  public constructor(
    public readonly code: StorageRecoveryErrorCode,
    message: string,
    public readonly inspection?: StorageIdentityInspection,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'StorageRecoveryError';
  }
}

/**
 * Explicitly recover one unambiguous historical Unified-MPC SQLite database
 * into the canonical data root.
 *
 * The historical source is never mutated. Recovery first takes a SQLite-level
 * snapshot (so WAL state is included), preserves that pre-migration snapshot,
 * migrates only the temporary copy, then restores the migrated backup through
 * the existing atomic restore path. A populated canonical database is never
 * overwritten automatically.
 */
export async function recoverHistoricalStorageIdentity(
  canonicalDataRoot: string,
  options: StorageRecoveryOptions = {},
): Promise<StorageRecoveryResult> {
  const canonicalRoot = path.resolve(canonicalDataRoot);
  const destinationPath = path.join(canonicalRoot, 'unified-mpc.sqlite');
  const backupDirectory = path.join(canonicalRoot, 'backups');
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const now = options.now ?? ((): Date => new Date());
  const inspection = inspectStorageIdentity(canonicalRoot, options);

  if (inspection.canonical.exists && !inspection.canonical.readable) {
    throw new StorageRecoveryError(
      'STORAGE_RECOVERY_CONFLICT',
      `canonical SQLite database cannot be inspected safely: ${destinationPath}`,
      inspection,
    );
  }

  if (!inspection.recoveryRequired) {
    return notNeeded(destinationPath);
  }

  const readableCandidates = inspection.historical.filter(
    (candidate) => candidate.readable && (candidate.gatewaySettingCount ?? 0) > 0,
  );
  if (readableCandidates.length > 1) {
    throw new StorageRecoveryError(
      'STORAGE_RECOVERY_AMBIGUOUS',
      `multiple historical gateway databases are plausible recovery sources: ${readableCandidates.map((candidate) => candidate.sqlitePath).join(', ')}`,
      inspection,
    );
  }

  const source = readableCandidates[0];
  if (source === undefined) {
    const unreadable = inspection.historical.filter((candidate) => !candidate.readable);
    throw new StorageRecoveryError(
      'STORAGE_RECOVERY_SOURCE_UNAVAILABLE',
      unreadable.length > 0
        ? `historical SQLite candidate cannot be inspected safely: ${unreadable.map((candidate) => candidate.sqlitePath).join(', ')}`
        : 'no readable historical gateway database is available for recovery',
      inspection,
    );
  }

  if (inspection.canonical.exists) assertCanonicalReplaceable(destinationPath, inspection);

  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(backupDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(canonicalRoot, '.storage-recovery-'));
  const snapshotPath = path.join(temporaryDirectory, 'historical-snapshot.sqlite');
  let migratedDatabase: SqliteDatabase | undefined;
  let pendingProvenancePath: string | undefined;

  try {
    await snapshotHistoricalDatabase(source.sqlitePath, snapshotPath);

    const sourceSnapshot = new DatabaseSync(snapshotPath);
    let sourceBackupId: string;
    try {
      sourceBackupId = createPreMigrationBackupSync(sourceSnapshot, backupDirectory, platform, arch).id;
    } finally {
      sourceSnapshot.close();
    }

    migratedDatabase = new SqliteDatabase(snapshotPath);
    const migratedBackupService = new SqliteBackupService(migratedDatabase, {
      databaseFilename: snapshotPath,
      backupDirectory,
      platform,
      arch,
      now,
    });
    const migratedBackup = await migratedBackupService.create('manual');

    // Re-check immediately before replacement so a concurrent writer cannot
    // turn a previously fresh canonical DB into data-bearing state unnoticed.
    let canonicalBackupId: string | null = null;
    if (existsSync(destinationPath)) {
      assertCanonicalReplaceable(destinationPath, inspectStorageIdentity(canonicalRoot, options));
      const canonical = new DatabaseSync(destinationPath);
      try {
        canonicalBackupId = createPreMigrationBackupSync(canonical, backupDirectory, platform, arch).id;
      } finally {
        canonical.close();
      }
    }

    const recoveredAt = now().toISOString();
    const provenancePath = path.join(
      canonicalRoot,
      `storage-recovery-${safeTimestamp(recoveredAt)}-${randomUUID().slice(0, 8)}.json`,
    );
    pendingProvenancePath = provenancePath + '.pending';
    const provenance: Omit<StorageRecoveryProvenance, 'status'> = {
      schemaVersion: 1,
      method: 'sqlite_backup_restore',
      recoveredAt,
      sourcePath: source.sqlitePath,
      destinationPath,
      sourceBackupId,
      migratedBackupId: migratedBackup.id,
      canonicalBackupId,
    };
    await writeFile(
      pendingProvenancePath,
      JSON.stringify({ ...provenance, status: 'prepared' } satisfies StorageRecoveryProvenance, null, 2),
      { encoding: 'utf8', flag: 'wx' },
    );

    await migratedBackupService.scheduleRestore(migratedBackup.id);
    migratedDatabase.close();
    migratedDatabase = undefined;

    const restored = applyPendingSqliteRestoreSync(destinationPath, backupDirectory, {
      platform,
      arch,
      now,
      beforeReplace: () => {
        const latestInspection = inspectStorageIdentity(canonicalRoot, options);
        if (latestInspection.canonical.exists && !latestInspection.canonical.readable) {
          throw new StorageRecoveryError(
            'STORAGE_RECOVERY_CONFLICT',
            `canonical SQLite database became unavailable before replacement: ${destinationPath}`,
            latestInspection,
          );
        }
        if (latestInspection.canonical.exists) {
          assertCanonicalReplaceable(destinationPath, latestInspection);
        }
      },
    });
    if (!restored.applied || restored.error !== undefined) {
      throw new Error(restored.error ?? 'scheduled SQLite recovery was not applied');
    }

    const finalProvenancePath = provenancePath + '.tmp-' + randomUUID();
    await writeFile(
      finalProvenancePath,
      JSON.stringify({ ...provenance, status: 'completed' } satisfies StorageRecoveryProvenance, null, 2),
      { encoding: 'utf8', flag: 'wx' },
    );
    await rename(finalProvenancePath, provenancePath);
    await rm(pendingProvenancePath, { force: true });
    pendingProvenancePath = undefined;

    return {
      status: 'recovered',
      sourcePath: source.sqlitePath,
      destinationPath,
      canonicalBackupId,
      sourceBackupId,
      migratedBackupId: migratedBackup.id,
      provenancePath,
    };
  } catch (error) {
    if (error instanceof StorageRecoveryError) throw error;
    throw new StorageRecoveryError(
      'STORAGE_RECOVERY_FAILED',
      error instanceof Error ? error.message : String(error),
      inspection,
      { cause: error },
    );
  } finally {
    migratedDatabase?.close();
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    // Keep a prepared provenance receipt when restore failed. It records the
    // exact source and backup IDs needed for manual recovery without claiming
    // that replacement completed.
    void pendingProvenancePath;
  }
}

async function snapshotHistoricalDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
  validateReadableDatabase(destinationPath);
}

function assertCanonicalReplaceable(
  databasePath: string,
  inspection: StorageIdentityInspection,
): void {
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try {
    validateConnection(database);
    if (hasApplicationData(database)) {
      throw new StorageRecoveryError(
        'STORAGE_RECOVERY_CONFLICT',
        `canonical SQLite database already contains application data and will not be overwritten: ${databasePath}`,
        inspection,
      );
    }
  } finally {
    database.close();
  }
}

function hasApplicationData(database: DatabaseSync): boolean {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
  ).all() as unknown[];
  for (const row of rows) {
    const name = objectString(row, 'name');
    if (name === null) continue;
    const present = database.prepare(`SELECT 1 AS present FROM ${quoteIdentifier(name)} LIMIT 1`).get();
    if (objectNumber(present, 'present') === 1) return true;
  }
  return false;
}

function validateReadableDatabase(filename: string): void {
  const database = new DatabaseSync(filename, { readOnly: true, timeout: 5_000 });
  try {
    validateConnection(database);
  } finally {
    database.close();
  }
}

function validateConnection(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA quick_check;').get();
  if (typeof row !== 'object' || row === null || !Object.values(row).includes('ok')) {
    throw new Error('SQLite integrity check failed');
  }
}

function quoteIdentifier(value: string): string {
  return '"' + value.replaceAll('"', '""') + '"';
}

function objectString(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

function objectNumber(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === 'number') return field;
  if (typeof field === 'bigint') return Number(field);
  return null;
}

function safeTimestamp(value: string): string {
  return value.replace(/[:.]/g, '-');
}

function notNeeded(destinationPath: string): StorageRecoveryResult {
  return {
    status: 'not_needed',
    sourcePath: null,
    destinationPath,
    canonicalBackupId: null,
    sourceBackupId: null,
    migratedBackupId: null,
    provenancePath: null,
  };
}
