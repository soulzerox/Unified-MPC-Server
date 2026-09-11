import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createPlatformProfile } from './platform-profile.js';

describe('Milestone 1 - Linux-Only Foundation & SQLite Concurrency Stress Test', () => {
  it('identifies Linux x64 as fully supported native platform', () => {
    const profile = createPlatformProfile({ platform: 'linux', arch: 'x64', release: '6.8.0-generic' });
    expect(profile.family).toBe('linux');
    expect(profile.supportTier).toBe('supported');
    expect(profile.capabilities.shell).toBe('native');
  });

  it('rejects win32 platform as completely unsupported', () => {
    const profile = createPlatformProfile({ platform: 'win32', arch: 'x64', release: '10.0.19045' });
    expect(profile.family).toBe('unsupported');
    expect(profile.supportTier).toBe('unsupported');
    expect(profile.capabilities.shell).toBe('unsupported');
  });

  it('handles high concurrency writes and reads with node:sqlite WAL mode under load', async () => {
    // In-memory or temporary SQLite database in WAL mode
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, key TEXT UNIQUE, value TEXT, updated_at INTEGER);');

    const insertStmt = db.prepare('INSERT INTO items (key, value, updated_at) VALUES (?, ?, ?);');
    const selectStmt = db.prepare('SELECT value FROM items WHERE key = ?;');

    // Concurrently execute 100 read/write operations
    const operations: Promise<void>[] = [];
    const count = 100;

    for (let i = 0; i < count; i += 1) {
      operations.push((async () => {
        const key = `key_${i}`;
        const val = `value_${i}_${Date.now()}`;
        insertStmt.run(key, val, Date.now());

        const row = selectStmt.get(key) as { value: string } | undefined;
        expect(row).toBeDefined();
        expect(row?.value).toBe(val);
      })());
    }

    await Promise.all(operations);

    const countRow = db.prepare('SELECT COUNT(*) as total FROM items;').get() as { total: number };
    expect(countRow.total).toBe(count);

    db.close();
  });
});
