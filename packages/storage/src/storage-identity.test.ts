import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { assertStorageIdentitySafe, inspectStorageIdentity } from './storage-identity.js';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function seedSettingsDatabase(dataRoot: string, entries: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  const filename = path.join(dataRoot, 'unified-mpc.sqlite');
  const database = new DatabaseSync(filename);
  try {
    database.exec('CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);');
    database.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL);');
    database.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run('029_goal_runtime_integration_observations');
    const insert = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(entries)) insert.run(key, value);
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('storage identity drift inspection', () => {
  it('fails closed before creating a fresh canonical DB when a historical HOME DB has gateway settings', async () => {
    const root = await tempRoot('storage-drift-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historical = path.join(home, '.local', 'share', 'unified-mpc');
    await seedSettingsDatabase(historical, {
      cloudflare_public_url: 'https://example.test',
      cloudflare_gateway_desired_state: 'connected',
    });

    const options = {
      environment: {
        HOME: home,
        XDG_DATA_HOME: path.join(root, 'xdg'),
        UNIFIED_MPC_DATA_PATH: canonical,
      },
      platform: 'linux' as NodeJS.Platform,
      systemHome: home,
    };

    const inspection = inspectStorageIdentity(canonical, options);
    expect(inspection.canonical.exists).toBe(false);
    expect(inspection.recoveryRequired).toBe(true);
    expect(inspection.recoverySourcePath).toBe(path.join(historical, 'unified-mpc.sqlite'));
    expect(inspection.historical).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sqlitePath: path.join(historical, 'unified-mpc.sqlite'),
        gatewaySettingCount: 2,
        readable: true,
      }),
    ]));

    expect(() => assertStorageIdentitySafe(canonical, options)).toThrow(/STORAGE_IDENTITY_DRIFT:/u);
    expect(existsSync(path.join(canonical, 'unified-mpc.sqlite'))).toBe(false);
  });

  it('detects the pre-pinning Web HOME path on macOS when canonical Application Support storage is empty', async () => {
    const root = await tempRoot('storage-drift-darwin-');
    const home = path.join(root, 'home');
    const canonical = path.join(home, 'Library', 'Application Support', 'unified-mpc');
    const historical = path.join(home, '.local', 'share', 'unified-mpc');
    await seedSettingsDatabase(historical, {
      cloudflare_public_url: 'https://legacy-web.example.test',
    });

    const inspection = inspectStorageIdentity(canonical, {
      environment: {
        HOME: home,
        UNIFIED_MPC_DATA_PATH: canonical,
      },
      platform: 'darwin',
      systemHome: home,
    });

    expect(inspection.recoveryRequired).toBe(true);
    expect(inspection.recoverySourcePath).toBe(path.join(historical, 'unified-mpc.sqlite'));
  });

  it('does not block an already-populated canonical DB even when a historical DB also exists', async () => {
    const root = await tempRoot('storage-canonical-populated-');
    const canonical = path.join(root, 'canonical');
    const home = path.join(root, 'home');
    const historical = path.join(home, '.local', 'share', 'unified-mpc');
    await seedSettingsDatabase(canonical, { cloudflare_public_url: 'https://canonical.test' });
    await seedSettingsDatabase(historical, { cloudflare_public_url: 'https://historical.test' });

    const inspection = assertStorageIdentitySafe(canonical, {
      environment: { HOME: home, UNIFIED_MPC_DATA_PATH: canonical },
      platform: 'linux',
      systemHome: home,
    });

    expect(inspection.canonical.gatewaySettingCount).toBe(1);
    expect(inspection.recoveryRequired).toBe(false);
    expect(inspection.recoverySourcePath).toBeNull();
    expect(inspection.historical).toEqual(expect.arrayContaining([
      expect.objectContaining({ gatewaySettingCount: 1 }),
    ]));
  });

  it('fails visibly when an existing canonical SQLite file cannot be inspected', async () => {
    const root = await tempRoot('storage-corrupt-');
    const canonical = path.join(root, 'canonical');
    await mkdir(canonical, { recursive: true });
    await writeFile(path.join(canonical, 'unified-mpc.sqlite'), 'not sqlite', 'utf8');

    expect(() => assertStorageIdentitySafe(canonical, {
      environment: { HOME: path.join(root, 'home'), UNIFIED_MPC_DATA_PATH: canonical },
      platform: 'linux',
      systemHome: path.join(root, 'home'),
    })).toThrow(/STORAGE_IDENTITY_UNAVAILABLE:/u);
  });
});
