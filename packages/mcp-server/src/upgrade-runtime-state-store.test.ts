import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UpgradeRuntimeStateStore } from './upgrade-runtime-state-store.js';

const stateStoreSourceUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'upgrade-runtime-state-store.ts'),
).href;

/** Mirror of the lock file name `withSpawnLock` derives from a key. */
function spawnLockPath(legacyPath: string, key: string): string {
  const basename = path.basename(legacyPath, path.extname(legacyPath));
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(path.dirname(legacyPath), `${basename}.state-v2`, 'locks', `spawn-${digest}.lock`);
}

async function waitForLog(logPath: string, needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(logPath, 'utf8').catch(() => '');
    if (text.includes(needle)) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${needle} in ${logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A second process that holds the spawn lock, so the file lock is really exercised. */
function holderScript(params: {
  readonly legacyPath: string;
  readonly key: string;
  readonly logPath: string;
  readonly holdMs: number;
  readonly staleMs: number;
}): string {
  return `
import { appendFile } from 'node:fs/promises';
import { UpgradeRuntimeStateStore } from ${JSON.stringify(stateStoreSourceUrl)};
const store = new UpgradeRuntimeStateStore(${JSON.stringify(params.legacyPath)}, 'holder-process');
await store.withSpawnLock(${JSON.stringify(params.key)}, async () => {
  await appendFile(${JSON.stringify(params.logPath)}, 'holder-entered\\n');
  await new Promise((resolve) => setTimeout(resolve, ${params.holdMs}));
  await appendFile(${JSON.stringify(params.logPath)}, 'holder-exited\\n');
}, { staleMs: ${params.staleMs}, waitMs: 10_000 });
`;
}

describe('UpgradeRuntimeStateStore', () => {
  it('merges simultaneous writes for the same session without losing checkpoints', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-state-'));
    const legacyPath = path.join(directory, 'upgrade-runtime.json');
    const stores = Array.from({ length: 16 }, () => new UpgradeRuntimeStateStore(legacyPath, 'client\0session-a'));

    await Promise.all(stores.map((store, index) => store.updateSession((current) => ({
      ...current,
      checkpoints: [...current.checkpoints, { id: `checkpoint-${index}` }],
    }))));

    const loaded = await stores[0]!.load();
    expect(loaded.session.checkpoints).toEqual(expect.arrayContaining(
      Array.from({ length: 16 }, (_, index) => ({ id: `checkpoint-${index}` })),
    ));
    expect(loaded.session.checkpoints).toHaveLength(16);
  });

  it('fails closed instead of overwriting unreadable authoritative session state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-state-'));
    const legacyPath = path.join(directory, 'upgrade-runtime.json');
    const store = new UpgradeRuntimeStateStore(legacyPath, 'client\0session-a');
    await store.updateSession((current) => ({ ...current, checkpoints: [...current.checkpoints, { id: 'checkpoint-a' }] }));
    const sessionPath = store.sessionStatePath();
    await writeFile(sessionPath, '{broken-json', 'utf8');

    await expect(store.updateSession((current) => ({
      ...current, checkpoints: [...current.checkpoints, { id: 'checkpoint-b' }],
    }))).rejects.toThrow();
    await expect(readFile(sessionPath, 'utf8')).resolves.toBe('{broken-json');
  });

  it('isolates session state while merging shared state across owners', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-state-'));
    const legacyPath = path.join(directory, 'upgrade-runtime.json');
    const sessionA = new UpgradeRuntimeStateStore(legacyPath, 'client\0session-a');
    const sessionB = new UpgradeRuntimeStateStore(legacyPath, 'client\0session-b');

    await sessionA.updateSession((current) => ({ ...current, session: [['owner', 'a']] }));
    await sessionB.updateSession((current) => ({ ...current, session: [['owner', 'b']] }));
    await Promise.all([
      sessionA.updateShared((current) => ({ ...current, plugins: [...current.plugins, { name: 'plugin-a', enabled: true }] })),
      sessionB.updateShared((current) => ({ ...current, plugins: [...current.plugins, { name: 'plugin-b', enabled: true }] })),
    ]);

    expect((await sessionA.load()).session.session).toEqual([['owner', 'a']]);
    expect((await sessionB.load()).session.session).toEqual([['owner', 'b']]);
    const shared = (await sessionA.load()).shared.plugins;
    expect(shared).toEqual(expect.arrayContaining([{ name: 'plugin-a', enabled: true }, { name: 'plugin-b', enabled: true }]));
    expect(shared).toHaveLength(2);
  });

  it('migrates legacy state once, claims legacy session data for one session, and preserves shared ledgers', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-runtime-state-'));
    const legacyPath = path.join(directory, 'upgrade-runtime.json');
    const legacy = {
      tasks: [{ id: 'legacy-task' }],
      checkpoints: [{ id: 'legacy-checkpoint' }],
      session: [['lastCheckpointId', 'legacy-checkpoint']],
      plugins: [{ name: 'legacy-plugin', enabled: true }],
      worktrees: [{ workspaceId: 'ws-1', worktreePath: '.worktrees/legacy', ref: 'main', owner: 'client', createdAt: '2026-08-20T00:00:00.000Z' }],
    };
    await writeFile(legacyPath, JSON.stringify(legacy), 'utf8');

    const first = new UpgradeRuntimeStateStore(legacyPath, 'client\0session-a');
    const migrated = await first.load();
    expect(migrated.session.checkpoints).toEqual([{ id: 'legacy-checkpoint' }]);
    expect(migrated.shared.plugins).toEqual([{ name: 'legacy-plugin', enabled: true }]);
    expect(migrated.shared.worktrees).toEqual(legacy.worktrees);

    const second = new UpgradeRuntimeStateStore(legacyPath, 'client\0session-b');
    const isolated = await second.load();
    expect(isolated.session).toEqual({ tasks: [], checkpoints: [], session: [] });
    expect(isolated.shared.plugins).toEqual([{ name: 'legacy-plugin', enabled: true }]);
    expect(isolated.shared.worktrees).toEqual(legacy.worktrees);
    expect(JSON.parse(await readFile(legacyPath, 'utf8'))).toEqual(legacy);
  });

  it('keeps a heartbeating spawn lock when the holder outlives the stale window', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-spawn-lock-heartbeat-'));
    const legacyPath = path.join(directory, 'upgrade-runtime.json');
    const key = 'ws-heartbeat\0.worktrees/shared';
    const logPath = path.join(directory, 'events.log');
    // The holder lives four times longer than the stale window. Without the
    // heartbeat the waiter would quarantine the live lock and enter early.
    const child = spawn(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      holderScript({ legacyPath, key, logPath, holdMs: 1_200, staleMs: 300 }),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let childError = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { childError += chunk; });
    const childExit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      await waitForLog(logPath, 'holder-entered');
      const store = new UpgradeRuntimeStateStore(legacyPath, 'waiter-process');
      const waiterStarted = Date.now();
      await store.withSpawnLock(key, async () => {
        await appendFile(logPath, 'waiter-entered\n');
      }, { staleMs: 300, waitMs: 10_000 });
      const waitedMs = Date.now() - waiterStarted;
      expect(await childExit, childError).toBe(0);
      expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
        'holder-entered',
        'holder-exited',
        'waiter-entered',
      ]);
      expect(waitedMs).toBeGreaterThanOrEqual(700);
    } finally {
      child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('recovers an abandoned spawn lock older than the stale window', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-spawn-lock-stale-'));
    const legacyPath = path.join(directory, 'upgrade-runtime.json');
    const key = 'ws-abandoned\0.worktrees/shared';
    const lockPath = spawnLockPath(legacyPath, key);
    try {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify({ token: 'abandoned-holder', createdAt: new Date().toISOString() }), 'utf8');
      const abandonedAt = new Date(Date.now() - 60_000);
      await utimes(lockPath, abandonedAt, abandonedAt);

      const store = new UpgradeRuntimeStateStore(legacyPath, 'waiter-process');
      const observed = await store.withSpawnLock(
        key,
        async () => JSON.parse(await readFile(lockPath, 'utf8')) as { readonly token: string },
        { waitMs: 5_000 },
      );

      expect(observed.token).not.toBe('abandoned-holder');
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a newer owner lock file when the previous holder releases', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unified-mpc-spawn-lock-release-'));
    const legacyPath = path.join(directory, 'upgrade-runtime.json');
    const key = 'ws-release\0.worktrees/shared';
    const lockPath = spawnLockPath(legacyPath, key);
    try {
      const store = new UpgradeRuntimeStateStore(legacyPath, 'first-owner');
      // Simulate a takeover race: another owner replaces the lock file before
      // this holder reaches its release path. Release must not delete it.
      await store.withSpawnLock(key, async () => {
        await writeFile(lockPath, JSON.stringify({ token: 'newer-owner', createdAt: new Date().toISOString() }), 'utf8');
      }, { staleMs: 300 });

      const record = JSON.parse(await readFile(lockPath, 'utf8')) as { readonly token: string };
      expect(record.token).toBe('newer-owner');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
