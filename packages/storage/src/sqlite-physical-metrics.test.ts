import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { readSqlitePhysicalMetrics } from './sqlite-physical-metrics.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sqlite-metrics-'));
  temporaryRoots.push(dir);
  return dir;
}

describe('readSqlitePhysicalMetrics (#210 SQLite physical space boundary)', () => {
  it('measures an in-memory database with null path and page/freelist metrics', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const metrics = db.physicalMetrics();
      expect(metrics.inMemory).toBe(true);
      expect(metrics.databasePath).toBeNull();
      expect(metrics.databaseBytes).toBe(-1);
      expect(metrics.walBytes).toBe(-1);
      expect(metrics.shmBytes).toBe(-1);
      expect(metrics.pageSizeBytes).toBe(4096);
      expect(metrics.pageCount).toBeGreaterThan(0);
      expect(metrics.freelistCount).toBe(0);
      expect(metrics.freelistBytes).toBe(0);
      expect(metrics.freelistRatio).toBe(0);
      expect(metrics.compactionRecommended).toBe(false);
      expect(metrics.compactionReason).toBeNull();
      expect(metrics.checkpoint).toMatchObject({
        mode: 'passive',
        truncated: false,
      });
    } finally {
      db.close();
    }
  });

  it('measures a disk database with file bytes and bounded PASSIVE checkpoint without truncation', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'state.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, payload TEXT);');
      db.connection.exec('BEGIN;');
      for (let i = 0; i < 300; i++) {
        db.connection.prepare('INSERT INTO sample VALUES (?, ?)').run(i, 'x'.repeat(256));
      }
      db.connection.exec('COMMIT;');
      const metrics = db.physicalMetrics();
      expect(metrics.inMemory).toBe(false);
      expect(metrics.databasePath).toBe(file);
      expect(metrics.databaseBytes).toBeGreaterThan(0);
      expect(metrics.pageSizeBytes).toBe(4096);
      expect(metrics.pageCount).toBeGreaterThan(0);
      expect(metrics.liveBytes).toBe(metrics.pageCount * metrics.pageSizeBytes);
      expect(metrics.checkpoint).toMatchObject({
        mode: 'passive',
        busy: false,
        truncated: false,
      });
    } finally {
      db.close();
    }
  });

  it('proves row deletion increases freelist without shrinking the database file', async () => {
    // issue-210 acceptance addition: row deletion/logical prune is not
    // physical compaction; tests prove deletion does not claim the file has shrunk.
    const dir = await tempDir();
    const file = path.join(dir, 'freelist.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, body TEXT);');
      db.connection.exec('BEGIN;');
      for (let i = 0; i < 500; i++) {
        db.connection.prepare('INSERT INTO bulk VALUES (?, ?)').run(i, 'data'.repeat(250));
      }
      db.connection.exec('COMMIT;');
      const before = db.physicalMetrics();
      const initialFileBytes = before.databaseBytes;
      const initialFreelist = before.freelistCount;

      // Delete 80% of rows — logical rows removed
      db.connection.exec('DELETE FROM bulk WHERE id > 200;');

      const after = db.physicalMetrics();

      // Database file on disk DID NOT SHRINK
      expect(after.databaseBytes).toBe(initialFileBytes);
      // But freelist count increased to hold reusable deleted pages
      expect(after.freelistCount).toBeGreaterThan(initialFreelist);
      expect(after.freelistBytes).toBe(after.freelistCount * after.pageSizeBytes);
      expect(after.freelistRatio).toBeGreaterThan(0);
      expect(after.liveBytes).toBe((after.pageCount - after.freelistCount) * after.pageSizeBytes);
    } finally {
      db.close();
    }
  });

  it('evaluates compaction recommendation threshold-first, never automatic', async () => {
    // issue-210 acceptance addition: physical compaction is threshold/evidence-driven,
    // never an automatic side effect.
    const dir = await tempDir();
    const file = path.join(dir, 'compaction.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, v TEXT);');
      db.connection.exec('BEGIN;');
      for (let i = 0; i < 300; i++) {
        db.connection.prepare('INSERT INTO items VALUES (?, ?)').run(i, 'val'.repeat(100));
      }
      db.connection.exec('COMMIT;');
      db.connection.exec('DELETE FROM items WHERE id > 50;');

      // With default 64MB min bytes threshold, small freelist is NOT recommended
      const defaultEval = db.physicalMetrics();
      expect(defaultEval.freelistCount).toBeGreaterThan(0);
      expect(defaultEval.compactionRecommended).toBe(false);
      expect(defaultEval.compactionReason).toBeNull();

      // With low byte threshold matching this test's size, recommendation triggers
      const sensitiveEval = db.physicalMetrics({
        compactionMinFreelistBytes: 4096,
        compactionFreelistRatio: 0.1,
      });
      expect(sensitiveEval.compactionRecommended).toBe(true);
      expect(sensitiveEval.compactionReason).toMatch(/freelist \d+ bytes/);
    } finally {
      db.close();
    }
  });

  it('stays bounded and non-blocking for a reader holding an open WAL snapshot', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'reader.sqlite');
    const writer = new SqliteDatabase(file);
    const reader = new DatabaseSync(file, { timeout: 5_000 });
    try {
      writer.connection.exec('CREATE TABLE held (id INTEGER PRIMARY KEY, v TEXT);');
      reader.exec('BEGIN;');
      reader.prepare('SELECT count(*) AS n FROM held').get();

      writer.connection.exec('BEGIN;');
      for (let i = 0; i < 200; i++) {
        writer.connection.prepare('INSERT INTO held VALUES (?, ?)').run(i, 'w'.repeat(256));
      }
      writer.connection.exec('COMMIT;');

      // A blocked checkpoint is reported, never waited on: PASSIVE copies what
      // it can, reports the WAL it could not finish, and never truncates.
      const metrics = writer.physicalMetrics();
      expect(metrics.checkpoint.mode).toBe('passive');
      expect(metrics.checkpoint.truncated).toBe(false);
      expect(metrics.checkpoint.walPages).toBeGreaterThanOrEqual(metrics.checkpoint.checkpointedPages);
      expect(metrics.walBytes).toBeGreaterThan(0);

      // The reader's snapshot survived the checkpoint.
      expect(reader.prepare('SELECT count(*) AS n FROM held').get()).toEqual({ n: 0 });
      reader.exec('ROLLBACK;');
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('supports checkpointMode: none to avoid running WAL checkpoint', () => {
    const db = new SqliteDatabase(':memory:');
    try {
      const metrics = readSqlitePhysicalMetrics(db.connection, null, { checkpointMode: 'none' });
      expect(metrics.checkpoint.mode).toBe('none');
      expect(metrics.checkpoint.busy).toBe(false);
    } finally {
      db.close();
    }
  });
});
