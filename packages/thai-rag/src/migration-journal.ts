import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@unified-mpc/domain';
import { resolveThaiRagProviderRoot } from './canonical-workspace.js';

export type ThaiRagMigrationState = 'prepared' | 'in-progress' | 'completed';

export interface ThaiRagMigrationRecord {
  readonly migrationId: string;
  readonly state: ThaiRagMigrationState;
  readonly legacyRoot: string;
  readonly backupRoot: string;
  readonly journalPath: string;
  readonly backupCompletedAt: string;
  readonly importedTurnIds: readonly string[];
  readonly reindexWorkspaceIds: readonly string[];
  readonly completedAt?: string;
  readonly updatedAt: string;
}

interface StoredMigrationRecord {
  readonly migrationId: string;
  readonly state: ThaiRagMigrationState;
  readonly legacyRoot: string;
  readonly backupRoot: string;
  readonly backupCompletedAt: string;
  readonly importedTurnIds: readonly string[];
  readonly reindexWorkspaceIds: readonly string[];
  readonly completedAt?: string;
  readonly updatedAt: string;
}

export class ThaiRagMigrationJournal {
  private readonly now: () => Date;

  public constructor(
    private readonly dataRoot: string,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public async prepare(migrationId: string, legacyRoot: string): Promise<Result<ThaiRagMigrationRecord>> {
    const existing = await this.get(migrationId);
    if (!existing.ok) return existing;
    if (existing.value !== null) return ok(existing.value);

    const paths = this.paths(migrationId);
    if (!paths.ok) return paths;
    const timestamp = this.now().toISOString();
    try {
      await mkdir(paths.value.migrationRoot, { recursive: true });
      await cp(legacyRoot, paths.value.backupRoot, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      const stored: StoredMigrationRecord = {
        migrationId,
        state: 'prepared',
        legacyRoot,
        backupRoot: paths.value.backupRoot,
        backupCompletedAt: timestamp,
        importedTurnIds: [],
        reindexWorkspaceIds: [],
        updatedAt: timestamp,
      };
      return this.persist(paths.value.journalPath, stored);
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', `Unable to prepare Thai-RAG legacy backup: ${safeError(error)}`, true));
    }
  }

  public async get(migrationId: string): Promise<Result<ThaiRagMigrationRecord | null>> {
    const paths = this.paths(migrationId);
    if (!paths.ok) return paths;
    try {
      const parsed: unknown = JSON.parse(await readFile(paths.value.journalPath, 'utf8'));
      const stored = parseRecord(parsed, migrationId, paths.value.backupRoot);
      if (stored === null) return err(appError('CONFLICT', 'Thai-RAG migration journal is invalid', true));
      return ok(toPublic(stored, paths.value.journalPath));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return ok(null);
      return err(appError('INTERNAL_ERROR', 'Unable to read Thai-RAG migration journal', true));
    }
  }

  public async checkpoint(migrationId: string, progress: {
    readonly importedTurnIds?: readonly string[];
    readonly reindexWorkspaceIds?: readonly string[];
  }): Promise<Result<ThaiRagMigrationRecord>> {
    const current = await this.get(migrationId);
    if (!current.ok) return current;
    if (current.value === null) return err(appError('CONFLICT', 'Thai-RAG migration backup must be prepared before checkpointing', true));
    if (current.value.state === 'completed') return ok(current.value);
    const timestamp = this.now().toISOString();
    const stored: StoredMigrationRecord = {
      ...withoutJournalPath(current.value),
      state: 'in-progress',
      importedTurnIds: union(current.value.importedTurnIds, progress.importedTurnIds ?? []),
      reindexWorkspaceIds: union(current.value.reindexWorkspaceIds, progress.reindexWorkspaceIds ?? []),
      updatedAt: timestamp,
    };
    return this.persist(current.value.journalPath, stored);
  }

  public async complete(migrationId: string): Promise<Result<ThaiRagMigrationRecord>> {
    const current = await this.get(migrationId);
    if (!current.ok) return current;
    if (current.value === null) return err(appError('CONFLICT', 'Thai-RAG migration backup must be prepared before completion', true));
    if (current.value.state === 'completed') return ok(current.value);
    const timestamp = this.now().toISOString();
    return this.persist(current.value.journalPath, {
      ...withoutJournalPath(current.value),
      state: 'completed',
      completedAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private paths(migrationId: string): Result<{
    readonly migrationRoot: string;
    readonly backupRoot: string;
    readonly journalPath: string;
  }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(migrationId)) {
      return err(appError('INVALID_INPUT', 'Thai-RAG migration ID is invalid'));
    }
    const providerRoot = resolveThaiRagProviderRoot(this.dataRoot);
    if (!providerRoot.ok) return providerRoot;
    const migrationRoot = path.join(providerRoot.value, 'migrations', migrationId);
    return ok({
      migrationRoot,
      backupRoot: path.join(migrationRoot, 'backup'),
      journalPath: path.join(migrationRoot, 'migration.json'),
    });
  }

  private async persist(journalPath: string, stored: StoredMigrationRecord): Promise<Result<ThaiRagMigrationRecord>> {
    try {
      await mkdir(path.dirname(journalPath), { recursive: true });
      const temporaryPath = `${journalPath}.tmp-${process.pid}`;
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, journalPath);
      return ok(toPublic(stored, journalPath));
    } catch (error: unknown) {
      return err(appError('INTERNAL_ERROR', `Unable to persist Thai-RAG migration journal: ${safeError(error)}`, true));
    }
  }
}

function withoutJournalPath(record: ThaiRagMigrationRecord): StoredMigrationRecord {
  return {
    migrationId: record.migrationId,
    state: record.state,
    legacyRoot: record.legacyRoot,
    backupRoot: record.backupRoot,
    backupCompletedAt: record.backupCompletedAt,
    importedTurnIds: record.importedTurnIds,
    reindexWorkspaceIds: record.reindexWorkspaceIds,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    updatedAt: record.updatedAt,
  };
}

function toPublic(stored: StoredMigrationRecord, journalPath: string): ThaiRagMigrationRecord {
  return { ...stored, journalPath };
}

function parseRecord(value: unknown, migrationId: string, backupRoot: string): StoredMigrationRecord | null {
  if (!isRecord(value)
    || value.migrationId !== migrationId
    || !isState(value.state)
    || typeof value.legacyRoot !== 'string'
    || value.backupRoot !== backupRoot
    || typeof value.backupCompletedAt !== 'string'
    || !isStringArray(value.importedTurnIds)
    || !isStringArray(value.reindexWorkspaceIds)
    || typeof value.updatedAt !== 'string'
    || (value.completedAt !== undefined && typeof value.completedAt !== 'string')) return null;
  return {
    migrationId,
    state: value.state,
    legacyRoot: value.legacyRoot,
    backupRoot,
    backupCompletedAt: value.backupCompletedAt,
    importedTurnIds: value.importedTurnIds,
    reindexWorkspaceIds: value.reindexWorkspaceIds,
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
    updatedAt: value.updatedAt,
  };
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

function isState(value: unknown): value is ThaiRagMigrationState {
  return value === 'prepared' || value === 'in-progress' || value === 'completed';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function safeError(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
