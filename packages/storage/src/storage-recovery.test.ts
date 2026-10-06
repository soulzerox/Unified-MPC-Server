import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from './database.js';
import { assertStorageIdentitySafe } from './storage-identity.js';
import { recoverHistoricalStorageIdentity, StorageRecoveryError } from './storage-recovery.js';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function seedLegacyDatabase(
  dataRoot: string,
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  const filename = path.join(dataRoot, 'unified-mpc.sqlite');
  const database = new DatabaseSync(filename);
  try {
    database.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        real_root_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY NOT NULL
      );
    `);
    database.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('001_initial');
    const insert = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(entries)) insert.run(key, value);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('historical storage recovery', () => {
  it('adopts one historical gateway DB through SQLite backup, migrates the snapshot, and records provenance', async () => {
    const root = await tempRoot('storage-recovery-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    const historicalPath = path.join(historicalRoot, 'unified-mpc.sqlite');
    await seedLegacyDatabase(historicalRoot, {
      cloudflare_public_url: 'https://historical.example.test',
      cloudflare_gateway_desired_state: 'connected',
    });

    const options = {
      environment: {
        HOME: home,
        XDG_DATA_HOME: path.join(root, 'xdg'),
        UNIFIED_MPC_DATA_PATH: canonical,
      },
      platform: 'linux' as NodeJS.Platform,
      arch: 'x64',
      systemHome: home,
      now: (): Date => new Date('2026-10-04T00:00:00.000Z'),
    };

    const result = await recoverHistoricalStorageIdentity(canonical, options);
    expect(result).toMatchObject({
      status: 'recovered',
      sourcePath: historicalPath,
      destinationPath: path.join(canonical, 'unified-mpc.sqlite'),
      canonicalBackupId: null,
      sourceBackupId: expect.any(String),
      migratedBackupId: expect.any(String),
      provenancePath: expect.any(String),
    });
    expect(existsSync(historicalPath)).toBe(true);
    expect(existsSync(path.join(canonical, 'unified-mpc.sqlite'))).toBe(true);
    expect(existsSync(result.provenancePath!)).toBe(true);

    const recovered = new DatabaseSync(path.join(canonical, 'unified-mpc.sqlite'), { readOnly: true });
    try {
      expect(recovered.prepare('SELECT value FROM settings WHERE key = ?').get('cloudflare_public_url'))
        .toMatchObject({ value: 'https://historical.example.test' });
      expect(recovered.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get())
        .toMatchObject({ id: '031_merge_reconciliation_records' });
    } finally {
      recovered.close();
    }

    const provenanceText = await readFile(result.provenancePath!, 'utf8');
    const provenance = JSON.parse(provenanceText) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      status: 'completed',
      method: 'sqlite_backup_restore',
      sourcePath: historicalPath,
      destinationPath: path.join(canonical, 'unified-mpc.sqlite'),
      sourceBackupId: result.sourceBackupId,
      migratedBackupId: result.migratedBackupId,
      canonicalBackupId: null,
    });
    expect(provenanceText).not.toContain('https://historical.example.test');
    expect(() => assertStorageIdentitySafe(canonical, options)).not.toThrow();

    await expect(recoverHistoricalStorageIdentity(canonical, options)).resolves.toMatchObject({
      status: 'not_needed',
      sourcePath: null,
      provenancePath: null,
    });
  });

  it('backs up a fresh canonical DB before replacing it with the recovered historical state', async () => {
    const root = await tempRoot('storage-recovery-fresh-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    await seedLegacyDatabase(historicalRoot, {
      cloudflare_public_url: 'https://historical.example.test',
    });
    await mkdir(canonical, { recursive: true });
    const canonicalDb = new SqliteDatabase(path.join(canonical, 'unified-mpc.sqlite'));
    canonicalDb.close();

    const result = await recoverHistoricalStorageIdentity(canonical, {
      environment: { HOME: home, UNIFIED_MPC_DATA_PATH: canonical },
      platform: 'linux',
      arch: 'x64',
      systemHome: home,
      now: (): Date => new Date('2026-10-04T00:01:00.000Z'),
    });

    expect(result.status).toBe('recovered');
    expect(result.canonicalBackupId).toEqual(expect.any(String));
    expect(existsSync(path.join(canonical, 'backups', result.canonicalBackupId! + '.sqlite'))).toBe(true);
    expect(existsSync(path.join(canonical, 'backups', result.canonicalBackupId! + '.json'))).toBe(true);
  });

  it('refuses to overwrite a canonical DB that already contains unrelated application data', async () => {
    const root = await tempRoot('storage-recovery-conflict-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    await seedLegacyDatabase(historicalRoot, {
      cloudflare_public_url: 'https://historical.example.test',
    });
    await mkdir(canonical, { recursive: true });
    const canonicalDb = new SqliteDatabase(path.join(canonical, 'unified-mpc.sqlite'));
    canonicalDb.connection.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('unrelated_setting', 'keep-me');
    canonicalDb.close();

    await expect(recoverHistoricalStorageIdentity(canonical, {
      environment: { HOME: home, UNIFIED_MPC_DATA_PATH: canonical },
      platform: 'linux',
      systemHome: home,
    })).rejects.toMatchObject<Partial<StorageRecoveryError>>({
      code: 'STORAGE_RECOVERY_CONFLICT',
    });

    const preserved = new DatabaseSync(path.join(canonical, 'unified-mpc.sqlite'), { readOnly: true });
    try {
      expect(preserved.prepare('SELECT value FROM settings WHERE key = ?').get('unrelated_setting'))
        .toMatchObject({ value: 'keep-me' });
      expect(preserved.prepare('SELECT value FROM settings WHERE key = ?').get('cloudflare_public_url')).toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('refuses automatic recovery when more than one historical gateway DB is plausible', async () => {
    const root = await tempRoot('storage-recovery-ambiguous-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const xdg = path.join(root, 'xdg');
    await seedLegacyDatabase(path.join(home, '.local', 'share', 'unified-mpc'), {
      cloudflare_public_url: 'https://home.example.test',
    });
    await seedLegacyDatabase(path.join(xdg, 'unified-mpc'), {
      cloudflare_public_url: 'https://xdg.example.test',
    });

    await expect(recoverHistoricalStorageIdentity(canonical, {
      environment: {
        HOME: home,
        XDG_DATA_HOME: xdg,
        UNIFIED_MPC_DATA_PATH: canonical,
      },
      platform: 'linux',
      systemHome: home,
    })).rejects.toMatchObject<Partial<StorageRecoveryError>>({
      code: 'STORAGE_RECOVERY_AMBIGUOUS',
    });
    expect(existsSync(path.join(canonical, 'unified-mpc.sqlite'))).toBe(false);
  });

  it('refuses recovery if the canonical DB becomes populated after the initial replacement check', async () => {
    const root = await tempRoot('storage-recovery-late-writer-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    await seedLegacyDatabase(historicalRoot, {
      cloudflare_public_url: 'https://historical.example.test',
    });
    await mkdir(canonical, { recursive: true });
    const canonicalPath = path.join(canonical, 'unified-mpc.sqlite');
    const canonicalDb = new SqliteDatabase(canonicalPath);
    canonicalDb.close();

    let nowCalls = 0;
    const now = (): Date => {
      nowCalls += 1;
      if (nowCalls === 2) {
        const lateWriter = new DatabaseSync(canonicalPath);
        try {
          lateWriter.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
            'late_writer_setting',
            'preserve-me',
          );
        } finally {
          lateWriter.close();
        }
      }
      return new Date('2026-10-04T00:02:00.000Z');
    };

    await expect(recoverHistoricalStorageIdentity(canonical, {
      environment: { HOME: home, UNIFIED_MPC_DATA_PATH: canonical },
      platform: 'linux',
      arch: 'x64',
      systemHome: home,
      now,
    })).rejects.toMatchObject<Partial<StorageRecoveryError>>({
      code: 'STORAGE_RECOVERY_CONFLICT',
    });

    const preserved = new DatabaseSync(canonicalPath, { readOnly: true });
    try {
      expect(preserved.prepare('SELECT value FROM settings WHERE key = ?').get('late_writer_setting'))
        .toMatchObject({ value: 'preserve-me' });
      expect(preserved.prepare('SELECT value FROM settings WHERE key = ?').get('cloudflare_public_url')).toBeUndefined();
    } finally {
      preserved.close();
    }
  });

  it('fails visibly when the historical recovery source is corrupt', async () => {
    const root = await tempRoot('storage-recovery-corrupt-source-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    await mkdir(historicalRoot, { recursive: true });
    await writeFile(path.join(historicalRoot, 'unified-mpc.sqlite'), 'not sqlite', 'utf8');

    await expect(recoverHistoricalStorageIdentity(canonical, {
      environment: { HOME: home, UNIFIED_MPC_DATA_PATH: canonical },
      platform: 'linux',
      systemHome: home,
    })).rejects.toMatchObject<Partial<StorageRecoveryError>>({
      code: 'STORAGE_RECOVERY_SOURCE_UNAVAILABLE',
    });
    expect(existsSync(path.join(canonical, 'unified-mpc.sqlite'))).toBe(false);
  });

  it('keeps prepared provenance when the scheduled restore fails', async () => {
    const root = await tempRoot('storage-recovery-restore-failure-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    const historicalPath = path.join(historicalRoot, 'unified-mpc.sqlite');
    const destinationPath = path.join(canonical, 'unified-mpc.sqlite');
    await seedLegacyDatabase(historicalRoot, {
      cloudflare_public_url: 'https://historical.example.test',
    });
    await mkdir(path.join(canonical, 'unified-mpc.sqlite.pre-restore'), { recursive: true });

    await expect(recoverHistoricalStorageIdentity(canonical, {
      environment: { HOME: home, UNIFIED_MPC_DATA_PATH: canonical },
      platform: 'linux',
      arch: 'x64',
      systemHome: home,
      now: (): Date => new Date('2026-10-04T00:03:00.000Z'),
    })).rejects.toMatchObject<Partial<StorageRecoveryError>>({
      code: 'STORAGE_RECOVERY_FAILED',
    });

    const pendingName = (await readdir(canonical)).find(
      (name) => name.startsWith('storage-recovery-') && name.endsWith('.json.pending'),
    );
    expect(pendingName).toEqual(expect.any(String));
    const provenance = JSON.parse(await readFile(path.join(canonical, pendingName!), 'utf8')) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      status: 'prepared',
      sourcePath: historicalPath,
      destinationPath,
      sourceBackupId: expect.any(String),
      migratedBackupId: expect.any(String),
    });
    expect(existsSync(destinationPath)).toBe(false);
  });

  it('includes committed WAL state when snapshotting the historical source', async () => {
    const root = await tempRoot('storage-recovery-wal-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historicalRoot = path.join(home, '.local', 'share', 'unified-mpc');
    const historicalPath = path.join(historicalRoot, 'unified-mpc.sqlite');
    await seedLegacyDatabase(historicalRoot, { unrelated_setting: 'keep-source-open' });

    const writer = new DatabaseSync(historicalPath);
    try {
      writer.exec('PRAGMA journal_mode = WAL;');
      writer.exec('PRAGMA wal_autocheckpoint = 0;');
      writer.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'cloudflare_public_url',
        'https://wal.example.test',
      );
      expect(existsSync(historicalPath + '-wal')).toBe(true);

      const result = await recoverHistoricalStorageIdentity(canonical, {
        environment: { HOME: home, UNIFIED_MPC_DATA_PATH: canonical },
        platform: 'linux',
        arch: 'x64',
        systemHome: home,
      });
      expect(result.status).toBe('recovered');
    } finally {
      writer.close();
    }

    const recovered = new DatabaseSync(path.join(canonical, 'unified-mpc.sqlite'), { readOnly: true });
    try {
      expect(recovered.prepare('SELECT value FROM settings WHERE key = ?').get('cloudflare_public_url'))
        .toMatchObject({ value: 'https://wal.example.test' });
    } finally {
      recovered.close();
    }
  });
});
