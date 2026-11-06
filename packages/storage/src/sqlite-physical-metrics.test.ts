import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
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

  it('physically reclaims a deleted payload and truncates the WAL', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'compact.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, body TEXT);');
      db.connection.exec('BEGIN;');
      const body = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 200; i++) {
        db.connection.prepare('INSERT INTO bulk VALUES (?, ?)').run(i, body);
      }
      db.connection.exec('COMMIT;');
      db.connection.exec('DELETE FROM bulk WHERE id > 10;');

      const before = db.physicalMetrics({ checkpointMode: 'none' });
      expect(before.freelistBytes).toBeGreaterThan(0);

      const result = db.compact();
      expect(result.status).toBe('compacted');
      if (result.status !== 'compacted') throw new Error('unreachable');
      expect(result.beforeBytes).toBe(before.databaseBytes);
      expect(result.afterBytes).toBeLessThan(result.beforeBytes);
      expect(result.reclaimedBytes).toBe(result.beforeBytes - result.afterBytes);
      expect(result.afterFreelistBytes).toBe(0);
      expect(result.checkpointBusy).toBe(false);
      expect(result.checkpointTruncated).toBe(true);
      expect(result.walBytesAfter).toBe(0);
      expect(db.physicalMetrics({ checkpointMode: 'none' }).freelistCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it('survives a crash between VACUUM and checkpoint and reclaims it on the next pass', async () => {
    // issue-210 acceptance addition: interruption inside the compaction window
    // must not lose rows or leave a file the next maintenance pass cannot free.
    const dir = await tempDir();
    const file = path.join(dir, 'crash.sqlite');
    const crashFile = path.join(dir, 'crash-copy.sqlite');
    const db = new SqliteDatabase(file);
    try {
      db.connection.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, body TEXT);');
      db.connection.exec('BEGIN;');
      const body = 'z'.repeat(64 * 1024);
      for (let i = 0; i < 120; i++) {
        db.connection.prepare('INSERT INTO bulk VALUES (?, ?)').run(i, body);
      }
      db.connection.exec('COMMIT;');
      db.connection.exec('DELETE FROM bulk WHERE id > 10;');

      // VACUUM writes the rebuilt database through the WAL, so a process that
      // dies before `wal_checkpoint(TRUNCATE)` leaves the old main file plus a
      // WAL that carries the new one. Snapshot exactly those two files into a
      // second directory; the shared-memory file is not copied because SQLite
      // rebuilds it from the WAL.
      db.connection.exec('VACUUM;');
      await copyFile(file, crashFile);
      await copyFile(`${file}-wal`, `${crashFile}-wal`);
      expect((await stat(`${crashFile}-wal`)).size).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    const reopened = new SqliteDatabase(crashFile);
    try {
      // Recovery from the surviving WAL: no row is lost and the file is sound.
      expect(reopened.connection.prepare('PRAGMA integrity_check;').get()).toEqual({ integrity_check: 'ok' });
      expect(reopened.connection.prepare('SELECT count(*) AS n FROM bulk').get()).toEqual({ n: 11 });

      const before = reopened.physicalMetrics({ checkpointMode: 'none' });
      // The abandoned VACUUM already rebuilt the pages, but the main file is
      // still at its pre-crash size until a truncating checkpoint runs.
      expect(before.freelistCount).toBe(0);
      expect(before.walBytes).toBeGreaterThan(0);

      const result = reopened.compact();
      expect(result.status).toBe('compacted');
      if (result.status !== 'compacted') throw new Error('unreachable');
      expect(result.walBytesAfter).toBe(0);
      expect(result.afterBytes).toBeLessThan(before.databaseBytes);
      expect(reopened.connection.prepare('PRAGMA integrity_check;').get()).toEqual({ integrity_check: 'ok' });
      expect(reopened.connection.prepare('SELECT count(*) AS n FROM bulk').get()).toEqual({ n: 11 });
    } finally {
      reopened.close();
    }
  });

  it('reports a reader-blocked truncate instead of claiming full reclamation', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'compact-reader.sqlite');
    const writer = new SqliteDatabase(file);
    const reader = new DatabaseSync(file, { timeout: 5_000 });
    try {
      writer.connection.exec('CREATE TABLE bulk (id INTEGER PRIMARY KEY, body TEXT);');
      writer.connection.exec('BEGIN;');
      const body = 'y'.repeat(64 * 1024);
      for (let i = 0; i < 200; i++) {
        writer.connection.prepare('INSERT INTO bulk VALUES (?, ?)').run(i, body);
      }
      writer.connection.exec('COMMIT;');
      writer.connection.exec('DELETE FROM bulk WHERE id > 10;');

      reader.exec('BEGIN;');
      reader.prepare('SELECT count(*) AS n FROM bulk').get();

      const result = writer.compact();
      // VACUUM may run while the reader keeps its snapshot, or SQLite may
      // report the reader as busy up front. Both are safe verdicts; what must
      // never happen is a claim that the reader did not affect truncation.
      if (result.status === 'skipped') {
        expect(result.reason).toBe('reader-pressure');
      } else {
        expect(result.checkpointBusy).toBe(true);
        expect(result.checkpointTruncated).toBe(false);
      }
      reader.exec('ROLLBACK;');
    } finally {
      reader.close();
      writer.close();
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
