import path from 'node:path';

import { appError, err, ok, type Result } from '@unified-mpc/domain';
import {
  STRUCTURAL_RECORD_SCHEMA_VERSION,
  isStructuralFingerprint,
  sameStructuralIdentity,
  structuralGenerationId,
  type ReadStructuralRecordsInput,
  type StructuralFingerprint,
  type StructuralGeneration,
  type SourceStructuralRecord,
  type StructuralRecordStore,
  type WriteStructuralGenerationInput,
} from '@unified-mpc/code-intelligence/structural-record-store';
import type { SqliteDatabase } from './database.js';

/**
 * SQLite adapter for the Code Intelligence record store (#131, slice 2).
 *
 * Rows are content the extractor produced; this adapter only refuses what it
 * cannot store honestly: two identities in one write, a duplicate path, a
 * fingerprint that is not `sha256:<hex>`, an unbounded read, and a second write
 * of an identity that already has a generation.
 */
const MAX_READ_LIMIT = 2_000;

export interface SqliteStructuralRecordStoreOptions {
  /** Injected so a test can pin `written_at`; defaults to the wall clock. */
  readonly now?: () => Date;
}

interface GenerationRow {
  readonly generation_id: string;
  readonly repository_id: string;
  readonly manifest_id: string;
  readonly revision_id: string;
  readonly commit_sha: string;
  readonly tree_oid: string;
  readonly ref: string;
  readonly schema_version: number;
  readonly written_at: string;
  readonly file_count: number;
}

interface FingerprintRow {
  readonly path: string;
  readonly fingerprint: string;
}

function invalid(message: string): Result<never> {
  return err(appError('INVALID_INPUT', message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateGenerationId(generationId: unknown): Result<string> {
  if (typeof generationId !== 'string' || generationId.length === 0) {
    return invalid('structural generation id is required');
  }
  return ok(generationId);
}

function validateLimit(limit: unknown): Result<number> {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) {
    return invalid(`structural record read needs an integer limit between 1 and ${MAX_READ_LIMIT}`);
  }
  return ok(limit);
}

function validateRecordPath(recordPath: unknown): Result<string> {
  if (typeof recordPath !== 'string' || recordPath.length === 0) {
    return invalid('a structural record needs a path');
  }
  if (path.isAbsolute(recordPath)) {
    return invalid(`structural record path ${recordPath} is not repo-relative`);
  }
  // Segment-wise: `..foo.ts` is a legal name, but `.`, `..` and an empty segment
  // are not, so `../x`, `src/../../x`, `a/./b` and `a//b` are refused here rather
  // than stored in an immutable generation.
  const segments = recordPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalid(`structural record path ${recordPath} is not repo-relative`);
  }
  return ok(recordPath);
}

export class SqliteStructuralRecordStore implements StructuralRecordStore {
  private readonly now: () => Date;

  constructor(
    private readonly database: SqliteDatabase,
    options: SqliteStructuralRecordStoreOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  public writeGeneration(input: WriteStructuralGenerationInput): Promise<Result<StructuralGeneration>> {
    try {
      return Promise.resolve(this.write(input));
    } catch (error) {
      return Promise.resolve(err(appError('INTERNAL_ERROR', `structural generation write failed: ${describe(error)}`)));
    }
  }

  public readGeneration(identity: WriteStructuralGenerationInput['identity']): Promise<Result<StructuralGeneration | undefined>> {
    try {
      const row = this.database.connection
        .prepare('SELECT * FROM structural_record_generations WHERE generation_id = ?')
        .get(structuralGenerationId(identity));
      if (row === undefined) return Promise.resolve(ok(undefined));
      const version = (row as { readonly schema_version?: unknown }).schema_version;
      if (version !== STRUCTURAL_RECORD_SCHEMA_VERSION) {
        return Promise.resolve(invalid(`structural generation was stored with schema version ${String(version)}; this build reads version ${STRUCTURAL_RECORD_SCHEMA_VERSION}`));
      }
      return Promise.resolve(ok(toGeneration(row)));
    } catch (error) {
      return Promise.resolve(err(appError('INTERNAL_ERROR', `structural generation read failed: ${describe(error)}`)));
    }
  }

  public readRecords(input: ReadStructuralRecordsInput): Promise<Result<readonly SourceStructuralRecord[]>> {
    try {
      const bounded = this.bound(input);
      if (!bounded.ok) return Promise.resolve(bounded);

      const rows = this.rows(bounded.value, 'payload');
      const records: SourceStructuralRecord[] = [];
      for (const row of rows) {
        const parsed = parseRecord((row as unknown as { readonly payload: string }).payload);
        if (!parsed.ok) return Promise.resolve(parsed);
        records.push(parsed.value);
      }
      return Promise.resolve(ok(records));
    } catch (error) {
      return Promise.resolve(err(appError('INTERNAL_ERROR', `structural record read failed: ${describe(error)}`)));
    }
  }

  public readFingerprints(input: ReadStructuralRecordsInput): Promise<Result<readonly StructuralFingerprint[]>> {
    try {
      const bounded = this.bound(input);
      if (!bounded.ok) return Promise.resolve(bounded);

      const rows = this.rows(bounded.value, 'path, fingerprint') as unknown as readonly FingerprintRow[];
      return Promise.resolve(ok(rows.map((row) => ({ path: row.path, fingerprint: row.fingerprint }))));
    } catch (error) {
      return Promise.resolve(err(appError('INTERNAL_ERROR', `structural fingerprint read failed: ${describe(error)}`)));
    }
  }

  /** Validates every refusal the contract names, so a write is all-or-nothing. */
  private write(input: WriteStructuralGenerationInput): Result<StructuralGeneration> {
    // An identity has exactly one generation and there is no delete, so accepting
    // an empty extraction would forbid the real one forever.
    if (input.records.length === 0) {
      return invalid('a structural generation needs at least one record; an empty extraction cannot claim an identity');
    }
    const generationId = structuralGenerationId(input.identity);
    const seen = new Set<string>();
    for (const record of input.records) {
      const recordPath = validateRecordPath(record.path);
      if (!recordPath.ok) return recordPath;
      if (!sameStructuralIdentity(record.identity, input.identity)) {
        return invalid(`structural record ${recordPath.value} carries a different identity than the generation`);
      }
      if (!isStructuralFingerprint(record.fingerprint)) {
        return invalid(`structural record ${recordPath.value} has a fingerprint that is not sha256:<64 hex>`);
      }
      if (seen.has(recordPath.value)) {
        return invalid(`structural record ${recordPath.value} appears twice in one generation`);
      }
      seen.add(recordPath.value);
    }

    const writtenAt = this.now().toISOString();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE;');
    try {
      // Inside the transaction: a concurrent writer that wins the race makes this
      // probe see its row, so the refusal stays a refusal instead of a UNIQUE
      // violation surfacing as INTERNAL_ERROR.
      const existing = connection
        .prepare('SELECT generation_id FROM structural_record_generations WHERE generation_id = ?')
        .get(generationId);
      if (existing !== undefined) {
        connection.exec('ROLLBACK;');
        return invalid(`structural generation ${generationId} is already stored; a generation is never rewritten`);
      }

      connection.prepare(`
        INSERT INTO structural_record_generations (
          generation_id, repository_id, manifest_id, revision_id, commit_sha, tree_oid, ref,
          schema_version, written_at, file_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generationId,
        input.identity.repository_id,
        input.identity.manifest_id,
        input.identity.revision_id,
        input.identity.commit_sha,
        input.identity.tree_oid,
        input.identity.ref,
        STRUCTURAL_RECORD_SCHEMA_VERSION,
        writtenAt,
        input.records.length,
      );

      const insert = connection.prepare(`
        INSERT INTO structural_records (generation_id, path, fingerprint, language, parse_error, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const record of input.records) {
        insert.run(
          generationId,
          record.path,
          record.fingerprint,
          record.language,
          record.parseError ?? null,
          JSON.stringify(record),
        );
      }
      connection.exec('COMMIT;');
    } catch (error) {
      connection.exec('ROLLBACK;');
      throw error;
    }

    return ok({
      identity: input.identity,
      generationId,
      schemaVersion: STRUCTURAL_RECORD_SCHEMA_VERSION,
      writtenAt,
      fileCount: input.records.length,
    });
  }

  private bound(input: ReadStructuralRecordsInput): Result<{
    generationId: string;
    limit: number;
    paths?: readonly string[];
    afterPath?: string;
  }> {
    const generationId = validateGenerationId(input.generationId);
    if (!generationId.ok) return generationId;
    const limit = validateLimit(input.limit);
    if (!limit.ok) return limit;
    // Fail closed: an empty generation cannot exist (the write path refuses one),
    // so a page with no rows means the id is wrong, not that the tree is empty.
    const known = this.database.connection
      .prepare('SELECT schema_version FROM structural_record_generations WHERE generation_id = ?')
      .get(generationId.value);
    if (known === undefined) {
      return invalid(`structural generation ${generationId.value} is not stored`);
    }
    // A generation is immutable, so its schema version is too: reading it with a
    // build that does not know that version would be a silent misread.
    const storedVersion = (known as { readonly schema_version?: unknown }).schema_version;
    if (storedVersion !== STRUCTURAL_RECORD_SCHEMA_VERSION) {
      return invalid(`structural generation ${generationId.value} was stored with schema version ${String(storedVersion)}; this build reads version ${STRUCTURAL_RECORD_SCHEMA_VERSION}`);
    }
    if (input.afterPath !== undefined) {
      const cursor = validateRecordPath(input.afterPath);
      if (!cursor.ok) return cursor;
    }
    if (input.paths !== undefined) {
      // Bounded by the same ceiling as `limit`: one placeholder per path, so an
      // unbounded filter would turn into SQLITE_TOOMANYVARIABLES (an internal
      // error) instead of a refusal.
      if (input.paths.length > MAX_READ_LIMIT) {
        return invalid(`structural record read accepts at most ${MAX_READ_LIMIT} paths`);
      }
      for (const recordPath of input.paths) {
        const valid = validateRecordPath(recordPath);
        if (!valid.ok) return valid;
      }
    }
    return ok({
      generationId: generationId.value,
      limit: limit.value,
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      ...(input.afterPath === undefined ? {} : { afterPath: input.afterPath }),
    });
  }

  private rows(
    input: {
      readonly generationId: string;
      readonly limit: number;
      readonly paths?: readonly string[];
      readonly afterPath?: string;
    },
    columns: string,
  ): readonly Record<string, unknown>[] {
    const base = `SELECT ${columns} FROM structural_records WHERE generation_id = ?`;
    if (input.paths !== undefined && input.paths.length === 0) return [];
    const placeholders = input.paths === undefined ? '' : ` AND path IN (${input.paths.map(() => '?').join(', ')})`;
    const cursor = input.afterPath === undefined ? '' : ' AND path > ?';
    // BINARY collation is byte order: deterministic and locale-free, unlike a
    // text collation that would depend on how SQLite was built.
    const rows = this.database.connection
      .prepare(`${base}${placeholders}${cursor} ORDER BY path COLLATE BINARY LIMIT ?`)
      .all(
        input.generationId,
        ...(input.paths ?? []),
        ...(input.afterPath === undefined ? [] : [input.afterPath]),
        input.limit,
      );
    return rows.filter(isRecord);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseRecord(payload: string): Result<SourceStructuralRecord> {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed) || typeof parsed.path !== 'string' || typeof parsed.fingerprint !== 'string') {
      return err(appError('INTERNAL_ERROR', 'a stored structural record is not a record'));
    }
    return ok(parsed as unknown as SourceStructuralRecord);
  } catch (error) {
    return err(appError('INTERNAL_ERROR', `a stored structural record is not JSON: ${describe(error)}`));
  }
}

function toGeneration(row: unknown): StructuralGeneration {
  if (!isRecord(row)) throw new Error('structural generation row is not an object');
  const generation = row as unknown as GenerationRow;
  return {
    identity: {
      repository_id: generation.repository_id,
      manifest_id: generation.manifest_id,
      revision_id: generation.revision_id,
      commit_sha: generation.commit_sha,
      tree_oid: generation.tree_oid,
      ref: generation.ref,
    },
    generationId: generation.generation_id,
    schemaVersion: generation.schema_version,
    writtenAt: generation.written_at,
    fileCount: generation.file_count,
  };
}
