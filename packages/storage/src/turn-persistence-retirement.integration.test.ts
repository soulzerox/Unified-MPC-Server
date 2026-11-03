import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_MIGRATION_ID, SqliteDatabase } from './database.js';
import { TURN_PERSISTENCE_MIGRATION_SQL } from './migrations/turn-persistence-migration.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function retiredTableNames(database: SqliteDatabase): string[] {
  return database.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'turn_persistence%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function migrationIds(database: SqliteDatabase): string[] {
  return database.connection
    .prepare('SELECT id FROM schema_migrations ORDER BY id')
    .all()
    .map((row) => (row as { id: string }).id);
}

describe('turn persistence retirement migration', () => {
  it('retires the released 018 tables from an upgraded database and keeps unrelated state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-retire-turn-persistence-'));
    temporaryRoots.push(root);
    const filename = path.join(root, 'state.sqlite');

    const legacy = new DatabaseSync(filename);
    legacy.exec('PRAGMA journal_mode = WAL;');
    legacy.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL);');
    legacy.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
    legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('cloudflare_public_url', 'https://kept.example.test');
    legacy.exec(TURN_PERSISTENCE_MIGRATION_SQL);
    legacy.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('018_turn_persistence');
    legacy.prepare('INSERT INTO turn_persistence_completed (scope, turn_id, role, completed_at) VALUES (?, ?, ?, ?)')
      .run('web', 'turn-1', 'user', '2026-08-01T00:00:00.000Z');
    legacy.prepare('INSERT INTO turn_persistence_active (scope, turn_id, mode, violations, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('web', 'turn-1', 'required', 0, '2026-08-01T00:00:00.000Z');
    legacy.close();

    const upgraded = new SqliteDatabase(filename);
    try {
      expect(retiredTableNames(upgraded)).toEqual([]);
      expect(migrationIds(upgraded)).toEqual(expect.arrayContaining([
        '018_turn_persistence',
        CURRENT_SCHEMA_MIGRATION_ID,
      ]));
      expect(upgraded.connection.prepare('SELECT value FROM settings WHERE key = ?').get('cloudflare_public_url'))
        .toMatchObject({ value: 'https://kept.example.test' });
    } finally {
      upgraded.close();
    }

    // A restart must be a no-op rather than a second destructive pass.
    const reopened = new SqliteDatabase(filename);
    try {
      expect(retiredTableNames(reopened)).toEqual([]);
      expect(migrationIds(reopened)).toEqual(expect.arrayContaining([CURRENT_SCHEMA_MIGRATION_ID]));
    } finally {
      reopened.close();
    }
  });

  it('converges a clean install so the retired tables never survive the first open', () => {
    const database = new SqliteDatabase(':memory:');
    try {
      expect(retiredTableNames(database)).toEqual([]);
      expect(migrationIds(database)).toEqual(expect.arrayContaining([
        '018_turn_persistence',
        CURRENT_SCHEMA_MIGRATION_ID,
      ]));
    } finally {
      database.close();
    }
  });
});
